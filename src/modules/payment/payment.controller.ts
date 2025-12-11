import { Request, Response } from "express";
import crypto from "crypto";
import Razorpay from "razorpay";
import prisma from "../../database/prismaclient";
import { getSingleAdminId, getSingleAdmin } from "../slots/slots.services";
import { PLANS, PlanSlug } from "../../constants/plan";
import { AppointmentMode, Prisma } from "@prisma/client";
import {
  sendPatientConfirmationMessage,
  sendDoctorNotificationMessage,
  sendBookingConfirmationMessage,
  sendLastMinuteConfirmationMessage,
} from "../../services/whatsapp.service";

// Initialize Razorpay instance
// Note: Environment variables are validated at startup in src/config/env.ts
// If we reach here, RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are guaranteed to exist
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

export function normalizeAppointmentMode(input: string): AppointmentMode {
  const v = (input || "").toLowerCase().trim();

  if (["in-person", "in_person", "clinic", "offline", "inperson"].includes(v)) {
    return AppointmentMode.IN_PERSON;
  }

  if (["online", "virtual", "video", "zoom"].includes(v)) {
    return AppointmentMode.ONLINE;
  }

  throw new Error("Invalid appointment mode");
}

/**
 * Create Razorpay order for an existing appointment
 * This is the main flow: appointment is created in recall flow, then order is created here
 */
