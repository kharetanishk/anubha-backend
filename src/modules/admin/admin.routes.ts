import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { requireRole } from "../../middleware/requiredRole";
import { attachUser } from "../../middleware/attachUser";
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
  saveDoctorSession,
} from "./admin.controller";

const adminRoutes = Router();

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
  adminUpdateAppointmentStatus
);

adminRoutes.post(
  "/doctor-session",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
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
  saveDoctorSession
);

export default adminRoutes;
