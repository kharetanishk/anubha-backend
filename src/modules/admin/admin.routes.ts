import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { requireRole } from "../../middleware/requiredRole";
import { attachUser } from "../../middleware/attachUser";
import { validateFileContentMiddleware } from "../../middleware/validateFileContent";
import { adminLimiter, generalLimiter } from "../../middleware/rateLimit";
import { validateFieldSizes } from "../../middleware/fieldSizeValidator";
import { Role } from "@prisma/client";
import multer from "multer";

import {
  adminGetAppointments,
  adminUpdateAppointmentStatus,
  adminGetAppointmentDetails,
  adminDeleteAppointment,
  createDoctorSession,
  upsertDoctorFieldValue,
  getDoctorSession,
  deleteDoctorSession,
  getDoctorFieldGroups,
  searchDoctorFields,
  saveDoctorSession,
  saveDoctorNotes,
  getDoctorNotes,
  deleteDoctorNoteAttachment,
} from "./admin.controller";

const adminRoutes = Router();

// Apply general rate limiting to all admin routes
adminRoutes.use(generalLimiter);
// Apply admin-specific rate limiting
adminRoutes.use(adminLimiter);

adminRoutes.get(
  "/appointments",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  adminGetAppointments
);

adminRoutes.get(
  "/appointments/:id",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  adminGetAppointmentDetails
);

adminRoutes.patch(
  "/appointments/:id/status",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  validateFieldSizes(), // Validate field sizes
  adminUpdateAppointmentStatus
);

// Admin delete endpoint: supports both DELETE (backward compatibility) and PATCH (recommended)
// DELETE /admin/appointments/:id - default admin-only delete
// PATCH /admin/appointments/:id/admin-delete - explicit admin-only delete (recommended)
adminRoutes.delete(
  "/appointments/:id",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  adminDeleteAppointment
);
adminRoutes.patch(
  "/appointments/:id/admin-delete",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  adminDeleteAppointment
);

adminRoutes.post(
  "/doctor-session",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  validateFieldSizes(), // Validate field sizes
  createDoctorSession
);

adminRoutes.get(
  "/doctor-session/:sessionId",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  getDoctorSession
);

adminRoutes.patch(
  "/doctor-session/:sessionId/value",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  validateFieldSizes(), // Validate field sizes
  upsertDoctorFieldValue
);

adminRoutes.delete(
  "/doctor-session/:sessionId",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  deleteDoctorSession
);

adminRoutes.get(
  "/doctor-fields/groups",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  getDoctorFieldGroups
);

adminRoutes.get(
  "/doctor-fields/search",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  searchDoctorFields
);

adminRoutes.post(
  "/doctor-session/save",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  validateFieldSizes(), // Validate field sizes
  saveDoctorSession
);

// Comprehensive Doctor Notes API
import pdfUpload from "../../middleware/pdfUploadConfig";
adminRoutes.post(
  "/doctor-notes",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  pdfUpload.array("dietCharts", 10), // Handle multiple PDF file uploads (max 10)
  validateFileContentMiddleware, // Validate file content matches MIME type
  validateFieldSizes(), // Validate field sizes (for JSON data in body)
  saveDoctorNotes
);

adminRoutes.get(
  "/doctor-notes/:appointmentId",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  getDoctorNotes
);

adminRoutes.patch(
  "/doctor-notes/:appointmentId",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  pdfUpload.array("dietCharts", 10), // Handle multiple PDF file uploads (max 10)
  validateFileContentMiddleware, // Validate file content matches MIME type
  validateFieldSizes(), // Validate field sizes (for JSON data in body)
  saveDoctorNotes // Reuse same handler, it will detect PATCH vs POST
);

adminRoutes.delete(
  "/doctor-notes/attachment/:attachmentId",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  deleteDoctorNoteAttachment
);

export default adminRoutes;
