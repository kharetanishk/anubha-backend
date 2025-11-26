import prisma from "../../database/prismaclient";
import { AppointmentStatus } from "@prisma/client";
import { AppointmentMode } from "@prisma/client";
import { Request, Response } from "express";

function dateRangeFromQuery(dateStr?: string) {
  if (!dateStr) return undefined;
  const day = new Date(dateStr);
  day.setHours(0, 0, 0, 0);
  const nextDay = new Date(day);
  nextDay.setDate(day.getDate() + 1);
  return { gte: day, lt: nextDay };
}

export async function adminGetAppointments(req: Request, res: Response) {
  try {
    const { date, status, mode, page = "1", limit = "20", q } = req.query;

    const where: any = {};

    const dateRange = dateRangeFromQuery(date as string | undefined);
    if (dateRange) where.startAt = dateRange;

    if (status) where.status = status as AppointmentStatus;

    if (mode) where.mode = mode as AppointmentMode;

    if (q && typeof q === "string") {
      where.OR = [
        { patient: { name: { contains: q, mode: "insensitive" } } },
        { patient: { phone: { contains: q, mode: "insensitive" } } },
        { patient: { email: { contains: q, mode: "insensitive" } } },
      ];
    }

    const pageNum = Math.max(1, Number(page));
    const lim = Math.min(200, Math.max(1, Number(limit)));
    const skip = (pageNum - 1) * lim;

    const [appointments, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        select: {
          id: true,
          startAt: true,
          endAt: true,
          status: true,
          mode: true,
          patient: {
            select: {
              id: true,
              name: true,
              phone: true,
              email: true,
            },
          },
        },
        orderBy: { startAt: "asc" },
        skip,
        take: lim,
      }),
      prisma.appointment.count({ where }),
    ]);

    return res.json({
      success: true,
      total,
      page: pageNum,
      limit: lim,
      appointments,
    });
  } catch (err) {
    console.error("Admin Get Appointments Error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Something went wrong" });
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

export async function adminGetAppointmentDetails(req: Request, res: Response) {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "Missing id param" });

    const appt = await prisma.appointment.findUnique({
      where: { id },
      include: {
        patient: {
          include: {
            files: true,
            recalls: {
              include: { entries: true },
            },
          },
        },
        slot: true,
        doctor: true,
        DoctorFormSession: {
          include: {
            values: {
              include: {
                field: {
                  include: { options: true },
                },
              },
            },
          },
        },
      },
    });

    if (!appt) return res.status(404).json({ error: "Appointment not found" });

    return res.json({ success: true, appointment: appt });
  } catch (err) {
    console.error("Admin Get Appointment Details Error:", err);
    return res
      .status(500)
      .json({ success: false, message: "from adminGetappointmentdetails" });
  }
}

export async function createDoctorSession(req: Request, res: Response) {
  try {
    const doctorId = req.user?.id;
    if (!doctorId) return res.status(401).json({ error: "Unauthenticated" });

    const { appointmentId, patientId, title } = req.body;
    if (!patientId) return res.status(400).json({ error: "Missing patientId" });

    if (appointmentId) {
      const appt = await prisma.appointment.findUnique({
        where: { id: appointmentId },
      });
      if (!appt)
        return res.status(404).json({ error: "Appointment not found" });
      if (appt.patientId !== patientId) {
        return res
          .status(400)
          .json({ error: "Appointment does not belong to patientId" });
      }
    }

    const session = await prisma.doctorFormSession.create({
      data: {
        appointmentId: appointmentId ?? null,
        patientId,
        doctorId,
        title: title ?? "Assessment",
      },
      include: { values: { include: { field: true } } },
    });

    return res.json({ success: true, session });
  } catch (err) {
    console.error("Create Doctor Session Error:", err);
    return res
      .status(500)
      .json({ success: false, message: "from createDoctorsession fucntion" });
  }
}

