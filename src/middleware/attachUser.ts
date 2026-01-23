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
      // Check role-specific cookies first (new architecture)
      // Then fallback to legacy cookie name for backward compatibility
      token = req.cookies.auth_token_user || 
              req.cookies.auth_token_admin || 
              req.cookies.auth_token; // Legacy cookie name
    }

    if (!token) {
      // Log missing cookie for debugging (only on non-auth endpoints)
      if (
        !req.path.includes("/auth/") &&
        !req.path.includes("/api/health") &&
        req.method !== "OPTIONS"
      ) {
        console.warn("[AUTH] No token found:", {
          path: req.path,
          method: req.method,
          hasAuthHeader: !!authHeader,
          hasCookies: !!req.cookies,
          cookieKeys: req.cookies ? Object.keys(req.cookies) : [],
          timestamp: new Date().toISOString(),
        });
      }
      return next();
    }

    const decoded = verifyToken(token);

    if (decoded) {
      req.user = { id: decoded.id, role: decoded.role };
    } else {
      // Log failed token verification for monitoring
      console.warn("[AUTH] Token verification failed:", {
        hasToken: !!token,
        tokenLength: token.length,
        tokenPreview: token.substring(0, 20) + "...",
        timestamp: new Date().toISOString(),
        path: req.path,
        method: req.method,
      });
    }

    return next();
  } catch (err: any) {
    // Log token verification errors for monitoring
    if (process.env.NODE_ENV !== "production") {
      console.error("[AUTH] Token verification error:", {
        error: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString(),
      });
    } else {
      console.error("[AUTH] Token verification error:", {
        error: err.message,
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString(),
      });
    }
    // Continue without user - let requireAuth middleware handle authorization
    return next();
  }
}
