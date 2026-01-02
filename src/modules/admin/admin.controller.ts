import prisma from "../../database/prismaclient";
import { AppointmentStatus } from "@prisma/client";
import { AppointmentMode } from "@prisma/client";
import { Request, Response } from "express";
import {
  sendPatientConfirmationMessage,
  sendDoctorNotificationMessage,
  formatDateForTemplate,
  formatTimeForTemplate,
} from "../../services/whatsapp.service";
import { getSingleAdmin } from "../slots/slots.services";
import {
  uploadPDFToCloudinary,
  generateSignedUrl,
  deleteFromCloudinary,
} from "../../util/cloudinary";

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

    // Exclude archived appointments and admin-deleted appointments from admin view
    where.isArchived = false;
    where.isDeletedByAdmin = false; // Admin-only soft delete: hide from admin view

    const [appointments, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        select: {
          id: true,
          startAt: true,
          endAt: true,
          createdAt: true,
          status: true,
          mode: true,
          planName: true,
          planSlug: true,
          planPackageName: true,
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

/**
 * Admin-only soft delete: Removes appointment from admin view only
 * Does NOT affect user visibility - appointment remains visible to user
 */
export async function adminDeleteAppointment(req: Request, res: Response) {
  try {
    const adminId = req.user?.id;
    if (!adminId) {
      return res.status(401).json({ success: false, error: "Unauthenticated" });
    }

    const { id } = req.params;
    // Handle DELETE requests that may not have a body, or PATCH requests with optional body
    const body = req.body || {};
    const { reason, scope } = body as {
      reason?: string;
      scope?: "admin" | "global";
    };

    // Check if appointment exists and belongs to this admin
    const appointment = await prisma.appointment.findUnique({
      where: { id },
      select: {
        id: true,
        doctorId: true,
        isArchived: true,
        isDeletedByAdmin: true,
      },
    });

    if (!appointment) {
      return res.status(404).json({
        success: false,
        error: "Appointment not found",
      });
    }

    // Verify admin owns/manages this appointment
    if (appointment.doctorId !== adminId) {
      return res.status(403).json({
        success: false,
        error:
          "Unauthorized: You don't have permission to delete this appointment",
      });
    }

    // Determine delete scope: default to admin-only, allow global archive if explicitly requested
    const deleteScope = scope || "admin";

    if (deleteScope === "global") {
      // Global archive: removes from both admin and user views
      if (appointment.isArchived) {
        return res.status(400).json({
          success: false,
          error: "Appointment is already archived globally",
        });
      }

      await prisma.appointment.update({
        where: { id },
        data: {
          isArchived: true,
          archivedAt: new Date(),
          isDeletedByAdmin: true, // Also mark as admin-deleted for audit
          deletedByAdminAt: new Date(),
          deletedByAdminReason: reason || "Archived globally by admin",
        },
      });

      // console.log(
      // `[ADMIN] Appointment ${id} archived globally by admin ${adminId}`
      // );
      return res.json({
        success: true,
        message: "Appointment archived globally (removed from all views)",
        scope: "global",
      });
    } else {
      // Admin-only delete: only removes from admin view, user still sees it
      if (appointment.isDeletedByAdmin) {
        return res.status(400).json({
          success: false,
          error: "Appointment is already deleted from admin view",
        });
      }

      await prisma.appointment.update({
        where: { id },
        data: {
          isDeletedByAdmin: true,
          deletedByAdminAt: new Date(),
          deletedByAdminReason: reason || null,
        },
      });

      // console.log(
      // `[ADMIN] Appointment ${id} deleted from admin view only by admin ${adminId} (user can still see it)
      // `
      // );

      return res.json({
        success: true,
        message:
          "Appointment deleted from admin dashboard (user view unaffected)",
        scope: "admin",
      });
    }
  } catch (err: any) {
    console.error("Admin Delete Appointment Error:", err);
    return res.status(500).json({
      success: false,
      error: "Something went wrong",
    });
  }
}

export async function adminUpdateAppointmentStatus(
  req: Request,
  res: Response
) {
  try {
    const adminId = req.user?.id;
    if (!adminId) {
      return res.status(401).json({ error: "Unauthenticated" });
    }

    const { id } = req.params;
    const { status } = req.body as { status: AppointmentStatus };

    if (!status) {
      return res.status(400).json({ error: "Missing status" });
    }

    // Use transaction with row-level locking to prevent race conditions
    let previousStatus: AppointmentStatus | null = null;
    const result = await prisma.$transaction(
      async (tx) => {
        // Lock appointment row to prevent concurrent updates
        const lockedAppt = await tx.$queryRaw<
          Array<{
            id: string;
            status: string;
            doctorId: string;
            slotId: string | null;
          }>
        >`
          SELECT id, status, "doctorId", "slotId"
          FROM "Appointment"
          WHERE id = ${id}
          FOR UPDATE
        `;

        if (!lockedAppt || lockedAppt.length === 0) {
          return { error: "Appointment not found", status: 404 };
        }

        const appointment = lockedAppt[0];

        // Authorization check: Verify admin owns/manages this appointment
        if (appointment.doctorId !== adminId) {
          // console.warn(
          // "[AUTH] Unauthorized appointment status update attempt:",
          // {
          // adminId,
          // appointmentId: id,
          // appointmentDoctorId: appointment.doctorId,
          // attemptedStatus: status,
          // timestamp: new Date()
          // .toISOString(),
          // }
          // );
          return {
            error:
              "Forbidden. You don't have permission to modify this appointment.",
            status: 403,
          };
        }

        const current = appointment.status as AppointmentStatus;
        previousStatus = current; // Store for notification check

        if (current === "CANCELLED" || current === "COMPLETED") {
          return {
            error: `Cannot modify an appointment that is ${current}`,
            status: 400,
          };
        }

        const allowedStatuses: AppointmentStatus[] = [
          "PENDING",
          "CONFIRMED",
          "CANCELLED",
          "COMPLETED",
        ];

        if (!allowedStatuses.includes(status)) {
          return { error: "Invalid status", status: 400 };
        }

        // Prepare update data
        const updateData: any = { status };

        // Clear bookingProgress when appointment is confirmed (no longer pending)
        if (status === "CONFIRMED") {
          updateData.bookingProgress = null;
        }

        // Update appointment atomically
        const updated = await tx.appointment.update({
          where: { id },
          data: updateData,
        });

        // Update slot status atomically within same transaction
        if (appointment.slotId) {
          if (status === "CANCELLED") {
            await tx.slot.update({
              where: { id: appointment.slotId },
              data: { isBooked: false },
            });
          } else if (status === "CONFIRMED") {
            await tx.slot.update({
              where: { id: appointment.slotId },
              data: { isBooked: true },
            });
          }
        }

        // CRITICAL: If confirming appointment, archive any duplicate PENDING appointments
        // This ensures only ONE active appointment exists per booking
        if (status === "CONFIRMED") {
          // Fetch appointment details needed for duplicate cleanup
          const confirmedAppt = await tx.appointment.findUnique({
            where: { id },
            select: {
              userId: true,
              patientId: true,
              startAt: true,
              planSlug: true,
            },
          });

          if (confirmedAppt) {
            const {
              archiveDuplicatePendingAppointments,
            } = require("../payment/payment.controller");
            await archiveDuplicatePendingAppointments(tx, id, {
              userId: confirmedAppt.userId,
              patientId: confirmedAppt.patientId,
              startAt: confirmedAppt.startAt,
              planSlug: confirmedAppt.planSlug || "",
            });
          }
        }

        return { appointment: updated };
      },
      {
        timeout: 10000, // 10 second timeout
        isolationLevel: "ReadCommitted",
      }
    );

    if (result.error) {
      return res.status(result.status || 500).json({ error: result.error });
    }

    const updated = result.appointment!;

    // Send WhatsApp notifications if appointment is being confirmed
    // This handles manual confirmation by admin (not just payment flow)
    if (status === "CONFIRMED" && previousStatus !== "CONFIRMED") {
      // console.log("==========================================");
      // console.log(
      // "[ADMIN] Appointment manually confirmed, sending WhatsApp notifications..."
      // );
      // console.log("  Appointment ID:", id);
      // console.log("  Previous Status:", previousStatus);
      // console.log("  New Status:", status);
      // console.log("==========================================");
      // Fetch appointment with patient and doctor details for notifications
      const appointmentWithDetails = await prisma.appointment.findUnique({
        where: { id },
        include: {
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

      if (appointmentWithDetails) {
        // Send notifications asynchronously (non-blocking)
        sendWhatsAppNotificationsForAdminConfirmation(
          appointmentWithDetails
        ).catch((error: any) => {
          console.error(
            "[ADMIN] WhatsApp notification failed (non-blocking):",
            error.message
          );
        });
      }
    }

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
    const adminId = req.user?.id;
    if (!adminId) {
      return res.status(401).json({ error: "Unauthenticated" });
    }

    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "Missing id param" });

    // console.log("[ADMIN] Fetching appointment details for ID:", id);
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
      // console.log("[ADMIN] Appointment not found:", id);
      return res.status(404).json({ error: "Appointment not found" });
    }

    // Authorization check: Verify admin owns/manages this appointment
    if (appt.doctorId !== adminId) {
      // console.warn("[AUTH] Unauthorized appointment details access attempt:", {
      // adminId,
      // appointmentId: id,
      // appointmentDoctorId: appt.doctorId,
      // timestamp: new Date()
      // .toISOString(),
      // });
      // return res.status(403).json({
      //   error: "Forbidden. You don't have permission to access this appointment.",
      // });
      return res.status(403).json({
        success: false,
        error:
          "Forbidden. You don't have permission to access this appointment.",
      });
    }

    // console.log("[ADMIN] Appointment found successfully");
    return res.json({ success: true, appointment: appt });
  } catch (err: any) {
    if (process.env.NODE_ENV !== "production") {
      console.error("[ADMIN] Get Appointment Details Error:", err);
      console.error("[ADMIN] Error details:", {
        message: err?.message,
        code: err?.code,
        meta: err?.meta,
        stack: err?.stack,
      });
    } else {
      console.error("[ADMIN] Get Appointment Details Error:", {
        message: err?.message,
        code: err?.code,
      });
    }
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
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
        select: {
          id: true,
          patientId: true,
          doctorId: true,
        },
      });
      if (!appt)
        return res.status(404).json({ error: "Appointment not found" });
      if (appt.patientId !== patientId) {
        return res
          .status(400)
          .json({ error: "Appointment does not belong to patientId" });
      }
      // Authorization check: Verify admin owns/manages this appointment
      if (appt.doctorId !== adminId) {
        // console.warn("[AUTH] Unauthorized doctor session creation attempt:", {
        // adminId,
        // appointmentId,
        // appointmentDoctorId: appt.doctorId,
        // timestamp: new Date()
        // .toISOString(),
        // });
        // return res.status(403).json({
        //   error: "Forbidden. You don't have permission to create a session for this appointment.",
        // });
        return res.status(403).json({
          success: false,
          error:
            "Forbidden. You don't have permission to create a session for this appointment.",
        });
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
        select: { id: true, patientId: true, doctorId: true },
      });
      if (!appointment) {
        return res.status(404).json({ error: "Appointment not found" });
      }
      if (appointment.patientId !== patientId) {
        return res
          .status(400)
          .json({ error: "Appointment does not belong to this patient" });
      }
      // Authorization check: Verify admin owns/manages this appointment
      if (appointment.doctorId !== adminId) {
        // console.warn("[AUTH] Unauthorized doctor session save attempt:", {
        // adminId,
        // appointmentId,
        // appointmentDoctorId: appointment.doctorId,
        // timestamp: new Date()
        // .toISOString(),
        // });
        // return res.status(403).json({
        //   error: "Forbidden. You don't have permission to save a session for this appointment.",
        // });
        return res.status(403).json({
          success: false,
          error:
            "Forbidden. You don't have permission to save a session for this appointment.",
        });
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
      error: "Something went wrong",
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

  // console.log(
  // `[BACKEND] ${req.method} /admin/doctor-notes - ${
  // isPatch ? "Partial update" : "Full submission"
  // }`
  // );
  try {
    const adminId = (req as any).user?.id;
    if (!adminId) {
      // console.log("[BACKEND] Unauthorized - no admin ID");
      return res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
    }

    // Handle both JSON and multipart/form-data
    let appointmentId: string | undefined;
    let parsedFormData: any;
    let isDraft: boolean = false;

    // For PATCH, get appointmentId from params
    if (isPatch) {
      appointmentId = req.params.appointmentId;
      // console.log(
      //   "[BACKEND] PATCH request - Appointment ID from params:",
      //   appointmentId
      // );
    }

    // Check if request is multipart/form-data (has files)
    const files = (req.files as Express.Multer.File[]) || [];
    const hasFiles = files.length > 0;

    if (hasFiles || (req as any).body?.formData) {
      // Multipart form data
      if (!isPatch) {
        appointmentId = (req as any).body.appointmentId;
      }
      const formDataStr = (req as any).body.formData;
      isDraft =
        (req as any).body.isDraft === "true" ||
        (req as any).body.isDraft === true;

      // console.log(
      //   `[BACKEND] Parsing form data - Is Draft: ${isDraft}, Has Files: ${hasFiles}, File Count: ${files.length}`
      // );
      try {
        parsedFormData =
          typeof formDataStr === "string"
            ? JSON.parse(formDataStr)
            : formDataStr;
        // console.log(
        // `[BACKEND] Parsed form data keys: ${Object.keys(parsedFormData)
        // .join(
        // ", "
        // )}`
        // );
      } catch (e) {
        console.error("[BACKEND] Failed to parse formData:", e);
        return res.status(400).json({
          success: false,
          error: "Invalid formData format",
        });
      }

      // Handle multiple file uploads (dietChart PDFs)
      if (hasFiles) {
        // console.log(`[BACKEND] Processing ${files.length} file upload(s)
        // `);

        const uploadedFiles: Array<{
          fileName: string;
          fileUrl: string;
          publicId: string;
          mimeType: string;
          sizeInBytes: number;
        }> = [];

        // Process each file
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          // console.log(`[BACKEND] Processing file ${i + 1}/${files.length}:`, {
          // filename: file.originalname,
          // mimetype: file.mimetype,
          // size: file.size,
          // });
          try {
            // Upload file to Cloudinary
            const base64 = `data:${file.mimetype};base64,${file.buffer.toString(
              "base64"
            )}`;

            // Generate unique public_id
            const timestamp = Date.now();
            const randomStr = Math.random().toString(36).substring(2, 15);
            const uniqueId = `nutriwell_diet_chart_${timestamp}_${randomStr}_${i}`;

            // Upload to Cloudinary using utility function
            const cloudinaryResult = await uploadPDFToCloudinary(base64, {
              folder: "nutriwell_diet_charts",
              publicId: uniqueId,
              context: {
                uploaded_at: new Date().toISOString(),
                uploaded_by: adminId,
                original_filename: file.originalname,
                appointment_id: appointmentId || "unknown",
                file_index: i.toString(),
              },
            });

            // console.log(`[BACKEND] File ${i + 1} uploaded to Cloudinary:`, {
            // publicId: cloudinaryResult.public_id,
            // url: cloudinaryResult.secure_url,
            // resourceType: cloudinaryResult.resource_type,
            // });
            // Use Cloudinary's secure_url directly - it includes proper Content-Type headers
            // No need for signed URLs when using resource_type: "auto"
            const fileUrl = cloudinaryResult.secure_url;

            // Store file info
            uploadedFiles.push({
              fileName: file.originalname,
              fileUrl: fileUrl,
              publicId: cloudinaryResult.public_id,
              mimeType: file.mimetype,
              sizeInBytes: file.size,
            });

            // Store first file info in formData for backward compatibility
            if (i === 0) {
              parsedFormData.dietPrescribed =
                parsedFormData.dietPrescribed || {};
              parsedFormData.dietPrescribed.dietChartFileName =
                file.originalname;
              parsedFormData.dietPrescribed.dietChartFileSize = file.size;
              parsedFormData.dietPrescribed.dietChartMimeType = file.mimetype;
              parsedFormData.dietPrescribed.dietChartUrl = fileUrl;
              parsedFormData.dietPrescribed.dietChartPublicId =
                cloudinaryResult.public_id;
            }
          } catch (uploadError: any) {
            console.error(`[BACKEND] File ${i + 1} upload error:`, uploadError);
            return res.status(500).json({
              success: false,
              error: `Failed to upload file "${file.originalname}": ${
                uploadError.message || "Unknown error"
              }`,
            });
          }
        }

        // Store all uploaded files for attachment creation
        (req as any).uploadedFiles = uploadedFiles;

        // console.log(
        // `[BACKEND] Successfully processed ${uploadedFiles.length} file(s)
        // `
        // );
      }
    } else {
      // Regular JSON request
      const body = req.body;
      if (!isPatch) {
        appointmentId = body.appointmentId;
      }
      parsedFormData = body.formData;
      isDraft = body.isDraft ?? false;
      // console.log(
      // `[BACKEND] JSON request - Is Draft: ${isDraft}, Form Data Keys: ${Object.keys(
      // parsedFormData || {}
      // )
      // .join(", ")}`
      // );
    }

    // Validate appointmentId is present
    if (!appointmentId) {
      console.error("[BACKEND] Missing appointment ID");
      return res.status(400).json({
        success: false,
        error: "Appointment ID is required",
      });
    }

    // TypeScript now knows appointmentId is defined after the check above
    const validatedAppointmentId: string = appointmentId;

    // Verify appointment exists
    const appointment = await prisma.appointment.findUnique({
      where: { id: validatedAppointmentId },
      select: {
        id: true,
        doctorId: true,
      },
    });

    if (!appointment) {
      console.error("[BACKEND] Appointment not found:", validatedAppointmentId);
      return res.status(404).json({
        success: false,
        error: "Appointment not found",
      });
    }

    // Authorization check: Verify admin owns/manages this appointment
    if (appointment.doctorId !== adminId) {
      // console.warn("[AUTH] Unauthorized doctor notes save attempt:", {
      // adminId,
      // appointmentId: validatedAppointmentId,
      // appointmentDoctorId: appointment.doctorId,
      //   timestamp: new Date().toISOString(),
      // });
      return res.status(403).json({
        success: false,
        error:
          "Forbidden. You don't have permission to modify notes for this appointment.",
      });
    }

    // Check if notes already exist for PATCH
    const existingNotes = await prisma.doctorNotes.findUnique({
      where: { appointmentId: validatedAppointmentId },
    });

    // For PATCH, merge with existing data
    if (isPatch && existingNotes) {
      const existingFormData = (existingNotes.formData as any) || {};
      // Deep merge partial data with existing data
      parsedFormData = deepMerge(existingFormData, parsedFormData);
      // console.log(
      // "[BACKEND] PATCH - Merged with existing data. Changed fields:",
      // Object.keys(parsedFormData)
      // );
    }

    // Log bodyMeasurements data for debugging
    if (parsedFormData?.bodyMeasurements) {
      // console.log(
      // "[BACKEND] Body Measurements data:",
      // JSON.stringify(parsedFormData.bodyMeasurements, null, 2)
      // );
    }

    // Upsert doctor notes
    const doctorNotes = await prisma.doctorNotes.upsert({
      where: {
        appointmentId: validatedAppointmentId,
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
        appointmentId: validatedAppointmentId,
        formData: parsedFormData as any,
        isDraft: isDraft ?? false,
        isCompleted: !isDraft,
        submittedAt: isDraft ? null : new Date(),
        createdBy: adminId,
        updatedBy: adminId,
      },
    });

    // Handle file attachments if files were uploaded
    const uploadedFiles = (req as any).uploadedFiles || [];
    if (uploadedFiles.length > 0) {
      // console.log(`[BACKEND] Creating ${uploadedFiles.length} attachment(s)
      // `);

      // Create attachments for each uploaded file
      for (const uploadedFile of uploadedFiles) {
        // Check if attachment with same publicId already exists
        const existingAttachment = await prisma.doctorNoteAttachment.findFirst({
          where: {
            doctorNotesId: doctorNotes.id,
            filePath: uploadedFile.publicId, // Match by Cloudinary public_id
            isArchived: false,
          },
        });

        if (existingAttachment) {
          // Update existing attachment
          await prisma.doctorNoteAttachment.update({
            where: { id: existingAttachment.id },
            data: {
              fileName: uploadedFile.fileName,
              fileUrl: uploadedFile.fileUrl,
              mimeType: uploadedFile.mimeType,
              sizeInBytes: uploadedFile.sizeInBytes,
              updatedAt: new Date(),
            },
          });
          // console.log(
          // `[BACKEND] Updated existing attachment: ${uploadedFile.fileName}`
          // );
        } else {
          // Create new attachment
          await prisma.doctorNoteAttachment.create({
            data: {
              doctorNotesId: doctorNotes.id,
              fileName: uploadedFile.fileName,
              filePath: uploadedFile.publicId, // Store Cloudinary public_id as filePath
              fileUrl: uploadedFile.fileUrl,
              mimeType: uploadedFile.mimeType,
              sizeInBytes: uploadedFile.sizeInBytes,
              provider: "CLOUDINARY",
              fileCategory: "DIET_CHART",
              section: "DietPrescribed",
            },
          });
          // console.log(
          //   `[BACKEND] Created new attachment: ${uploadedFile.fileName}`
          // );
        }
      }

      // console.log(
      // `[BACKEND] Successfully processed ${uploadedFiles.length} attachment(s)
      // `
      // );
    }

    // Verify bodyMeasurements was saved
    if (
      doctorNotes.formData &&
      (doctorNotes.formData as any)?.bodyMeasurements
    ) {
      // console.log(
      // "[SAVE DOCTOR NOTES] Body Measurements saved successfully:",
      // JSON.stringify((doctorNotes.formData as any)
      // .bodyMeasurements, null, 2)
      // );
    } else {
      // console.warn(
      // "[SAVE DOCTOR NOTES] Warning: bodyMeasurements not found in saved formData"
      // );
    }

    const duration = Date.now() - startTime;
    // console.log(
    // `[BACKEND] ${
    // isPatch ? "PATCH" : "POST"
    // } completed in ${duration}ms - Notes ID: ${doctorNotes.id}`
    // );
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

    // Log comprehensive error details
    console.error(`[BACKEND] Save Doctor Notes Error (${duration}ms):`, {
      error: err,
      errorType: err?.constructor?.name,
      errorMessage: err?.message,
      errorStack: err?.stack,
      errorName: err?.name,
      errorCode: err?.code,
      errorStatus: err?.status,
      errorResponse: err?.response,
    });

    // Handle different error types
    let statusCode = 500;
    let errorMessage = "Failed to save doctor notes";

    // Check if it's a validation error from middleware
    if (err?.status === 400 || err?.response?.status === 400) {
      statusCode = 400;
      if (err?.response?.data?.errors) {
        errorMessage = err.response.data.errors.join(". ");
      } else if (err?.response?.data?.error) {
        errorMessage = err.response.data.error;
      } else if (err?.response?.data?.message) {
        errorMessage = err.response.data.message;
      }
    } else if (err?.message) {
      errorMessage = err.message;
    } else if (typeof err === "string") {
      errorMessage = err;
    }

    return res.status(statusCode).json({
      success: false,
      error: errorMessage,
      ...(err?.response?.data?.errors && { errors: err.response.data.errors }),
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
 * Send WhatsApp notifications when admin manually confirms an appointment
 */
async function sendWhatsAppNotificationsForAdminConfirmation(appointment: any) {
  try {
    // console.log("==========================================");
    // console.log("[ADMIN WHATSAPP] Sending confirmation notifications...");
    // console.log("  Appointment ID:", appointment.id);
    // console.log("  Appointment Status: CONFIRMED (by admin)
    // ");
    // console.log("==========================================");
    // Get patient phone number
    const patientPhone = appointment.patient?.phone;
    const patientName = appointment.patient?.name || "Patient";

    if (!patientPhone) {
      // console.warn(
      // "[ADMIN WHATSAPP] ⚠️ Patient phone not found, skipping patient notification"
      // );
    } else {
      // console.log("[ADMIN WHATSAPP] Sending patient confirmation message...");
      // console.log("  Patient Name:", patientName);
      // console.log("  Patient Phone:", patientPhone);
      const patientResult = await sendPatientConfirmationMessage(patientPhone);

      if (patientResult.success) {
        // console.log("==========================================");
        // console.log(
        // "[ADMIN WHATSAPP] ✅ Patient notification sent successfully"
        // );
        // console.log("  Patient Phone:", patientPhone);
        // console.log("  Patient Name:", patientName);
        // console.log("==========================================");
      } else {
        console.error("==========================================");
        console.error("[ADMIN WHATSAPP] ❌ Patient notification failed");
        console.error("  Patient Phone:", patientPhone);
        console.error("  Error:", patientResult.error);
        console.error("==========================================");
      }
    }

    // Get doctor phone number
    const doctorPhone = appointment.doctor?.phone;
    const doctorName = appointment.doctor?.name || "Doctor";

    // Prepare data for doctor notification
    const planName = appointment.planName || "Consultation Plan";
    const slotStartTime = appointment.slot?.startAt || appointment.startAt;
    const slotEndTime = appointment.slot?.endAt || appointment.endAt;

    // Format appointment date and slot time
    const appointmentDate = formatDateForTemplate(slotStartTime);
    const slotTimeFormatted = formatTimeForTemplate(slotStartTime, slotEndTime);

    if (!doctorPhone) {
      // console.log(
      // "[ADMIN WHATSAPP] Doctor phone not found in appointment, trying admin fallback..."
      // );
      try {
        const admin = await getSingleAdmin();
        const adminPhone = admin.phone;
        const adminName = admin.name || "Admin";

        if (adminPhone) {
          // console.log(
          // "[ADMIN WHATSAPP] Sending doctor notification (using admin phone)
          // ..."
          // );
          const doctorResult = await sendDoctorNotificationMessage(
            planName,
            patientName,
            appointmentDate,
            slotTimeFormatted
          );
          if (doctorResult.success) {
            // console.log("==========================================");
            // console.log(
            // "[ADMIN WHATSAPP] ✅ Doctor notification sent successfully"
            // );
            // console.log("  Admin Phone:", adminPhone);
            // console.log("  Template: doctor_confirmation");
            // console.log("==========================================");
          } else {
            console.error("==========================================");
            console.error("[ADMIN WHATSAPP] ❌ Doctor notification failed");
            console.error("  Admin Phone:", adminPhone);
            console.error("  Error:", doctorResult.error);
            console.error("==========================================");
          }
        } else {
          // console.warn(
          // "[ADMIN WHATSAPP] ⚠️ Admin phone not found, skipping doctor notification"
          // );
        }
      } catch (adminError: any) {
        console.error(
          "[ADMIN WHATSAPP] ❌ Failed to get admin phone:",
          adminError.message
        );
      }
    } else {
      // console.log("[ADMIN WHATSAPP] Sending doctor notification...");
      const doctorResult = await sendDoctorNotificationMessage(
        planName,
        patientName,
        appointmentDate,
        slotTimeFormatted
      );
      if (doctorResult.success) {
        // console.log("==========================================");
        // console.log(
        // "[ADMIN WHATSAPP] ✅ Doctor notification sent successfully"
        // );
        // console.log("  Doctor Phone:", doctorPhone);
        // console.log("  Template: doctor_confirmation");
        // console.log("==========================================");
      } else {
        console.error("==========================================");
        console.error("[ADMIN WHATSAPP] ❌ Doctor notification failed");
        console.error("  Doctor Phone:", doctorPhone);
        console.error("  Error:", doctorResult.error);
        console.error("==========================================");
      }
    }

    // console.log("[ADMIN WHATSAPP] ✅ Notification process completed");
  } catch (error: any) {
    console.error("==========================================");
    console.error("[ADMIN WHATSAPP] ❌ Error sending notifications");
    console.error("  Error:", error.message);
    console.error("  Stack:", error.stack);
    console.error("==========================================");
    throw error;
  }
}

/**
 * Get comprehensive doctor notes for an appointment
 * GET /api/admin/doctor-notes/:appointmentId
 */
export async function getDoctorNotes(req: Request, res: Response) {
  const startTime = Date.now();
  // console.log("[BACKEND] GET /admin/doctor-notes/:appointmentId");
  try {
    const adminId = (req as any).user?.id;
    if (!adminId) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized",
      });
    }

    const { appointmentId } = req.params;
    // console.log("[BACKEND] Fetching notes for appointment:", appointmentId);
    if (!appointmentId) {
      console.error("[BACKEND] Missing appointment ID");
      return res.status(400).json({
        success: false,
        error: "Appointment ID is required",
      });
    }

    // Verify appointment exists and admin owns it
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        doctorId: true,
      },
    });

    if (!appointment) {
      return res.status(404).json({
        success: false,
        error: "Appointment not found",
      });
    }

    // Authorization check: Verify admin owns/manages this appointment
    if (appointment.doctorId !== adminId) {
      // console.warn("[AUTH] Unauthorized doctor notes access attempt:", {
      // adminId,
      // appointmentId,
      // appointmentDoctorId: appointment.doctorId,
      // timestamp: new Date()
      // .toISOString(),
      // });
      // return res.status(403).json({
      //   success: false,
      //   error:
      //     "Forbidden. You don't have permission to access notes for this appointment.",
      // });
      return res.status(403).json({
        success: false,
        error:
          "Forbidden. You don't have permission to access notes for this appointment.",
      });
    }

    const doctorNotes = await prisma.doctorNotes.findUnique({
      where: {
        appointmentId: appointmentId,
      },
      include: {
        attachments: {
          where: {
            isArchived: false,
          },
          orderBy: {
            createdAt: "desc",
          },
        },
      },
    });

    if (!doctorNotes) {
      const duration = Date.now() - startTime;
      // console.log(`[BACKEND] No notes found for appointment (${duration}ms)
      // `);
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
      // console.log(
      // "[BACKEND] Body Measurements data retrieved:",
      // JSON.stringify((doctorNotes.formData as any)
      // .bodyMeasurements, null, 2)
      // );
    }

    const duration = Date.now() - startTime;
    // console.log(
    // `[BACKEND] GET completed in ${duration}ms - Notes ID: ${doctorNotes.id}, Attachments: ${doctorNotes.attachments.length}`
    // );
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
        attachments: doctorNotes.attachments.map((att) => {
          // Regenerate signed URL with correct resource type
          let resourceType: "image" | "raw" | "video" | "auto" = "image";
          if (att.mimeType === "application/pdf") {
            resourceType = "raw";
          } else if (att.mimeType?.startsWith("video/")) {
            resourceType = "video";
          } else if (att.mimeType?.startsWith("image/")) {
            resourceType = "image";
          } else if (att.mimeType && !att.mimeType.startsWith("image/")) {
            // For other file types, use raw
            resourceType = "raw";
          }

          // Regenerate signed URL if publicId exists
          let fileUrl = att.fileUrl;
          if (att.filePath) {
            // filePath stores the Cloudinary public_id
            try {
              fileUrl = generateSignedUrl(
                att.filePath,
                365 * 24 * 60 * 60,
                resourceType
              );
            } catch (error: any) {
              console.error(
                `[BACKEND] Failed to regenerate URL for attachment ${att.id}:`,
                error.message
              );
              // Keep original URL if regeneration fails
            }
          }

          return {
            id: att.id,
            fileName: att.fileName,
            fileUrl: fileUrl,
            mimeType: att.mimeType,
            sizeInBytes: att.sizeInBytes,
            fileCategory: att.fileCategory,
            section: att.section,
            createdAt: att.createdAt.toISOString(),
          };
        }),
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
      error: "Something went wrong",
    });
  }
}

