import { Router } from "express";
import { patientController } from "./patient.contoller";
import { validateBody } from "../../middleware/validateRequest";
import { createPatientSchema } from "./patient.validators";
import { requireAuth } from "../../middleware/requireAuth";
import { requireRole } from "../../middleware/requiredRole";
import { patientLimiter } from "../../middleware/rateLimit";
import { createRecallSchema } from "./recall_form/recall.validation";
import {
  createRecallHandler,
  deleteRecallEntryHandler,
  getRecallHandler,
} from "./recall_form/recall.controller";

const patientRoutes = Router();

patientRoutes.post(
  "/",
  requireAuth,
  patientLimiter,
  validateBody(createPatientSchema),
  (req, res) => patientController.create(req, res)
);

patientRoutes.get("/me", requireAuth, (req, res) =>
  patientController.listMine(req, res)
);

patientRoutes.get("/me/:id", requireAuth, (req, res) =>
  patientController.getMineById(req, res)
);

patientRoutes.get("/", requireAuth, requireRole("ADMIN"), (req, res) =>
  patientController.adminListAll(req, res)
);

patientRoutes.get("/:id", requireAuth, requireRole("ADMIN"), (req, res) =>
  patientController.adminGetById(req, res)
);

patientRoutes.patch("/:id", requireAuth, requireRole("ADMIN"), (req, res) =>
  patientController.adminUpdate(req, res)
);

patientRoutes.delete("/file/:fileId", requireAuth, (req, res) =>
  patientController.deleteFile(req, res)
);

patientRoutes.post(
  "/recall",
  requireAuth,
  validateBody(createRecallSchema),
  createRecallHandler
);

patientRoutes.delete(
  "/recall/:recallId/entry/:entryId",
  requireAuth,
  deleteRecallEntryHandler
);

patientRoutes.get("/recall/:recallId", requireAuth, getRecallHandler);

export default patientRoutes;
