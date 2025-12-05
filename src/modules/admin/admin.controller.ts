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

/**
 * Get appointments for admin panel
 * Shows ALL appointments (PENDING, CONFIRMED, CANCELLED, COMPLETED) by default
 * Can be filtered by status, date, mode, or search query
 */
export async function adminGetAppointments(req: Request, res: Response) {
  try {
    const { date, status, mode, page = "1", limit = "20", q } = req.query;

    const where: any = {};

    const dateRange = dateRangeFromQuery(date as string | undefined);
    if (dateRange) where.startAt = dateRange;

    // Admin can filter by status, but by default shows all appointments
    // This allows admin to see PENDING appointments that need attention
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
          planName: true,
          paymentStatus: true,
          patient: {
            select: {
              id: true,
              name: true,
              phone: true,
              email: true,
            },
          },
        } as any,
        orderBy: { startAt: "desc" }, // Most recent first
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

    console.log("[ADMIN] Fetching appointment details for ID:", id);

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
        doctor: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        DoctorFormSession: true, // Simplified - no nested values relation
        doctorNotes: true, // Include doctor notes if they exist
      },
    });

    if (!appt) {
      console.log("[ADMIN] Appointment not found:", id);
      return res.status(404).json({ error: "Appointment not found" });
    }

    console.log("[ADMIN] Appointment found successfully");
    return res.json({ success: true, appointment: appt });
  } catch (err: any) {
    console.error("[ADMIN] Get Appointment Details Error:", err);
    console.error("[ADMIN] Error details:", {
      message: err?.message,
      code: err?.code,
      meta: err?.meta,
      stack: err?.stack,
    });
    return res.status(500).json({
      success: false,
      message: "Failed to fetch appointment details",
      error: process.env.NODE_ENV === "development" ? err?.message : undefined,
    });
  }
}

export async function createDoctorSession(req: Request, res: Response) {
  try {
    const adminId = req.user?.id;
    if (!adminId) return res.status(401).json({ error: "Unauthenticated" });

    const { appointmentId, patientId, title, notes, fieldValues } = req.body;
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

    // Check if session already exists for this appointment
    let session;
    if (appointmentId) {
      const existing = await prisma.doctorFormSession.findFirst({
        where: { appointmentId, adminId },
      });
      if (existing) {
        // Session already exists, return it
        session = existing;
      } else {
        // Create new session
        session = await prisma.doctorFormSession.create({
          data: {
            appointmentId: appointmentId ?? null,
            patientId,
            adminId,
          },
        });
      }
    } else {
      session = await prisma.doctorFormSession.create({
        data: {
          appointmentId: appointmentId ?? null,
          patientId,
          adminId,
        },
      });
    }

    // Note: Field values are no longer stored in DoctorFormSession
    // The new schema uses DoctorNotes model for comprehensive form data
    // Field values handling has been moved to the new doctor notes system

    // Return the session
    const updatedSession = await prisma.doctorFormSession.findUnique({
      where: { id: session.id },
    });

    return res.json({ success: true, session: updatedSession });
  } catch (err) {
    console.error("Create Doctor Session Error:", err);
    return res
      .status(500)
      .json({ success: false, message: "from createDoctorsession fucntion" });
  }
}

export async function upsertDoctorFieldValue(req: Request, res: Response) {
  // This endpoint is deprecated - field values are now stored in DoctorNotes model
  return res.status(410).json({
    success: false,
    error: "This endpoint is deprecated. Use the new doctor notes API instead.",
  });
}

