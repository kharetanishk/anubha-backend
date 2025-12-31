/**
 * Payment Service - Production-Grade Payment State Management
 * Handles payment state machine, idempotency, and retry safety
 */

import { Prisma, PrismaClient } from "@prisma/client";
import Razorpay from "razorpay";
import crypto from "crypto";
import prisma from "../../database/prismaclient";

// Payment State Machine
export enum PaymentStatus {
  PENDING = "PENDING",
  PAID = "PAID",
  FAILED = "FAILED",
  EXPIRED = "EXPIRED",
}

// Valid state transitions
const VALID_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  [PaymentStatus.PENDING]: [
    PaymentStatus.PAID,
    PaymentStatus.FAILED,
    PaymentStatus.EXPIRED,
  ],
  [PaymentStatus.PAID]: [], // Terminal state - no transitions allowed
  [PaymentStatus.FAILED]: [PaymentStatus.PENDING], // Allow retry
  [PaymentStatus.EXPIRED]: [PaymentStatus.PENDING], // Allow retry
};

/**
 * Check if a state transition is valid
 */
export function isValidTransition(
  from: PaymentStatus | string,
  to: PaymentStatus | string
): boolean {
  const fromStatus = from as PaymentStatus;
  const toStatus = to as PaymentStatus;

  if (!Object.values(PaymentStatus).includes(fromStatus)) {
    return false;
  }

  if (!Object.values(PaymentStatus).includes(toStatus)) {
    return false;
  }

  return VALID_TRANSITIONS[fromStatus].includes(toStatus);
}

/**
 * Normalize payment status string to enum
 */
export function normalizePaymentStatus(
  status: string | null | undefined
): PaymentStatus {
  if (!status) return PaymentStatus.PENDING;

  const upperStatus = status.toUpperCase();
  if (Object.values(PaymentStatus).includes(upperStatus as PaymentStatus)) {
    return upperStatus as PaymentStatus;
  }

  // Legacy status mapping
  if (upperStatus === "SUCCESS") return PaymentStatus.PAID;

  return PaymentStatus.PENDING;
}

/**
 * Payment service for handling payment operations
 */
export class PaymentService {
  private razorpay: Razorpay;

  constructor(razorpay: Razorpay) {
    this.razorpay = razorpay;
  }

  /**
   * Validate appointment ownership and state before payment operations
   */
  async validateAppointmentForPayment(
    appointmentId: string,
    userId: string,
    tx?: Prisma.TransactionClient
  ): Promise<{
    appointment: any;
    canProceed: boolean;
    error?: string;
  }> {
    const db = tx || prisma;

    const appointment = await db.appointment.findFirst({
      where: {
        id: appointmentId,
        userId,
        isArchived: false,
      },
      include: {
        patient: true,
        slot: true,
      },
    });

    if (!appointment) {
      return {
        appointment: null,
        canProceed: false,
        error: "Appointment not found or unauthorized",
      };
    }

    // Validate appointment status
    if (appointment.status !== "PENDING") {
      return {
        appointment,
        canProceed: false,
        error: `Appointment is already ${appointment.status.toLowerCase()}. Cannot proceed with payment.`,
      };
    }

    // Validate slot
    if (!appointment.slotId || !appointment.slot) {
      return {
        appointment,
        canProceed: false,
        error: "No slot assigned to appointment. Please select a slot first.",
      };
    }

    if (appointment.slot.isBooked) {
      return {
        appointment,
        canProceed: false,
        error:
          "Slot is already booked by another user. Please select a different slot.",
      };
    }

    // Validate plan price
    const planPrice = appointment.planPrice;
    if (!planPrice || planPrice <= 0) {
      return {
        appointment,
        canProceed: false,
        error: "Invalid plan price. Please contact support.",
      };
    }

    return {
      appointment,
      canProceed: true,
    };
  }

