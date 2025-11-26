import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { requireRole } from "../../middleware/requiredRole";
import { Role } from "@prisma/client";

import {
  adminGetAppointments,
  adminUpdateAppointmentStatus,
  adminGetAppointmentDetails,
  createDoctorSession,
  upsertDoctorFieldValue,
  getDoctorSession,
  deleteDoctorSession,
  getDoctorFieldGroups,
  searchDoctorFields,
} from "./admin.controller";

const adminRoutes = Router();

adminRoutes.get(
  "/appointments",
  requireAuth,
  requireRole(Role.ADMIN),
  adminGetAppointments
);

adminRoutes.get(
  "/appointments/:id",
  requireAuth,
  requireRole(Role.ADMIN),
  adminGetAppointmentDetails
);

adminRoutes.patch(
  "/appointments/:id/status",
  requireAuth,
  requireRole(Role.ADMIN),
  adminUpdateAppointmentStatus
);

adminRoutes.post(
  "/doctor-session",
  requireAuth,
  requireRole(Role.ADMIN),
  createDoctorSession
);

adminRoutes.get(
  "/doctor-session/:sessionId",
  requireAuth,
  requireRole(Role.ADMIN),
  getDoctorSession
);

adminRoutes.patch(
  "/doctor-session/:sessionId/value",
  requireAuth,
  requireRole(Role.ADMIN),
  upsertDoctorFieldValue
);

adminRoutes.delete(
  "/doctor-session/:sessionId",
  requireAuth,
  requireRole(Role.ADMIN),
  deleteDoctorSession
);

adminRoutes.get(
  "/doctor-fields/groups",
  requireAuth,
  requireRole(Role.ADMIN),
  getDoctorFieldGroups
);

adminRoutes.get(
  "/doctor-fields/search",
  requireAuth,
  requireRole(Role.ADMIN),
  searchDoctorFields
);

export default adminRoutes;
