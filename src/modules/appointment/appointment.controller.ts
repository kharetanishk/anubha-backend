import { Request, Response } from "express";
import prisma from "../../database/prismaclient";
import { getSingleDoctorId } from "./appointment.service";
import { AppointmentStatus } from "@prisma/client";
import { AppointmentMode } from "@prisma/client";

export async function createAppointmentHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) {
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
    } = req.body;

    if (!patientId || !slotId) {
      return res.status(400).json({
        success: false,
        message: "patientId and slotId are required",
      });
    }

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
        message: "Slot already booked",
      });
    }

    const doctorId = await getSingleDoctorId();

    const appointment = await prisma.appointment.create({
      data: {
        userId,
        doctorId,
        patientId,
        slotId,
        startAt: slot.startAt,
        endAt: slot.endAt,
        mode: appointmentMode,

        planSlug,
        planName,
        planPrice: Number(planPrice),
        planDuration,
        planPackageName,

        status: "PENDING",
      },
    });

    await prisma.slot.update({
      where: { id: slotId },
      data: { isBooked: true },
    });

    return res.status(201).json({
      success: true,
      message: "Appointment created successfully",
      data: appointment,
    });
  } catch (err: any) {
    console.error("APPOINTMENT CREATE ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
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

    const appointments = await prisma.appointment.findMany({
      where: { userId: req.user.id },
      orderBy: { startAt: "desc" },
      include: {
        patient: { select: { name: true } },
        slot: true,
      },
    });

    return res.json({ success: true, appointments });
  } catch (err) {
    console.error("GET MY APPOINTMENTS ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to get appointments",
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