export async function createOrderHandler(req: Request, res: Response) {
  try {
    console.log("[PAYMENT] Create order request received");
    const userId = req.user?.id;
    if (!userId) {
      console.error("[PAYMENT] Unauthenticated request");
      return res.status(401).json({
        success: false,
        error: "Unauthenticated. Please login again.",
      });
    }

    // Note: Razorpay configuration is validated at startup
    // If we reach here, Razorpay is configured

    // Support both new flow (appointmentId) and old flow (slotId, patientId) for backward compatibility
    const { appointmentId, slotId, patientId, planSlug, appointmentMode } =
      req.body as {
        appointmentId?: string;
        slotId?: string;
        patientId?: string;
        planSlug?: PlanSlug;
        appointmentMode?: string;
      };

    console.log("[PAYMENT] Request body:", {
      appointmentId: appointmentId || "none",
      slotId: slotId || "none",
      planSlug: planSlug || "none",
    });

    let appointment: any;

    // NEW FLOW: Use existing appointment (created in recall flow)
    if (appointmentId) {
      console.log("[PAYMENT] Using existing appointment:", appointmentId);

      // Use transaction to prevent race conditions
      appointment = await prisma.$transaction(async (tx) => {
        const appt = await tx.appointment.findFirst({
          where: {
            id: appointmentId,
            userId,
          },
          include: {
            patient: true,
            slot: true,
          },
        });

        if (!appt) {
          throw new Error("Appointment not found or unauthorized");
        }

        // Validate appointment is in PENDING status
        if (appt.status !== "PENDING") {
          throw new Error(
            `Appointment is already ${appt.status.toLowerCase()}. Cannot create payment order.`
          );
        }

        // Validate slot is assigned
        if (!appt.slotId || !appt.slot) {
          throw new Error(
            "No slot assigned to appointment. Please select a slot first."
          );
        }

        // Check if slot is already booked (race condition check)
        if (appt.slot.isBooked) {
          throw new Error(
            "Slot is already booked by another user. Please select a different slot."
          );
        }

        // Check if order already exists for this appointment
        if (appt.paymentId) {
          console.log(
            "[PAYMENT] Order already exists for appointment:",
            appt.paymentId
          );
          // Return existing order info - don't create duplicate
          // This will be handled by frontend to resume payment
          throw new Error("Payment order already exists for this appointment.");
        }

        return appt;
      });

      // Get plan price from appointment (already validated in recall flow)
      const planPrice = appointment.planPrice;

      // Validate plan price
      if (!planPrice || planPrice <= 0) {
        console.error("[PAYMENT] Invalid plan price:", planPrice);
        return res.status(400).json({
          success: false,
          error: "Invalid plan price. Please contact support.",
        });
      }

      // Convert to paise (Razorpay requires amount in smallest currency unit)
      const amountInPaise = Math.round(planPrice * 100);

      console.log("[PAYMENT] Creating Razorpay order:", {
        amountInPaise,
        planPrice,
        appointmentId: appointment.id,
      });

      // Generate receipt (max 40 chars for Razorpay)
      // Format: rcpt_<short-appointment-id>_<timestamp>
      const shortApptId = appointment.id.slice(-8); // Last 8 chars of UUID
      const timestamp = Date.now().toString().slice(-10); // Last 10 digits of timestamp
      const receipt = `rcpt_${shortApptId}_${timestamp}`; // Max length: 5 + 8 + 1 + 10 = 24 chars

      let order;
      try {
        order = await razorpay.orders.create({
          amount: amountInPaise,
          currency: "INR",
          receipt: receipt,
          notes: {
            appointmentId: appointment.id,
            planSlug: appointment.planSlug,
            planName: appointment.planName,
            userId: userId,
          },
        });
      } catch (razorpayError: any) {
        console.error(
          "[PAYMENT] Razorpay order creation failed:",
          razorpayError
        );
        return res.status(500).json({
          success: false,
          error:
            razorpayError?.error?.description ||
            "Failed to create payment order. Please try again.",
        });
      }

      // Update appointment with payment order ID in a transaction
      try {
        await prisma.$transaction(async (tx) => {
          // Double-check appointment status hasn't changed
          const currentAppt = await tx.appointment.findUnique({
            where: { id: appointment.id },
            select: { status: true, paymentId: true },
          });

          if (!currentAppt) {
            throw new Error("Appointment not found");
          }

          if (currentAppt.status !== "PENDING") {
            throw new Error(
              "Appointment status changed. Cannot update payment."
            );
          }

          if (currentAppt.paymentId) {
            throw new Error("Payment order already exists");
          }

          // Update appointment with payment order ID
          await tx.appointment.update({
            where: { id: appointment.id },
            data: {
              paymentId: order.id,
              amount: planPrice, // Store in rupees (not paise) in database
              paymentStatus: "PENDING",
            } as any,
          });
        });
      } catch (updateError: any) {
        console.error(
          "[PAYMENT] Failed to update appointment with order ID:",
          updateError
        );
        // Order was created but appointment update failed - this is a critical error
        // In production, you might want to cancel the Razorpay order here
        return res.status(500).json({
          success: false,
          error:
            "Failed to link payment order to appointment. Please contact support.",
        });
      }

      console.log("==========================================");
      console.log("[PAYMENT ORDER CREATED] ✅ Order Created Successfully:");
      console.log("  Order ID (Razorpay Order ID):", order.id);
      console.log("  Order Amount (in paise):", order.amount);
      console.log("  Order Currency:", order.currency);
      console.log("  Order Receipt:", order.receipt);
      console.log("  Order Status:", order.status);
      console.log("  Appointment ID:", appointment.id);
      console.log("==========================================");

      return res.json({
        success: true,
        order: {
          id: order.id,
          amount: order.amount, // Already in paise from Razorpay
          currency: order.currency,
          receipt: order.receipt,
          status: order.status,
        },
        appointmentId: appointment.id,
      });
    }

    // OLD FLOW: Create new appointment (for backward compatibility - not recommended)
    if (!slotId || !patientId || !planSlug || !appointmentMode) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields. Please use appointmentId instead.",
      });
    }

    const plan = PLANS[planSlug];
    if (!plan) {
      return res.status(400).json({
        success: false,
        error: "Invalid plan selected",
      });
    }

    const modeEnum = normalizeAppointmentMode(appointmentMode);
    const patient = await prisma.patientDetials.findFirst({
      where: {
        id: patientId,
        userId,
      },
    });

    if (!patient) {
      return res.status(403).json({
        success: false,
        error: "Patient does not belong to current user",
      });
    }

    const slot = await prisma.slot.findUnique({
      where: { id: slotId },
    });

    if (!slot) {
      return res.status(400).json({
        success: false,
        error: "Slot not found",
      });
    }

    if (slot.isBooked) {
      return res.status(400).json({
        success: false,
        error: "Slot already booked",
      });
    }

    if (slot.mode !== modeEnum) {
      return res.status(400).json({
        success: false,
        error: "Slot mode does not match selected mode",
      });
    }

    if (slot.startAt <= new Date()) {
      return res.status(400).json({
        success: false,
        error: "Slot is in the past",
      });
    }

    const amountInPaise = Math.round(plan.price * 100);
    const receipt = `rcpt_${Date.now()}`;

    let order;
    try {
      order = await razorpay.orders.create({
        amount: amountInPaise,
        currency: "INR",
        receipt: receipt,
      });
    } catch (razorpayError: any) {
      console.error("[PAYMENT] Razorpay order creation failed:", razorpayError);
      return res.status(500).json({
        success: false,
        error:
          razorpayError?.error?.description || "Failed to create payment order",
      });
    }

    const doctorId = await getSingleAdminId();

    try {
      appointment = await prisma.appointment.create({
        data: {
          userId,
          doctorId,
          patientId,
          slotId: slot.id,
          startAt: slot.startAt,
          endAt: slot.endAt,
          paymentId: order.id,
          amount: plan.price, // Store in rupees
          status: "PENDING",
          mode: modeEnum,
          planSlug,
          planName: plan.name,
          planPrice: plan.price,
          planDuration: plan.duration,
          planPackageName: plan.packageName,
        },
      });
    } catch (err: any) {
      // Handle unique constraint -> slot double booking race condition
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" &&
        Array.isArray(err.meta?.target) &&
        err.meta?.target.includes("slotId")
      ) {
        return res.status(409).json({
          success: false,
          error: "Slot already booked by another user",
        });
      }
      throw err;
    }

    return res.json({
      success: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt,
        status: order.status,
      },
      appointmentId: appointment.id,
    });
  } catch (err: any) {
    console.error("[PAYMENT] Create order error:", {
      message: err.message,
      stack: err.stack,
      code: err.code,
    });

    // Handle Prisma errors
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2002") {
        return res.status(409).json({
          success: false,
          error: "Slot already booked",
        });
      }
    }

    return res.status(500).json({
      success: false,
      error: err.message || "Something went wrong. Please try again.",
    });
  }
}