  /**
   * Check existing Razorpay order and determine if it should be reused or expired
   * @param paymentId Razorpay order ID
   * @param dbPaymentStatus Payment status from our database (source of truth)
   */
  async checkExistingOrder(
    paymentId: string | null,
    dbPaymentStatus?: PaymentStatus
  ): Promise<{
    shouldReuse: boolean;
    shouldExpire: boolean;
    order?: any;
    error?: string;
  }> {
    if (!paymentId) {
      return {
        shouldReuse: false,
        shouldExpire: false,
      };
    }

    try {
      const order = await this.razorpay.orders.fetch(paymentId);

      // Check order age (24 hours validity)
      const orderCreatedAt = order.created_at * 1000;
      const hoursSinceCreation =
        (Date.now() - orderCreatedAt) / (1000 * 60 * 60);

      // Check if order is paid in Razorpay
      const razorpayOrderPaid = order.status === "paid";

      // If database payment status is provided, use it as source of truth
      if (dbPaymentStatus !== undefined) {
        // Database says PAID - payment is truly completed
        if (dbPaymentStatus === PaymentStatus.PAID) {
          return {
            shouldReuse: false,
            shouldExpire: false,
            order,
            error: "Payment already completed for this appointment.",
          };
        }

        // Database says PENDING but Razorpay says paid - data inconsistency
        // This can happen if webhook failed or hasn't processed yet
        // Don't block the user - allow retry (the verifyPayment/webhook will sync)
        if (razorpayOrderPaid && dbPaymentStatus === PaymentStatus.PENDING) {
          return {
            shouldReuse: false,
            shouldExpire: true, // Expire and create new order
            order,
            error: "PAYMENT_STATUS_MISMATCH", // Special flag for handling
          };
        }
      } else {
        // No DB status provided - fallback to Razorpay status
        // This should only happen if called without DB status
        if (razorpayOrderPaid) {
          return {
            shouldReuse: false,
            shouldExpire: false,
            order,
            error: "Payment already completed for this appointment.",
          };
        }
      }

      // If order is valid and not expired, reuse it
      if (hoursSinceCreation <= 24 && order.status === "created") {
        return {
          shouldReuse: true,
          shouldExpire: false,
          order,
        };
      }

      // Order is expired or in invalid state
      return {
        shouldReuse: false,
        shouldExpire: true,
        order,
      };
    } catch (error: any) {
      // Order not found in Razorpay (404) or belongs to different account
      // This can happen when Razorpay keys are changed
      // console.warn(
      // `[PAYMENT] Order not found in Razorpay (may belong to different account)
      // : ${paymentId}`,
      // error.message || error
      // );
      // Mark for expiration so a new order can be created
      return {
        shouldReuse: false,
        shouldExpire: true,
      };
    }
  }

  /**
   * Expire old payment order (SHORT transaction - only DB operations)
   */
  async expireOldOrder(
    appointmentId: string,
    tx?: Prisma.TransactionClient
  ): Promise<void> {
    const db = tx || prisma;

    const useTransaction = !tx;

    if (useTransaction) {
      await prisma.$transaction(
        async (txInner) => {
          await txInner.appointment.update({
            where: { id: appointmentId },
            data: {
              paymentId: null,
              paymentStatus: PaymentStatus.EXPIRED,
            } as any,
          });
        },
        {
          timeout: 3000,
          maxWait: 2000,
        }
      );
    } else {
      await db.appointment.update({
        where: { id: appointmentId },
        data: {
          paymentId: null,
          paymentStatus: PaymentStatus.EXPIRED,
        } as any,
      });
    }
  }

  /**
   * Create Razorpay order (OUTSIDE transaction - external API call)
   */
  async createRazorpayOrder(params: {
    amount: number; // in paise
    appointmentId: string;
    planSlug?: string | null;
    planName?: string | null;
    userId: string;
    receipt?: string;
  }): Promise<any> {
    const receipt =
      params.receipt ||
      `rcpt_${params.appointmentId.slice(-8)}_${Date.now()
        .toString()
        .slice(-10)}`;

    return await this.razorpay.orders.create({
      amount: params.amount,
      currency: "INR",
      receipt,
      notes: {
        appointmentId: params.appointmentId,
        planSlug: params.planSlug || "",
        planName: params.planName || "",
        userId: params.userId,
      },
    });
  }

