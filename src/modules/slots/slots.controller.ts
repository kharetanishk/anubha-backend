// src/modules/slots/slot.controller.ts
import { Request, Response } from "express";
import {
  generateSlotsForRange,
  addDoctorDayOff,
  removeDoctorDayOff,
  getAvailableSlotsForDate,
  getAdminSlots,
  getAdminDayOffList,
  previewSlotsForRange,
  getAdminSlotDateRange,
} from "./slots.services";
import {
  generateSlotsSchema,
  dayOffSchema,
  availableSlotsQuerySchema,
  adminSlotsQuerySchema,
} from "./slots.validation";

export async function generateSlotsHandler(req: Request, res: Response) {
  try {
    const parsed = generateSlotsSchema.parse(req.body);

    const result = await generateSlotsForRange(parsed);

    return res.status(200).json({
      success: true,
      message: "Slots generated successfully",
      createdCount: result.createdCount,
    });
  } catch (err: any) {
    console.error("generateSlotsHandler error:", err);
    return res.status(400).json({
      success: false,
      message: err?.message || "Failed to generate slots",
    });
  }
}

export async function addDayOffHandler(req: Request, res: Response) {
  try {
    const parsed = dayOffSchema.parse(req.body);

    const dayOff = await addDoctorDayOff(parsed);

    return res.status(200).json({
      success: true,
      message: "Day off saved successfully",
      data: dayOff,
    });
  } catch (err: any) {
    console.error("addDayOffHandler error:", err);
    return res.status(400).json({
      success: false,
      message: err?.message || "Failed to save day off",
    });
  }
}

export async function removeDayOffHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;

    await removeDoctorDayOff(id);

    return res.status(200).json({
      success: true,
      message: "Day off removed successfully",
    });
  } catch (err: any) {
    console.error("removeDayOffHandler error:", err);
    return res.status(400).json({
      success: false,
      message: err?.message || "Failed to remove day off",
    });
  }
}

export async function getAvailableSlotsHandler(req: Request, res: Response) {
  try {
    // console.log(" [SLOTS CONTROLLER] Available slots request received");
    // console.log(" [SLOTS CONTROLLER] Query params:", req.query);
    const parsed = availableSlotsQuerySchema.parse(req.query);
    // console.log(" [SLOTS CONTROLLER] Validated query:", parsed);
    const slots = await getAvailableSlotsForDate(parsed);

    // console.log(" [SLOTS CONTROLLER] Returning slots:", {
    //   count: slots.length,
    //   date: parsed.date,
    //   mode: parsed.mode,
    // });
    return res.status(200).json({
      success: true,
      data: slots,
    });
  } catch (err: any) {
    // console.error(" [SLOTS CONTROLLER] getAvailableSlotsHandler error:", err);
    console.error(" [SLOTS CONTROLLER] Error details:", {
      message: err?.message,
      name: err?.name,
    });
    return res.status(400).json({
      success: false,
      message: err?.message || "Failed to fetch available slots",
    });
  }
}

export async function adminGetSlotsHandler(req: Request, res: Response) {
  try {
    const parsed = adminSlotsQuerySchema.parse(req.query);

    const slots = await getAdminSlots(parsed);

    return res.status(200).json({
      success: true,
      data: slots,
    });
  } catch (err: any) {
    console.error("adminGetSlotsHandler error:", err);
    return res.status(400).json({
      success: false,
      message: err?.message || "Failed to fetch admin slots",
    });
  }
}

export async function adminGetDayOffListHandler(req: Request, res: Response) {
  try {
    const offs = await getAdminDayOffList();

    return res.status(200).json({
      success: true,
      data: offs,
    });
  } catch (err: any) {
    console.error("adminGetDayOffListHandler error:", err);
    return res.status(400).json({
      success: false,
      message: err?.message || "Failed to fetch day off list",
    });
  }
}

export async function previewSlotsHandler(req: Request, res: Response) {
  try {
    // Parse query params - modes should be comma-separated string
    const { startDate, endDate, modes } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "startDate and endDate are required",
      });
    }

    // Parse modes from query string (comma-separated or array)
    let modesArray: string[] = [];
    if (modes) {
      if (typeof modes === "string") {
        modesArray = modes.split(",").map((m) => m.trim());
      } else if (Array.isArray(modes)) {
        modesArray = modes.map((m) => String(m).trim());
      }
    } else {
      // Default to both modes if not specified
      modesArray = ["IN_PERSON", "ONLINE"];
    }

    const parsed = generateSlotsSchema.parse({
      startDate: String(startDate),
      endDate: String(endDate),
      modes: modesArray,
    });

    const preview = await previewSlotsForRange(parsed);

    return res.status(200).json({
      success: true,
      data: preview,
    });
  } catch (err: any) {
    console.error("previewSlotsHandler error:", err);
    return res.status(400).json({
      success: false,
      message: err?.message || "Failed to preview slots",
    });
  }
}

export async function getSlotDateRangeHandler(req: Request, res: Response) {
  try {
    const dateRange = await getAdminSlotDateRange();

    return res.status(200).json({
      success: true,
      data: dateRange,
    });
  } catch (err: any) {
    console.error("getSlotDateRangeHandler error:", err);
    return res.status(500).json({
      success: false,
      message: err?.message || "Failed to fetch slot date range",
    });
  }
}