export async function getDoctorSession(req: Request, res: Response) {
  try {
    const session = await prisma.doctorFormSession.findUnique({
      where: { id: req.params.id },
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
    const adminId = req.user?.id;
    if (!adminId) return res.status(401).json({ error: "Unauthenticated" });

    const { id } = req.params;
    const session = await prisma.doctorFormSession.findUnique({
      where: { id },
      select: { adminId: true },
    });
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.adminId !== adminId)
      return res.status(403).json({ error: "Not authorized" });

    await prisma.doctorFormSession.delete({ where: { id } });
    return res.json({ success: true });
  } catch (err) {
    console.error("Delete Doctor Session Error:", err);
    return res.status(500).json({ success: false });
  }
}

export async function getDoctorFieldGroups(req: Request, res: Response) {
  // This endpoint is deprecated - the old field system has been replaced
  return res.status(410).json({
    success: false,
    error: "This endpoint is deprecated. Use the new doctor notes API instead.",
    groups: [],
  });
}

export async function searchDoctorFields(req: Request, res: Response) {
  // This endpoint is deprecated - the old field system has been replaced
  return res.status(410).json({
    success: false,
    error: "This endpoint is deprecated. Use the new doctor notes API instead.",
    fields: [],
  });
}

export async function addFieldToSession(req: Request, res: Response) {
  // This endpoint is deprecated - field values are now stored in DoctorNotes model
  return res.status(410).json({
    success: false,
    error: "This endpoint is deprecated. Use the new doctor notes API instead.",
  });
}

export async function saveDoctorSession(req: Request, res: Response) {
  try {
    const adminId = req.user?.id;
    if (!adminId) return res.status(401).json({ error: "Unauthenticated" });

    const { appointmentId, patientId, notes, fieldValues } = req.body;

    if (!patientId) {
      return res.status(400).json({ error: "Missing patientId" });
    }

    // Verify patient exists
    const patient = await prisma.patientDetials.findUnique({
      where: { id: patientId },
      select: { id: true },
    });
    if (!patient) {
      return res.status(404).json({ error: "Patient not found" });
    }

    // Verify appointment if provided
    if (appointmentId) {
      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        select: { id: true, patientId: true },
      });
      if (!appointment) {
        return res.status(404).json({ error: "Appointment not found" });
      }
      if (appointment.patientId !== patientId) {
        return res
          .status(400)
          .json({ error: "Appointment does not belong to this patient" });
      }
    }

    // Find or create session
    let session;
    const existingSession = await prisma.doctorFormSession.findFirst({
      where: {
        appointmentId: appointmentId || null,
        patientId,
        adminId,
      },
    });

    if (existingSession) {
      // Session already exists, use it
      session = existingSession;
    } else {
      // Create new session
      session = await prisma.doctorFormSession.create({
        data: {
          appointmentId: appointmentId || null,
          patientId,
          adminId,
        },
      });
    }

    // Note: DoctorFormSession is now just a tracking model
    // The comprehensive doctor notes with form data should be stored in DoctorNotes model
    // Field values are no longer stored in DoctorFormSession
    // Use the new doctor notes API endpoints for saving comprehensive form data

    // Return the session
    const updatedSession = await prisma.doctorFormSession.findUnique({
      where: { id: session.id },
    });

    return res.json({
      success: true,
      session: updatedSession,
      message: existingSession
        ? "Doctor session updated successfully"
        : "Doctor session created successfully",
    });
  } catch (err: any) {
    console.error("Save Doctor Session Error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to save doctor notes",
    });
  }
}

/**
 * Save comprehensive doctor notes (form data)
 * POST /api/admin/doctor-notes (full submission)
 * PATCH /api/admin/doctor-notes/:appointmentId (partial update)
 */
