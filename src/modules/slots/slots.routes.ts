// src/modules/slots/slot.routes.ts
import { Router } from "express";
import {
  generateSlotsHandler,
  addDayOffHandler,
  removeDayOffHandler,
  getAvailableSlotsHandler,
  adminGetSlotsHandler,
  adminGetDayOffListHandler,
  previewSlotsHandler,
} from "./slots.controller";
import { requireRole } from "../../middleware/requiredRole";
import { Role } from "@prisma/client";
import { attachUser } from "../../middleware/attachUser";
import { requireAuth } from "../../middleware/requireAuth";

const slotRoutes = Router();

// Admin: preview slots for a date range (before creating)
slotRoutes.get(
  "/admin/preview",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  previewSlotsHandler
);

// Admin: generate slots for a date range
slotRoutes.post(
  "/admin/generate",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  generateSlotsHandler
);

// Admin: add a day off
slotRoutes.post(
  "/admin/day-off",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  addDayOffHandler
);

// Admin: remove a day off
slotRoutes.delete(
  "/admin/day-off/:id",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  removeDayOffHandler
);
// ADMIN: get all slots (with filters)
slotRoutes.get(
  "/admin/list",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  adminGetSlotsHandler
);

// ADMIN: get all day-offs
slotRoutes.get(
  "/admin/day-off",
  attachUser,
  requireAuth,
  requireRole(Role.ADMIN),
  adminGetDayOffListHandler
);

// Public (patient): get available slots for a date + mode
slotRoutes.get("/available", attachUser, getAvailableSlotsHandler);

export default slotRoutes;
