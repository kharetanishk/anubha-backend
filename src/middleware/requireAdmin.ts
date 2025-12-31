import { Request, Response, NextFunction } from "express";
import prisma from "../database/prismaclient";
import { AppError } from "../util/AppError";

/**
 * SECURITY: requireAdmin middleware
 *
 * This middleware verifies admin role from the DATABASE, not just JWT token.
 * This provides defense-in-depth against token tampering or role escalation.
 *
 * Usage:
 *   adminRoutes.get("/sensitive-endpoint", requireAuth, requireAdmin, handler);
 *
 * Note: This performs a database query, so use sparingly on high-traffic routes.
 * For most admin routes, requireRole(Role.ADMIN) is sufficient since JWT is cryptographically signed.
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    // First check: User must be authenticated (JWT check)
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized. Login required.",
      });
    }

    // Second check: JWT must have ADMIN role
    if (req.user.role !== "ADMIN") {
      return res.status(403).json({
        success: false,
        message: "Forbidden. Admin access required.",
      });
    }

    // Third check: Verify role from DATABASE (defense-in-depth)
    // This ensures the user's role in DB matches the JWT token
    // For ADMIN role, check Admin table; for USER role, check User table
    let user: { id: string; role: string; isArchived?: boolean } | null = null;

    if (req.user.role === "ADMIN") {
      // Check Admin table for admin users
      const admin = await prisma.admin.findUnique({
        where: { id: req.user.id },
        select: { id: true, isArchived: true },
      });

      if (admin) {
        user = {
          id: admin.id,
          role: "ADMIN",
          isArchived: admin.isArchived || false,
        };
      }
    } else {
      // Check User table for regular users
      const regularUser = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { id: true, role: true, isArchived: true },
      });

      if (regularUser) {
        user = regularUser;
      }
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (user.isArchived) {
      return res.status(403).json({
        success: false,
        message: "Account is archived.",
      });
    }

    // CRITICAL: Verify role from database matches JWT token
    if (user.role !== "ADMIN") {
      // console.warn(
      // `[SECURITY] Role mismatch detected for user ${req.user.id}: JWT=${req.user.role}, DB=${user.role}`
      // );
return res.status(403).json({
        success: false,
        message: "Forbidden. Admin access required.",
      });
    }

    // All checks passed - user is verified admin from database
    next();
  } catch (error: any) {
    console.error("[AUTH] requireAdmin error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error during authorization.",
    });
  }
}
