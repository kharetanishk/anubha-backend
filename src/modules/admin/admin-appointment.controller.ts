import { Request, Response } from "express";
import prisma from "../../database/prismaclient";
import { getSingleDoctorId } from "../appointment/appointment.service";
import { AppointmentStatus, AppointmentMode } from "@prisma/client";
import { validatePlanDetails } from "../appointment/plan-validation";
import { AppError } from "../../util/AppError";

/**
 * Admin Appointment Controller
 * Handles admin-created appointments on behalf of users
 */

/**
 * Create appointment by admin for a user
 * POST /api/admin/appointments
 */
export async function createAppointmentByAdmin(req: Request, res: Response) {
  try {
    const adminId = req.user?.id;
    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const {
      userId,
      patientId,
      slotId,
      planSlug,
      planName,
      planPrice,
      planDuration,
      planPackageName,
      appointmentMode,
      startAt,
      endAt,
      paymentMode, // CASH, OFFLINE, PAID
      recallEntries, // Optional recall data
      recallNotes, // Optional recall notes
    } = req.body;

    // Validate required fields
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    if (!patientId) {
      return res.status(400).json({
        success: false,
        message: "patientId is required",
      });
    }

    // Validate plan details
    if (!planSlug || !planName || !planPrice || !planDuration) {
      return res.status(400).json({
        success: false,
        message:
          "Plan details (planSlug, planName, planPrice, planDuration) are required",
      });
    }

    // Validate appointmentMode
    if (
      !appointmentMode ||
      !["IN_PERSON", "ONLINE"].includes(appointmentMode)
    ) {
      return res.status(400).json({
        success: false,
        message: "appointmentMode must be 'IN_PERSON' or 'ONLINE'",
      });
    }

    // Validate paymentMode
    const validPaymentModes = ["CASH", "OFFLINE", "PAID"];
    const paymentModeToUse = paymentMode || "CASH";
    if (!validPaymentModes.includes(paymentModeToUse)) {
      return res.status(400).json({
        success: false,
        message: `paymentMode must be one of: ${validPaymentModes.join(", ")}`,
      });
    }

    // Validate plan details (prevent price manipulation)
    try {
      validatePlanDetails({
        planSlug,
        planName,
        planPrice: Number(planPrice),
        planPackageName: planPackageName || undefined,
        planDuration,
      });
    } catch (validationError: any) {
      return res.status(400).json({
        success: false,
        message: validationError.message || "Invalid plan details",
      });
    }

    // Verify user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Verify patient exists and belongs to user
    const patient = await prisma.patientDetials.findFirst({
      where: { id: patientId, userId },
      select: { id: true, userId: true },
    });

    if (!patient) {
      return res.status(404).json({
        success: false,
        message: "Patient not found or does not belong to this user",
      });
    }

    // Get doctor ID
    let doctorId: string;
    try {
      doctorId = await getSingleDoctorId();
    } catch (doctorError: any) {
      return res.status(500).json({
        success: false,
        message: doctorError.message || "Failed to get doctor information",
      });
    }

    // Handle slot and dates - Use transaction for atomicity
    let appointmentStartAt: Date;
    let appointmentEndAt: Date;
    let finalSlotId: string | null = null;

    if (slotId) {
      // Use transaction to lock slot and mark as booked atomically
      const slotResult = await prisma.$transaction(
        async (tx) => {
          // Lock slot row to prevent concurrent bookings
          const lockedSlot = await tx.$queryRaw<
            Array<{
              id: string;
              startAt: Date;
              endAt: Date;
              mode: string;
              isBooked: boolean;
            }>
          >`
            SELECT id, "startAt", "endAt", mode, "isBooked"
            FROM "Slot"
            WHERE id = ${slotId}
            FOR UPDATE
          `;

          if (!lockedSlot || lockedSlot.length === 0) {
            return { error: "Slot not found" };
          }

          const slot = lockedSlot[0];

          // Check if already booked (double-check after lock)
          if (slot.isBooked) {
            return { error: "Slot is already booked" };
          }

          // Mark slot as booked atomically
          await tx.slot.update({
            where: { id: slotId },
            data: { isBooked: true },
          });

          return { slot };
        },
        {
          timeout: 10000, // 10 second timeout
          isolationLevel: "ReadCommitted",
        }
      );

      if (slotResult.error) {
        return res
          .status(slotResult.error === "Slot not found" ? 404 : 400)
          .json({
            success: false,
            message: slotResult.error,
          });
      }

      const slot = slotResult.slot!;
      appointmentStartAt = slot.startAt;
      appointmentEndAt = slot.endAt;
      finalSlotId = slotId;
    } else if (startAt && endAt) {
      // Use provided custom dates
      appointmentStartAt = new Date(startAt);
      appointmentEndAt = new Date(endAt);

      if (
        isNaN(appointmentStartAt.getTime()) ||
        isNaN(appointmentEndAt.getTime())
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid date format for startAt or endAt",
        });
      }

      // Validate dates are in the future (at least 1 minute)
      const now = new Date();
      const minFutureTime = new Date(now.getTime() + 60 * 1000);
      if (appointmentStartAt < minFutureTime) {
        return res.status(400).json({
          success: false,
          message:
            "Appointment start time must be in the future (at least 1 minute from now)",
        });
      }

      if (appointmentEndAt <= appointmentStartAt) {
        return res.status(400).json({
          success: false,
          message: "endAt must be after startAt",
        });
      }
    } else {
      return res.status(400).json({
        success: false,
        message: "Either slotId or startAt/endAt dates are required",
      });
    }

    // Create appointment with CONFIRMED status in transaction
    const appointment = await prisma.appointment.create({
      data: {
        userId,
        doctorId,
        patientId,
        slotId: finalSlotId,
        startAt: appointmentStartAt,
        endAt: appointmentEndAt,
        mode: appointmentMode as AppointmentMode,
        status: "CONFIRMED", // Admin-created appointments are immediately CONFIRMED
        paymentStatus: "PAID", // Admin-created appointments are always PAID (no Razorpay needed)
        planSlug,
        planName,
        planPrice: Number(planPrice),
        planDuration,
        planPackageName,
      },
    });

    // Create recall if recallEntries are provided
    let recall = null;
    if (
      recallEntries &&
      Array.isArray(recallEntries) &&
      recallEntries.length > 0
    ) {
      recall = await prisma.recall.create({
        data: {
          patientId,
          appointmentId: appointment.id,
          notes: recallNotes || null,
          entries: {
            create: recallEntries.map((entry: any) => ({
              mealType: entry.mealType,
              time: entry.time,
              foodItem: entry.foodItem,
              quantity: entry.quantity,
              notes: entry.notes || null,
            })),
          },
        },
        include: {
          entries: true,
        },
      });
    }

    return res.status(201).json({
      success: true,
      message: "Appointment created successfully",
      appointment: {
        ...appointment,
        recall,
      },
    });
  } catch (error: any) {
    console.error("[ADMIN APPOINTMENT] Create error:", error);

    // Handle Prisma-specific errors
    if (error.code === "P2002") {
      return res.status(409).json({
        success: false,
        message: "Appointment conflict. Please try again.",
      });
    }

    const statusCode = error instanceof AppError ? error.statusCode : 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || "Failed to create appointment",
    });
  }
}
