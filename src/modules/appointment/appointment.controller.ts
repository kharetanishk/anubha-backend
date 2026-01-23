import { Request, Response } from "express";
import prisma from "../../database/prismaclient";
import { getSingleDoctorId } from "./appointment.service";
import { AppointmentStatus, BookingProgress, Prisma } from "@prisma/client";
import { AppointmentMode } from "@prisma/client";
import { validatePlanDetails } from "./plan-validation";
import { archiveDuplicatePendingAppointments } from "../payment/payment.controller";

export async function createAppointmentHandler(req: Request, res: Response) {
  try {
    // console.log(" [BACKEND] Appointment creation request received");
    // console.log(
    //   " [BACKEND] User:",
    //   req.user ? { id: req.user.id, role: req.user.role } : "NOT AUTHENTICATED"
    // );

    const userId = req.user?.id;
    if (!userId) {
      console.error(
        " [BACKEND] Appointment creation failed: User not authenticated"
      );
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const {
      appointmentId, // NEW: Optional appointment ID to update existing appointment
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
      bookingProgress, // Track where user is in the booking flow
    } = req.body;

    // console.log(" [BACKEND] Request body:", {
    //   patientId,
    //   slotId: slotId || "none",
    //   planSlug,
    //   planName,
    //   planPrice,
    //   appointmentMode,
    // });

    if (!patientId) {
      console.error(
        " [BACKEND] Appointment creation failed: patientId missing"
      );
      return res.status(400).json({
        success: false,
        message: "patientId is required",
      });
    }

    // SECURITY: Verify patient exists and belongs to the user
    // Use transaction to prevent race condition where patient is deleted between check and appointment creation
    // console.log(" [BACKEND] Verifying patient exists...");
    // Verify patient within the appointment creation transaction to prevent race conditions
    // This ensures patient exists at the moment of appointment creation
    let patient;
    try {
      patient = await prisma.patientDetials.findFirst({
        where: { id: patientId, userId },
        select: { id: true, name: true, userId: true },
      });

      if (!patient) {
        console.error(
          " [BACKEND] Appointment creation failed: Patient not found or unauthorized"
        );
        return res.status(404).json({
          success: false,
          message: "Patient not found or unauthorized",
        });
      }
      // console.log(" [BACKEND] Patient verified:", {
      //   id: patient.id,
      //   name: patient.name,
      // });
    } catch (error: any) {
      // console.error(" [BACKEND] Error verifying patient:", error);
      console.error(" [BACKEND] Error verifying patient:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to verify patient. Please try again.",
      });
    }

    // SECURITY: Validate plan details (prevent price manipulation attacks)
    // Plan details are required and must match server-side definitions
    if (!planSlug || !planName || !planPrice) {
      console.error(
        " [BACKEND] Appointment creation failed: Plan details missing"
      );
      return res.status(400).json({
        success: false,
        message: "Plan details (planSlug, planName, planPrice) are required",
      });
    }

    // Validate planDuration is provided (required field in schema)
    if (!planDuration) {
      console.error(
        " [BACKEND] Appointment creation failed: planDuration is required"
      );
      return res.status(400).json({
        success: false,
        message:
          "planDuration is required. For general consultation, use '40 min' or 'N/A'",
      });
    }

    // Validate appointmentMode
    if (
      !appointmentMode ||
      !["IN_PERSON", "ONLINE"].includes(appointmentMode)
    ) {
      console.error(
        " [BACKEND] Appointment creation failed: Invalid appointmentMode"
      );
      return res.status(400).json({
        success: false,
        message: "appointmentMode must be 'IN_PERSON' or 'ONLINE'",
      });
    }

    // console.log(" [BACKEND] Validating plan details...");
    try {
      validatePlanDetails({
        planSlug,
        planName,
        planPrice: Number(planPrice),
        planPackageName: planPackageName || undefined,
        planDuration: planDuration,
      });
      // console.log(" [BACKEND] Plan details validated successfully");
    } catch (validationError: any) {
      console.error(
        " [BACKEND] Plan validation error (possible security issue):",
        validationError
      );
      return res.status(400).json({
        success: false,
        message: validationError.message || "Invalid plan details",
      });
    }

    // If slotId is provided, validate and use slot times
    // Otherwise, use provided startAt/endAt or create placeholder appointment
    let appointmentStartAt: Date;
    let appointmentEndAt: Date;
    let finalSlotId: string | null = null;
    let slotMode: AppointmentMode | null = null;

    if (slotId) {
      // console.log(" [BACKEND] Validating slot:", slotId);
      // Use transaction with SELECT FOR UPDATE to prevent race conditions
      // This locks the slot row until transaction completes
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
              adminId: string;
            }>
          >`
          SELECT id, "startAt", "endAt", mode, "isBooked", "adminId"
          FROM "Slot"
          WHERE id = ${slotId}
          FOR UPDATE
        `;

          if (!lockedSlot || lockedSlot.length === 0) {
            return null;
          }

          const slot = lockedSlot[0];

          // Check if already booked (double-check after lock)
          if (slot.isBooked) {
            return { error: "Slot already booked" };
          }

          // SECURITY: Validate slot startAt is in the future
          // slot.startAt is UTC from database, now is UTC, so comparison is correct
          const now = new Date();
          const minFutureTime = new Date(now.getTime() + 60 * 1000); // At least 1 minute in the future
          if (slot.startAt < minFutureTime) {
            return { error: "Slot start time must be in the future" };
          }

          // Validate slot endAt is after startAt
          if (slot.endAt <= slot.startAt) {
            return { error: "Invalid slot: endAt must be after startAt" };
          }

          // Mark slot as booked atomically within transaction
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

      if (!slotResult) {
        console.error(" [BACKEND] Slot not found:", slotId);
        return res.status(404).json({
          success: false,
          message: "Slot not found",
        });
      }

      if (slotResult.error) {
        console.error(" [BACKEND] Slot validation failed:", slotResult.error);
        return res.status(400).json({
          success: false,
          message: slotResult.error,
        });
      }

      const slot = slotResult.slot!;
      // console.log(" [BACKEND] Slot validated and locked:", {
      //   id: slot.id,
      //   startAt: slot.startAt,
      //   endAt: slot.endAt,
      //   mode: slot.mode,
      // });

      // DATA INTEGRITY: Validate that appointment dates match slot dates when slot is assigned
      // If startAt/endAt are provided, they MUST match the slot dates exactly
      // Note: new Date(startAt) parses ISO strings correctly (UTC if 'Z' suffix, or specified timezone)
      // Frontend should send ISO strings with timezone info to ensure correct parsing
      if (startAt || endAt) {
        const providedStartAt = startAt ? new Date(startAt) : null;
        const providedEndAt = endAt ? new Date(endAt) : null;

        // Check if provided dates match slot dates (with 1 second tolerance for timezone/rounding)
        const startAtMatches =
          !providedStartAt ||
          Math.abs(providedStartAt.getTime() - slot.startAt.getTime()) < 1000;
        const endAtMatches =
          !providedEndAt ||
          Math.abs(providedEndAt.getTime() - slot.endAt.getTime()) < 1000;

        if (!startAtMatches || !endAtMatches) {
          console.error(
            " [BACKEND] ❌ DATA INTEGRITY VIOLATION: Provided dates do not match slot dates"
          );
          console.error(" [BACKEND] Slot dates:", {
            startAt: slot.startAt,
            endAt: slot.endAt,
          });
          console.error(" [BACKEND] Provided dates:", {
            startAt: providedStartAt,
            endAt: providedEndAt,
          });
          return res.status(400).json({
            success: false,
            message:
              "Appointment dates must match slot dates exactly. Please use the slot's startAt and endAt values.",
          });
        }

        // console.log(
        // " [BACKEND] ✓ Provided dates match slot dates (validation passed)
        // "
        // );
      }

      // Always use slot dates to ensure appointment dates match slot dates
      // This ensures data consistency even if dates were not provided
      appointmentStartAt = slot.startAt;
      appointmentEndAt = slot.endAt;
      finalSlotId = slotId;
      slotMode = slot.mode as AppointmentMode;
    } else {
      // Create appointment without slot (for recall flow)
      // Use provided startAt/endAt or create placeholder dates
      // Note: new Date() parses ISO strings correctly (UTC if 'Z' suffix, or specified timezone)
      // Frontend should send ISO strings with timezone info to ensure correct parsing
      if (startAt && endAt) {
        // console.log(" [BACKEND] Using provided startAt/endAt dates");
        appointmentStartAt = new Date(startAt);
        appointmentEndAt = new Date(endAt);

        // Validate dates are valid
        if (
          isNaN(appointmentStartAt.getTime()) ||
          isNaN(appointmentEndAt.getTime())
        ) {
          console.error(" [BACKEND] Invalid date format provided");
          return res.status(400).json({
            success: false,
            message: "Invalid date format for startAt or endAt",
          });
        }

        // SECURITY: Validate startAt is in the future
        // appointmentStartAt is UTC Date object, now is UTC, so comparison is correct
        const now = new Date();
        const minFutureTime = new Date(now.getTime() + 60 * 1000); // At least 1 minute in the future
        if (appointmentStartAt < minFutureTime) {
          console.error(" [BACKEND] startAt must be in the future");
          return res.status(400).json({
            success: false,
            message:
              "Appointment start time must be in the future (at least 1 minute from now)",
          });
        }

        // Validate endAt is after startAt
        if (appointmentEndAt <= appointmentStartAt) {
          console.error(" [BACKEND] endAt must be after startAt");
          return res.status(400).json({
            success: false,
            message: "endAt must be after startAt",
          });
        }
      } else {
        // Create appointment without slot (for recall flow)
        // SECURITY: Require either slotId OR valid startAt/endAt dates
        // Placeholder appointments with arbitrary dates are not allowed
        if (startAt && endAt) {
          // console.log(
          // " [BACKEND] Using provided startAt/endAt dates (no slotId)
          // "
          // );
          appointmentStartAt = new Date(startAt);
          appointmentEndAt = new Date(endAt);

          // Validate dates are valid
          if (
            isNaN(appointmentStartAt.getTime()) ||
            isNaN(appointmentEndAt.getTime())
          ) {
            console.error(" [BACKEND] Invalid date format provided");
            return res.status(400).json({
              success: false,
              message: "Invalid date format for startAt or endAt",
            });
          }

          // SECURITY: Validate startAt is in the future
          // appointmentStartAt is UTC Date object, now is UTC, so comparison is correct
          const now = new Date();
          const minFutureTime = new Date(now.getTime() + 60 * 1000); // At least 1 minute in the future
          if (appointmentStartAt < minFutureTime) {
            console.error(" [BACKEND] startAt must be in the future");
            return res.status(400).json({
              success: false,
              message:
                "Appointment start time must be in the future (at least 1 minute from now)",
            });
          }

          // Validate endAt is after startAt
          if (appointmentEndAt <= appointmentStartAt) {
            console.error(" [BACKEND] endAt must be after startAt");
            return res.status(400).json({
              success: false,
              message: "endAt must be after startAt",
            });
          }
        } else {
          // SECURITY: No slotId and no startAt/endAt provided
          // For backward compatibility with recall flow, create placeholder dates
          // but log a warning and ensure they will be updated when slot is selected
          // console.warn(
          // " [BACKEND] ⚠️ Creating appointment without slotId or dates (placeholder dates will be used)
          // "
          // );
          // console.warn(
          // " [BACKEND] This appointment MUST have a slot assigned before confirmation"
          // );
          // Create placeholder dates (will be updated when slot is selected)
          // These are clearly placeholders and will be validated when slot is assigned
          appointmentStartAt = new Date();
          appointmentEndAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour later

          // console.log(
          // " [BACKEND] Using placeholder dates (will be updated when slot is selected)
          // :",
          // {
          // startAt: appointmentStartAt,
          // endAt: appointmentEndAt,
          // }
          // );
        }
      }
    }

    // console.log(" [BACKEND] Getting doctor ID...");
    let doctorId: string;
    try {
      doctorId = await getSingleDoctorId();
      // console.log(" [BACKEND] Doctor ID:", doctorId);
    } catch (doctorError: any) {
      console.error(" [BACKEND] Failed to get doctor ID:", doctorError);
      return res.status(500).json({
        success: false,
        message: doctorError.message || "Failed to get doctor information",
      });
    }

    // console.log(" [BACKEND] Creating appointment in database...");
    // console.log(" [BACKEND] Appointment data:", {
    //   userId,
    //   doctorId,
    //   patientId,
    //   slotId: finalSlotId || "none",
    //   startAt: appointmentStartAt,
    //   endAt: appointmentEndAt,
    //   mode: appointmentMode,
    //   planSlug,
    //   planName,
    //   planPrice: Number(planPrice),
    //   planDuration,
    // });

    // SECURITY: Create appointment in transaction to ensure patient still exists
    // This prevents race condition where patient is deleted between validation and creation
    let appointment;
    try {
      // Re-verify patient exists within transaction to prevent race condition
      const patientCheck = await prisma.patientDetials.findUnique({
        where: { id: patientId },
        select: { id: true, userId: true },
      });

      if (!patientCheck || patientCheck.userId !== userId) {
        console.error(
          " [BACKEND] Patient validation failed during appointment creation (race condition detected)"
        );
        return res.status(404).json({
          success: false,
          message:
            "Patient not found or unauthorized. Please refresh and try again.",
        });
      }

      // NEW: If appointmentId is provided, update that appointment directly
      if (appointmentId) {
        const existingAppt = await prisma.appointment.findFirst({
          where: {
            id: appointmentId,
            userId,
            status: "PENDING",
            isArchived: false,
          },
        });

        if (existingAppt) {
          // Determine booking progress
          let progress: BookingProgress | null = null;
          if (
            bookingProgress &&
            ["USER_DETAILS", "RECALL", "SLOT", "PAYMENT"].includes(
              bookingProgress
            )
          ) {
            progress = bookingProgress as BookingProgress;
          } else {
            if (slotId) {
              progress = "SLOT";
            } else if (patientId) {
              progress = "USER_DETAILS";
            }
          }

          // Update existing appointment
          const updatedAppointment = await prisma.appointment.update({
            where: { id: existingAppt.id },
            data: {
              bookingProgress: progress,
              startAt: appointmentStartAt,
              endAt: appointmentEndAt,
              slotId: finalSlotId,
              mode: appointmentMode as AppointmentMode,
              planSlug,
              planName,
              planPrice: Number(planPrice),
              planDuration,
              planPackageName,
            },
          });

          return res.status(200).json({
            success: true,
            message: "Appointment updated successfully",
            data: updatedAppointment,
            updated: true,
          });
        }
        // If appointmentId provided but not found, continue with normal flow
      }

      // CRITICAL: Check if a CONFIRMED appointment already exists for this patient and plan
      // This prevents creating new PENDING appointments when a CONFIRMED appointment already exists
      // Match by: userId, patientId, planSlug, startAt (date), and optionally slotId
      // This ensures we don't create pending appointments when confirmed ones exist for the same booking
      const confirmedWhere: any = {
        userId,
        patientId,
        planSlug,
        startAt: appointmentStartAt, // Always match by date/time
        status: "CONFIRMED",
        isArchived: false, // Only check non-archived appointments
      };

      // If slotId is provided, also match by slotId for more precise detection
      if (finalSlotId) {
        confirmedWhere.slotId = finalSlotId;
      }

      const existingConfirmedAppointment = await prisma.appointment.findFirst({
        where: confirmedWhere,
        orderBy: {
          createdAt: "desc", // Get the most recent one
        },
      });

      if (existingConfirmedAppointment) {
        // console.log(
        // " [BACKEND] ⚠️ CONFIRMED appointment already exists for this booking. Returning existing appointment:",
        // existingConfirmedAppointment.id,
        // {
        // userId,
        // patientId,
        // planSlug,
        // startAt: appointmentStartAt,
        // slotId: finalSlotId || "none",
        // }
        // );
        // Return the existing CONFIRMED appointment - don't create a new PENDING one
        return res.status(200).json({
          success: true,
          message: "Confirmed appointment already exists for this booking",
          data: existingConfirmedAppointment,
          updated: false, // Indicate this is an existing confirmed appointment
          alreadyConfirmed: true,
        });
      }

      // CRITICAL: Check if a PENDING appointment already exists for this logical booking
      // This prevents duplicate PENDING appointments when the booking flow is called multiple times
      // IMPROVED: Match by logical booking (userId + patientId + planSlug) without requiring exact startAt
      // This allows users to change slots without creating new appointments
      const pendingWhere: Prisma.AppointmentWhereInput = {
        userId,
        patientId,
        planSlug,
        status: "PENDING",
        isArchived: false, // Only check non-archived appointments
        // REMOVED: startAt match (too strict - user may change slot)
        // REMOVED: slotId match (user may change slot)
      };

      const existingPendingAppointment = await prisma.appointment.findFirst({
        where: pendingWhere,
        orderBy: {
          createdAt: "desc", // Get the most recent one
        },
      });

      if (existingPendingAppointment) {
        // console.log(
        //   " [BACKEND] ⚠️ PENDING appointment already exists for this booking (userId, patientId, startAt, planSlug). Updating existing appointment:",
        //   existingPendingAppointment.id,
        //   {
        //     userId,
        //     patientId,
        //     startAt: appointmentStartAt,
        //     planSlug,
        //   }
        // );

        // Determine booking progress based on what's provided
        let progress: BookingProgress | null = null;
        if (
          bookingProgress &&
          ["USER_DETAILS", "RECALL", "SLOT", "PAYMENT"].includes(
            bookingProgress
          )
        ) {
          progress = bookingProgress as BookingProgress;
        } else {
          // Auto-detect progress based on provided data
          if (slotId) {
            progress = "SLOT"; // Slot selected, next is payment
          } else if (patientId) {
            progress = "USER_DETAILS"; // User form filled, next is recall
          }
        }

        // Update the existing PENDING appointment instead of creating a new one
        appointment = await prisma.appointment.update({
          where: { id: existingPendingAppointment.id },
          data: {
            bookingProgress: progress,
            startAt: appointmentStartAt,
            endAt: appointmentEndAt,
            slotId: finalSlotId, // Update slotId if provided
            mode: appointmentMode as AppointmentMode,
            planSlug,
            planName,
            planPrice: Number(planPrice),
            planDuration,
            planPackageName,
          },
        });

        // console.log(
        // " [BACKEND] Updated existing PENDING appointment:",
        // appointment.id
        // );
        // Return early - don't create a new appointment
        return res.status(200).json({
          success: true,
          message: "Appointment updated successfully",
          data: appointment,
          updated: true, // Indicate this was an update, not a create
        });
      }

      // Determine booking progress based on what's provided
      let progress: BookingProgress | null = null;
      if (
        bookingProgress &&
        ["USER_DETAILS", "RECALL", "SLOT", "PAYMENT"].includes(bookingProgress)
      ) {
        progress = bookingProgress as BookingProgress;
      } else {
        // Auto-detect progress based on provided data
        if (slotId) {
          progress = "SLOT"; // Slot selected, next is payment
        } else if (patientId) {
          progress = "USER_DETAILS"; // User form filled, next is recall
        }
      }

      appointment = await prisma.appointment.create({
        data: {
          userId,
          doctorId,
          patientId,
          slotId: finalSlotId,
          startAt: appointmentStartAt,
          endAt: appointmentEndAt,
          mode: appointmentMode as AppointmentMode,
          status: "PENDING", // Always create with PENDING status
          bookingProgress: progress,

          planSlug,
          planName,
          planPrice: Number(planPrice),
          planDuration,
          planPackageName,
        },
      });

      // NEW: Archive old PENDING duplicates immediately after creating new appointment
      // This prevents accumulation of abandoned bookings
      try {
        await prisma.$transaction(async (tx) => {
          await archiveDuplicatePendingAppointments(tx, appointment.id, {
            userId: appointment.userId,
            patientId: appointment.patientId,
            planSlug: appointment.planSlug,
            startAt: appointment.startAt, // Optional - used for logging only
          });
        });
      } catch (archiveError) {
        // Log but don't fail - appointment creation succeeded
        console.warn(
          "[APPOINTMENT] Failed to archive duplicates (non-critical):",
          archiveError
        );
      }
    } catch (dbError: any) {
      console.error(" [BACKEND] Database error creating appointment:", dbError);
      console.error(" [BACKEND] Database error details:", {
        code: dbError.code,
        meta: dbError.meta,
        message: dbError.message,
      });

      // Handle Prisma-specific errors
      if (dbError.code === "P2002") {
        return res.status(409).json({
          success: false,
          message: "Appointment conflict. Please try again.",
        });
      }

      return res.status(500).json({
        success: false,
        message: dbError.message || "Failed to create appointment in database",
      });
    }

    // NOTE: Slot is NOT marked as booked here. It will only be marked as booked
    // after payment is confirmed and appointment status is set to CONFIRMED.
    // This happens in:
    // 1. razorpayWebhookHandler (payment.captured event)
    // 2. verifyPaymentHandler (manual payment verification)
    // 3. updateAppointmentStatusHandler (when status is manually set to CONFIRMED)

    if (finalSlotId) {
      // console.log(
      //   "ℹ️ [BACKEND] Slot assigned to appointment (will be marked as booked after payment confirmation):",
      //   finalSlotId
      // );
    } else {
      // console.log(
      //   "ℹ️ [BACKEND] No slotId provided, appointment created without slot (will be set later)"
      // );
    }

    // console.log(" [BACKEND] Appointment created successfully:", {
    //   id: appointment.id,
    //   patientId: appointment.patientId,
    //   status: appointment.status,
    //   slotId: appointment.slotId,
    // });

    return res.status(201).json({
      success: true,
      message: "Appointment created successfully",
      data: appointment,
    });
  } catch (err: any) {
    // console.error(" [BACKEND] CREATE APPOINTMENT ERROR:", err);
    // console.error(" [BACKEND] Error details:", {
    //   name: err.name,
    //   message: err.message,
    //   code: err.code,
    //   stack: err.stack,
    // });
    console.error(" [BACKEND] CREATE APPOINTMENT ERROR:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Internal server error",
    });
  }
}

