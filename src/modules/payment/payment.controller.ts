import { Request, Response } from "express";
import crypto from "crypto";
import Razorpay from "razorpay";
import prisma from "../../database/prismaclient";
import { getSingleAdminId } from "../slots/slots.services";
import { PLANS, PlanSlug } from "../../constants/plan";
import { AppointmentMode, Prisma } from "@prisma/client";
import {
  sendBookingConfirmationMessage,
  sendLastMinuteConfirmationMessage,
  sendDoctorNotificationMessage,
  formatDateForTemplate,
  formatTimeForTemplate,
} from "../../services/whatsapp.service";
// Invoice generation is now manual (removed automatic generation)
import {
  paymentService,
  PaymentStatus,
  isValidTransition,
  normalizePaymentStatus,
} from "./payment.service";

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
 * COMPREHENSIVE DUPLICATE CLEANUP
 * Archives all PENDING appointments that match the same logical booking
 * Matches by: userId, patientId, startAt (slotTime), planSlug
 * This ensures only ONE active appointment exists per booking
 */
export async function archiveDuplicatePendingAppointments(
  tx: Prisma.TransactionClient,
  confirmedAppointmentId: string,
  confirmedAppointment: {
    userId: string;
    patientId: string;
    startAt: Date | string;
    planSlug: string;
  }
) {
  // Build comprehensive where clause for duplicate detection
  // Match by: userId, patientId, startAt (slotTime), planSlug
  const duplicateWhere: Prisma.AppointmentWhereInput = {
    userId: confirmedAppointment.userId,
    patientId: confirmedAppointment.patientId,
    startAt: new Date(confirmedAppointment.startAt),
    planSlug: confirmedAppointment.planSlug,
    status: "PENDING",
    id: { not: confirmedAppointmentId }, // Exclude the one we just confirmed
    isArchived: false, // Only archive active appointments
  };

  const duplicatePendingAppointments = await tx.appointment.findMany({
    where: duplicateWhere,
    select: { id: true },
  });

  if (duplicatePendingAppointments.length > 0) {
    // console.log(
    //   `[DUPLICATE CLEANUP] 🧹 Archiving ${duplicatePendingAppointments.length} duplicate PENDING appointment(s) for the same booking`,
    //   {
    //     userId: confirmedAppointment.userId,
    //     patientId: confirmedAppointment.patientId,
    //     startAt: confirmedAppointment.startAt,
    //     planSlug: confirmedAppointment.planSlug,
    //   }
    // );

    await tx.appointment.updateMany({
      where: {
        id: {
          in: duplicatePendingAppointments.map((apt) => apt.id),
        },
      },
      data: {
        isArchived: true,
        archivedAt: new Date(),
      },
    });

    // console.log(
    //   `[DUPLICATE CLEANUP] ✅ Archived duplicate appointments:`,
    //   duplicatePendingAppointments.map((apt) => apt.id)
    // );
  }

  return duplicatePendingAppointments.length;
}

/**
 * Create Razorpay order for an existing appointment
 * This is the main flow: appointment is created in recall flow, then order is created here
 */
/**
 * Create Razorpay order for an appointment
 * Production-grade implementation with:
 * - Transaction safety (no external API calls in transactions)
 * - Payment state machine validation
 * - Idempotency and retry safety
 * - Comprehensive error handling and logging
 */
