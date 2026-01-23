import { Request, Response } from "express";
import { createRecall } from "./recall.service";
import { deleteRecallEntry } from "./recall.service";
import prisma from "../../../database/prismaclient";

export async function createRecallHandler(req: Request, res: Response) {
  try {
    // console.log(" [BACKEND] Recall creation request received");
    // console.log(
    //   " [BACKEND] User:",
    //   req.user ? { id: req.user.id, role: req.user.role } : "NOT AUTHENTICATED"
    // );
    const userId = (req as any).user?.id;
    if (!userId) {
      console.error(
        " [BACKEND] Recall creation failed: User not authenticated"
      );
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    // console.log(" [BACKEND] Request body:", {
    // patientId: req.body.patientId,
    // entriesCount: req.body.entries?.length || 0,
    // hasNotes: !!req.body.notes,
    // appointmentId: req.body.appointmentId || "none",
    // });
    // console.log(" [BACKEND] Calling createRecall service...");
    const recall = await createRecall(req.body, userId);

    // console.log(" [BACKEND] Recall created successfully:", {
    //   id: recall.id,
    //   patientId: recall.patientId,
    //   entriesCount: recall.entries.length,
    //   appointmentId: recall.appointmentId,
    // });
    return res.status(201).json({
      success: true,
      message: "Recall stored successfully",
      data: recall,
    });
  } catch (err: any) {
    // console.error(" [BACKEND] CREATE RECALL ERROR:", err);
    console.error(" [BACKEND] Error details:", {
      name: err.name,
      message: err.message,
      code: err.code,
    });
    return res.status(400).json({
      success: false,
      message: err.message || "Failed to save recall",
    });
  }
}

export async function deleteRecallEntryHandler(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { recallId, entryId } = req.params;

    const updatedRecall = await deleteRecallEntry(
      recallId,
      entryId,
      req.user.id
    );

    return res.json({
      success: true,
      message: "Entry deleted successfully",
      data: updatedRecall,
    });
  } catch (err: any) {
    return res.status(400).json({
      success: false,
      message: err.message || "Failed to delete recall entry",
    });
  }
}

export async function getRecallHandler(req: Request, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { recallId } = req.params;

    // Verify recall belongs to user
    const recall = await prisma.recall.findFirst({
      where: {
        id: recallId,
        patient: { userId: req.user.id },
      },
      include: { entries: true },
    });

    if (!recall) {
      return res.status(404).json({
        success: false,
        message: "Recall not found or unauthorized",
      });
    }

    return res.json({ success: true, data: recall });
  } catch (err: any) {
    return res.status(400).json({ success: false, message: err.message });
  }
}

export async function getRecallByAppointmentHandler(
  req: Request,
  res: Response
) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { appointmentId } = req.params;

    // Verify appointment belongs to user
    const appointment = await prisma.appointment.findFirst({
      where: {
        id: appointmentId,
        userId: req.user.id,
      },
    });

    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: "Appointment not found or unauthorized",
      });
    }

    // Fetch recall for this appointment
    const recall = await prisma.recall.findFirst({
      where: {
        appointmentId,
        isArchived: false,
      },
      include: {
        entries: true,
      },
    });

    return res.json({ success: true, data: recall });
  } catch (err: any) {
    return res.status(400).json({ success: false, message: err.message });
  }
}