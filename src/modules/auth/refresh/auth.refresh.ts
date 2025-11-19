import { Request, Response } from "express";
import prisma from "../../../database/prismaclient";
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} from "../utils/token";

export const refreshSession = async (req: Request, res: Response) => {
  try {
    const token = req.cookies?.refresh_token;

    if (!token) {
      return res.status(401).json({ message: "No refresh token provided" });
    }

    // 1️⃣ Validate refresh token signature
    const payload = verifyRefreshToken(token);
    if (!payload) {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    // 2️⃣ Fetch token from DB with owner info
    const storedToken = await prisma.refreshToken.findUnique({
      where: { token },
      include: { user: true, admin: true },
    });

    if (!storedToken) {
      return res.status(401).json({ message: "Refresh token not found" });
    }

    // 3️⃣ Check expiry
    if (storedToken.expiresAt < new Date()) {
      await prisma.refreshToken.delete({ where: { token } });
      return res.status(401).json({ message: "Refresh token expired" });
    }

    // 4️⃣ Determine owner (USER or ADMIN)
    const owner = storedToken.user
      ? { id: storedToken.user.id, role: "USER" as const }
      : storedToken.admin
      ? { id: storedToken.admin.id, role: "ADMIN" as const }
      : null;

    if (!owner) {
      return res.status(401).json({ message: "Invalid token owner" });
    }

    // 5️⃣ Delete the old refresh token (rotation)
    await prisma.refreshToken.delete({ where: { token } });

    // 6️⃣ Generate new refresh token (this function INSERTS it into DB)
    const { refreshToken, refreshTokenExpiry } = await generateRefreshToken(
      owner.id,
      owner.role
    );

    // 7️⃣ Generate new access token
    const accessToken = generateAccessToken({
      id: owner.id,
      role: owner.role,
    });

    // 8️⃣ Set cookies
    res.cookie("refresh_token", refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });

    res.cookie("access_token", accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: 15 * 60 * 1000, // 15 minutes
    });

    // 9️⃣ Response
    return res.json({
      message: "Session refreshed",
      accessToken,
      refreshToken,
      expiresAt: refreshTokenExpiry,
      user: {
        id: owner.id,
        role: owner.role,
      },
      origin: "auth/refresh",
    });
  } catch (error) {
    console.error("REFRESH ERROR:", error);
    return res.status(500).json({ message: "Server error" });
  }
};
