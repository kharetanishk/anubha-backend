import { Request, Response, NextFunction } from "express";
import { Role } from "@prisma/client";

export function requireRole(...allowedRoles: Role[]) {
  return function (req: Request, res: Response, next: NextFunction) {
    const user = req.user;

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized. Login required.",
      });
    }

    if (!allowedRoles.includes(user.role)) {
      return res.status(403).json({
        success: false,
        message: "Forbidden. You don't have permission.",
      });
    }

    next();
  };
}