export async function upsertDoctorFieldValue(req: Request, res: Response) {
  try {
    const doctorId = req.user?.id;
    if (!doctorId) return res.status(401).json({ error: "Unauthenticated" });

    const { sessionId } = req.params;
    const { fieldId, value } = req.body;
    if (!sessionId || !fieldId || !value)
      return res.status(400).json({ error: "Missing body" });

    const session = await prisma.doctorFormSession.findUnique({
      where: { id: sessionId },
      select: { doctorId: true },
    });
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.doctorId !== doctorId)
      return res.status(403).json({ error: "Not authorized" });

    const field = await prisma.doctorFieldMaster.findUnique({
      where: { id: fieldId },
      select: { id: true, type: true },
    });
    if (!field) return res.status(404).json({ error: "Field not found" });

    const allowedKeys = [
      "stringValue",
      "numberValue",
      "booleanValue",
      "dateValue",
      "timeValue",
      "jsonValue",
      "notes",
    ];
    const cleanData: any = {};
    for (const k of allowedKeys) {
      if (value[k] !== undefined) cleanData[k] = value[k];
    }

    const existing = await prisma.doctorFormFieldValue.findFirst({
      where: { sessionId, fieldId },
    });

    let saved;
    if (existing) {
      saved = await prisma.doctorFormFieldValue.update({
        where: { id: existing.id },
        data: cleanData,
        include: { field: { include: { options: true } } },
      });
    } else {
      saved = await prisma.doctorFormFieldValue.create({
        data: { sessionId, fieldId, ...cleanData },
        include: { field: { include: { options: true } } },
      });
    }

    return res.json({ success: true, value: saved });
  } catch (err) {
    console.error("Upsert Doctor Field Value Error:", err);
    return res.status(500).json({ success: false });
  }
}

export async function getDoctorSession(req: Request, res: Response) {
  try {
    const session = await prisma.doctorFormSession.findUnique({
      where: { id: req.params.id },
      include: {
        values: {
          include: { field: { include: { options: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!session) return res.status(404).json({ error: "Session not found" });
    return res.json({ success: true, session });
  } catch (err) {
    console.error("Get Doctor Session Error:", err);
    return res.status(500).json({ success: false });
  }
}

export async function deleteDoctorSession(req: Request, res: Response) {
  try {
    const doctorId = req.user?.id;
    if (!doctorId) return res.status(401).json({ error: "Unauthenticated" });

    const { id } = req.params;
    const session = await prisma.doctorFormSession.findUnique({
      where: { id },
      select: { doctorId: true },
    });
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.doctorId !== doctorId)
      return res.status(403).json({ error: "Not authorized" });

    await prisma.doctorFormSession.delete({ where: { id } });
    return res.json({ success: true });
  } catch (err) {
    console.error("Delete Doctor Session Error:", err);
    return res.status(500).json({ success: false });
  }
}

export async function getDoctorFieldGroups(req: Request, res: Response) {
  try {
    const groups = await prisma.doctorFieldGroup.findMany({
      orderBy: { order: "asc" },
      include: {
        fields: {
          where: { active: true },
          orderBy: { order: "asc" },
          include: { options: true },
        },
      },
    });
    return res.json({ success: true, groups });
  } catch (err) {
    console.error("Get Doctor Field Groups Error:", err);
    return res.status(500).json({ success: false });
  }
}

export async function searchDoctorFields(req: Request, res: Response) {
  try {
    const q = (req.query.q as string) || "";
    const fields = await prisma.doctorFieldMaster.findMany({
      where: {
        active: true,
        OR: [
          { label: { contains: q, mode: "insensitive" } },
          { key: { contains: q, mode: "insensitive" } },
        ],
      },
      include: { options: true },
      orderBy: { order: "asc" },
      take: 50,
    });
    return res.json({ success: true, fields });
  } catch (err) {
    console.error("Search Doctor Fields Error:", err);
    return res.status(500).json({ success: false });
  }
}

export async function addFieldToSession(req: Request, res: Response) {
  try {
    const doctorId = req.user?.id;
    if (!doctorId) return res.status(401).json({ error: "Unauthenticated" });

    const { sessionId } = req.params;
    const { fieldId } = req.body;
    if (!sessionId || !fieldId)
      return res.status(400).json({ error: "Missing params" });

    const session = await prisma.doctorFormSession.findUnique({
      where: { id: sessionId },
      select: { doctorId: true },
    });
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.doctorId !== doctorId) {
      return res
        .status(403)
        .json({ error: "Not authorized to modify this session" });
    }

    const field = await prisma.doctorFieldMaster.findUnique({
      where: { id: fieldId },
      select: { id: true },
    });
    if (!field) return res.status(404).json({ error: "Field not found" });

    const value = await prisma.doctorFormFieldValue.create({
      data: {
        sessionId,
        fieldId,
      },
      include: { field: { include: { options: true } } },
    });

    return res.json({ success: true, value });
  } catch (err) {
    console.error("Add Field To Session Error:", err);
    return res.status(500).json({ success: false });
  }
}
