import { Request, Response } from "express";
import prisma from "../../database/prismaclient";
import { getSingleDoctorId } from "./appointment.service";
import { AppointmentStatus } from "@prisma/client";
import { AppointmentMode } from "@prisma/client";
import { validatePlanDetails } from "./plan-validation";

export async function createAppointmentHandler(req: Request, res: Response) {
  try {
    console.log(" [BACKEND] Appointment creation request received");
    console.log(
      " [BACKEND] User:",
      req.user ? { id: req.user.id, role: req.user.role } : "NOT AUTHENTICATED"
    );

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
    } = req.body;

    console.log(" [BACKEND] Request body:", {
      patientId,
      slotId: slotId || "none",
      planSlug,
      planName,
      planPrice,
      appointmentMode,
    });

    if (!patientId) {
      console.error(
        " [BACKEND] Appointment creation failed: patientId missing"
      );
      return res.status(400).json({
        success: false,
        message: "patientId is required",
      });
    }

    // Verify patient exists and belongs to the user
    console.log(" [BACKEND] Verifying patient exists...");
    const patient = await prisma.patientDetials.findFirst({
      where: { id: patientId, userId },
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
    console.log(" [BACKEND] Patient verified:", {
      id: patient.id,
      name: patient.name,
    });

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

    console.log(" [BACKEND] Validating plan details...");
    try {
      validatePlanDetails({
        planSlug,
        planName,
        planPrice: Number(planPrice),
        planPackageName: planPackageName || undefined,
        planDuration: planDuration,
      });
      console.log(" [BACKEND] Plan details validated successfully");
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

    if (slotId) {
      console.log(" [BACKEND] Validating slot:", slotId);
      const slot = await prisma.slot.findUnique({
        where: { id: slotId },
      });

      if (!slot) {
        console.error(" [BACKEND] Slot not found:", slotId);
        return res.status(404).json({
          success: false,
          message: "Slot not found",
        });
      }

      if (slot.isBooked) {
        console.error(" [BACKEND] Slot already booked:", slotId);
        return res.status(400).json({
          success: false,
          message: "Slot already booked",
        });
      }

      console.log(" [BACKEND] Slot validated:", {
        id: slot.id,
        startAt: slot.startAt,
        endAt: slot.endAt,
        mode: slot.mode,
      });

      appointmentStartAt = slot.startAt;
      appointmentEndAt = slot.endAt;
      finalSlotId = slotId;
    } else {
      // Create appointment without slot (for recall flow)
      // Use provided startAt/endAt or create placeholder dates
      if (startAt && endAt) {
        console.log(" [BACKEND] Using provided startAt/endAt dates");
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

        // Validate endAt is after startAt
        if (appointmentEndAt <= appointmentStartAt) {
          console.error(" [BACKEND] endAt must be after startAt");
          return res.status(400).json({
            success: false,
            message: "endAt must be after startAt",
          });
        }
      } else {
        // Create placeholder dates (will be updated when slot is selected)
        console.log(
          " [BACKEND] Creating placeholder dates (no slotId provided)"
        );
        appointmentStartAt = new Date();
        appointmentEndAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour later
      }
    }

    console.log(" [BACKEND] Getting doctor ID...");
    let doctorId: string;
    try {
      doctorId = await getSingleDoctorId();
      console.log(" [BACKEND] Doctor ID:", doctorId);
    } catch (doctorError: any) {
      console.error(" [BACKEND] Failed to get doctor ID:", doctorError);
      return res.status(500).json({
        success: false,
        message: doctorError.message || "Failed to get doctor information",
      });
    }

    console.log(" [BACKEND] Creating appointment in database...");
    console.log(" [BACKEND] Appointment data:", {
      userId,
      doctorId,
      patientId,
      slotId: finalSlotId || "none",
      startAt: appointmentStartAt,
      endAt: appointmentEndAt,
      mode: appointmentMode,
      planSlug,
      planName,
      planPrice: Number(planPrice),
      planDuration,
    });

    let appointment;
    try {
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

          planSlug,
          planName,
          planPrice: Number(planPrice),
          planDuration,
          planPackageName,
        },
      });
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
      console.log(
        "ℹ️ [BACKEND] Slot assigned to appointment (will be marked as booked after payment confirmation):",
        finalSlotId
      );
    } else {
      console.log(
        "ℹ️ [BACKEND] No slotId provided, appointment created without slot (will be set later)"
      );
    }

    console.log(" [BACKEND] Appointment created successfully:", {
      id: appointment.id,
      patientId: appointment.patientId,
      status: appointment.status,
      slotId: appointment.slotId,
    });

    return res.status(201).json({
      success: true,
      message: "Appointment created successfully",
      data: appointment,
    });
  } catch (err: any) {
    console.error(" [BACKEND] CREATE APPOINTMENT ERROR:", err);
    console.error(" [BACKEND] Error details:", {
      name: err.name,
      message: err.message,
      code: err.code,
      stack: err.stack,
    });
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
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    // Only return CONFIRMED appointments for users
    // Users should only see appointments that have been successfully paid for
    const appointments = await prisma.appointment.findMany({
      where: {
        userId: req.user.id,
        status: "CONFIRMED", // Only show confirmed (paid) appointments
      },
      orderBy: { startAt: "desc" },
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
    });

    console.log(
      `[USER APPOINTMENTS] Returning ${appointments.length} confirmed appointments for user ${req.user.id}`
    );

    return res.json({ success: true, appointments });
  } catch (err) {
    console.error("GET MY APPOINTMENTS ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to get appointments",
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
          include: {
            files: true,
            recalls: {
              include: {
                entries: true,
              },
              orderBy: { createdAt: "desc" },
            },
          },
        },
        slot: true,
      },
    });

    if (!appointment) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    // Verify the appointment belongs to the user
    if (appointment.userId !== req.user.id) {
      return res.status(403).json({
        error: "Not authorized to view this appointment",
      });
    }

    return res.json({ success: true, appointment });
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

    const patient = await prisma.patientDetials.findFirst({
      where: { id: patientId, userId: req.user.id },
    });

    if (!patient) {
      return res.status(403).json({
        success: false,
        message: "Not allowed",
      });
    }

    const appointments = await prisma.appointment.findMany({
      where: { patientId },
      orderBy: { startAt: "desc" },
      include: {
        slot: true,
        patient: true,
      },
    });

    return res.json({ success: true, appointments });
  } catch (err) {
    console.error("GET APPOINTMENTS BY PATIENT ERROR:", err);
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
    const { slotId } = req.body;

    if (!slotId) {
      return res.status(400).json({
        success: false,
        message: "slotId is required",
      });
    }

    // Verify appointment belongs to user
    const appointment = await prisma.appointment.findFirst({
      where: {
        id: appointmentId,
        userId,
        status: "PENDING", // Only allow updating pending appointments
      },
    });

    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: "Appointment not found or cannot be updated",
      });
    }

    // Verify slot exists and is available
    const slot = await prisma.slot.findUnique({
      where: { id: slotId },
    });

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

    // If appointment already has a slot, unbook it
    if (appointment.slotId) {
      await prisma.slot.update({
        where: { id: appointment.slotId },
        data: { isBooked: false },
      });
    }

    // Update appointment with new slot
    const updatedAppointment = await prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        slotId: slotId,
        startAt: slot.startAt,
        endAt: slot.endAt,
        mode: slot.mode,
      },
    });

    // NOTE: Slot is NOT marked as booked here. It will only be marked as booked
    // after payment is confirmed and appointment status is set to CONFIRMED.
    // This happens in:
    // 1. razorpayWebhookHandler (payment.captured event)
    // 2. verifyPaymentHandler (manual payment verification)
    // 3. updateAppointmentStatusHandler (when status is manually set to CONFIRMED)

    console.log(
      "ℹ️ [BACKEND] Slot assigned to appointment (will be marked as booked after payment confirmation):",
      slotId
    );

    return res.json({
      success: true,
      message: "Appointment updated with slot successfully",
      data: updatedAppointment,
    });
  } catch (err: any) {
    console.error("UPDATE APPOINTMENT SLOT ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}
