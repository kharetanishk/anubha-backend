import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { requireRole } from "../../middleware/requiredRole";
import { requireAdmin } from "../../middleware/requireAdmin";
import { attachUser } from "../../middleware/attachUser";
import { validateFileContentMiddleware } from "../../middleware/validateFileContent";
// NOTE: /api/admin routes are intentionally NOT rate-limited.
// The admin dashboard can generate many legitimate requests and rate limiting causes 429s.
import { validateFieldSizes } from "../../middleware/fieldSizeValidator";
import { validateBody } from "../../middleware/validateRequest";
import { createPatientSchema } from "../patient/patient.validators";
import { Role } from "@prisma/client";
import multer from "multer";
import imageUpload from "../../middleware/multerConfig";

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
  getDoctorNoteAttachment,
  downloadDoctorNoteAttachment,
  deleteDoctorNoteAttachment,
  sendDoctorNotesEmailController,
} from "./admin.controller";
import {
  uploadAdminProfilePicture,
  getAdminProfilePicture,
  updateAdminProfilePicture,
  deleteAdminProfilePicture,
} from "./admin-profile.controller";
import {
  createUser,
  listUsers,
  getUserById,
  getUserPatients,
  createPatientForUser,
  deleteUser,
} from "./admin-user.controller";
import { createAppointmentByAdmin } from "./admin-appointment.controller";

const adminRoutes = Router();

// Rate limiters removed for admin routes (single-admin setup)

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

// CRITICAL: Appointment status updates require DB-verified admin role
adminRoutes.patch(
  "/appointments/:id/status",
  attachUser,
  requireAuth,
  requireAdmin, // Database-verified admin check
  validateFieldSizes(), // Validate field sizes
  adminUpdateAppointmentStatus
);

// CRITICAL: Appointment deletion requires DB-verified admin role
// Admin delete endpoint: supports both DELETE (backward compatibility) and PATCH (recommended)
// DELETE /admin/appointments/:id - default admin-only delete
// PATCH /admin/appointments/:id/admin-delete - explicit admin-only delete (recommended)
adminRoutes.delete(
  "/appointments/:id",
  attachUser,
  requireAuth,
  requireAdmin, // Database-verified admin check
  adminDeleteAppointment
);
adminRoutes.patch(
  "/appointments/:id/admin-delete",
  attachUser,
  requireAuth,
  requireAdmin, // Database-verified admin check
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

// CRITICAL: Doctor Notes API - requires DB-verified admin role
import pdfUpload from "../../middleware/pdfUploadConfig";
// Use multer.fields to handle both PDFs and images
const doctorNotesUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (
    req: Express.Request,
    file: Express.Multer.File,
    cb: multer.FileFilterCallback
  ) => {
    const fieldName = file.fieldname;
    const mimeType = file.mimetype.toLowerCase();

    // Validate based on field name
    if (fieldName === "dietCharts") {
      // Only allow PDFs for dietCharts
      if (mimeType === "application/pdf") {
        cb(null, true);
      } else {
        const error = new Error("Only PDF files are allowed for diet charts!");
        error.name = "MulterFileTypeError";
        cb(error);
      }
    } else if (
      fieldName === "preConsultationImages" ||
      fieldName === "postConsultationImages"
    ) {
      // Only allow images for consultation images
      const allowedImageTypes = [
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/x-png",
      ];
      if (allowedImageTypes.includes(mimeType)) {
        cb(null, true);
      } else {
        const error = new Error(
          "Only JPG, PNG, and JPEG images are allowed for consultation images!"
        );
        error.name = "MulterFileTypeError";
        cb(error);
      }
    } else if (fieldName === "medicalReports") {
      // Allow PDFs and images for medical reports
      const allowedReportTypes = [
        "application/pdf",
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/x-png",
      ];
      if (allowedReportTypes.includes(mimeType)) {
        cb(null, true);
      } else {
        const error = new Error(
          "Only PDF, JPG, PNG, and JPEG files are allowed for medical reports!"
        );
        error.name = "MulterFileTypeError";
        cb(error);
      }
    } else {
      const error = new Error(`Unknown field name: ${fieldName}`);
      error.name = "MulterFileTypeError";
      cb(error);
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
    files: 40, // Allow up to 40 files total (10 PDFs + 10 pre + 10 post + 10 reports)
  },
}).fields([
  { name: "dietCharts", maxCount: 10 },
  { name: "preConsultationImages", maxCount: 10 },
  { name: "postConsultationImages", maxCount: 10 },
  { name: "medicalReports", maxCount: 10 },
]);

adminRoutes.post(
  "/doctor-notes",
  (req, res, next) => {
    console.log("[ROUTE] POST /api/admin/doctor-notes - Request received");
    next();
  },
  // attachUser is already applied globally in app.ts, no need to call it again
  (req, res, next) => {
    console.log(
      "[ROUTE] POST /api/admin/doctor-notes - User:",
      req.user ? { id: req.user.id, role: req.user.role } : "null"
    );
    next();
  },
  requireAuth,
  requireAdmin, // Database-verified admin check
  (req, res, next) => {
    console.log(
      "[ROUTE] POST /api/admin/doctor-notes - After requireAdmin, entering multer"
    );
    next();
  },
  doctorNotesUpload, // Handle multiple file types (PDFs and images)
  (req, res, next) => {
    console.log(
      "[ROUTE] POST /api/admin/doctor-notes - After multer, files:",
      req.files ? Object.keys(req.files) : "none"
    );
    next();
  },
  validateFileContentMiddleware, // Validate file content matches MIME type
  validateFieldSizes(), // Validate field sizes (for JSON data in body)
  saveDoctorNotes
);

