import prisma from "../../database/prismaclient";
import { AppointmentStatus } from "@prisma/client";
import { AppointmentMode } from "@prisma/client";
import { Request, Response } from "express";
import {
  sendBookingConfirmationMessage,
  sendDoctorNotificationMessage,
  formatDateForTemplate,
  formatTimeForTemplate,
} from "../../services/whatsapp.service";
import { sendAppointmentConfirmationNotifications } from "../../services/notification/appointment-notification.service";
import { generateSignedUrl, deleteFromCloudinary } from "../../util/cloudinary";
import {
  uploadDoctorNoteFile,
  uploadPrePostImage,
  generateSignedDownloadUrl,
  type PrePostType,
} from "../../services/storage/r2.service";
import { downloadFile } from "../../services/storage/r2.service";
import { sendDoctorNotesEmail } from "../../services/email/doctor-notes-email.service";
import { fromZonedTime } from "date-fns-tz";
import { AppError } from "../../util/AppError";
import {
  deepMerge,
  parseDoctorNotesFormData,
  syncDoctorNoteAttachments,
  upsertDoctorNotes,
} from "./doctor-notes.service";

const BUSINESS_TIMEZONE = "Asia/Kolkata";

/**
 * Create date range from query string (YYYY-MM-DD format).
 * Converts date string to UTC Date objects representing start of day in IST.
 */
function dateRangeFromQuery(dateStr?: string) {
  if (!dateStr) return undefined;
  // Convert date string to UTC Date object representing start of day in IST
  const day = fromZonedTime(`${dateStr}T00:00:00`, BUSINESS_TIMEZONE);
  const nextDay = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  return { gte: day, lt: nextDay };
}

/**
 * Get appointments for admin panel
 *
 * Filters:
 * - date (single date or range)
 * - status (PENDING, CONFIRMED, CANCELLED, COMPLETED)
 * - mode (IN_PERSON, ONLINE)
 * - q (search by patient name, phone, or email)
 *
 * PERFORMANCE NOTES:
 * - Query is optimized by a composite index on:
 *   (isArchived, isDeletedByAdmin, status, mode, startAt)
 *   which matches the WHERE + ORDER BY pattern used here.
 *
 * FUTURE IMPROVEMENTS (NOT IMPLEMENTED YET):
 * - Switch to cursor-based pagination for very large datasets (> 10k rows)
 *   API shape example:
 *     GET /api/admin/appointments?cursor=<appointmentId>&take=50
 *   Response:
 *     { appointments: [...], nextCursor: string | null, hasMore: boolean }
 * - Frontend would then use a `nextCursor` pattern (infinite scroll or paged).
 * - Consider virtual scrolling (react-window / react-virtualized) and
 *   infinite scroll ("Load more" with IntersectionObserver) for very large pages.
 *
 * Shows ALL appointments (PENDING, CONFIRMED, CANCELLED, COMPLETED) by default
 * Can be filtered by status, date, mode, or search query
 */