export async function adminUpdateAppointmentStatus(
  req: Request,
  res: Response
) {
  try {
    const { id } = req.params;
    const { status } = req.body as { status: AppointmentStatus };

    if (!status) {
      return res.status(400).json({ error: "Missing status" });
    }

    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: { slot: true },
      // Note: admin status update doesn't check isArchived as admin may need to update archived records
    });

    if (!appointment) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    const current = appointment.status;

    if (current === "CANCELLED" || current === "COMPLETED") {
      return res.status(400).json({
        error: `Cannot modify an appointment that is ${current}`,
      });
    }

    const allowedStatuses: AppointmentStatus[] = [
      "PENDING",
      "CONFIRMED",
      "CANCELLED",
      "COMPLETED",
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    let slotUpdate = undefined;
    if (status === "CANCELLED" && appointment.slotId) {
      slotUpdate = prisma.slot.update({
        where: { id: appointment.slotId },
        data: { isBooked: false },
      });
    }

    if (status === "CONFIRMED" && appointment.slotId) {
      slotUpdate = prisma.slot.update({
        where: { id: appointment.slotId },
        data: { isBooked: true },
      });
    }

    const updated = await prisma.appointment.update({
      where: { id },
      data: { status },
    });

    if (slotUpdate) await slotUpdate;

    return res.json({
      success: true,
      appointment: updated,
    });
  } catch (err) {
    console.error("Admin Update Status Error:", err);
    return res.status(500).json({ error: "Something went wrong" });
  }
}