export async function saveDoctorNotes(req: Request, res: Response) {
  const isPatch = req.method === "PATCH";
  const startTime = Date.now();

  console.log(
    `[BACKEND] ${req.method} /admin/doctor-notes - ${
      isPatch ? "Partial update" : "Full submission"
    }`
  );

  try {
    const adminId = (req as any).user?.id;
    if (!adminId) {
      console.log("[BACKEND] Unauthorized - no admin ID");
      return res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
    }

    // Handle both JSON and multipart/form-data
    let appointmentId: string;
    let parsedFormData: any;
    let isDraft: boolean = false;

    // For PATCH, get appointmentId from params
    if (isPatch) {
      appointmentId = req.params.appointmentId;
      console.log(
        "[BACKEND] PATCH request - Appointment ID from params:",
        appointmentId
      );
    }

    // Check if request is multipart/form-data (has file)
    if (req.file || (req as any).body?.formData) {
      // Multipart form data
      if (!isPatch) {
        appointmentId = (req as any).body.appointmentId;
      }
      const formDataStr = (req as any).body.formData;
      isDraft =
        (req as any).body.isDraft === "true" ||
        (req as any).body.isDraft === true;

      console.log(
        `[BACKEND] Parsing form data - Is Draft: ${isDraft}, Has File: ${!!req.file}`
      );

      try {
        parsedFormData =
          typeof formDataStr === "string"
            ? JSON.parse(formDataStr)
            : formDataStr;
        console.log(
          `[BACKEND] Parsed form data keys: ${Object.keys(parsedFormData).join(
            ", "
          )}`
        );
      } catch (e) {
        console.error("[BACKEND] Failed to parse formData:", e);
        return res.status(400).json({
          success: false,
          error: "Invalid formData format",
        });
      }

      // Handle file upload if present (dietChart)
      if (req.file) {
        // File is available in req.file
        // You can upload to cloudinary or save file path here
        // For now, we'll store the file info in formData
        parsedFormData.dietPrescribed = parsedFormData.dietPrescribed || {};
        parsedFormData.dietPrescribed.dietChartFileName = req.file.originalname;
        parsedFormData.dietPrescribed.dietChartFileSize = req.file.size;
        parsedFormData.dietPrescribed.dietChartMimeType = req.file.mimetype;
      }
    } else {
      // Regular JSON request
      const body = req.body;
      if (!isPatch) {
        appointmentId = body.appointmentId;
      }
      parsedFormData = body.formData;
      isDraft = body.isDraft ?? false;
      console.log(
        `[BACKEND] JSON request - Is Draft: ${isDraft}, Form Data Keys: ${Object.keys(
          parsedFormData || {}
        ).join(", ")}`
      );
    }

    if (!appointmentId) {
      console.error("[BACKEND] Missing appointment ID");
      return res.status(400).json({
        success: false,
        error: "Appointment ID is required",
      });
    }

    // Verify appointment exists
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
    });

    if (!appointment) {
      console.error("[BACKEND] Appointment not found:", appointmentId);
      return res.status(404).json({
        success: false,
        error: "Appointment not found",
      });
    }

    // Check if notes already exist for PATCH
    const existingNotes = await prisma.doctorNotes.findUnique({
      where: { appointmentId: appointmentId },
    });

    // For PATCH, merge with existing data
    if (isPatch && existingNotes) {
      const existingFormData = (existingNotes.formData as any) || {};
      // Deep merge partial data with existing data
      parsedFormData = deepMerge(existingFormData, parsedFormData);
      console.log(
        "[BACKEND] PATCH - Merged with existing data. Changed fields:",
        Object.keys(parsedFormData)
      );
    }

    // Log bodyMeasurements data for debugging
    if (parsedFormData?.bodyMeasurements) {
      console.log(
        "[BACKEND] Body Measurements data:",
        JSON.stringify(parsedFormData.bodyMeasurements, null, 2)
      );
    }

    // Upsert doctor notes
    const doctorNotes = await prisma.doctorNotes.upsert({
      where: {
        appointmentId: appointmentId,
      },
      update: {
        formData: parsedFormData as any,
        isDraft: isDraft ?? false,
        isCompleted: !isDraft,
        submittedAt: isDraft ? null : new Date(),
        updatedBy: adminId,
        updatedAt: new Date(),
      },
      create: {
        appointmentId: appointmentId,
        formData: parsedFormData as any,
        isDraft: isDraft ?? false,
        isCompleted: !isDraft,
        submittedAt: isDraft ? null : new Date(),
        createdBy: adminId,
        updatedBy: adminId,
      },
    });

    // Verify bodyMeasurements was saved
    if (
      doctorNotes.formData &&
      (doctorNotes.formData as any)?.bodyMeasurements
    ) {
      console.log(
        "[SAVE DOCTOR NOTES] Body Measurements saved successfully:",
        JSON.stringify((doctorNotes.formData as any).bodyMeasurements, null, 2)
      );
    } else {
      console.warn(
        "[SAVE DOCTOR NOTES] Warning: bodyMeasurements not found in saved formData"
      );
    }

    const duration = Date.now() - startTime;
    console.log(
      `[BACKEND] ${
        isPatch ? "PATCH" : "POST"
      } completed in ${duration}ms - Notes ID: ${doctorNotes.id}`
    );

    return res.json({
      success: true,
      message: isDraft
        ? "Doctor notes saved as draft"
        : isPatch
        ? "Doctor notes updated successfully"
        : "Doctor notes saved successfully",
      doctorNotes: {
        id: doctorNotes.id,
        appointmentId: doctorNotes.appointmentId,
      },
    });
  } catch (err: any) {
    const duration = Date.now() - startTime;
    console.error(
      `[BACKEND] Save Doctor Notes Error (${duration}ms):`,
      err.message || err
    );
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to save doctor notes",
    });
  }
}

