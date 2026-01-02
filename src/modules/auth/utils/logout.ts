import { Request, Response } from "express";

/**
 * Helper function to get consistent cookie options for clearing cookies
 * Must match the options used when setting the cookie
 */
function getAuthTokenCookieOptions() {
  const options: any = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const, // Must match the setting cookie options
    path: "/", // Must match the setting cookie path
  };

  // Set domain in production for proper cookie clearing
  // In development, omit domain to allow localhost
  if (process.env.NODE_ENV === "production" && process.env.COOKIE_DOMAIN) {
    options.domain = process.env.COOKIE_DOMAIN;
  }

  return options;
}

export const logout = async (req: Request, res: Response) => {
  try {
    res.clearCookie("auth_token", getAuthTokenCookieOptions());

    return res.json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    console.error("LOGOUT ERROR:", error);
    res.status(500).json({ success: false, message: "Server error during logout" });
  }
};
