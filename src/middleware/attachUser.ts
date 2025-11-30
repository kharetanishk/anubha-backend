import { NextFunction, Request, Response } from "express";
import { verifyToken } from "../modules/auth/utils/token";

export async function attachUser(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    // Try to get token from Authorization header first (Bearer token)
    let token: string | undefined;
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    } else {
      // Fallback to cookie
      token = req.cookies.auth_token;
    }

    if (!token) {
      return next();
    }

    const decoded = verifyToken(token);

    if (decoded) {
      req.user = { id: decoded.id, role: decoded.role };
    }

    return next();
  } catch (err) {
    // Silently continue if token verification fails
    return next();
  }
}