  /**
   * Link payment order to appointment (SHORT transaction - only DB operations)
   */
  async linkOrderToAppointment(
    appointmentId: string,
    orderId: string,
    amount: number,
    tx?: Prisma.TransactionClient
  ): Promise<void> {
    const db = tx || prisma;

    const useTransaction = !tx;

    if (useTransaction) {
      await prisma.$transaction(
        async (txInner) => {
          // Double-check appointment status
          const currentAppt = await txInner.appointment.findUnique({
            where: { id: appointmentId },
            select: { status: true, paymentId: true },
          });

          if (!currentAppt) {
            throw new Error("Appointment not found");
          }

          if (currentAppt.status !== "PENDING") {
            throw new Error(
              `Appointment status changed to ${currentAppt.status}. Cannot update payment.`
            );
          }

          if (currentAppt.paymentId && currentAppt.paymentId === orderId) {
            // Already linked - idempotent success
            return;
          }

          // Update appointment with payment order ID
          await txInner.appointment.update({
            where: { id: appointmentId },
            data: {
              paymentId: orderId,
              amount,
              paymentStatus: PaymentStatus.PENDING,
            } as any,
          });
        },
        {
          timeout: 3000,
          maxWait: 2000,
        }
      );
    } else {
      // Double-check appointment status
      const currentAppt = await db.appointment.findUnique({
        where: { id: appointmentId },
        select: { status: true, paymentId: true },
      });

      if (!currentAppt) {
        throw new Error("Appointment not found");
      }

      if (currentAppt.status !== "PENDING") {
        throw new Error(
          `Appointment status changed to ${currentAppt.status}. Cannot update payment.`
        );
      }

      if (currentAppt.paymentId && currentAppt.paymentId === orderId) {
        // Already linked - idempotent success
        return;
      }

      await db.appointment.update({
        where: { id: appointmentId },
        data: {
          paymentId: orderId,
          amount,
          paymentStatus: PaymentStatus.PENDING,
        } as any,
      });
    }
  }

  /**
   * Verify payment signature
   */
  verifyPaymentSignature(
    orderId: string,
    paymentId: string,
    signature: string,
    secret: string
  ): boolean {
    const body = `${orderId}|${paymentId}`;
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("hex");

    return expectedSignature === signature;
  }

  /**
   * Find appointment by payment order ID with fallback
   */
  async findAppointmentByOrderId(
    orderId: string,
    userId?: string,
    tx?: Prisma.TransactionClient
  ): Promise<any | null> {
    const db = tx || prisma;

    // First try: Find by paymentId
    let appointment = await db.appointment.findFirst({
      where: {
        paymentId: orderId,
        ...(userId && { userId }),
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

    if (appointment) {
      return appointment;
    }

    // Fallback: Try to find by order notes (if paymentId wasn't saved)
    try {
      const razorpayOrder = await this.razorpay.orders.fetch(orderId);
      const appointmentIdFromNotes = razorpayOrder.notes?.appointmentId;

      if (appointmentIdFromNotes) {
        appointment = await db.appointment.findFirst({
          where: {
            id: String(appointmentIdFromNotes),
            ...(userId && { userId }),
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

        // Link paymentId if found and not already set
        if (appointment && !appointment.paymentId && !tx) {
          await db.appointment.update({
            where: { id: appointment.id },
            data: { paymentId: orderId },
          });
        }
      }
    } catch (error) {
      // Order not found in Razorpay - return null
    }

    return appointment;
  }
}

// Export singleton instance
export const paymentService = new PaymentService(
  new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID!,
    key_secret: process.env.RAZORPAY_KEY_SECRET!,
  })
);
