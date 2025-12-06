import { Request, Response } from "express";

export const logout = async (req: Request, res: Response) => {
  try {
    res.clearCookie("auth_token", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax",
    });

    return res.json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    console.error("LOGOUT ERROR:", error);
    res.status(500).json({ success: false, message: "Server error during logout" });
  }
};
