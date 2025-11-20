import { Request, Response } from "express";
import { createRecall } from "./recall.service";
import { deleteRecallEntry } from "./recall.service";
import prisma from "../../../database/prismaclient";

export async function createRecallHandler(req: Request, res: Response) {
  try {
    const userId = (req as any).user?.id;
    if (!userId)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    const recall = await createRecall(req.body, userId);

    return res.status(201).json({
      success: true,
      message: "Recall stored successfully",
      data: recall,
    });
  } catch (err: any) {
    return res.status(400).json({
      success: false,
      message: err.message || "Failed to save recall",
    });
  }
}

export async function deleteRecallEntryHandler(req: Request, res: Response) {
  try {
    const { recallId, entryId } = req.params;

    const updatedRecall = await deleteRecallEntry(recallId, entryId);

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
    const { recallId } = req.params;

    const recall = await prisma.recall.findUnique({
      where: { id: recallId },
      include: { entries: true },
    });

    return res.json({ success: true, data: recall });
  } catch (err: any) {
    return res.status(400).json({ success: false, message: err.message });
  }
}