adminRoutes.get(
  "/doctor-notes/:appointmentId",
  (req, res, next) => {
    console.log(
      "[ROUTE] GET /api/admin/doctor-notes/:appointmentId - Request received"
    );
    next();
  },
  // attachUser is already applied globally in app.ts, no need to call it again
  (req, res, next) => {
    console.log(
      "[ROUTE] GET /api/admin/doctor-notes/:appointmentId - User:",
      req.user ? { id: req.user.id, role: req.user.role } : "null"
    );
    next();
  },
  requireAuth,
  requireRole(Role.ADMIN), // Read-only, JWT check sufficient
  getDoctorNotes
);

adminRoutes.patch(
  "/doctor-notes/:appointmentId",
  attachUser,
  requireAuth,
  requireAdmin, // Database-verified admin check
  doctorNotesUpload, // Handle multiple file types (PDFs and images)
  validateFileContentMiddleware, // Validate file content matches MIME type
  validateFieldSizes(), // Validate field sizes (for JSON data in body)
  saveDoctorNotes // Reuse same handler, it will detect PATCH vs POST
);

// GET /api/admin/doctor-notes/attachment/:attachmentId/view - View/Get attachment signed URL (admin-only)
adminRoutes.get(
  "/doctor-notes/attachment/:attachmentId/view",
  attachUser,
  requireAuth,
  requireAdmin, // Database-verified admin check
  getDoctorNoteAttachment
);

// GET /api/admin/doctor-notes/attachment/:attachmentId/download - Download attachment via backend (admin-only)
adminRoutes.get(
  "/doctor-notes/attachment/:attachmentId/download",
  attachUser,
  requireAuth,
  requireAdmin, // Database-verified admin check
  downloadDoctorNoteAttachment
);

// DELETE /api/admin/doctor-notes/attachment/:attachmentId - Delete attachment (admin-only)
adminRoutes.delete(
  "/doctor-notes/attachment/:attachmentId",
  attachUser,
  requireAuth,
  requireAdmin, // Database-verified admin check
  deleteDoctorNoteAttachment
);

// POST /api/admin/doctor-notes/:appointmentId/send-email - Send Doctor Notes PDFs via email (admin-only)
adminRoutes.post(
  "/doctor-notes/:appointmentId/send-email",
  attachUser,
  requireAuth,
  requireAdmin, // Database-verified admin check
  validateFieldSizes(), // Validate field sizes
  sendDoctorNotesEmailController
);

// Admin Profile Picture Routes
// POST /api/admin/profile/picture - Upload profile picture
adminRoutes.post(
  "/profile/picture",
  attachUser,
  requireAuth,
  requireAdmin, // Database-verified admin check
  imageUpload.single("profilePicture"), // Single file upload with field name "profilePicture"
  validateFileContentMiddleware, // Validate file content matches MIME type
  uploadAdminProfilePicture
);

// GET /api/admin/profile/picture - Get profile picture
adminRoutes.get(
  "/profile/picture",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN), // Read-only, JWT check sufficient
  getAdminProfilePicture
);

// PUT /api/admin/profile/picture - Update profile picture
adminRoutes.put(
  "/profile/picture",
  attachUser,
  requireAuth,
  requireAdmin, // Database-verified admin check
  imageUpload.single("profilePicture"), // Single file upload with field name "profilePicture"
  validateFileContentMiddleware, // Validate file content matches MIME type
  updateAdminProfilePicture
);

// PATCH /api/admin/profile/picture - Update profile picture (alternative)
adminRoutes.patch(
  "/profile/picture",
  attachUser,
  requireAuth,
  requireAdmin, // Database-verified admin check
  imageUpload.single("profilePicture"), // Single file upload with field name "profilePicture"
  validateFileContentMiddleware, // Validate file content matches MIME type
  updateAdminProfilePicture
);

// DELETE /api/admin/profile/picture - Delete profile picture
adminRoutes.delete(
  "/profile/picture",
  attachUser,
  requireAuth,
  requireAdmin, // Database-verified admin check
  deleteAdminProfilePicture
);

// Admin User Management Routes
// POST /api/admin/users - Create a new user (admin creates on behalf of patient)
adminRoutes.post(
  "/users",
  attachUser,
  requireAuth,
  requireAdmin, // Database-verified admin check
  validateFieldSizes(), // Validate field sizes
  createUser
);

// GET /api/admin/users - List all users with search
adminRoutes.get(
  "/users",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN), // Read-only, JWT check sufficient
  listUsers
);

// GET /api/admin/users/:id - Get user by ID
adminRoutes.get(
  "/users/:id",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN), // Read-only, JWT check sufficient
  getUserById
);

// GET /api/admin/users/:id/patients - Get patients for a user
adminRoutes.get(
  "/users/:id/patients",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN), // Read-only, JWT check sufficient
  getUserPatients
);

// DELETE /api/admin/users/:id - Delete a user (admin operation - soft delete)
adminRoutes.delete(
  "/users/:id",
  attachUser,
  requireAuth,
  requireAdmin, // Database-verified admin check
  deleteUser
);

// POST /api/admin/users/:id/patients - Create a patient for a user (admin operation)
adminRoutes.post(
  "/users/:id/patients",
  attachUser,
  requireAuth,
  requireAdmin, // Database-verified admin check
  validateFieldSizes(), // Validate field sizes
  validateBody(createPatientSchema), // Validate patient data
  createPatientForUser
);

// Admin Appointment Creation Routes
// POST /api/admin/appointments - Create appointment by admin for a user
adminRoutes.post(
  "/appointments/create",
  attachUser,
  requireAuth,
  requireAdmin, // Database-verified admin check
  validateFieldSizes(), // Validate field sizes
  createAppointmentByAdmin
);

export default adminRoutes;