export async function adminGetAppointments(req: Request, res: Response) {
  try {
    const { date, status, mode, page = "1", limit = "20", q, sort } = req.query;

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

    const startTime = Date.now();

    // Determine sort order: latest (desc) or oldest (asc), default to latest
    const sortOrder = sort === "oldest" ? "asc" : "desc";

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
        orderBy: { startAt: sortOrder },
        skip,
        take: lim,
      }),
      prisma.appointment.count({ where }),
    ]);

    const durationMs = Date.now() - startTime;

    // Lightweight performance logging for debugging (non-production only)
    if (process.env.NODE_ENV !== "production") {
      // To avoid noisy logs in long-running processes, only log occasionally
      if (Math.random() < 0.1) {
        console.log("[ADMIN APPOINTMENTS] Query performance:", {
          total,
          page: pageNum,
          limit: lim,
          filters: {
            date,
            status,
            mode,
            q,
          },
          durationMs,
        });
      }
    }

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
        
        // Send email notifications (new)
        sendAppointmentConfirmationNotifications({
          appointment: {
            id: appointmentWithDetails.id,
            planName: appointmentWithDetails.planName,
            patient: {
              name: appointmentWithDetails.patient?.name,
              phone: appointmentWithDetails.patient?.phone,
              email: appointmentWithDetails.patient?.email,
            },
            slot: appointmentWithDetails.slot
              ? {
                  startAt: appointmentWithDetails.slot.startAt,
                  endAt: appointmentWithDetails.slot.endAt,
                }
              : undefined,
            startAt: appointmentWithDetails.startAt,
            endAt: appointmentWithDetails.endAt,
          },
        }).catch((error: any) => {
          console.error(
            "[ADMIN] Email notification failed (non-blocking):",
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
          // ❌ REMOVED files and recalls from here - will fetch separately by appointmentId
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

    // ✅ Fetch appointment-scoped recalls separately
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

    // ✅ Fetch appointment-scoped files separately (not all patient files)
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
    // ✅ Attach appointment-scoped recalls and files to response
    return res.json({
      success: true,
      appointment: {
        ...appt,
        patient: {
          ...appt.patient,
          recalls: appointmentRecalls, // ✅ Only appointment-specific recalls
        },
        files: appointmentFiles, // ✅ Only appointment-specific files (at appointment level)
      },
    });
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
  // Debug logs removed for production
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
    // Handle both array-style files (PDFs) and fields-style files (images and reports)
    let files: Express.Multer.File[] = [];
    let preImages: Express.Multer.File[] = [];
    let postImages: Express.Multer.File[] = [];
    let medicalReports: Express.Multer.File[] = [];

    if (req.files) {
      if (Array.isArray(req.files)) {
        // Array format (PDFs from dietCharts field)
        files = req.files as Express.Multer.File[];
      } else if (req.files && typeof req.files === "object") {
        // Fields format (multiple field names)
        const filesObj = req.files as {
          [fieldname: string]: Express.Multer.File[];
        };
        if (filesObj.dietCharts) {
          files = Array.isArray(filesObj.dietCharts) ? filesObj.dietCharts : [];
        }
        if (filesObj.preConsultationImages) {
          preImages = Array.isArray(filesObj.preConsultationImages)
            ? filesObj.preConsultationImages
            : [filesObj.preConsultationImages];
        }
        if (filesObj.postConsultationImages) {
          postImages = Array.isArray(filesObj.postConsultationImages)
            ? filesObj.postConsultationImages
            : [filesObj.postConsultationImages];
        }
        if (filesObj.medicalReports) {
          medicalReports = Array.isArray(filesObj.medicalReports)
            ? filesObj.medicalReports
            : [filesObj.medicalReports];
        }
      }
    }

    const hasFiles =
      files.length > 0 ||
      preImages.length > 0 ||
      postImages.length > 0 ||
      medicalReports.length > 0;

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
        parsedFormData = parseDoctorNotesFormData(formDataStr);
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
        // Validate appointmentId is present before uploading files
        if (!appointmentId) {
          return res.status(400).json({
            success: false,
            error: "Appointment ID is required before uploading files",
          });
        }

        // console.log(`[BACKEND] Processing ${files.length} file upload(s)
        // `);

        const uploadedFiles: Array<{
          fileName: string;
          filePath: string; // R2 object key
          mimeType: string;
          sizeInBytes: number;
        }> = [];

        // Get R2 bucket name from environment variable
        const r2Bucket = process.env.R2_BUCKET;
        if (!r2Bucket) {
          console.error("[BACKEND] R2_BUCKET environment variable is not set");
          return res.status(500).json({
            success: false,
            error: "Storage configuration error. Please contact support.",
          });
        }

        // File upload summary log removed for production

        // Process each file
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          // console.log(`[BACKEND] Processing file ${i + 1}/${files.length}:`, {
          // filename: file.originalname,
          // mimetype: file.mimetype,
          // size: file.size,
          // });
          try {
            // Extract file extension from original filename
            const fileExtension =
              file.originalname.split(".").pop()?.toLowerCase() || "pdf";

            // Upload to R2 using structured key format: doctor-notes/{type}/{appointmentId}/{uuid}.{ext}
            // Type is "pdf" for diet chart PDFs
            const uploadResult = await uploadDoctorNoteFile({
              bucket: r2Bucket,
              type: "pdf", // Diet chart PDFs are type "pdf"
              appointmentId: appointmentId,
              body: file.buffer, // Use file buffer directly
              extension: fileExtension,
              contentType: file.mimetype,
              metadata: {
                original_filename: file.originalname,
                uploaded_by: adminId,
                uploaded_at: new Date().toISOString(),
                file_index: i.toString(),
              },
            });

            // Store file info (only key, no URL)
            uploadedFiles.push({
              fileName: file.originalname,
              filePath: uploadResult.key, // R2 object key (e.g., "doctor-notes/pdf/appt-123/uuid.pdf")
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
              // Store R2 key instead of URL
              parsedFormData.dietPrescribed.dietChartPublicId =
                uploadResult.key;
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

        // Process pre-consultation images
        for (let i = 0; i < preImages.length; i++) {
          const file = preImages[i];
          try {
            const fileExtension =
              file.originalname.split(".").pop()?.toLowerCase() || "jpg";

            // Validate image extension
            const allowedExtensions = ["jpg", "jpeg", "png"];
            if (!allowedExtensions.includes(fileExtension)) {
              return res.status(400).json({
                success: false,
                error: `Invalid file type for pre-consultation image: ${fileExtension}. Only JPG, JPEG, and PNG are allowed.`,
              });
            }

            const uploadResult = await uploadPrePostImage({
              bucket: r2Bucket,
              prePostType: "pre",
              appointmentId: appointmentId,
              body: file.buffer,
              extension: fileExtension,
              contentType: file.mimetype,
              metadata: {
                original_filename: file.originalname,
                uploaded_by: adminId,
                uploaded_at: new Date().toISOString(),
                file_index: i.toString(),
              },
            });

            uploadedFiles.push({
              fileName: file.originalname,
              filePath: uploadResult.key,
              mimeType: file.mimetype,
              sizeInBytes: file.size,
            });
          } catch (uploadError: any) {
            console.error(
              `[BACKEND] Pre-image ${i + 1} upload error:`,
              uploadError
            );
            return res.status(500).json({
              success: false,
              error: `Failed to upload pre-consultation image "${
                file.originalname
              }": ${uploadError.message || "Unknown error"}`,
            });
          }
        }

        // Process post-consultation images
        for (let i = 0; i < postImages.length; i++) {
          const file = postImages[i];
          try {
            const fileExtension =
              file.originalname.split(".").pop()?.toLowerCase() || "jpg";

            // Validate image extension
            const allowedExtensions = ["jpg", "jpeg", "png"];
            if (!allowedExtensions.includes(fileExtension)) {
              return res.status(400).json({
                success: false,
                error: `Invalid file type for post-consultation image: ${fileExtension}. Only JPG, JPEG, and PNG are allowed.`,
              });
            }

            const uploadResult = await uploadPrePostImage({
              bucket: r2Bucket,
              prePostType: "post",
              appointmentId: appointmentId,
              body: file.buffer,
              extension: fileExtension,
              contentType: file.mimetype,
              metadata: {
                original_filename: file.originalname,
                uploaded_by: adminId,
                uploaded_at: new Date().toISOString(),
                file_index: i.toString(),
              },
            });

            uploadedFiles.push({
              fileName: file.originalname,
              filePath: uploadResult.key,
              mimeType: file.mimetype,
              sizeInBytes: file.size,
            });
          } catch (uploadError: any) {
            console.error(
              `[BACKEND] Post-image ${i + 1} upload error:`,
              uploadError
            );
            return res.status(500).json({
              success: false,
              error: `Failed to upload post-consultation image "${
                file.originalname
              }": ${uploadError.message || "Unknown error"}`,
            });
          }
        }

        // Process medical reports (PDFs, PNG, JPG, JPEG)
        for (let i = 0; i < medicalReports.length; i++) {
          const file = medicalReports[i];
          try {
            const fileExtension =
              file.originalname.split(".").pop()?.toLowerCase() || "pdf";

            // Validate file extension
            const allowedExtensions = ["pdf", "png", "jpg", "jpeg"];
            if (!allowedExtensions.includes(fileExtension)) {
              return res.status(400).json({
                success: false,
                error: `Invalid file type for medical report: ${fileExtension}. Only PDF, PNG, JPG, and JPEG are allowed.`,
              });
            }

            // Upload to R2 using structured key format: doctor-notes/reports/{appointmentId}/{uuid}.{ext}
            const uploadResult = await uploadDoctorNoteFile({
              bucket: r2Bucket,
              type: "reports", // Medical reports are type "reports"
              appointmentId: appointmentId,
              body: file.buffer,
              extension: fileExtension,
              contentType: file.mimetype,
              metadata: {
                original_filename: file.originalname,
                uploaded_by: adminId,
                uploaded_at: new Date().toISOString(),
                file_index: i.toString(),
              },
            });

            uploadedFiles.push({
              fileName: file.originalname,
              filePath: uploadResult.key,
              mimeType: file.mimetype,
              sizeInBytes: file.size,
            });
          } catch (uploadError: any) {
            console.error(
              `[BACKEND] Medical report ${i + 1} upload error:`,
              uploadError
            );
            return res.status(500).json({
              success: false,
              error: `Failed to upload medical report "${file.originalname}": ${
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

    // Extract sectionKey from header (preferred) or body (fallback)
    // Header format: X-Section-Key or section-key
    // Body format: { sectionKey: "foodFrequency" } or formData: "sectionKey=..."
    let sectionKey: string | undefined;
    if (req.headers["x-section-key"]) {
      sectionKey = req.headers["x-section-key"] as string;
    } else if (req.headers["section-key"]) {
      sectionKey = req.headers["section-key"] as string;
    } else if ((req as any).body?.sectionKey) {
      // For both JSON and multipart/form-data
      const bodySectionKey = (req as any).body.sectionKey;
      sectionKey = typeof bodySectionKey === "string" ? bodySectionKey : undefined;
    }

    // If sectionKey is provided, skip deep merge (service will handle partial update)
    // Otherwise, fallback to existing full merge behavior (backward compatible)
    if (!sectionKey) {
      // Check if notes already exist for PATCH
      const existingNotes = await prisma.doctorNotes.findUnique({
        where: { appointmentId: validatedAppointmentId },
      });

      // For PATCH, merge with existing data (original behavior)
      if (isPatch && existingNotes) {
        const existingFormData = (existingNotes.formData as any) || {};
        // Deep merge partial data with existing data
        parsedFormData = deepMerge(existingFormData, parsedFormData);
        // console.log(
        // "[BACKEND] PATCH - Merged with existing data. Changed fields:",
        // Object.keys(parsedFormData)
        // );
      }
    }

    // Log bodyMeasurements data for debugging
    if (parsedFormData?.bodyMeasurements) {
      // console.log(
      // "[BACKEND] Body Measurements data:",
      // JSON.stringify(parsedFormData.bodyMeasurements, null, 2)
      // );
    }

    // Upsert doctor notes (with optional sectionKey for partial updates)
    const doctorNotes = await upsertDoctorNotes({
      appointmentId: validatedAppointmentId,
      adminId,
      formData: parsedFormData,
      isDraft: isDraft ?? false,
      sectionKey: sectionKey || undefined, // Pass sectionKey if provided
      isPatch: isPatch, // Indicate if this is a PATCH request
    });

    // Ensure doctorNotes is not null (should never be null after upsert)
    if (!doctorNotes) {
      console.error("[BACKEND] Unexpected: doctorNotes is null after upsert");
      return res.status(500).json({
        success: false,
        error: "Failed to save doctor notes",
      });
    }

    // Handle file attachments if files were uploaded
    const uploadedFiles = (req as any).uploadedFiles || [];
    if (uploadedFiles.length > 0) {
      await syncDoctorNoteAttachments({
        doctorNotesId: doctorNotes.id,
        uploadedFiles,
      });
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

    // Handle DoctorNotesServiceError (from service layer)
    if (err?.constructor?.name === "DoctorNotesServiceError" || err?.code) {
      const serviceError = err as import("./doctor-notes.service").DoctorNotesServiceError;
      let statusCode = 400;

      // Map service error codes to HTTP status codes
      if (serviceError.code === "NOT_FOUND") {
        statusCode = 404;
      } else if (serviceError.code === "INVALID_SECTION_KEY") {
        statusCode = 400;
      } else if (serviceError.code === "INVALID_FORM_DATA") {
        statusCode = 400;
      } else if (serviceError.code === "UPDATE_FAILED") {
        statusCode = 500;
      }

      return res.status(statusCode).json({
        success: false,
        error: serviceError.message || "Service error occurred",
      });
    }

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
 * Send WhatsApp notifications when admin manually confirms an appointment
 */
export async function sendWhatsAppNotificationsForAdminConfirmation(appointment: any) {
  try {
    if (process.env.NODE_ENV === "development") {
      console.log("==========================================");
      console.log("[ADMIN WHATSAPP] Sending confirmation notifications...");
      console.log("  Appointment ID:", appointment.id);
      console.log("  Appointment Status: CONFIRMED (by admin)");
      console.log("==========================================");
    }
    // Get patient phone number and slot times
    const patientPhone = appointment.patient?.phone;
    const patientName = appointment.patient?.name || "Patient";
    const slotStartTime = appointment.slot?.startAt || appointment.startAt;
    const slotEndTime = appointment.slot?.endAt || appointment.endAt;

    if (!patientPhone) {
      // console.warn(
      // "[ADMIN WHATSAPP] ⚠️ Patient phone not found, skipping patient notification"
      // );
    } else if (!slotStartTime) {
      console.error(
        "[ADMIN WHATSAPP] ❌ Slot time not found, cannot send patient notification"
      );
    } else {
      // Convert to Date objects for the booking confirmation message
      const slotTimeDate = new Date(slotStartTime);
      const slotEndTimeDate = slotEndTime ? new Date(slotEndTime) : undefined;

      // Send booking confirmation message using the same template as user bookings
      const patientResult = await sendBookingConfirmationMessage(
        patientPhone,
        slotTimeDate,
        patientName,
        slotEndTimeDate
      );

      if (patientResult.success) {
        if (process.env.NODE_ENV === "development") {
          console.log("==========================================");
          console.log(
            "[ADMIN WHATSAPP] ✅ Patient notification sent successfully"
          );
          console.log("  Patient Phone:", patientPhone);
          console.log("  Patient Name:", patientName);
          console.log("  Template: bookingconfirm");
          console.log("==========================================");
        }
      } else {
        console.error("==========================================");
        console.error("[ADMIN WHATSAPP] ❌ Patient notification failed");
        console.error("  Patient Phone:", patientPhone);
        console.error("  Error:", patientResult.error);
        console.error("==========================================");
      }
    }

    // Prepare data for doctor notification
    // Always sends to fixed doctor/admin number: 919713885582 (single doctor application)
    const planName = appointment.planName || "Consultation Plan";

    // Format appointment date and slot time
    const appointmentDate = formatDateForTemplate(slotStartTime);
    const slotTimeFormatted = formatTimeForTemplate(slotStartTime, slotEndTime);

    // Send doctor notification (always uses fixed admin/doctor number: 919713885582)
    const doctorResult = await sendDoctorNotificationMessage(
      planName,
      patientName,
      appointmentDate,
      slotTimeFormatted
      // doctorPhone parameter is ignored - always uses fixed admin/doctor number (919713885582)
    );
    if (doctorResult.success) {
      if (process.env.NODE_ENV === "development") {
        console.log("==========================================");
        console.log(
          "[ADMIN WHATSAPP] ✅ Doctor notification sent successfully"
        );
        console.log("  Doctor/Admin Phone: 919713885582 (fixed)");
        console.log("  Template: doctor_confirmation");
        console.log("  Plan Name:", planName);
        console.log("  Patient Name:", patientName);
        console.log("  Appointment Date:", appointmentDate);
        console.log("  Slot Time:", slotTimeFormatted);
        console.log("==========================================");
      }
    } else {
      console.error("==========================================");
      console.error("[ADMIN WHATSAPP] ❌ Doctor notification failed");
      console.error("  Doctor/Admin Phone: 919713885582 (fixed)");
      console.error("  Error:", doctorResult.error);
      console.error("==========================================");
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
          // Handle R2 (S3) stored files differently from Cloudinary
          // R2 files: provider = S3, filePath = R2 object key, fileUrl = null
          // Cloudinary files: provider = CLOUDINARY, filePath = public_id, fileUrl = signed URL

          let fileUrl = att.fileUrl || null;

          if (att.provider === "S3") {
            // R2-stored files: Do NOT generate URLs here
            // Frontend will call getDoctorNoteAttachmentViewUrl() to get signed URLs on demand
            // Keep fileUrl as null - the frontend will fetch signed URLs when needed
            fileUrl = null;
          } else if (att.provider === "CLOUDINARY" && att.filePath) {
            // Cloudinary files: Generate signed URL from public_id (filePath)
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

            try {
              // filePath stores the Cloudinary public_id for Cloudinary files
              fileUrl = generateSignedUrl(
                att.filePath,
                365 * 24 * 60 * 60,
                resourceType
              );
            } catch (error: any) {
              console.error(
                `[BACKEND] Failed to regenerate Cloudinary URL for attachment ${att.id}:`,
                error.message
              );
              // Keep original URL if regeneration fails
            }
          }

          return {
            id: att.id,
            fileName: att.fileName,
            filePath: att.filePath, // Always include filePath (R2 key or Cloudinary public_id)
            fileUrl: fileUrl, // null for R2 files, signed URL for Cloudinary
            mimeType: att.mimeType,
            sizeInBytes: att.sizeInBytes,
            fileCategory: att.fileCategory,
            section: att.section,
            provider: att.provider, // Include provider so frontend knows how to handle
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
 * View/Get a doctor note attachment PDF (R2 stored files)
 * Generates a short-lived signed URL for secure access to private R2 objects
 *
 * GET /api/admin/doctor-notes/attachment/:attachmentId/view
 *
 * Security:
 * - Admin-only endpoint (requires authentication and admin role)
 * - Validates appointment ownership before generating URL
 * - Generates time-limited signed URLs (7 minutes expiry)
 * - URLs are never stored or cached
 * - Only works for S3 (R2) provider files
 */
export async function getDoctorNoteAttachment(req: Request, res: Response) {
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
    // Fetch attachment with doctor notes and appointment details
    const attachment = await prisma.doctorNoteAttachment.findUnique({
      where: { id: attachmentId },
      include: {
        doctorNotes: {
          include: {
            appointment: {
              select: {
                id: true,
                doctorId: true,
              },
            },
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

    // Verify attachment is not archived
    if (attachment.isArchived) {
      return res.status(404).json({
        success: false,
        error: "Attachment not found",
      });
    }

    // Verify admin owns/manages the appointment
    if (attachment.doctorNotes.appointment.doctorId !== adminId) {
      return res.status(403).json({
        success: false,
        error:
          "Forbidden. You don't have permission to access this attachment.",
      });
    }

    // Only support R2 (S3) provider files
    if (attachment.provider !== "S3") {
      return res.status(400).json({
        success: false,
        error: "This endpoint only supports R2 (S3) stored files",
      });
    }

    // Validate filePath (R2 key) exists
    if (!attachment.filePath || !attachment.filePath.trim()) {
      return res.status(400).json({
        success: false,
        error: "Invalid attachment: file path is missing",
      });
    }

    // Get R2 bucket name from environment variable
    const r2Bucket = process.env.R2_BUCKET;
    if (!r2Bucket) {
      console.error("[BACKEND] R2_BUCKET environment variable is not set");
      return res.status(500).json({
        success: false,
        error: "Storage configuration error. Please contact support.",
      });
    }

    // Generate short-lived signed URL (7 minutes = 420 seconds)
    // This provides a balance between security and usability
    const SIGNED_URL_EXPIRY = 420; // 7 minutes
    const signedUrl = await generateSignedDownloadUrl(
      r2Bucket,
      attachment.filePath,
      SIGNED_URL_EXPIRY
    );

    return res.json({
      success: true,
      signedUrl,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      expiresIn: SIGNED_URL_EXPIRY, // Inform frontend of expiry time
    });
  } catch (error: any) {
    console.error("[BACKEND] Get Doctor Note Attachment Error:", error);

    // Handle R2 service errors
    if (
      error.message?.includes("Bucket name") ||
      error.message?.includes("Object key")
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid storage configuration",
      });
    }

    return res.status(500).json({
      success: false,
      error: "Failed to generate file access URL",
    });
  }
}

/**
 * Download a doctor note attachment via the backend (no CORS / no frontend XHR to R2).
 *
 * GET /api/admin/doctor-notes/attachment/:attachmentId/download
 *
 * Security:
 * - Admin-only (requires authentication + admin role)
 * - Validates appointment ownership before downloading
 * - Files remain private in R2; only streamed to authorized admin
 *
 * Note: We intentionally stream from R2 server-side instead of asking the browser to
 * fetch the R2 signed URL. This avoids browser CORS/preflight issues that break downloads.
 */
export async function downloadDoctorNoteAttachment(req: Request, res: Response) {
  const attachmentId = req.params.attachmentId;
  const adminId = req.user?.id;

  if (!adminId) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  if (!attachmentId) {
    return res
      .status(400)
      .json({ success: false, error: "Attachment ID is required" });
  }

  try {
    const attachment = await prisma.doctorNoteAttachment.findUnique({
      where: { id: attachmentId },
      include: {
        doctorNotes: {
          include: {
            appointment: {
              select: { id: true, doctorId: true },
            },
          },
        },
      },
    });

    if (!attachment || attachment.isArchived) {
      return res
        .status(404)
        .json({ success: false, error: "Attachment not found" });
    }

    if (attachment.doctorNotes.appointment.doctorId !== adminId) {
      return res.status(403).json({
        success: false,
        error: "Forbidden. You don't have permission to access this attachment.",
      });
    }

    if (attachment.provider !== "S3") {
      return res.status(400).json({
        success: false,
        error: "This endpoint only supports R2 (S3) stored files",
      });
    }

    if (!attachment.filePath || !attachment.filePath.trim()) {
      return res.status(400).json({
        success: false,
        error: "Invalid attachment: file path is missing",
      });
    }

    const r2Bucket = process.env.R2_BUCKET;
    if (!r2Bucket) {
      console.error("[BACKEND] R2_BUCKET environment variable is not set");
      return res.status(500).json({
        success: false,
        error: "Storage configuration error. Please contact support.",
      });
    }

    const fileBuffer = await downloadFile(r2Bucket, attachment.filePath);
    const safeFileName =
      attachment.fileName && attachment.fileName.trim()
        ? attachment.fileName.trim()
        : `attachment-${attachment.id}`;

    res.setHeader("Content-Type", attachment.mimeType || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeFileName.replace(/"/g, "")}"`
    );
    res.setHeader("Content-Length", fileBuffer.length.toString());

    return res.status(200).send(fileBuffer);
  } catch (error: any) {
    console.error("[BACKEND] Download Doctor Note Attachment Error:", error);
    return res
      .status(500)
      .json({ success: false, error: "Failed to download attachment" });
  }
}

/**
 * Send Doctor Notes PDFs via email
 *
 * POST /api/admin/doctor-notes/:appointmentId/send-email
 *
 * Security:
 * - Admin-only endpoint (requires authentication and admin role)
 * - Validates appointment ownership before sending
 * - Downloads files server-side from R2 (no signed URLs)
 * - Files remain private in R2 at all times
 */
export async function sendDoctorNotesEmailController(
  req: Request,
  res: Response
) {
  const appointmentId = req.params.appointmentId;
  const adminId = req.user?.id;

  if (!adminId) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized",
    });
  }

  if (!appointmentId) {
    return res.status(400).json({
      success: false,
      error: "Appointment ID is required",
    });
  }

  const { toEmail, usePatientEmail } = req.body;

  // Validate email parameters
  if (!usePatientEmail && !toEmail) {
    return res.status(400).json({
      success: false,
      error: "Either usePatientEmail must be true or toEmail must be provided",
    });
  }

  if (usePatientEmail && toEmail) {
    return res.status(400).json({
      success: false,
      error: "Cannot specify both usePatientEmail and toEmail",
    });
  }

  try {
    // Fetch appointment with patient details and doctor notes
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        patient: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        doctorNotes: {
          include: {
            attachments: {
              where: {
                isArchived: false,
                // Don't filter by provider here - we'll filter for PDFs later
                // Some PDFs might be stored in Cloudinary or R2
              },
              select: {
                id: true,
                fileName: true,
                filePath: true,
                mimeType: true,
                sizeInBytes: true,
                fileCategory: true, // Include fileCategory for filtering
                provider: true, // Include provider to know storage type
              },
            },
          },
        },
      },
    });

    if (!appointment) {
      return res.status(404).json({
        success: false,
        error: "Appointment not found",
      });
    }

    // Verify admin owns/manages the appointment
    if (appointment.doctorId !== adminId) {
      return res.status(403).json({
        success: false,
        error:
          "Forbidden. You don't have permission to access this appointment.",
      });
    }

    // Check if doctor notes exist
    if (!appointment.doctorNotes) {
      return res.status(404).json({
        success: false,
        error: "Doctor notes not found for this appointment",
      });
    }

    // Debug logs removed for production

    // Get PDF attachments that are stored in R2 (S3 provider)
    // Email service only supports R2 downloads, so we must filter by provider === S3
    // Primary detection: mimeType === 'application/pdf' (most reliable)
    // Secondary: filePath pattern for R2-stored PDFs (doctor-notes/pdf/...)
    // Tertiary: file extension (.pdf) as fallback
    // Note: Do NOT rely on fileCategory as it may have legacy/inconsistent values
    const attachments = appointment.doctorNotes.attachments.filter((att) => {
      const provider = (att as any).provider;

      // Only process attachments stored in R2 (S3 provider)
      // Email service can only download from R2, not Cloudinary
      if (provider !== "S3") {
        return false;
      }

      // PRIMARY: Check mimeType (most reliable indicator)
      if (att.mimeType === "application/pdf") {
        return true;
      }

      // SECONDARY: Check filePath pattern for R2-stored PDFs
      // R2 PDFs are stored with path: "doctor-notes/pdf/{appointmentId}/{uuid}.pdf"
      if (att.filePath && att.filePath.includes("/pdf/")) {
        return true;
      }

      // TERTIARY: Check file extension as fallback (for edge cases)
      if (att.fileName && att.fileName.toLowerCase().endsWith(".pdf")) {
        return true;
      }

      return false;
    });

    // PDF filtering results log removed for production

    if (attachments.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No PDF attachments found for this doctor note",
      });
    }

    // Determine recipient email
    let recipientEmail: string;
    if (usePatientEmail) {
      if (!appointment.patient.email) {
        return res.status(400).json({
          success: false,
          error:
            "Patient email not available. Please use a custom email address.",
        });
      }
      recipientEmail = appointment.patient.email;
    } else {
      // Validate custom email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(toEmail)) {
        return res.status(400).json({
          success: false,
          error: "Invalid email address format",
        });
      }
      recipientEmail = toEmail;
    }

    // Get R2 bucket name from environment variable
    const r2Bucket = process.env.R2_BUCKET;
    if (!r2Bucket) {
      console.error("[BACKEND] R2_BUCKET environment variable is not set");
      return res.status(500).json({
        success: false,
        error: "Storage configuration error. Please contact support.",
      });
    }

    // Send email with attachments
    const result = await sendDoctorNotesEmail({
      toEmail: recipientEmail,
      patientName: appointment.patient.name || "Patient",
      appointmentDate: appointment.startAt,
      attachments: attachments.map((att) => ({
        fileName: att.fileName,
        filePath: att.filePath,
        mimeType: att.mimeType,
        sizeInBytes: att.sizeInBytes,
      })),
      r2Bucket,
    });

    return res.json({
      success: true,
      message: result.message,
    });
  } catch (error: any) {
    console.error("[BACKEND] Send Doctor Notes Email Error:", error);

    if (error instanceof AppError) {
      return res.status(error.statusCode).json({
        success: false,
        error: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      error: "Failed to send email",
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