/**
 * Deep merge utility for merging partial updates with existing form data
 */
function deepMerge(target: any, source: any): any {
  const output = { ...target };
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach((key) => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

function isObject(item: any): boolean {
  return item && typeof item === "object" && !Array.isArray(item);
}

/**
 * Get comprehensive doctor notes for an appointment
 * GET /api/admin/doctor-notes/:appointmentId
 */
export async function getDoctorNotes(req: Request, res: Response) {
  const startTime = Date.now();
  console.log("[BACKEND] GET /admin/doctor-notes/:appointmentId");

  try {
    const { appointmentId } = req.params;
    console.log("[BACKEND] Fetching notes for appointment:", appointmentId);

    if (!appointmentId) {
      console.error("[BACKEND] Missing appointment ID");
      return res.status(400).json({
        success: false,
        error: "Appointment ID is required",
      });
    }

    const doctorNotes = await prisma.doctorNotes.findUnique({
      where: {
        appointmentId: appointmentId,
      },
    });

    if (!doctorNotes) {
      const duration = Date.now() - startTime;
      console.log(`[BACKEND] No notes found for appointment (${duration}ms)`);
      return res.json({
        success: true,
        doctorNotes: null,
      });
    }

    // Log bodyMeasurements data for debugging
    if (
      doctorNotes.formData &&
      (doctorNotes.formData as any)?.bodyMeasurements
    ) {
      console.log(
        "[BACKEND] Body Measurements data retrieved:",
        JSON.stringify((doctorNotes.formData as any).bodyMeasurements, null, 2)
      );
    }

    const duration = Date.now() - startTime;
    console.log(
      `[BACKEND] GET completed in ${duration}ms - Notes ID: ${doctorNotes.id}`
    );

    return res.json({
      success: true,
      doctorNotes: {
        id: doctorNotes.id,
        appointmentId: doctorNotes.appointmentId,
        formData: doctorNotes.formData,
        notes: doctorNotes.notes,
        isDraft: doctorNotes.isDraft,
        isCompleted: doctorNotes.isCompleted,
        createdAt: doctorNotes.createdAt.toISOString(),
        updatedAt: doctorNotes.updatedAt.toISOString(),
      },
    });
  } catch (err: any) {
    const duration = Date.now() - startTime;
    console.error(
      `[BACKEND] Get Doctor Notes Error (${duration}ms):`,
      err.message || err
    );
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to get doctor notes",
    });
  }
}
