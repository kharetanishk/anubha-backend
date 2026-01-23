import { Router } from "express";
import { patientController } from "./patient.controller";
import { validateBody } from "../../middleware/validateRequest";
import { createPatientSchema } from "./patient.validators";
import { requireAuth } from "../../middleware/requireAuth";
import { requireRole } from "../../middleware/requiredRole";
import { attachUser } from "../../middleware/attachUser";
import { patientLimiter, generalLimiter } from "../../middleware/rateLimit";
import { validateFieldSizes } from "../../middleware/fieldSizeValidator";
import { createRecallSchema } from "./recall/recall.validation";
import {
  createRecallHandler,
  deleteRecallEntryHandler,
  getRecallHandler,
  getRecallByAppointmentHandler,
} from "./recall/recall.controller";

const patientRoutes = Router();

// Apply general rate limiting to all patient routes
patientRoutes.use(generalLimiter);

patientRoutes.post(
  "/",
  attachUser,
  requireAuth,
  patientLimiter,
  validateFieldSizes(), // Validate field sizes
  validateBody(createPatientSchema),
  (req, res) => patientController.create(req, res)
);

patientRoutes.get("/me", attachUser, requireAuth, (req, res) =>
  patientController.listMine(req, res)
);

patientRoutes.get("/me/:id", attachUser, requireAuth, (req, res) =>
  patientController.getMineById(req, res)
);

patientRoutes.get(
  "/",
  attachUser,
  requireAuth,
  requireRole("ADMIN"),
  (req, res) => patientController.adminListAll(req, res)
);

patientRoutes.get(
  "/:id",
  attachUser,
  requireAuth,
  requireRole("ADMIN"),
  (req, res) => patientController.adminGetById(req, res)
);

patientRoutes.patch(
  "/:id",
  attachUser,
  requireAuth,
  requireRole("ADMIN"),
  validateFieldSizes(), // Validate field sizes
  (req, res) => patientController.adminUpdate(req, res)
);

patientRoutes.patch("/:id/files", attachUser, requireAuth, (req, res) =>
  patientController.linkFiles(req, res)
);

patientRoutes.delete("/file/:fileId", attachUser, requireAuth, (req, res) =>
  patientController.deleteFile(req, res)
);

patientRoutes.post(
  "/recall",
  attachUser,
  requireAuth,
  patientLimiter, // Apply rate limiting to recall creation
  validateFieldSizes(), // Validate field sizes
  validateBody(createRecallSchema),
  createRecallHandler
);

patientRoutes.delete(
  "/recall/:recallId/entry/:entryId",
  attachUser,
  requireAuth,
  deleteRecallEntryHandler
);

patientRoutes.get(
  "/recall/:recallId",
  attachUser,
  requireAuth,
  getRecallHandler
);

patientRoutes.get(
  "/recall/appointment/:appointmentId",
  attachUser,
  requireAuth,
  getRecallByAppointmentHandler
);

export default patientRoutes;
