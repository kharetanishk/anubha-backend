import { NextFunction, Request, Response } from "express";
import { verifyToken } from "../modules/auth/utils/token";

export async function attachUser(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const token = req.cookies.auth_token;

    if (!token) {
      return next();
    }

    const decoded = verifyToken(token);

    if (decoded) {
      req.user = { id: decoded.id, role: decoded.role };
    }

    return next();
  } catch {
    return next();
  }
}
