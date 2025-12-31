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
      // Log missing cookie for debugging (only on non-auth endpoints)
      if (
        !req.path.includes("/auth/") &&
        !req.path.includes("/api/health") &&
        req.method !== "OPTIONS"
      ) {
        // console.warn("[AUTH] Cookie missing:", {
        // path: req.path,
        // method: req.method,
        // timestamp: new Date()
        // .toISOString(),
        // });
        // }
        // return next();
    }

    const decoded = verifyToken(token);

    if (decoded) {
      req.user = { id: decoded.id, role: decoded.role };
    } else {
      // Log failed token verification for monitoring
      // console.warn("[AUTH] Token verification failed:", {
      // hasToken: !!token,
      // tokenLength: token.length,
      // tokenPreview: token.substring(0, 20)
      // + "...",
      // timestamp: new Date().toISOString(),
      // path: req.path,
      // method: req.method,
      // });
      // }

    return next();
  } catch (err: any) {
    // Log token verification errors for monitoring
    console.error("[AUTH] Token verification error:", {
      error: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
      timestamp: new Date().toISOString(),
    });
    // Continue without user - let requireAuth middleware handle authorization
    return next();
  }
}