export async function createOrderHandler(req: Request, res: Response) {
  const requestId = `req_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 9)}`;
  const startTime = Date.now();

  try {
    // console.log(`[PAYMENT:${requestId}] Create order request received`);
    const userId = req.user?.id;
    if (!userId) {
      console.error(`[PAYMENT:${requestId}] Unauthenticated request`);
      return res.status(401).json({
        success: false,
        error: "Unauthenticated. Please login again.",
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

    // console.log(`[PAYMENT:${requestId}] Request body:`, {
    // appointmentId: appointmentId || "none",
    // slotId: slotId || "none",
    // planSlug: planSlug || "none",
    // userId,
    // });
    let appointment: any;

    // NEW FLOW: Use existing appointment (created in recall flow)
    if (appointmentId) {
      // console.log(
      // `[PAYMENT:${requestId}] NEW FLOW: Using existing appointment:`,
      // appointmentId
      // );
      // ============================================================
      // STEP 1: Validate appointment and existing payment state (OUTSIDE transaction)
      // ============================================================
      const validationResult =
        await paymentService.validateAppointmentForPayment(
          appointmentId,
          userId
        );

      if (!validationResult.canProceed) {
        console.error(
          `[PAYMENT:${requestId}] Validation failed:`,
          validationResult.error
        );
        return res
          .status(
            validationResult.error?.includes("not found")
              ? 404
              : validationResult.error?.includes("booked")
              ? 409
              : 400
          )
          .json({
            success: false,
            error: validationResult.error || "Validation failed",
          });
      }

      const existingAppt = validationResult.appointment;
      const planPrice = existingAppt.planPrice;

      // ============================================================
      // STEP 2: Check payment status in database first (source of truth)
      // ============================================================
      const dbPaymentStatus = normalizePaymentStatus(
        (existingAppt as any).paymentStatus
      );

      // console.log(`[PAYMENT:${requestId}] Payment status check:`, {
      // appointmentId: existingAppt.id,
      // dbPaymentStatus,
      // appointmentStatus: existingAppt.status,
      // paymentId: existingAppt.paymentId,
      // });
      // If payment is already PAID in our database, return error
      if (
        dbPaymentStatus === PaymentStatus.PAID ||
        existingAppt.status === "CONFIRMED"
      ) {
        // console.log(
        // `[PAYMENT:${requestId}] Payment already completed in database`
        // );
        return res.status(400).json({
          success: false,
          error: "Payment already completed for this appointment.",
        });
      }

      // ============================================================
      // STEP 3: Check existing order in Razorpay (OUTSIDE transaction)
      // ============================================================
      const orderCheck = await paymentService.checkExistingOrder(
        existingAppt.paymentId,
        dbPaymentStatus // Pass DB payment status to handle inconsistencies
      );

      if (orderCheck.error && orderCheck.error !== "PAYMENT_STATUS_MISMATCH") {
        console.error(
          `[PAYMENT:${requestId}] Order check error:`,
          orderCheck.error
        );
        return res.status(400).json({
          success: false,
          error: orderCheck.error,
        });
      }

      // Handle payment status mismatch (Razorpay says paid, but DB says PENDING)
      // This can happen due to webhook delays or failures
      if (orderCheck.error === "PAYMENT_STATUS_MISMATCH") {
        // console.warn(
        // `[PAYMENT:${requestId}] ⚠️ Payment status mismatch detected - Razorpay says paid but DB says PENDING`
        // );
        // Allow user to retry - the verifyPayment/webhook will sync the status
        // For now, expire the old order and create a new one
        orderCheck.shouldExpire = true;
      }

      if (orderCheck.shouldReuse && orderCheck.order) {
        // console.log(
        // `[PAYMENT:${requestId}] ✅ Reusing existing valid order:`,
        // orderCheck.order.id
        // );
        return res.json({
          success: true,
          order: {
            id: orderCheck.order.id,
            amount: orderCheck.order.amount,
            currency: orderCheck.order.currency,
            receipt: orderCheck.order.receipt,
            status: orderCheck.order.status,
          },
          appointmentId: existingAppt.id,
        });
      }

      // ============================================================
      // STEP 3: Mark old order as expired if needed (SHORT transaction - only DB operations)
      // ============================================================
      if (orderCheck.shouldExpire && existingAppt.paymentId) {
        // console.log(
        // `[PAYMENT:${requestId}] Expiring old order:`,
        // existingAppt.paymentId
        // );
        const txStart = Date.now();
        try {
          await paymentService.expireOldOrder(appointmentId);
          // console.log(
          // `[PAYMENT:${requestId}] ✅ Expired old order in ${
          // Date.now()
          // - txStart
          // }ms`
          // );
        } catch (expireError: any) {
          console.error(
            `[PAYMENT:${requestId}] ⚠️ Failed to expire old order (non-critical):`,
            {
              error: expireError.message,
              code: expireError.code,
            }
          );
          // Continue - this is non-critical, we'll create a new order anyway
        }
      }

      // ============================================================
      // STEP 4: Create Razorpay order (OUTSIDE transaction - external API call)
      // ============================================================
      const amountInPaise = Math.round(planPrice * 100);
      // console.log(`[PAYMENT:${requestId}] Creating Razorpay order:`, {
      // amountInPaise,
      // planPrice,
      // appointmentId: existingAppt.id,
      // });
      let order;
      try {
        order = await paymentService.createRazorpayOrder({
          amount: amountInPaise,
          appointmentId: existingAppt.id,
          planSlug: existingAppt.planSlug,
          planName: existingAppt.planName,
          userId,
        });
        // console.log(
        //   `[PAYMENT:${requestId}] ✅ Razorpay order created:`,
        //   order.id
        // );
      } catch (razorpayError: any) {
        console.error(
          `[PAYMENT:${requestId}] ❌ Razorpay order creation failed:`,
          {
            error: razorpayError?.error?.description || razorpayError.message,
            code: razorpayError?.error?.code,
          }
        );
        return res.status(500).json({
          success: false,
          error: "Something went wrong",
        });
      }

      // ============================================================
      // STEP 5: Link order to appointment (SHORT transaction - only DB operations)
      // ============================================================
      const txStart = Date.now();
      try {
        await paymentService.linkOrderToAppointment(
          appointmentId,
          order.id,
          planPrice
        );
        // console.log(
        // `[PAYMENT:${requestId}] ✅ Linked order to appointment in ${
        // Date.now()
        // - txStart
        // }ms`
        // );
      } catch (updateError: any) {
        console.error(
          `[PAYMENT:${requestId}] ❌ Failed to link order (took ${
            Date.now() - txStart
          }ms):`,
          {
            error: updateError.message,
            code: updateError.code,
          }
        );

        if (
          updateError instanceof Prisma.PrismaClientKnownRequestError &&
          updateError.code === "P2028"
        ) {
          console.error(
            `[PAYMENT:${requestId}] Transaction timeout - database is locked or overloaded`
          );
        }

        // Order was created but appointment update failed - this is a critical error
        // In production, you might want to cancel the Razorpay order here
        return res.status(500).json({
          success: false,
          error:
            "Failed to link payment order to appointment. Please try again in a moment.",
        });
      }

      const totalTime = Date.now() - startTime;
      // console.log(
      // `[PAYMENT:${requestId}] ✅ Order created successfully in ${totalTime}ms:`,
      // {
      // orderId: order.id,
      // amount: order.amount,
      // currency: order.currency,
      // appointmentId,
      // duration: `${totalTime}ms`,
      // }
      // );
      return res.json({
        success: true,
        order: {
          id: order.id,
          amount: order.amount, // Already in paise from Razorpay
          currency: order.currency,
          receipt: order.receipt,
          status: order.status,
        },
        appointmentId: appointmentId,
      });
    }

    // OLD FLOW: Create new appointment (for backward compatibility - not recommended)
    // This flow is deprecated - use appointmentId flow instead
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

    // ============================================================
    // STEP 1: Validate inputs (OUTSIDE transaction)
    // ============================================================
    const [patient, slot] = await Promise.all([
      prisma.patientDetials.findFirst({
        where: { id: patientId, userId },
      }),
      prisma.slot.findUnique({ where: { id: slotId } }),
    ]);

    if (!patient) {
      return res.status(403).json({
        success: false,
        error: "Patient does not belong to current user",
      });
    }

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

    // Compare slot time (UTC from database) with current time (UTC)
    // Both are UTC internally, so direct comparison is correct
    if (slot.startAt <= new Date()) {
      return res.status(400).json({
        success: false,
        error: "Slot is in the past",
      });
    }

    // CRITICAL: Check if appointment already exists (OUTSIDE transaction)
    // Match by: userId, patientId, slotId, startAt (date), planSlug, and status
    // This ensures we reuse the same pending appointment instead of creating duplicates
    // PRIORITY: Check for PENDING appointments first, then CONFIRMED
    const existingPendingAppointment = await prisma.appointment.findFirst({
      where: {
        slotId: slot.id,
        patientId: patientId,
        userId: userId,
        startAt: slot.startAt, // Also match by date to prevent duplicates for same slot on different dates
        planSlug: planSlug, // Match by plan to prevent mixing different plans
        status: "PENDING", // Only check for PENDING appointments
        isArchived: false,
      },
      include: {
        patient: true,
        slot: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // Also check for CONFIRMED appointments to prevent creating duplicates
    const existingConfirmedAppointment = await prisma.appointment.findFirst({
      where: {
        slotId: slot.id,
        patientId: patientId,
        userId: userId,
        startAt: slot.startAt,
        planSlug: planSlug,
        status: "CONFIRMED",
        isArchived: false,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // Use pending appointment if found, otherwise check confirmed
    const existingAppointment =
      existingPendingAppointment || existingConfirmedAppointment;

    if (existingAppointment) {
      // console.log(
      // "[PAYMENT] ⚠️ Appointment already exists for this slot/patient. Using existing appointment:",
      // existingAppointment.id,
      // {
      // status: existingAppointment.status,
      // slotId: slot.id,
      // patientId: patientId,
      // startAt: slot.startAt,
      // planSlug: planSlug,
      // }
      // );
      if (existingAppointment.status === "CONFIRMED") {
        // console.log(
        // "[PAYMENT] ⚠️ CONFIRMED appointment already exists - cannot create payment order for confirmed appointment"
        // );
        return res.status(400).json({
          success: false,
          error:
            "Appointment is already confirmed. Please use the existing appointment.",
        });
      }

      // Use the existing PENDING appointment - never create a new one
      appointment = existingAppointment;
      // console.log(
      // "[PAYMENT] ✅ Reusing existing PENDING appointment:",
      // appointment.id
      // );
      // Check if existing appointment has a valid order
      if (appointment.paymentId && appointment.paymentId.startsWith("order_")) {
        try {
          const existingOrder = await razorpay.orders.fetch(
            appointment.paymentId
          );
          const orderCreatedAt = existingOrder.created_at * 1000;
          const hoursSinceCreation =
            (Date.now() - orderCreatedAt) / (1000 * 60 * 60);

          if (hoursSinceCreation <= 24 && existingOrder.status === "created") {
            return res.json({
              success: true,
              order: {
                id: existingOrder.id,
                amount: existingOrder.amount,
                currency: existingOrder.currency,
                receipt: existingOrder.receipt,
                status: existingOrder.status,
              },
              appointmentId: appointment.id,
            });
          }
        } catch (error: any) {
          console.error("[PAYMENT] Failed to fetch existing order:", error);
          // Continue to create new order
        }
      }
    }

    // ============================================================
    // STEP 2: Create Razorpay order (OUTSIDE transaction)
    // ============================================================
    const amountInPaise = Math.round(plan.price * 100);
    const receipt = `rcpt_${Date.now()}`;

    let order;
    try {
      order = await razorpay.orders.create({
        amount: amountInPaise,
        currency: "INR",
        receipt: receipt,
        notes: {
          slotId: slot.id,
          patientId: patientId,
          userId: userId,
          planSlug: planSlug,
        },
      });
      // console.log("[PAYMENT] ✅ Razorpay order created:", order.id);
    } catch (razorpayError: any) {
      console.error("[PAYMENT] Razorpay order creation failed:", razorpayError);
      return res.status(500).json({
        success: false,
        error:
          razorpayError?.error?.description || "Failed to create payment order",
      });
    }

    // ============================================================
    // STEP 3: Create or update appointment (SHORT transaction)
    // ============================================================
    const txStart = Date.now();
    try {
      if (appointment) {
        // Update existing appointment
        await prisma.$transaction(
          async (tx) => {
            await tx.appointment.update({
              where: { id: appointment.id },
              data: {
                paymentId: order.id,
                amount: plan.price,
                paymentStatus: "PENDING",
              } as any,
            });
          },
          {
            timeout: 3000,
            maxWait: 2000,
          }
        );
      } else {
        // CRITICAL: This should NEVER happen if duplicate detection is working correctly
        // But add triple-check to prevent creating duplicates due to race conditions
        // console.warn(
        // "[PAYMENT] ⚠️ No existing appointment found - performing final check before creating"
        // );
        const finalCheckAppointment = await prisma.appointment.findFirst({
          where: {
            OR: [
              // Check by slotId, patientId, userId, startAt, planSlug
              {
                slotId: slot.id,
                patientId: patientId,
                userId: userId,
                startAt: slot.startAt,
                planSlug: planSlug,
                isArchived: false,
              },
              // Also check without slotId (for appointments without slots)
              {
                patientId: patientId,
                userId: userId,
                startAt: slot.startAt,
                planSlug: planSlug,
                status: "PENDING",
                isArchived: false,
              },
            ],
          },
          orderBy: {
            createdAt: "desc",
          },
        });

        if (finalCheckAppointment) {
          // console.log(
          // "[PAYMENT] ✅ Found existing appointment on final check, reusing:",
          // finalCheckAppointment.id,
          // {
          // status: finalCheckAppointment.status,
          // slotId: finalCheckAppointment.slotId,
          // }
          // );
          if (finalCheckAppointment.status === "CONFIRMED") {
            return res.status(400).json({
              success: false,
              error:
                "Appointment is already confirmed. Please use the existing appointment.",
            });
          }

          appointment = finalCheckAppointment;
          // Update existing appointment with payment info
          await prisma.$transaction(
            async (tx) => {
              await tx.appointment.update({
                where: { id: appointment.id },
                data: {
                  paymentId: order.id,
                  amount: plan.price,
                  paymentStatus: "PENDING",
                  // Ensure slotId is set if it wasn't before
                  slotId: slot.id,
                  startAt: slot.startAt,
                  endAt: slot.endAt,
                  mode: modeEnum,
                } as any,
              });
            },
            {
              timeout: 3000,
              maxWait: 2000,
            }
          );
        } else {
          // Only create new appointment if absolutely no existing appointment found
          // This should be rare - most appointments should be created via createAppointmentHandler
          // console.log(
          // "[PAYMENT] Creating new PENDING appointment (OLD FLOW - should use appointmentId flow instead)
          // "
          // );
          const doctorId = await getSingleAdminId();
          appointment = await prisma.$transaction(
            async (tx) => {
              return await tx.appointment.create({
                data: {
                  userId,
                  doctorId,
                  patientId,
                  slotId: slot.id,
                  startAt: slot.startAt,
                  endAt: slot.endAt,
                  paymentId: order.id,
                  amount: plan.price,
                  status: "PENDING", // Always create as PENDING
                  mode: modeEnum,
                  planSlug,
                  planName: plan.name,
                  planPrice: plan.price,
                  planDuration: plan.duration,
                  planPackageName: plan.packageName,
                },
              });
            },
            {
              timeout: 3000,
              maxWait: 2000,
            }
          );
        }
      }
      // console.log(
      // `[PAYMENT] ✅ ${appointment ? "Updated" : "Created"} appointment in ${
      // Date.now()
      // - txStart
      // }ms`
      // );
    } catch (err: any) {
      console.error(
        `[PAYMENT] ❌ Failed to ${
          appointment ? "update" : "create"
        } appointment (took ${Date.now() - txStart}ms):`,
        err
      );

      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2028"
      ) {
        console.error(
          "[PAYMENT] Transaction timeout - database is locked or overloaded"
        );
      }

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
    const totalTime = Date.now() - startTime;
    if (process.env.NODE_ENV !== "production") {
      console.error(
        `[PAYMENT:${requestId}] ❌ Create order error (${totalTime}ms):`,
        {
          message: err.message,
          code: err.code,
          name: err.name,
          stack: err.stack?.split("\n")[0], // Only log first line of stack
        }
      );
    } else {
      console.error(
        `[PAYMENT:${requestId}] ❌ Create order error (${totalTime}ms):`,
        {
          message: err.message,
          code: err.code,
          name: err.name,
        }
      );
    }

    // Handle Prisma errors
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2002") {
        return res.status(409).json({
          success: false,
          error: "Slot already booked",
        });
      }
      if (err.code === "P2028") {
        return res.status(503).json({
          success: false,
          error: "Database operation timed out. Please try again in a moment.",
        });
      }
    }

    // Handle network/API errors
    if (err.code === "ETIMEDOUT" || err.code === "ECONNRESET") {
      return res.status(503).json({
        success: false,
        error: "Payment service temporarily unavailable. Please try again.",
      });
    }

    return res.status(500).json({
      success: false,
      error:
        "An unexpected error occurred. Please try again or contact support.",
    });
  }
}

/**
 * Verify Razorpay payment signature and confirm appointment
 * Production-grade implementation with:
 * - Payment state machine validation
 * - Idempotency checks
 * - Row-level locking for concurrency safety
 * - Proper error handling
 */
export async function verifyPaymentHandler(req: Request, res: Response) {
  const requestId = `req_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 9)}`;
  const startTime = Date.now();

  try {
    // console.log(`[PAYMENT:${requestId}] Verify payment request received`);
    const userId = req.user?.id;
    if (!userId) {
      console.error(
        `[PAYMENT:${requestId}] Unauthenticated verification request`
      );
      return res.status(401).json({
        success: false,
        error: "Unauthenticated. Please login again.",
      });
    }

    const { orderId, paymentId, signature } = req.body;

    if (!orderId || !paymentId || !signature) {
      console.error(`[PAYMENT:${requestId}] Missing verification fields`);
      return res.status(400).json({
        success: false,
        error: "Missing required fields: orderId, paymentId, signature",
      });
    }

    // console.log(`[PAYMENT:${requestId}] Payment verification request:`, {
    // orderId,
    // paymentId,
    // userId,
    // });
    // CRITICAL: Verify Razorpay signature before proceeding
    // Signature verification ensures payment data integrity
    // If signature is invalid, payment is REJECTED and appointment remains PENDING
    // NOTE: If Razorpay keys were changed, signatures from orders created with old keys will fail
    let isValidSignature = false;
    try {
      isValidSignature = paymentService.verifyPaymentSignature(
        orderId,
        paymentId,
        signature,
        process.env.RAZORPAY_KEY_SECRET!
      );
    } catch (sigError: any) {
      console.error(
        `[PAYMENT:${requestId}] ❌ Signature verification error:`,
        sigError.message
      );
      return res.status(400).json({
        success: false,
        error: "Payment signature verification failed. Please contact support.",
      });
    }

    if (!isValidSignature) {
      console.error(
        `[PAYMENT:${requestId}] ❌ Signature mismatch - Payment verification REJECTED`
      );
      console.error(`[PAYMENT:${requestId}] Order ID: ${orderId}`);
      console.error(`[PAYMENT:${requestId}] Payment ID: ${paymentId}`);
      console.error(
        `[PAYMENT:${requestId}] ❌ Appointment remains PENDING - payment signature invalid`
      );
      console.error(
        `[PAYMENT:${requestId}] NOTE: If you recently changed Razorpay keys, old orders may fail signature verification`
      );
      return res.status(400).json({
        success: false,
        error:
          "Invalid payment signature. Please try creating a new payment order.",
      });
    }

    // console.log(`[PAYMENT:${requestId}] ✅ Signature verified successfully`);
    // Find appointment by payment order ID
    let appointment = await paymentService.findAppointmentByOrderId(
      orderId,
      userId
    );

    if (!appointment) {
      console.error(
        `[PAYMENT:${requestId}] Appointment not found for order:`,
        orderId
      );
      return res.status(404).json({
        success: false,
        error: "Appointment not found for this payment order",
      });
    }

    const currentPaymentStatus = normalizePaymentStatus(
      (appointment as any).paymentStatus
    );

    // console.log(`[PAYMENT:${requestId}] Appointment found:`, {
    // id: appointment.id,
    // currentStatus: appointment.status,
    // paymentStatus: currentPaymentStatus,
    // });
    // Idempotency check: if already confirmed, return success
    if (appointment.status === "CONFIRMED") {
      // console.log(
      // `[PAYMENT:${requestId}] ✅ Appointment already confirmed (idempotent)
      // `
      // );
      return res.json({
        success: true,
        alreadyConfirmed: true,
        message: "Payment already verified and appointment confirmed",
      });
    }

    // Validate state transition
    if (!isValidTransition(currentPaymentStatus, PaymentStatus.PAID)) {
      console.error(`[PAYMENT:${requestId}] ❌ Invalid state transition:`, {
        from: currentPaymentStatus,
        to: PaymentStatus.PAID,
      });
      return res.status(400).json({
        success: false,
        error: `Cannot transition payment from ${currentPaymentStatus} to PAID`,
      });
    }

    // CRITICAL: Update appointment status ONLY in a transaction with row-level locking
    // This ensures:
    // 1. Appointment is confirmed ONLY after successful verification
    // 2. Race conditions are prevented (webhook + API both calling)
    // 3. Idempotency - if already confirmed, no duplicate updates
    // 4. If transaction fails or times out, appointment remains PENDING
    // console.log(
    // `[PAYMENT:${requestId}] Starting transaction for appointment confirmation:`,
    // appointment.id
    // );
    const transactionStartTime = Date.now();

    try {
      await prisma.$transaction(async (tx) => {
        // console.log(
        // `[PAYMENT:${requestId}] Transaction started (${
        // Date.now()
        // - transactionStartTime
        // }ms since request)`
        // );

        // Row-level locking to prevent concurrent updates
        const lockStartTime = Date.now();
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
        // console.log(
        // `[PAYMENT:${requestId}] Row lock acquired in ${
        // Date.now()
        // - lockStartTime
        // }ms`
        // );

        if (!lockedAppt || lockedAppt.length === 0) {
          throw new Error("Appointment not found during transaction");
        }

        const apptStatus = lockedAppt[0].status;
        const apptPaymentStatus = normalizePaymentStatus(
          lockedAppt[0].paymentStatus
        );
        const apptSlotId = lockedAppt[0].slotId;

        // Idempotency check - if already confirmed, return early
        if (apptStatus === "CONFIRMED") {
          // console.log(
          // `[PAYMENT:${requestId}] Appointment already confirmed (race condition prevented)
          // `
          // );
          return;
        }

        // Validate state transition
        if (!isValidTransition(apptPaymentStatus, PaymentStatus.PAID)) {
          console.error(`[PAYMENT:${requestId}] ❌ Invalid state transition:`, {
            from: apptPaymentStatus,
            to: PaymentStatus.PAID,
          });
          throw new Error(
            `Cannot transition payment from ${apptPaymentStatus} to PAID. Invalid state transition.`
          );
        }

        // Additional validation - ensure appointment is still in PENDING status
        if (apptStatus !== "PENDING") {
          throw new Error(
            `Cannot confirm appointment in ${apptStatus} status. Expected PENDING. Payment verification aborted.`
          );
        }

        // Update appointment to CONFIRMED with proper state transition
        await tx.appointment.update({
          where: { id: appointment.id },
          data: {
            status: "CONFIRMED",
            paymentStatus: PaymentStatus.PAID,
            bookingProgress: null,
            notes: paymentId, // Store Razorpay Payment ID
          } as any,
        });

        // console.log(
        // `[PAYMENT:${requestId}] ✅ Payment state transition: ${apptPaymentStatus} → ${PaymentStatus.PAID}`
        // );
        // CRITICAL: Archive any other PENDING appointments for the same logical booking
        // This prevents duplicate PENDING appointments from remaining after confirmation
        // Matches by: userId, patientId, startAt (slotTime), planSlug
        // Use the appointment object from earlier query (before transaction) which has all needed fields
        await archiveDuplicatePendingAppointments(tx, appointment.id, {
          userId: appointment.userId,
          patientId: appointment.patientId,
          startAt: appointment.startAt,
          planSlug: appointment.planSlug || "",
        });

        // console.log(`[PAYMENT:${requestId}] ✅ Payment verified and stored:`, {
        // appointmentId: appointment.id,
        // orderId,
        // paymentId,
        // paymentStatus: PaymentStatus.PAID,
        // appointmentStatus: "CONFIRMED",
        // });
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
            // console.log(`[PAYMENT:${requestId}] ✅ Slot marked as booked:`, {
            // slotId: apptSlotId,
            // isBooked: updatedSlot.isBooked,
            // });
          } catch (slotError: any) {
            // Slot may already be booked (race condition) - log but don't fail
            // This can happen if webhook processed payment before verifyPaymentHandler
            // console.warn(
            //   `[PAYMENT:${requestId}] ⚠️ Slot update failed (may already be booked):`,
            //   slotError.message
            // );
          }
        }
      });

      // console.log(
      //   `[PAYMENT:${requestId}] ✅ Appointment confirmed successfully`
      // );
    } catch (transactionError: any) {
      const transactionDuration = Date.now() - transactionStartTime;
      console.error(
        `[PAYMENT:${requestId}] ❌ Transaction failed (${transactionDuration}ms):`,
        {
          error: transactionError.message,
          code: transactionError.code,
        }
      );

      // If appointment was confirmed but transaction failed partway through,
      // we need to handle this gracefully
      if (
        transactionError instanceof Prisma.PrismaClientKnownRequestError &&
        transactionError.code === "P2028"
      ) {
        console.error(
          `[PAYMENT:${requestId}] Transaction timeout - database is locked or overloaded`
        );
      }

      throw transactionError;
    }

    // Return success response
    return res.json({
      success: true,
      message: "Payment verified and appointment confirmed",
      appointmentId: appointment.id,
    });
  } catch (err: any) {
    const totalTime = Date.now() - startTime;
    console.error(
      `[PAYMENT:${requestId}] ❌ Verify payment error (${totalTime}ms):`,
      {
        message: err.message,
        code: err.code,
        name: err.name,
      }
    );

    return res.status(500).json({
      success: false,
      error: "Something went wrong",
    });
  }
}

/**
 * Get existing payment order for an appointment
 * Used to resume payment if order already exists
 */
export async function getExistingOrderHandler(req: Request, res: Response) {
  try {
    // console.log("[PAYMENT] Get existing order request received");
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

    // console.log(
    // "[PAYMENT] Finding existing order for appointment:",
    // appointmentId
    // );
    // Find appointment with existing payment order
    const appointment = (await prisma.appointment.findFirst({
      where: {
        id: appointmentId,
        userId, // Ensure appointment belongs to the user
        isArchived: false, // Exclude archived appointments
      },
      select: {
        id: true,
        paymentId: true,
        planPrice: true,
        status: true,
        paymentStatus: true, // Include paymentStatus
      } as any,
    })) as any; // Type assertion to handle paymentStatus field

    if (!appointment) {
      console.error("[PAYMENT] Appointment not found or unauthorized");
      return res.status(404).json({
        success: false,
        error: "Appointment not found or unauthorized",
      });
    }

    // Check if appointment is already confirmed (database is source of truth)
    if (appointment.status === "CONFIRMED") {
      return res.status(400).json({
        success: false,
        error: "Appointment is already confirmed",
      });
    }

    // Check payment status in database first (source of truth)
    const dbPaymentStatus = normalizePaymentStatus(appointment.paymentStatus);
    if (dbPaymentStatus === PaymentStatus.PAID) {
      // console.log("[PAYMENT] Payment already completed in database");
      return res.status(400).json({
        success: false,
        error: "Payment already completed for this appointment.",
        shouldCreateNew: false,
      });
    }

    // Check if payment order exists
    if (!appointment.paymentId) {
      // console.log("[PAYMENT] No existing order found for appointment");
      return res.status(404).json({
        success: false,
        error: "No existing payment order found for this appointment",
      });
    }

    // console.log("[PAYMENT] Existing order found:", appointment.paymentId);
    // Fetch order details from Razorpay to get amount and currency
    let orderDetails;
    try {
      orderDetails = await razorpay.orders.fetch(appointment.paymentId);
      // console.log("[PAYMENT] Razorpay order status:", {
      // orderStatus: orderDetails.status,
      // dbPaymentStatus,
      // });
      // If Razorpay says paid but our DB says PENDING - data inconsistency
      // Allow retry (webhook/verifyPayment will sync the status)
      if (
        orderDetails.status === "paid" &&
        dbPaymentStatus === PaymentStatus.PENDING
      ) {
        // console.warn(
        // "[PAYMENT] ⚠️ Payment status mismatch - Razorpay says paid but DB says PENDING. Allowing retry."
        // );
        // Clear the order and allow creating a new one
        await prisma.appointment.update({
          where: { id: appointment.id },
          data: {
            paymentId: null,
            paymentStatus: PaymentStatus.PENDING,
          } as any,
        });
        return res.status(404).json({
          success: false,
          error:
            "Previous payment order status unclear. A new order will be created for you.",
          shouldCreateNew: true,
        });
      }

      // If Razorpay says paid and DB also says PAID (or confirmed), return error
      if (orderDetails.status === "paid") {
        // console.log("[PAYMENT] Order already paid in Razorpay and database");
        return res.status(400).json({
          success: false,
          error:
            "This payment order has already been completed. Please check your appointments.",
          shouldCreateNew: false,
        });
      }

      // Check if order has expired (Razorpay orders are valid for limited time)
      // Razorpay doesn't explicitly mark orders as "expired", but they become invalid after some time
      // We can check the created_at timestamp and reject orders older than 24 hours
      const orderCreatedAt = orderDetails.created_at * 1000; // Convert to milliseconds
      const now = Date.now();
      const hoursSinceCreation = (now - orderCreatedAt) / (1000 * 60 * 60);

      if (hoursSinceCreation > 24) {
        // console.warn(
        // `[PAYMENT] Order is ${hoursSinceCreation.toFixed(
        // 1
        // )
        // } hours old - likely expired`
        // );
        // Clear the expired paymentId from appointment so user can create new order
        await prisma.appointment.update({
          where: { id: appointment.id },
          data: {
            paymentId: null, // Clear expired order
            paymentStatus: "PENDING",
          } as any,
        });
        // console.log(
        // "[PAYMENT] Cleared expired order from appointment, user can create new order"
        // );
        return res.status(410).json({
          // 410 Gone
          success: false,
          error:
            "Your previous payment order has expired. A new order will be created for you.",
          shouldCreateNew: true, // Signal frontend to create new order
          expired: true,
        });
      }

      // Order is valid and can be used
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
        shouldCreateNew: false,
      });
    } catch (razorpayError: any) {
      console.error(
        "[PAYMENT] Failed to fetch order from Razorpay:",
        razorpayError.error?.description || razorpayError.message
      );

      // If order doesn't exist in Razorpay (might have been deleted/expired)
      // Clear it from appointment and allow creating new order
      // console.log(
      // "[PAYMENT] Order not found in Razorpay - clearing from appointment"
      // );
      await prisma.appointment.update({
        where: { id: appointment.id },
        data: {
          paymentId: null, // Clear invalid order
          paymentStatus: "PENDING",
        } as any,
      });

      return res.status(404).json({
        success: false,
        error:
          "Previous payment order not found. A new order will be created for you.",
        shouldCreateNew: true, // Signal frontend to create new order
      });
    }
  } catch (err: any) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[PAYMENT] Get existing order error:", {
        message: err.message,
        stack: err.stack,
      });
    } else {
      console.error("[PAYMENT] Get existing order error:", {
        message: err.message,
      });
    }
    return res.status(500).json({
      success: false,
      error: "Something went wrong",
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
    // console.log("==========================================");
    // console.log(
    // "[BOOKING CONFIRMATION] Processing appointment confirmation notifications..."
    // );
    // console.log("  Appointment ID:", appointment.id);
    // console.log("  Order ID:", orderId);
    // console.log("  Payment ID:", paymentId);
    // console.log("  Appointment Status: CONFIRMED");
    // console.log("==========================================");
    // Get appointment slot time (use slot.startAt or appointment.startAt)
    const slotStartTime = appointment.slot?.startAt || appointment.startAt;
    const slotEndTime = appointment.slot?.endAt || appointment.endAt;
    if (!slotStartTime) {
      console.error(
        "[BOOKING CONFIRMATION] ❌ Slot time not found, cannot send notifications"
      );
      return;
    }

    // slotStartTime and slotEndTime are UTC Date objects from database
    // All comparisons are done in UTC, which is correct since database stores UTC
    const slotTimeDate = new Date(slotStartTime);
    const slotEndTimeDate = slotEndTime ? new Date(slotEndTime) : undefined;
    const now = new Date(); // Current UTC time

    // Calculate reminder time (1 hour before slot time in UTC)
    // reminderTime is stored in UTC in database, so cron job can compare UTC times directly
    const reminderTime = new Date(slotTimeDate.getTime() - 60 * 60 * 1000); // -1 hour

    // console.log("  Slot Time:", slotTimeDate.toISOString()
    // );
    // console.log("  Reminder Time:", reminderTime.toISOString()
    // );
    // console.log("  Current Time:", now.toISOString()
    // );
    // console.log("==========================================");
    // Case C: Booking at or after slot time (invalid - should not happen)
    // Comparison is in UTC (both now and slotTimeDate are UTC)
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
      // console.warn(
      // "[BOOKING CONFIRMATION] ⚠️ Patient phone not found, skipping patient notification"
      // );
      // console.warn("  Patient Name:", patientName);
      // console.warn("  Patient ID:", appointment.patient?.id);
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
      // All comparisons are in UTC (reminderTime, now, and slotTimeDate are all UTC)
      if (reminderTime <= now && now < slotTimeDate) {
        // console.log("==========================================");
        // console.log(
        // "[BOOKING CONFIRMATION] Case B: Booking inside reminder window"
        // );
        // console.log("  Sending combined last-minute confirmation + reminder");
        // console.log("  Patient Name:", patientName);
        // console.log("  Patient Phone:", patientPhone);
        // console.log("==========================================");
        const result = await sendLastMinuteConfirmationMessage(
          patientPhone,
          slotTimeDate,
          patientName,
          slotEndTimeDate
        );

        if (result.success) {
          // console.log("==========================================");
          // console.log(
          // "[BOOKING CONFIRMATION] ✅ Last-minute confirmation sent successfully"
          // );
          // console.log("  Patient Phone:", patientPhone);
          // console.log("  Template: Last-minute combined");
          // console.log("==========================================");
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
        // console.log("==========================================");
        // console.log(
        // "[BOOKING CONFIRMATION] Case A: Booking well before reminder window"
        // );
        // console.log("  Sending booking confirmation only");
        // console.log("  Reminder will be sent later by cron job");
        // console.log("  Patient Name:", patientName);
        // console.log("  Patient Phone:", patientPhone);
        // console.log("==========================================");
        const result = await sendBookingConfirmationMessage(
          patientPhone,
          slotTimeDate,
          patientName,
          slotEndTimeDate
        );

        if (result.success) {
          // console.log("==========================================");
          // console.log(
          // "[BOOKING CONFIRMATION] ✅ Booking confirmation sent successfully"
          // );
          // console.log("  Patient Phone:", patientPhone);
          // console.log("  Template: Booking confirmation");
          // console.log("==========================================");
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

    // Send admin notification using doctor_confirmation template (fixed admin phone: 919713885582)
    // console.log("[WHATSAPP CONFIRMATION] Sending admin notification...");
    // console.log("  Admin Phone: 919713885582 (fixed)
    // ");
    // console.log("  Template: doctor_confirmation");
    try {
      // Prepare data for doctor notification
      const planName = appointment.planName || "Consultation Plan";
      const patientName = appointment.patient?.name || "Patient";
      const slotStartTime = appointment.slot?.startAt || appointment.startAt;
      const slotEndTime = appointment.slot?.endAt || appointment.endAt;

      // Format appointment date and slot time
      const appointmentDate = formatDateForTemplate(slotStartTime);
      const slotTimeFormatted = formatTimeForTemplate(
        slotStartTime,
        slotEndTime
      );

      const adminResult = await sendDoctorNotificationMessage(
        planName,
        patientName,
        appointmentDate,
        slotTimeFormatted
      );
      if (adminResult.success) {
        // console.log("==========================================");
        // console.log(
        // "[WHATSAPP CONFIRMATION] ✅ Admin notification sent successfully"
        // );
        // console.log("  Admin Phone: 919713885582");
        // console.log("  Template: doctor_confirmation");
        // console.log("==========================================");
      } else {
        console.error("==========================================");
        console.error("[WHATSAPP CONFIRMATION] ❌ Admin notification failed");
        console.error("  Admin Phone: 919713885582");
        console.error("  Error:", adminResult.error);
        console.error("==========================================");
      }
    } catch (error: any) {
      console.error("==========================================");
      console.error(
        "[WHATSAPP CONFIRMATION] ❌ Error sending admin notification"
      );
      console.error("  Error:", error.message);
      if (process.env.NODE_ENV !== "production") {
        console.error("  Stack:", error.stack);
      }
      console.error("==========================================");
    }

    // console.log("[WHATSAPP CONFIRMATION] ✅ Notification process completed");
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
    // console.log("[WEBHOOK] Razorpay webhook received");
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

    // console.log("[WEBHOOK] ✅ Signature verified successfully");
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

    // console.log("[WEBHOOK] Event Details:", {
    // eventType,
    // eventId,
    // timestamp: new Date()
    // .toISOString(),
    // });

    // Check for idempotency - prevent processing same event twice
    if (eventId) {
      const existingEvent = await prisma.webhookEvent.findUnique({
        where: { eventId },
      });

      if (existingEvent) {
        // console.log(
        // "[WEBHOOK] ⚠️ Event already processed (idempotency check)
        // :",
        // eventId
        // );
        return res.json({
          success: true,
          message: "Event already processed",
          eventId,
        });
      }
    }

    // Process payment.captured event
    if (eventType === "payment.captured") {
      // console.log("[WEBHOOK] Processing payment.captured event");
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

      // console.log("[WEBHOOK] Payment Details:", {
      // orderId,
      // paymentId,
      // paymentStatus,
      // amount: paymentEntity.amount,
      // currency: paymentEntity.currency,
      // });
      if (!orderId || !paymentId) {
        // console.error("[WEBHOOK] ❌ Missing orderId or paymentId");
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
            let appointment: Awaited<
              ReturnType<typeof tx.appointment.findFirst>
            > = await tx.appointment.findFirst({
              where: {
                paymentId: orderId,
                isArchived: false, // Only check non-archived appointments
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

            // CRITICAL FALLBACK: If appointment not found by paymentId, check via order notes
            if (!appointment) {
              // console.warn(
              // "[WEBHOOK] ⚠️ Appointment not found by paymentId, checking order notes..."
              // );
              try {
                const razorpayOrder = await razorpay.orders.fetch(orderId);
                const appointmentIdFromNotes =
                  razorpayOrder.notes?.appointmentId;

                if (appointmentIdFromNotes) {
                  const foundAppointment = await tx.appointment.findFirst({
                    where: {
                      id: String(appointmentIdFromNotes),
                      isArchived: false,
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

                  if (
                    foundAppointment &&
                    foundAppointment.status === "PENDING"
                  ) {
                    appointment = foundAppointment;
                    // Link the paymentId to this appointment if it's not already set
                    if (!appointment.paymentId) {
                      await tx.appointment.update({
                        where: { id: appointment.id },
                        data: { paymentId: orderId },
                      });
                      // console.log(
                      //   `[WEBHOOK] ✅ Linked paymentId ${orderId} to appointment ${appointment.id}`
                      // );
                    }
                  }
                }
              } catch (fetchError: any) {
                console.error(
                  "[WEBHOOK] Failed to fetch Razorpay order for fallback:",
                  fetchError
                );
              }
            }

            if (!appointment) {
              // console.warn(
              //   "[WEBHOOK] ⚠️ Appointment not found for order:",
              //   orderId
              // );
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
              // console.log(
              // "[WEBHOOK] ⚠️ Appointment already confirmed (race condition prevented)
              // :",
              // appointment.id
              // );
              return;
            }

            // Additional validation: ensure appointment is still in PENDING status
            if (apptStatus !== "PENDING") {
              // console.warn(
              //   `[WEBHOOK] ⚠️ Cannot confirm appointment in ${apptStatus} status. Expected PENDING.`
              // );
              return;
            }

            // CRITICAL: Update appointment to CONFIRMED ONLY after payment.captured event
            // This is the FINAL AUTHORITY for payment confirmation
            // Webhook ensures payment is confirmed even if verifyPaymentHandler times out
            // Use PaymentStatus.PAID (not "SUCCESS") for consistency with state machine
            await tx.appointment.update({
              where: { id: appointment.id },
              data: {
                status: "CONFIRMED",
                paymentStatus: PaymentStatus.PAID,
                bookingProgress: null,
                notes: paymentId, // Store Razorpay Payment ID
              } as any,
            });

            // console.log(
            //   `[WEBHOOK] ✅ Appointment CONFIRMED via webhook: ${appointment.id}`
            // );
            // CRITICAL: Archive any other PENDING appointments for the same logical booking
            // This prevents duplicate PENDING appointments from remaining after confirmation
            // Matches by: userId, patientId, startAt (slotTime), planSlug
            const confirmedAppt = await tx.appointment.findUnique({
              where: { id: appointment.id },
              select: {
                userId: true,
                patientId: true,
                startAt: true,
                planSlug: true,
              },
            });

            if (confirmedAppt) {
              await archiveDuplicatePendingAppointments(
                tx,
                appointment.id,
                confirmedAppt
              );
            }

            // console.log("[WEBHOOK] ✅ Appointment confirmed:", appointment.id);
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
                // console.log("[WEBHOOK] ✅ Slot marked as booked:", apptSlotId);
              } catch (slotError: any) {
                // Slot may already be booked (race condition) - log but don't fail
                // console.warn(
                //   "[WEBHOOK] ⚠️ Slot update failed (may already be booked):",
                //   slotError.message
                // );
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
                // console.log(
                //   "[WEBHOOK] ✅ WhatsApp notifications sent for appointment:",
                //   appointment.id
                // );
              } catch (whatsappError: any) {
                console.error(
                  "[WEBHOOK] ❌ WhatsApp notification failed (non-blocking):",
                  whatsappError.message
                );
              }

              // NOTE: Invoice generation is now manual - users can generate it from the appointment details page
              // This allows users to generate invoices on-demand rather than automatically
            });
          },
          {
            timeout: 10000, // 10 second timeout
            isolationLevel: "ReadCommitted", // Prevent dirty reads
          }
        );

        // console.log(
        //   "[WEBHOOK] ✅ Payment captured event processed successfully"
        // );
      } catch (transactionError: any) {
        console.error("[WEBHOOK] ❌ Transaction error:", transactionError);
        // If event was stored but processing failed, we still return success
        // to prevent Razorpay from retrying (idempotency)
        if (eventId) {
          const eventExists = await prisma.webhookEvent.findUnique({
            where: { eventId },
          });
          if (eventExists) {
            // console.log(
            //   "[WEBHOOK] Event stored but processing failed - returning success for idempotency"
            // );
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
      // console.log("[WEBHOOK] ⚠️ Unhandled event type:", eventType);
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
    if (process.env.NODE_ENV !== "production") {
      console.error("[WEBHOOK] ❌ Webhook handler error:", {
        message: err.message,
        stack: err.stack,
      });
    } else {
      console.error("[WEBHOOK] ❌ Webhook handler error:", {
        message: err.message,
      });
    }

    // Return 500 to allow Razorpay to retry
    return res.status(500).json({
      success: false,
      error: "Something went wrong",
    });
  }
}