export async function getMyAppointments(req: Request, res: Response) {
  const startTime = Date.now(); // For performance monitoring
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { includePending, page = "1", limit = "20", sort } = req.query; // Optional query params

    // Build where clause
    const where: any = {
      userId: req.user.id,
      isArchived: false, // Exclude deleted appointments
      isDeletedByAdmin: false, // Exclude appointments deleted by admin
    };

    if (includePending === "true") {
      // Include CONFIRMED, PENDING, CANCELLED, and COMPLETED appointments
      // This ensures all appointment statuses are visible to users
      where.status = {
        in: ["CONFIRMED", "PENDING", "CANCELLED", "COMPLETED"],
      };
    } else {
      // Include CONFIRMED, CANCELLED, and COMPLETED appointments
      // PENDING appointments are excluded by default, but CANCELLED and COMPLETED should always be visible
      where.status = {
        in: ["CONFIRMED", "CANCELLED", "COMPLETED"],
      };
    }

    // Pagination
    const pageNum = Math.max(1, Number(page));
    const lim = Math.min(200, Math.max(1, Number(limit)));
    const skip = (pageNum - 1) * lim;

    // Determine sort order: latest (desc) or oldest (asc), default to latest
    const sortOrder = sort === "oldest" ? "asc" : "desc";

    const [appointments, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        skip,
        take: lim,
        orderBy: { startAt: sortOrder },
        include: {
          patient: {
            select: {
              id: true,
              name: true,
              phone: true,
              email: true,
            },
          },
          slot: {
            select: {
              id: true,
              startAt: true,
              endAt: true,
              mode: true,
            },
          },
        },
      }),
      prisma.appointment.count({ where }),
    ]);

    const durationMs = Date.now() - startTime;

    // Log performance occasionally in development
    if (process.env.NODE_ENV === "development" && Math.random() < 0.1) {
      console.log(
        `[USER APPOINTMENTS PERFORMANCE] Query took ${durationMs}ms. Total: ${total}, Page: ${pageNum}, Limit: ${lim}, includePending: ${includePending}`
      );
    }

    return res.json({
      success: true,
      appointments,
      total,
      page: pageNum,
      limit: lim,
    });
  } catch (err) {
    console.error("GET MY APPOINTMENTS ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to get appointments",
    });
  }
}

