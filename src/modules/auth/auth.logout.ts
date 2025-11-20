import { Request, Response } from "express";
import prisma from "../../database/prismaclient";

export const logout = async (req: Request, res: Response) => {
  try {
    const refreshToken = req.cookies?.refresh_token;

    if (refreshToken) {
      await prisma.refreshToken.deleteMany({
        where: { token: refreshToken },
      });
    }

    res.clearCookie("access_token", {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
    });

    res.clearCookie("refresh_token", {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
    });

    return res.json({ message: "Logged out successfully" });
  } catch (error) {
    console.error("LOGOUT ERROR:", error);
    res.status(500).json({ message: "Server error during logout" });
  }
};