/**
 * Delete a doctor note attachment (PDF)
 * Deletes from both database and Cloudinary
 */
export async function deleteDoctorNoteAttachment(req: Request, res: Response) {
  const startTime = Date.now();
  const attachmentId = req.params.attachmentId;
  const adminId = req.user?.id;

  if (!adminId) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized",
    });
  }

  if (!attachmentId) {
    return res.status(400).json({
      success: false,
      error: "Attachment ID is required",
    });
  }

  try {
    // console.log(
    //   `[BACKEND] Delete Doctor Note Attachment - Attachment ID: ${attachmentId}`
    // );
    // Find the attachment
    const attachment = await prisma.doctorNoteAttachment.findUnique({
      where: { id: attachmentId },
      include: {
        doctorNotes: {
          select: {
            id: true,
            appointmentId: true,
            createdBy: true,
          },
        },
      },
    });

    if (!attachment) {
      return res.status(404).json({
        success: false,
        error: "Attachment not found",
      });
    }

    // Verify admin has access to this attachment's doctor notes
    // (Optional: Add additional authorization checks if needed)

    // Delete from Cloudinary if publicId exists
    if (attachment.filePath && attachment.provider === "CLOUDINARY") {
      try {
        // console.log(
        //   `[BACKEND] Deleting file from Cloudinary: ${attachment.filePath}`
        // );
        const deleteResult = await deleteFromCloudinary(attachment.filePath);
        if (deleteResult?.result === "ok") {
          // console.log(
          //   `[BACKEND] Successfully deleted file from Cloudinary: ${attachment.filePath}`
          // );
        } else {
          // console.warn(
          // `[BACKEND] Cloudinary delete returned: ${deleteResult?.result}`
          // );
        }
      } catch (cloudinaryError: any) {
        console.error(
          `[BACKEND] Failed to delete from Cloudinary:`,
          cloudinaryError.message
        );
        // Continue with database deletion even if Cloudinary deletion fails
      }
    }

    // Delete from database (soft delete by archiving)
    await prisma.doctorNoteAttachment.update({
      where: { id: attachmentId },
      data: {
        isArchived: true,
        archivedAt: new Date(),
      },
    });

    const duration = Date.now() - startTime;
    // console.log(
    //   `[BACKEND] Delete Doctor Note Attachment completed in ${duration}ms`
    // );
    return res.json({
      success: true,
      message: "Attachment deleted successfully",
    });
  } catch (err: any) {
    const duration = Date.now() - startTime;
    console.error(
      `[BACKEND] Delete Doctor Note Attachment Error (${duration}ms):`,
      err.message || err
    );
    return res.status(500).json({
      success: false,
      error: "Something went wrong",
    });
  }
}