/**
 * Verify Razorpay payment signature and confirm appointment
 * This is called from the frontend after successful payment
 */
export async function verifyPaymentHandler(req: Request, res: Response) {
  try {
    console.log("[PAYMENT] Verify payment request received");
    const userId = req.user?.id;
    if (!userId) {
      console.error("[PAYMENT] Unauthenticated verification request");
      return res.status(401).json({
        success: false,
        error: "Unauthenticated. Please login again.",
      });
    }

    const { orderId, paymentId, signature } = req.body;

    if (!orderId || !paymentId || !signature) {
      console.error("[PAYMENT] Missing verification fields");
      return res.status(400).json({
        success: false,
        error: "Missing required fields: orderId, paymentId, signature",
      });
    }

    // Console log payment details with proper labels
    console.log("==========================================");
    console.log("[PAYMENT VERIFICATION] Payment Details Received:");
    console.log("  Order ID (Razorpay Order ID):", orderId);
    console.log("  Payment ID (Razorpay Payment ID):", paymentId);
    console.log("  Payment Signature:", signature);
    console.log("==========================================");

    // Verify Razorpay signature
    const body = `${orderId}|${paymentId}`;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!)
      .update(body)
      .digest("hex");

    console.log("[PAYMENT VERIFICATION] Signature Verification:");
    console.log("  Expected Signature:", expectedSignature);
    console.log("  Received Signature:", signature);
    console.log("  Signature Match:", expectedSignature === signature);

    if (expectedSignature !== signature) {
      console.error(
        "[PAYMENT VERIFICATION] ❌ Signature mismatch - Payment verification failed"
      );
      return res.status(400).json({
        success: false,
        error: "Invalid payment signature. Payment verification failed.",
      });
    }

    console.log("[PAYMENT VERIFICATION] ✅ Signature verified successfully");
    console.log(
      "[PAYMENT VERIFICATION] Finding appointment for order:",
      orderId
    );

    // Find appointment by payment order ID with patient and doctor details
    const appointment = await prisma.appointment.findFirst({
      where: {
        paymentId: orderId,
        userId, // Ensure appointment belongs to the user
      },
      include: {
        slot: true,
        patient: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
          },
        },
        doctor: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
          },
        },
      },
    });

    if (!appointment) {
      console.error("[PAYMENT] Appointment not found for order:", orderId);
      return res.status(404).json({
        success: false,
        error: "Appointment not found for this payment order",
      });
    }

    // Type assertion for paymentStatus
    const appointmentWithPaymentStatus = appointment as any;

    console.log("[PAYMENT] Appointment found:", {
      id: appointment.id,
      currentStatus: appointment.status,
      paymentStatus: appointmentWithPaymentStatus.paymentStatus,
    });

    // Check if already confirmed (idempotency)
    if (appointment.status === "CONFIRMED") {
      console.log("[PAYMENT] Appointment already confirmed");
      return res.json({
        success: true,
        alreadyConfirmed: true,
        message: "Payment already verified and appointment confirmed",
      });
    }

    // Update appointment status in a transaction to prevent race conditions
    await prisma.$transaction(
      async (tx) => {
        // Use raw query with FOR UPDATE to lock the row and prevent concurrent updates
        // This ensures only one request can update the appointment at a time
        // DATA INTEGRITY: Also check paymentStatus to prevent duplicate payment processing
        const lockedAppt = await tx.$queryRaw<
          Array<{
            id: string;
            status: string;
            paymentStatus: string;
            slotId: string | null;
          }>
        >`
          SELECT id, status, "paymentStatus", "slotId"
          FROM "Appointment"
          WHERE id = ${appointment.id}
          FOR UPDATE
        `;

        if (!lockedAppt || lockedAppt.length === 0) {
          throw new Error("Appointment not found");
        }

        const apptStatus = lockedAppt[0].status;
        const apptPaymentStatus = lockedAppt[0].paymentStatus;
        const apptSlotId = lockedAppt[0].slotId;

        // DATA INTEGRITY: Idempotency check - if already confirmed, return early
        if (apptStatus === "CONFIRMED") {
          console.log(
            "[PAYMENT] Appointment already confirmed (race condition prevented)"
          );
          return;
        }

        // DATA INTEGRITY: Check payment status to prevent duplicate payment processing
        if (apptPaymentStatus === "SUCCESS") {
          console.warn(
            "[PAYMENT] Payment already processed (paymentStatus is SUCCESS)"
          );
          throw new Error(
            "Payment has already been processed for this appointment. Cannot process duplicate payment."
          );
        }

        // DATA INTEGRITY: Additional validation - ensure appointment is still in PENDING status
        // This prevents confirming cancelled or completed appointments
        if (apptStatus !== "PENDING") {
          throw new Error(
            `Cannot confirm appointment in ${apptStatus} status. Expected PENDING. Payment verification aborted.`
          );
        }

        // Update appointment to CONFIRMED and store payment details
        // Note: paymentId field stores Razorpay Order ID (orderId)
        //       notes field stores Razorpay Payment ID (paymentId)
        // Clear bookingProgress since appointment is now confirmed (no longer pending)
        await tx.appointment.update({
          where: { id: appointment.id },
          data: {
            status: "CONFIRMED",
            paymentStatus: "SUCCESS",
            bookingProgress: null, // Clear booking progress - appointment is confirmed
            // paymentId field already contains orderId (set during order creation)
            // Store Razorpay Payment ID in notes field
            notes: paymentId, // Razorpay Payment ID (pay_xxxxx)
          } as any,
        });

        console.log("==========================================");
        console.log("[PAYMENT SUCCESS] Payment Verified and Stored:");
        console.log("  Appointment ID:", appointment.id);
        console.log("  Order ID (Razorpay Order ID):", orderId);
        console.log("  Payment ID (Razorpay Payment ID):", paymentId);
        console.log("  Payment Status: SUCCESS");
        console.log("  Appointment Status: CONFIRMED");
        console.log("==========================================");

        // Mark slot as booked if slot exists
        // This is critical: slot must be marked as booked when payment succeeds
        if (apptSlotId) {
          try {
            // Lock slot row to prevent concurrent bookings
            await tx.$queryRaw`
              SELECT id
              FROM "Slot"
              WHERE id = ${apptSlotId}
              FOR UPDATE
            `;

            const updatedSlot = await tx.slot.update({
              where: { id: apptSlotId },
              data: { isBooked: true },
            });
            console.log("==========================================");
            console.log("[PAYMENT SUCCESS] ✅ Slot Marked as Booked:");
            console.log("  Slot ID:", apptSlotId);
            console.log("  Slot isBooked:", updatedSlot.isBooked);
            console.log("  Slot Start Time:", updatedSlot.startAt);
            console.log("  Slot Mode:", updatedSlot.mode);
            console.log("==========================================");
          } catch (slotError: any) {
            // Slot may already be booked (race condition) - log but don't fail
            // This can happen if webhook processed payment before verifyPaymentHandler
            console.warn(
              "[PAYMENT] Slot update failed (may already be booked):",
              slotError.message
            );
            // Still log the slot ID for debugging
            console.log("[PAYMENT] Attempted to book slot:", apptSlotId);
          }
        } else {
          console.log(
            "[PAYMENT] No slot ID found for appointment - skipping slot booking"
          );
        }
      },
      {
        timeout: 10000, // 10 second timeout
        isolationLevel: "ReadCommitted", // Prevent dirty reads
      }
    );

    console.log(
      "[PAYMENT] Appointment CONFIRMED via verify API:",
      appointment.id
    );

    // Send WhatsApp notifications after successful payment confirmation
    // This runs outside the transaction to avoid blocking payment confirmation
    console.log("==========================================");
    console.log("[PAYMENT] Starting WhatsApp notification process...");
    console.log("  Appointment ID:", appointment.id);
    console.log("  Patient Phone:", appointment.patient?.phone || "Not found");
    console.log("  Doctor Phone:", appointment.doctor?.phone || "Not found");
    console.log("==========================================");

    try {
      await sendWhatsAppNotifications(appointment, orderId, paymentId);
      console.log("[PAYMENT] ✅ WhatsApp notification process completed");
    } catch (whatsappError: any) {
      // Log error but don't fail the payment confirmation
      console.error("==========================================");
      console.error(
        "[PAYMENT] ❌ WhatsApp notification failed (non-blocking):"
      );
      console.error("  Error:", whatsappError.message);
      console.error("  Stack:", whatsappError.stack);
      console.error("==========================================");
    }

    return res.json({
      success: true,
      message: "Payment verified successfully. Your appointment is confirmed.",
    });
  } catch (err: any) {
    console.error("[PAYMENT] verifyPaymentHandler error:", {
      message: err.message,
      stack: err.stack,
    });
    return res.status(500).json({
      success: false,
      error:
        "Internal server error. Please contact support with your payment ID.",
    });
  }
}