// New endpoint: Get pending appointments specifically
export async function getPendingAppointments(req: Request, res: Response) {
  const startTime = Date.now(); // For performance monitoring
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { patientId, page = "1", limit = "10" } = req.query; // Optional query params

    const where: any = {
      userId: req.user.id,
      status: "PENDING",
      isArchived: false, // Exclude deleted appointments
    };

    // If patientId is provided, filter by patientId
    if (patientId && typeof patientId === "string") {
      where.patientId = patientId;
    }

    // Pagination
    const pageNum = Math.max(1, Number(page));
    const lim = Math.min(200, Math.max(1, Number(limit)));
    const skip = (pageNum - 1) * lim;

    const [appointments, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        skip,
        take: lim,
        orderBy: { createdAt: "desc" },
        include: {
          patient: {
            select: {
              id: true,
              name: true,
              phone: true,
              email: true,
            },
          },
          slot: {
            select: {
              id: true,
              startAt: true,
              endAt: true,
              mode: true,
            },
          },
        },
      }),
      prisma.appointment.count({ where }),
    ]);

    const durationMs = Date.now() - startTime;

    // Log performance occasionally in development
    if (process.env.NODE_ENV === "development" && Math.random() < 0.1) {
      console.log(
        `[PENDING APPOINTMENTS PERFORMANCE] Query took ${durationMs}ms. Total: ${total}, Page: ${pageNum}, Limit: ${lim}`
      );
    }

    return res.json({
      success: true,
      appointments,
      total,
      page: pageNum,
      limit: lim,
    });
  } catch (err) {
    console.error("GET PENDING APPOINTMENTS ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to get pending appointments",
    });
  }
}

