import { Router } from "express";
import {
  createAppointmentHandler,
  getMyAppointments,
  getAppointmentsByPatient,
  updateAppointmentSlotHandler,
  getUserAppointmentDetails,
} from "./appointment.controller";
import { attachUser } from "../../middleware/attachUser";
import { requireAuth } from "../../middleware/requireAuth";

const appointmentRoutes = Router();

appointmentRoutes.post(
  "/create",
  attachUser,
  requireAuth,
  createAppointmentHandler
);

appointmentRoutes.get("/my", attachUser, requireAuth, getMyAppointments);

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

appointmentRoutes.patch(
  "/:appointmentId/slot",
  attachUser,
  requireAuth,
  updateAppointmentSlotHandler
);

export default appointmentRoutes;
