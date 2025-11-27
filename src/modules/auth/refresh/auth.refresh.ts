import { Request, Response } from "express";

export const refreshSession = async (req: Request, res: Response) => {
  try {
    if (req.user) {
      return res.json({
        success: true,
        message: "Session is valid",
        user: req.user,
      });
    }

    return res.status(401).json({
      success: false,
      message: "No valid session",
    });
  } catch (error) {
    console.error("REFRESH ERROR:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