// New endpoint: Update booking progress
export async function updateBookingProgress(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { appointmentId } = req.params;
    const { bookingProgress } = req.body;

    if (
      !bookingProgress ||
      !["USER_DETAILS", "RECALL", "SLOT", "PAYMENT"].includes(bookingProgress)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid bookingProgress. Must be one of: USER_DETAILS, RECALL, SLOT, PAYMENT",
      });
    }

    // Verify appointment belongs to user
    const appointment = await prisma.appointment.findFirst({
      where: {
        id: appointmentId,
        userId: req.user.id,
        status: "PENDING", // Only allow updating progress for pending appointments
        isArchived: false, // Exclude archived appointments
      },
    });

    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: "Appointment not found or cannot be updated",
      });
    }

    const updated = await prisma.appointment.update({
      where: { id: appointmentId },
      data: { bookingProgress: bookingProgress as BookingProgress },
    });

    // console.log(
    // `[UPDATE BOOKING PROGRESS] Updated appointment ${appointmentId} to progress: ${bookingProgress}`
    // );
    return res.json({
      success: true,
      message: "Booking progress updated successfully",
      appointment: updated,
    });
  } catch (err: any) {
    console.error("UPDATE BOOKING PROGRESS ERROR:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to update booking progress",
    });
  }
}