/**
 * Get existing payment order for an appointment
 * Used to resume payment if order already exists
 */
export async function getExistingOrderHandler(req: Request, res: Response) {
  try {
    console.log("[PAYMENT] Get existing order request received");
    const userId = req.user?.id;
    if (!userId) {
      console.error("[PAYMENT] Unauthenticated request");
      return res.status(401).json({
        success: false,
        error: "Unauthenticated. Please login again.",
      });
    }

    const { appointmentId } = req.params;

    if (!appointmentId) {
      return res.status(400).json({
        success: false,
        error: "Appointment ID is required",
      });
    }

    console.log(
      "[PAYMENT] Finding existing order for appointment:",
      appointmentId
    );

    // Find appointment with existing payment order
    const appointment = (await prisma.appointment.findFirst({
      where: {
        id: appointmentId,
        userId, // Ensure appointment belongs to the user
      },
      select: {
        id: true,
        paymentId: true,
        planPrice: true,
        status: true,
        // paymentStatus exists in schema but Prisma types may be stale
      } as any,
    })) as any; // Type assertion to handle paymentStatus field

    if (!appointment) {
      console.error("[PAYMENT] Appointment not found or unauthorized");
      return res.status(404).json({
        success: false,
        error: "Appointment not found or unauthorized",
      });
    }

    // Check if appointment is already confirmed
    if (appointment.status === "CONFIRMED") {
      return res.status(400).json({
        success: false,
        error: "Appointment is already confirmed",
      });
    }

    // Check if payment order exists
    if (!appointment.paymentId) {
      console.log("[PAYMENT] No existing order found for appointment");
      return res.status(404).json({
        success: false,
        error: "No existing payment order found for this appointment",
      });
    }

    console.log("[PAYMENT] Existing order found:", appointment.paymentId);

    // Fetch order details from Razorpay to get amount and currency
    let orderDetails;
    try {
      orderDetails = await razorpay.orders.fetch(appointment.paymentId);
    } catch (razorpayError: any) {
      console.error(
        "[PAYMENT] Failed to fetch order from Razorpay:",
        razorpayError
      );
      // If order doesn't exist in Razorpay, return error
      return res.status(404).json({
        success: false,
        error: "Payment order not found in payment gateway",
      });
    }

    return res.json({
      success: true,
      order: {
        id: orderDetails.id,
        amount: orderDetails.amount, // Already in paise
        currency: orderDetails.currency,
        receipt: orderDetails.receipt,
        status: orderDetails.status,
      },
      appointmentId: appointment.id,
    });
  } catch (err: any) {
    console.error("[PAYMENT] Get existing order error:", {
      message: err.message,
      stack: err.stack,
    });
    return res.status(500).json({
      success: false,
      error: err.message || "Internal server error",
    });
  }
}

