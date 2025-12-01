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
} from "../../services/whatsapp.service";

// Initialize Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

// Validate Razorpay configuration
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.error(
    "[PAYMENT] ERROR: Razorpay keys not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env"
  );
}

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

    // Validate Razorpay configuration
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      console.error("[PAYMENT] Razorpay not configured");
      return res.status(500).json({
        success: false,
        error: "Payment gateway not configured. Please contact support.",
      });
    }

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
    await prisma.$transaction(async (tx) => {
      // Double-check status hasn't changed
      const currentAppt = await tx.appointment.findUnique({
        where: { id: appointment.id },
        select: { status: true, slotId: true },
      });

      if (!currentAppt) {
        throw new Error("Appointment not found");
      }

      if (currentAppt.status === "CONFIRMED") {
        // Already confirmed, skip update
        return;
      }

      // Update appointment to CONFIRMED and store payment details
      // Note: paymentId field stores Razorpay Order ID (orderId)
      //       notes field stores Razorpay Payment ID (paymentId)
      await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          status: "CONFIRMED",
          paymentStatus: "SUCCESS",
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
      if (currentAppt.slotId) {
        try {
          const updatedSlot = await tx.slot.update({
            where: { id: currentAppt.slotId },
            data: { isBooked: true },
          });
          console.log("==========================================");
          console.log("[PAYMENT SUCCESS] ✅ Slot Marked as Booked:");
          console.log("  Slot ID:", currentAppt.slotId);
          console.log("  Slot isBooked:", updatedSlot.isBooked);
          console.log("  Slot Start Time:", updatedSlot.startAt);
          console.log("  Slot Mode:", updatedSlot.mode);
          console.log("==========================================");
        } catch (slotError: any) {
          // Slot may already be booked (race condition) - log but don't fail
          console.warn(
            "[PAYMENT] Slot update failed (may already be booked):",
            slotError.message
          );
          // Still log the slot ID for debugging
          console.log("[PAYMENT] Attempted to book slot:", currentAppt.slotId);
        }
      } else {
        console.log(
          "[PAYMENT] No slot ID found for appointment - skipping slot booking"
        );
      }
    });

    console.log(
      "[PAYMENT] Appointment CONFIRMED via verify API:",
      appointment.id
    );

    // Send WhatsApp notifications after successful payment confirmation
    // This runs outside the transaction to avoid blocking payment confirmation
    try {
      await sendWhatsAppNotifications(appointment, orderId, paymentId);
    } catch (whatsappError: any) {
      // Log error but don't fail the payment confirmation
      console.error(
        "[PAYMENT] WhatsApp notification failed (non-blocking):",
        whatsappError.message
      );
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
 * Send WhatsApp notifications to patient and doctor after payment confirmation
 * This is called after payment is verified and appointment is confirmed
 */
async function sendWhatsAppNotifications(
  appointment: any,
  orderId: string,
  paymentId: string
) {
  try {
    console.log("[WHATSAPP] Sending confirmation notifications...");

    // Get patient phone number
    const patientPhone = appointment.patient?.phone;
    if (!patientPhone) {
      console.warn(
        "[WHATSAPP] Patient phone not found, skipping patient notification"
      );
    } else {
      // Send patient confirmation message
      // Note: body_1 is automatically set to patient phone number (type: "numbers") in sendPatientConfirmationMessage
      const patientResult = await sendPatientConfirmationMessage(patientPhone);

      if (patientResult.success) {
        console.log("[WHATSAPP] ✅ Patient notification sent:", patientPhone);
      } else {
        console.error(
          "[WHATSAPP] ❌ Patient notification failed:",
          patientResult.error
        );
      }
    }

    // Get doctor phone number
    const doctorPhone = appointment.doctor?.phone;
    if (!doctorPhone) {
      // Fallback: get admin phone from getSingleAdmin
      try {
        const admin = await getSingleAdmin();
        const adminPhone = admin.phone;

        if (adminPhone) {
          const doctorResult = await sendDoctorNotificationMessage(adminPhone);
          if (doctorResult.success) {
            console.log("[WHATSAPP] ✅ Doctor notification sent:", adminPhone);
          } else {
            console.error(
              "[WHATSAPP] ❌ Doctor notification failed:",
              doctorResult.error
            );
          }
        } else {
          console.warn(
            "[WHATSAPP] Doctor phone not found, skipping doctor notification"
          );
        }
      } catch (adminError: any) {
        console.error(
          "[WHATSAPP] Failed to get admin phone:",
          adminError.message
        );
      }
    } else {
      const doctorResult = await sendDoctorNotificationMessage(doctorPhone);
      if (doctorResult.success) {
        console.log("[WHATSAPP] ✅ Doctor notification sent:", doctorPhone);
      } else {
        console.error(
          "[WHATSAPP] ❌ Doctor notification failed:",
          doctorResult.error
        );
      }
    }

    console.log("[WHATSAPP] Notification process completed");
  } catch (error: any) {
    console.error("[WHATSAPP] Error sending notifications:", error);
    throw error;
  }
}

// Webhook handler (kept for reference but not used in current flow)
export async function razorpayWebhookHandler(req: Request, res: Response) {
  // This is kept for future use but not actively used in the current payment flow
  // The payment verification is handled via verifyPaymentHandler instead
  return res.json({
    success: true,
    message: "Webhook received (not processed)",
  });
}