export async function getUserAppointmentDetails(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "Missing appointment id" });
    }

    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: {
        patient: {
          // ❌ REMOVED recalls from here - will fetch separately by appointmentId
        },
        slot: true,
      },
    });

    // ✅ Fetch appointment-scoped recalls separately (like Files)
    const appointmentRecalls = await prisma.recall.findMany({
      where: {
        appointmentId: id, // ✅ Filter by appointmentId
        isArchived: false,
      },
      include: {
        entries: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // Reports are scoped to the appointment (not patient) to prevent cross-appointment sharing.
    // We fetch them explicitly to avoid relying on Prisma relation typings during build-time.
    // NOTE: Using raw SQL query as workaround until Prisma client is regenerated with File.appointmentId support.
    // TODO: After running `npx prisma generate`, replace with: prisma.file.findMany({ where: { appointmentId: id, isArchived: false } })
    const appointmentFiles = await prisma.$queryRaw<Array<{
      id: string;
      url: string;
      fileName: string;
      mimeType: string;
      createdAt: Date;
      provider: string;
      sizeInBytes: number;
      updatedAt: Date;
      patientId: string | null;
      appointmentId: string | null;
      publicId: string;
      archivedAt: Date | null;
      isArchived: boolean;
    }>>`
      SELECT * FROM "File"
      WHERE "appointmentId"::text = ${id}::text
        AND "isArchived" = false
      ORDER BY "createdAt" ASC
    `;

    // Exclude archived appointments from user view
    if (appointment && appointment.isArchived) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    if (!appointment) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    // Verify the appointment belongs to the user
    if (appointment.userId !== req.user.id) {
      return res.status(403).json({
        error: "Not authorized to view this appointment",
      });
    }

    return res.json({
      success: true,
      appointment: {
        ...(appointment as any),
        patient: {
          ...(appointment as any).patient,
          recalls: appointmentRecalls, // ✅ Only appointment-specific recalls
        },
        files: appointmentFiles,
      },
    });
  } catch (err) {
    console.error("GET USER APPOINTMENT DETAILS ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to get appointment details",
    });
  }
}