/**
 * Get plan price from backend (public endpoint)
 */
export async function getPlanPriceHandler(req: Request, res: Response) {
  try {
    const { planSlug } = req.query;

    if (!planSlug || typeof planSlug !== "string") {
      return res.status(400).json({
        success: false,
        error: "planSlug is required",
      });
    }

    const plan = PLANS[planSlug as PlanSlug];
    if (!plan) {
      return res.status(404).json({
        success: false,
        error: "Plan not found",
      });
    }

    return res.json({
      success: true,
      plan: {
        slug: planSlug,
        name: plan.name,
        price: plan.price,
        duration: plan.duration,
        packageName: plan.packageName,
      },
    });
  } catch (err: any) {
    console.error("[PAYMENT] Get plan price error:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
}

/**
 * Send WhatsApp/SMS notifications to patient and doctor after payment confirmation
 * Implements the booking logic with three cases based on booking time relative to reminder window
 * Case A: Booking well before reminder window -> Send booking confirmation only
 * Case B: Booking inside reminder window -> Send combined last-minute confirmation
 * Case C: Booking at or after slot time -> Invalid (should not happen, handled in validation)
 */
async function sendWhatsAppNotifications(
  appointment: any,
  orderId: string,
  paymentId: string
) {
  try {
    console.log("==========================================");
    console.log(
      "[BOOKING CONFIRMATION] Processing appointment confirmation notifications..."
    );
    console.log("  Appointment ID:", appointment.id);
    console.log("  Order ID:", orderId);
    console.log("  Payment ID:", paymentId);
    console.log("  Appointment Status: CONFIRMED");
    console.log("==========================================");

    // Get appointment slot time (use slot.startAt or appointment.startAt)
    const slotTime = appointment.slot?.startAt || appointment.startAt;
    if (!slotTime) {
      console.error(
        "[BOOKING CONFIRMATION] ❌ Slot time not found, cannot send notifications"
      );
      return;
    }

    const slotTimeDate = new Date(slotTime);
    const now = new Date();

    // Calculate reminder time (1 hour before slot time)
    const reminderTime = new Date(slotTimeDate.getTime() - 60 * 60 * 1000); // -1 hour

    console.log("  Slot Time:", slotTimeDate.toISOString());
    console.log("  Reminder Time:", reminderTime.toISOString());
    console.log("  Current Time:", now.toISOString());
    console.log("==========================================");

    // Case C: Booking at or after slot time (invalid - should not happen)
    if (now >= slotTimeDate) {
      console.error(
        "[BOOKING CONFIRMATION] ❌ Invalid: Booking time is at or after slot time"
      );
      console.error(
        "  This should not happen - slot time validation should prevent this"
      );
      // Still update reminderTime in DB for consistency, but don't send SMS
      await prisma.appointment.update({
        where: { id: appointment.id },
        data: {
          reminderTime: reminderTime,
          reminderSent: true, // Mark as sent to prevent cron from trying to send
        },
      });
      return;
    }

    // Get patient phone number
    const patientPhone = appointment.patient?.phone;
    const patientName = appointment.patient?.name || "Patient";

    if (!patientPhone) {
      console.warn(
        "[BOOKING CONFIRMATION] ⚠️ Patient phone not found, skipping patient notification"
      );
      console.warn("  Patient Name:", patientName);
      console.warn("  Patient ID:", appointment.patient?.id);

      // Still update reminderTime in DB even if we can't send SMS
      await prisma.appointment.update({
        where: { id: appointment.id },
        data: {
          reminderTime: reminderTime,
          // Keep reminderSent as false so cron can try later if phone is updated
        },
      });
    } else {
      // Case B: Booking inside reminder window (reminderTime <= now < slotTime)
      if (reminderTime <= now && now < slotTimeDate) {
        console.log("==========================================");
        console.log(
          "[BOOKING CONFIRMATION] Case B: Booking inside reminder window"
        );
        console.log("  Sending combined last-minute confirmation + reminder");
        console.log("  Patient Name:", patientName);
        console.log("  Patient Phone:", patientPhone);
        console.log("==========================================");

        const result = await sendLastMinuteConfirmationMessage(
          patientPhone,
          slotTimeDate
        );

        if (result.success) {
          console.log("==========================================");
          console.log(
            "[BOOKING CONFIRMATION] ✅ Last-minute confirmation sent successfully"
          );
          console.log("  Patient Phone:", patientPhone);
          console.log("  Template: Last-minute combined");
          console.log("==========================================");

          // Update DB: set reminderSent = true (no separate reminder needed)
          await prisma.appointment.update({
            where: { id: appointment.id },
            data: {
              reminderTime: reminderTime,
              reminderSent: true, // Mark as sent so cron doesn't send another reminder
            },
          });
        } else {
          console.error("==========================================");
          console.error(
            "[BOOKING CONFIRMATION] ❌ Last-minute confirmation failed"
          );
          console.error("  Patient Phone:", patientPhone);
          console.error("  Error:", result.error);
          console.error("==========================================");

          // Still update reminderTime in DB, but keep reminderSent = false
          // so cron can try to send reminder later
          await prisma.appointment.update({
            where: { id: appointment.id },
            data: {
              reminderTime: reminderTime,
              reminderSent: false,
            },
          });
        }
      }
      // Case A: Booking well before reminder window (now < reminderTime)
      else {
        console.log("==========================================");
        console.log(
          "[BOOKING CONFIRMATION] Case A: Booking well before reminder window"
        );
        console.log("  Sending booking confirmation only");
        console.log("  Reminder will be sent later by cron job");
        console.log("  Patient Name:", patientName);
        console.log("  Patient Phone:", patientPhone);
        console.log("==========================================");

        const result = await sendBookingConfirmationMessage(
          patientPhone,
          slotTimeDate
        );

        if (result.success) {
          console.log("==========================================");
          console.log(
            "[BOOKING CONFIRMATION] ✅ Booking confirmation sent successfully"
          );
          console.log("  Patient Phone:", patientPhone);
          console.log("  Template: Booking confirmation");
          console.log("==========================================");
        } else {
          console.error("==========================================");
          console.error(
            "[BOOKING CONFIRMATION] ❌ Booking confirmation failed"
          );
          console.error("  Patient Phone:", patientPhone);
          console.error("  Error:", result.error);
          console.error("==========================================");
        }

        // Update DB: set reminderSent = false (cron will send reminder later)
        await prisma.appointment.update({
          where: { id: appointment.id },
          data: {
            reminderTime: reminderTime,
            reminderSent: false, // Cron job will send reminder later
          },
        });
      }
    }

    // Get doctor phone number
    const doctorPhone = appointment.doctor?.phone;
    const doctorName = appointment.doctor?.name || "Doctor";

    if (!doctorPhone) {
      console.log(
        "[WHATSAPP CONFIRMATION] Doctor phone not found in appointment, trying admin fallback..."
      );
      // Fallback: get admin phone from getSingleAdmin
      try {
        const admin = await getSingleAdmin();
        const adminPhone = admin.phone;
        const adminName = admin.name || "Admin";

        if (adminPhone) {
          console.log(
            "[WHATSAPP CONFIRMATION] Sending doctor notification (using admin phone)..."
          );
          console.log("  Admin Name:", adminName);
          console.log("  Admin Phone:", adminPhone);

          const doctorResult = await sendDoctorNotificationMessage(adminPhone);
          if (doctorResult.success) {
            console.log("==========================================");
            console.log(
              "[WHATSAPP CONFIRMATION] ✅ Doctor notification sent successfully"
            );
            console.log("  Admin Phone:", adminPhone);
            console.log("  Admin Name:", adminName);
            console.log("  Template: testing_nut");
            console.log("==========================================");
          } else {
            console.error("==========================================");
            console.error(
              "[WHATSAPP CONFIRMATION] ❌ Doctor notification failed"
            );
            console.error("  Admin Phone:", adminPhone);
            console.error("  Error:", doctorResult.error);
            console.error("==========================================");
          }
        } else {
          console.warn(
            "[WHATSAPP CONFIRMATION] ⚠️ Admin phone not found, skipping doctor notification"
          );
        }
      } catch (adminError: any) {
        console.error("==========================================");
        console.error("[WHATSAPP CONFIRMATION] ❌ Failed to get admin phone");
        console.error("  Error:", adminError.message);
        console.error("==========================================");
      }
    } else {
      console.log("[WHATSAPP CONFIRMATION] Sending doctor notification...");
      console.log("  Doctor Name:", doctorName);
      console.log("  Doctor Phone:", doctorPhone);

      const doctorResult = await sendDoctorNotificationMessage(doctorPhone);
      if (doctorResult.success) {
        console.log("==========================================");
        console.log(
          "[WHATSAPP CONFIRMATION] ✅ Doctor notification sent successfully"
        );
        console.log("  Doctor Phone:", doctorPhone);
        console.log("  Doctor Name:", doctorName);
        console.log("  Template: testing_nut");
        console.log("==========================================");
      } else {
        console.error("==========================================");
        console.error("[WHATSAPP CONFIRMATION] ❌ Doctor notification failed");
        console.error("  Doctor Phone:", doctorPhone);
        console.error("  Error:", doctorResult.error);
        console.error("==========================================");
      }
    }

    console.log("[WHATSAPP CONFIRMATION] ✅ Notification process completed");
  } catch (error: any) {
    console.error("==========================================");
    console.error("[WHATSAPP CONFIRMATION] ❌ Error sending notifications");
    console.error("  Error:", error.message);
    console.error("  Stack:", error.stack);
    console.error("==========================================");
    throw error;
  }
}

/**
 * Razorpay Webhook Handler
 * Processes payment.captured events with signature verification and race condition handling
 */
export async function razorpayWebhookHandler(req: Request, res: Response) {
  try {
    console.log("[WEBHOOK] Razorpay webhook received");

    // Get raw body for signature verification
    const rawBody = (req as any).rawBody;
    if (!rawBody) {
      console.error("[WEBHOOK] ❌ Raw body not found");
      return res.status(400).json({
        success: false,
        error: "Raw body required for signature verification",
      });
    }

    // Get webhook signature from headers
    const webhookSignature = req.headers["x-razorpay-signature"] as string;
    if (!webhookSignature) {
      console.error("[WEBHOOK] ❌ Webhook signature header missing");
      return res.status(400).json({
        success: false,
        error: "Webhook signature header missing",
      });
    }

    // Get webhook secret from environment
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("[WEBHOOK] ❌ RAZORPAY_WEBHOOK_SECRET not configured");
      return res.status(500).json({
        success: false,
        error: "Webhook secret not configured",
      });
    }

    // Verify webhook signature using HMAC-SHA256
    // Razorpay webhook signatures use HMAC-SHA256 of the raw body
    let isValidSignature = false;
    try {
      const expectedSignature = crypto
        .createHmac("sha256", webhookSecret)
        .update(rawBody)
        .digest("hex");

      // Razorpay sends signature in format: sha256=<hash>
      // Extract hash if signature includes prefix
      const receivedSignature = webhookSignature.includes("sha256=")
        ? webhookSignature.split("sha256=")[1]
        : webhookSignature;

      isValidSignature = crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(receivedSignature)
      );
    } catch (signatureError: any) {
      console.error(
        "[WEBHOOK] ❌ Signature verification error:",
        signatureError
      );
      return res.status(400).json({
        success: false,
        error: "Invalid webhook signature",
      });
    }

    if (!isValidSignature) {
      console.error("[WEBHOOK] ❌ Invalid webhook signature");
      return res.status(400).json({
        success: false,
        error: "Invalid webhook signature",
      });
    }

    console.log("[WEBHOOK] ✅ Signature verified successfully");

    // Parse webhook payload
    const webhookPayload = req.body;
    if (!webhookPayload) {
      console.error("[WEBHOOK] ❌ Webhook payload missing");
      return res.status(400).json({
        success: false,
        error: "Webhook payload missing",
      });
    }

    const eventType = webhookPayload.event;
    const eventId = webhookPayload.id || webhookPayload.event_id;

    console.log("[WEBHOOK] Event Details:", {
      eventType,
      eventId,
      timestamp: new Date().toISOString(),
    });

    // Check for idempotency - prevent processing same event twice
    if (eventId) {
      const existingEvent = await prisma.webhookEvent.findUnique({
        where: { eventId },
      });

      if (existingEvent) {
        console.log(
          "[WEBHOOK] ⚠️ Event already processed (idempotency check):",
          eventId
        );
        return res.json({
          success: true,
          message: "Event already processed",
          eventId,
        });
      }
    }

    // Process payment.captured event
    if (eventType === "payment.captured") {
      console.log("[WEBHOOK] Processing payment.captured event");

      const paymentEntity = webhookPayload.payload?.payment?.entity;
      if (!paymentEntity) {
        console.error("[WEBHOOK] ❌ Payment entity missing in payload");
        return res.status(400).json({
          success: false,
          error: "Payment entity missing in webhook payload",
        });
      }

      const orderId = paymentEntity.order_id;
      const paymentId = paymentEntity.id;
      const paymentStatus = paymentEntity.status;

      console.log("[WEBHOOK] Payment Details:", {
        orderId,
        paymentId,
        paymentStatus,
        amount: paymentEntity.amount,
        currency: paymentEntity.currency,
      });

      if (!orderId || !paymentId) {
        console.error("[WEBHOOK] ❌ Missing orderId or paymentId");
        return res.status(400).json({
          success: false,
          error: "Missing orderId or paymentId in webhook payload",
        });
      }

      // Process payment capture in a transaction to handle race conditions
      try {
        await prisma.$transaction(
          async (tx) => {
            // Store webhook event for idempotency (before processing)
            if (eventId) {
              await tx.webhookEvent.create({
                data: { eventId },
              });
            }

            // Find appointment by payment order ID
            const appointment = await tx.appointment.findFirst({
              where: {
                paymentId: orderId,
              },
              include: {
                slot: true,
                patient: {
                  select: {
                    id: true,
                    name: true,
                    phone: true,
                    email: true,
                  },
                },
                doctor: {
                  select: {
                    id: true,
                    name: true,
                    phone: true,
                    email: true,
                  },
                },
              },
            });

            if (!appointment) {
              console.warn(
                "[WEBHOOK] ⚠️ Appointment not found for order:",
                orderId
              );
              // Don't fail webhook - appointment might be processed via verifyPaymentHandler
              return;
            }

            // Lock appointment row to prevent concurrent updates
            const lockedAppt = await tx.$queryRaw<
              Array<{ id: string; status: string; slotId: string | null }>
            >`
              SELECT id, status, "slotId"
              FROM "Appointment"
              WHERE id = ${appointment.id}
              FOR UPDATE
            `;

            if (!lockedAppt || lockedAppt.length === 0) {
              throw new Error("Appointment not found during transaction");
            }

            const apptStatus = lockedAppt[0].status;
            const apptSlotId = lockedAppt[0].slotId;

            // Idempotency check: if already confirmed, return early
            if (apptStatus === "CONFIRMED") {
              console.log(
                "[WEBHOOK] ⚠️ Appointment already confirmed (race condition prevented):",
                appointment.id
              );
              return;
            }

            // Additional validation: ensure appointment is still in PENDING status
            if (apptStatus !== "PENDING") {
              console.warn(
                `[WEBHOOK] ⚠️ Cannot confirm appointment in ${apptStatus} status. Expected PENDING.`
              );
              return;
            }

            // Update appointment to CONFIRMED
            await tx.appointment.update({
              where: { id: appointment.id },
              data: {
                status: "CONFIRMED",
                paymentStatus: "SUCCESS",
                bookingProgress: null,
                notes: paymentId, // Store Razorpay Payment ID
              } as any,
            });

            console.log("[WEBHOOK] ✅ Appointment confirmed:", appointment.id);

            // Mark slot as booked if slot exists
            if (apptSlotId) {
              try {
                // Lock slot row to prevent concurrent bookings
                await tx.$queryRaw`
                  SELECT id
                  FROM "Slot"
                  WHERE id = ${apptSlotId}
                  FOR UPDATE
                `;

                await tx.slot.update({
                  where: { id: apptSlotId },
                  data: { isBooked: true },
                });
                console.log("[WEBHOOK] ✅ Slot marked as booked:", apptSlotId);
              } catch (slotError: any) {
                // Slot may already be booked (race condition) - log but don't fail
                console.warn(
                  "[WEBHOOK] ⚠️ Slot update failed (may already be booked):",
                  slotError.message
                );
              }
            }

            // Send WhatsApp notifications (outside transaction to avoid blocking)
            // Use setImmediate to ensure transaction completes first
            setImmediate(async () => {
              try {
                await sendWhatsAppNotifications(
                  appointment,
                  orderId,
                  paymentId
                );
                console.log(
                  "[WEBHOOK] ✅ WhatsApp notifications sent for appointment:",
                  appointment.id
                );
              } catch (whatsappError: any) {
                console.error(
                  "[WEBHOOK] ❌ WhatsApp notification failed (non-blocking):",
                  whatsappError.message
                );
              }
            });
          },
          {
            timeout: 10000, // 10 second timeout
            isolationLevel: "ReadCommitted", // Prevent dirty reads
          }
        );

        console.log(
          "[WEBHOOK] ✅ Payment captured event processed successfully"
        );
      } catch (transactionError: any) {
        console.error("[WEBHOOK] ❌ Transaction error:", transactionError);
        // If event was stored but processing failed, we still return success
        // to prevent Razorpay from retrying (idempotency)
        if (eventId) {
          const eventExists = await prisma.webhookEvent.findUnique({
            where: { eventId },
          });
          if (eventExists) {
            console.log(
              "[WEBHOOK] Event stored but processing failed - returning success for idempotency"
            );
            return res.json({
              success: true,
              message: "Event received but processing failed",
              eventId,
            });
          }
        }
        throw transactionError;
      }
    } else {
      console.log("[WEBHOOK] ⚠️ Unhandled event type:", eventType);
      // Store event for idempotency even if we don't process it
      if (eventId) {
        try {
          await prisma.webhookEvent.create({
            data: { eventId },
          });
        } catch (e) {
          // Event might already exist, ignore
        }
      }
    }

    // Return success immediately to acknowledge webhook receipt
    return res.json({
      success: true,
      message: "Webhook processed successfully",
      eventId,
      eventType,
    });
  } catch (err: any) {
    console.error("[WEBHOOK] ❌ Webhook handler error:", {
      message: err.message,
      stack: err.stack,
    });

    // Return 500 to allow Razorpay to retry
    return res.status(500).json({
      success: false,
      error: "Internal server error processing webhook",
    });
  }
}
