import { Router } from "express";
import {
  createAppointmentHandler,
  getMyAppointments,
  getAppointmentsByPatient,
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

appointmentRoutes.get("/my", requireAuth, getMyAppointments);

appointmentRoutes.get(
  "/patient/:patientId",
  requireAuth,
  getAppointmentsByPatient
);

export default appointmentRoutes;