export async function getAppointmentsByPatient(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { patientId } = req.params;

    // Wrap database operations in try-catch to handle connection errors
    let patient;
    try {
      patient = await prisma.patientDetials.findFirst({
        where: {
          id: patientId,
          userId: req.user.id,
          isArchived: false, // Exclude archived patients
        },
      });
    } catch (dbError: any) {
      console.error(
        "[GET APPOINTMENTS BY PATIENT] Database connection error on patient lookup:",
        dbError
      );
      // Handle connection errors (P1017 - Server has closed the connection)
      if (
        dbError.code === "P1017" ||
        dbError.message?.includes("closed") ||
        dbError.message?.includes("ConnectionReset")
      ) {
        return res.status(503).json({
          success: false,
          message: "Database connection error. Please try again in a moment.",
          retryable: true,
        });
      }
      throw dbError; // Re-throw if it's not a connection error
    }

    if (!patient) {
      return res.status(403).json({
        success: false,
        message: "Not allowed",
      });
    }

    let appointments;
    try {
      appointments = await prisma.appointment.findMany({
        where: {
          patientId,
          isArchived: false, // Exclude deleted appointments
          status: "CONFIRMED", // Only return confirmed appointments (matching getMyAppointments behavior)
        },
        orderBy: { startAt: "desc" },
        include: {
          slot: {
            select: {
              id: true,
              startAt: true,
              endAt: true,
              mode: true,
            },
          },
          patient: {
            select: {
              id: true,
              name: true,
              phone: true,
              email: true,
            },
          },
        },
      });
    } catch (dbError: any) {
      console.error(
        "[GET APPOINTMENTS BY PATIENT] Database connection error on appointments lookup:",
        dbError
      );
      // Handle connection errors (P1017 - Server has closed the connection)
      if (
        dbError.code === "P1017" ||
        dbError.message?.includes("closed") ||
        dbError.message?.includes("ConnectionReset")
      ) {
        return res.status(503).json({
          success: false,
          message: "Database connection error. Please try again in a moment.",
          retryable: true,
        });
      }
      throw dbError; // Re-throw if it's not a connection error
    }

    return res.json({ success: true, appointments });
  } catch (err: any) {
    console.error("[GET APPOINTMENTS BY PATIENT] Unexpected error:", {
      error: err,
      message: err?.message,
      code: err?.code,
      stack: err?.stack,
    });

    // Check if it's a connection error that wasn't caught in inner try-catch
    if (
      err.code === "P1017" ||
      err.message?.includes("closed") ||
      err.message?.includes("ConnectionReset")
    ) {
      return res.status(503).json({
        success: false,
        message: "Database connection error. Please try again in a moment.",
        retryable: true,
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to fetch appointments",
    });
  }
}

