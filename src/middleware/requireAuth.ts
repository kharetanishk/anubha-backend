import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import prisma from "../database/prismaclient";
import { generateAccessToken } from "../modules/auth/utils/token";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const accessToken = req.cookies.access_token;
    const refreshToken = req.cookies.refresh_token;

    if (!accessToken && !refreshToken) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    // 1️⃣ Try Access Token first
    try {
      const decoded = jwt.verify(
        accessToken,
        process.env.ACCESS_TOKEN_SECRET!
      ) as Express.UserPayload;

      req.user = { id: decoded.id, role: decoded.role };
      return next();
    } catch {
      // access token expired -> fallback to refresh token
    }

    // 2️⃣ No refresh token = session dead
    if (!refreshToken) {
      return res
        .status(401)
        .json({ message: "Session expired. Please login." });
    }

    const storedToken = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: true, admin: true },
    });

    if (!storedToken || storedToken.expiresAt < new Date()) {
      return res.status(401).json({ message: "Session expired. Login again." });
    }

    // ——————————————————
    // 3️⃣ Determine OWNER of refresh token
    // ——————————————————
    let owner: { id: string; role: "USER" | "ADMIN" } | null = null;

    if (storedToken.user) {
      owner = { id: storedToken.user.id, role: "USER" };
    } else if (storedToken.admin) {
      owner = { id: storedToken.admin.id, role: "ADMIN" };
    } else {
      return res.status(401).json({ message: "Invalid session token" });
    }

    // ——————————————————
    // 4️⃣ Issue NEW access token
    // ——————————————————
    const newAccessToken = generateAccessToken({
      id: owner.id,
      role: owner.role,
    });

    res.cookie("access_token", newAccessToken, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: 15 * 60 * 1000,
    });

    req.user = owner;

    return next();
  } catch (err) {
    console.error("AUTH ERROR:", err);
    return res.status(401).json({ message: "Unauthorized" });
  }
}
