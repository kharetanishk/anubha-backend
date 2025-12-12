import { Router } from "express";
import {
  createAppointmentHandler,
  getMyAppointments,
  getAppointmentsByPatient,
  updateAppointmentSlotHandler,
  getUserAppointmentDetails,
  getPendingAppointments,
  updateBookingProgress,
  deleteAppointmentHandler,
} from "./appointment.controller";
import { attachUser } from "../../middleware/attachUser";
import { requireAuth } from "../../middleware/requireAuth";
import {
  appointmentCreateLimiter,
  appointmentUpdateLimiter,
  generalLimiter,
} from "../../middleware/rateLimit";
import { validateFieldSizes } from "../../middleware/fieldSizeValidator";

const appointmentRoutes = Router();

// Apply general rate limiting to all appointment routes
appointmentRoutes.use(generalLimiter);

// Appointment creation - strict rate limiting + field validation
appointmentRoutes.post(
  "/create",
  appointmentCreateLimiter,
  attachUser,
  requireAuth,
  validateFieldSizes(), // Validate field sizes
  createAppointmentHandler
);

// Get appointments - moderate rate limiting
appointmentRoutes.get("/my", attachUser, requireAuth, getMyAppointments);

appointmentRoutes.get(
  "/pending",
  attachUser,
  requireAuth,
  getPendingAppointments
);

appointmentRoutes.get(
  "/patient/:patientId",
  attachUser,
  requireAuth,
  getAppointmentsByPatient
);

appointmentRoutes.get(
  "/my/:id",
  attachUser,
  requireAuth,
  getUserAppointmentDetails
);

// Appointment updates - moderate rate limiting + field validation
appointmentRoutes.patch(
  "/:appointmentId/slot",
  appointmentUpdateLimiter,
  attachUser,
  requireAuth,
  validateFieldSizes(), // Validate field sizes
  updateAppointmentSlotHandler
);

appointmentRoutes.patch(
  "/:appointmentId/progress",
  appointmentUpdateLimiter,
  attachUser,
  requireAuth,
  validateFieldSizes(), // Validate field sizes
  updateBookingProgress
);

appointmentRoutes.delete(
  "/:appointmentId",
  attachUser,
  requireAuth,
  deleteAppointmentHandler
);

export default appointmentRoutes;