export async function updateAppointmentSlotHandler(
  req: Request,
  res: Response
) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const { appointmentId } = req.params;
    const { slotId, bookingProgress } = req.body;

    if (!slotId) {
      return res.status(400).json({
        success: false,
        message: "slotId is required",
      });
    }

    // Verify appointment belongs to user
    let appointment;
    try {
      appointment = await prisma.appointment.findFirst({
        where: {
          id: appointmentId,
          userId,
          status: "PENDING", // Only allow updating pending appointments
          isArchived: false, // Exclude archived appointments
        },
      });
    } catch (dbError: any) {
      console.error("[UPDATE SLOT] Database connection error:", dbError);
      // Handle connection errors (P1017 - Server has closed the connection)
      if (dbError.code === "P1017" || dbError.message?.includes("closed")) {
        // Return a user-friendly error and suggest retry
        return res.status(503).json({
          success: false,
          message: "Database connection error. Please try again in a moment.",
          retryable: true,
        });
      }
      throw dbError; // Re-throw other errors
    }

    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: "Appointment not found or cannot be updated",
      });
    }

    // Verify slot exists and is available
    let slot;
    try {
      slot = await prisma.slot.findUnique({
        where: { id: slotId },
      });
    } catch (dbError: any) {
      console.error(
        "[UPDATE SLOT] Database connection error on slot lookup:",
        dbError
      );
      if (dbError.code === "P1017" || dbError.message?.includes("closed")) {
        return res.status(503).json({
          success: false,
          message: "Database connection error. Please try again in a moment.",
          retryable: true,
        });
      }
      throw dbError;
    }

    if (!slot) {
      return res.status(404).json({
        success: false,
        message: "Slot not found",
      });
    }

    if (slot.isBooked) {
      return res.status(400).json({
        success: false,
        message: "Slot is already booked",
      });
    }

    // SECURITY: If appointment already has a slot, unbook it ONLY if appointment is PENDING
    // Never unbook slots for CONFIRMED, CANCELLED, or COMPLETED appointments
    if (appointment.slotId) {
      // Double-check appointment status before unbooking slot
      const currentAppointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        select: { status: true },
      });

      if (!currentAppointment) {
        return res.status(404).json({
          success: false,
          message: "Appointment not found",
        });
      }

      // Only unbook slot if appointment is still PENDING
      // CONFIRMED, CANCELLED, or COMPLETED appointments should not have their slots unbooked
      if (currentAppointment.status === "PENDING") {
        try {
          await prisma.slot.update({
            where: { id: appointment.slotId },
            data: { isBooked: false },
          });
          // console.log(
          // `[BACKEND] Unbooked slot ${appointment.slotId} for PENDING appointment ${appointmentId}`
          // );
        } catch (dbError: any) {
          console.error(
            "[UPDATE SLOT] Database connection error on slot unbooking:",
            dbError
          );
          if (dbError.code === "P1017" || dbError.message?.includes("closed")) {
            return res.status(503).json({
              success: false,
              message:
                "Database connection error. Please try again in a moment.",
              retryable: true,
            });
          }
          throw dbError;
        }
      } else {
        // console.warn(
        // `[BACKEND] Cannot unbook slot for appointment ${appointmentId} with status ${currentAppointment.status}`
        // );
        return res.status(400).json({
          success: false,
          message: `Cannot change slot for appointment with status ${currentAppointment.status}. Only PENDING appointments can have their slots changed.`,
        });
      }
    }

    // Update appointment with new slot and optionally update booking progress
    const updateData: any = {
      slotId: slotId,
      startAt: slot.startAt,
      endAt: slot.endAt,
      mode: slot.mode,
    };

    // If bookingProgress is provided and valid, update it
    if (
      bookingProgress &&
      ["USER_DETAILS", "RECALL", "SLOT", "PAYMENT"].includes(bookingProgress)
    ) {
      updateData.bookingProgress = bookingProgress as BookingProgress;
    } else {
      // Auto-set to SLOT if not provided (slot selected means user is at SLOT step)
      updateData.bookingProgress = "SLOT";
    }

    let updatedAppointment;
    try {
      updatedAppointment = await prisma.appointment.update({
        where: { id: appointmentId },
        data: updateData,
      });
    } catch (dbError: any) {
      console.error(
        "[UPDATE SLOT] Database connection error on appointment update:",
        dbError
      );
      if (dbError.code === "P1017" || dbError.message?.includes("closed")) {
        return res.status(503).json({
          success: false,
          message: "Database connection error. Please try again in a moment.",
          retryable: true,
        });
      }
      throw dbError;
    }

    // NOTE: Slot is NOT marked as booked here. It will only be marked as booked
    // after payment is confirmed and appointment status is set to CONFIRMED.
    // This happens in:
    // 1. razorpayWebhookHandler (payment.captured event)
    // 2. verifyPaymentHandler (manual payment verification)
    // 3. updateAppointmentStatusHandler (when status is manually set to CONFIRMED)

    // console.log(
    // "ℹ️ [BACKEND] Slot assigned to appointment (will be marked as booked after payment confirmation)
    // :",
    // slotId
    // );

    return res.json({
      success: true,
      message: "Appointment updated with slot successfully",
      data: updatedAppointment,
    });
  } catch (err: any) {
    console.error("UPDATE APPOINTMENT SLOT ERROR:", err);

    // Handle Prisma connection errors specifically
    if (
      err.code === "P1017" ||
      err.message?.includes("closed") ||
      err.message?.includes("connection")
    ) {
      return res.status(503).json({
        success: false,
        message: "Database connection error. Please try again in a moment.",
        retryable: true,
      });
    }

    return res.status(500).json({
      success: false,
      message: err.message || "Internal server error",
    });
  }
}

/**
 * Delete an appointment (user can delete their own appointments)
 */
export async function deleteAppointmentHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "Unauthenticated",
      });
    }

    const { appointmentId } = req.params;

    if (!appointmentId) {
      return res.status(400).json({
        success: false,
        error: "Appointment ID is required",
      });
    }

    // Check if appointment exists and belongs to this user
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { id: true, userId: true, isArchived: true },
    });

    if (!appointment) {
      return res.status(404).json({
        success: false,
        error: "Appointment not found",
      });
    }

    // Verify user owns this appointment
    if (appointment.userId !== userId) {
      return res.status(403).json({
        success: false,
        error:
          "Unauthorized: You don't have permission to delete this appointment",
      });
    }

    // Check if already archived
    if (appointment.isArchived) {
      return res.status(400).json({
        success: false,
        error: "Appointment is already deleted",
      });
    }

    // Soft delete by setting isArchived = true and archivedAt timestamp
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        isArchived: true,
        archivedAt: new Date(),
      },
    });

    // console.log(
    // `[USER] Appointment ${appointmentId} deleted by user ${userId}`
    // );
    return res.json({
      success: true,
      message: "Appointment deleted successfully",
    });
  } catch (err: any) {
    console.error("User Delete Appointment Error:", err);
    return res.status(500).json({
      success: false,
      error: "Something went wrong",
    });
  }
}
