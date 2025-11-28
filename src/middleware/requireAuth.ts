import { NextFunction, Request, Response } from "express";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Not authenticated. Please login.",
      });
    }

    return next();
  } catch (err) {
    console.error("AUTH ERROR:", err);
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }
}
