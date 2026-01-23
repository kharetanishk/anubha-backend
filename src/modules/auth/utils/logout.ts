import { Request, Response } from "express";

/**
 * Helper function to get consistent cookie options for clearing cookies
 * Must match EXACTLY the options used when setting the cookie in auth.controller.ts
 */
function getAuthTokenCookieOptions() {
  const isProduction = process.env.NODE_ENV === "production";
  const isStaging = process.env.NODE_ENV !== "production" && 
    (process.env.FRONTEND_URL?.includes("staging") || 
     process.env.CORS_ORIGINS?.includes("staging") ||
     process.env.COOKIE_DOMAIN?.includes("staging"));

  const options: any = {
    httpOnly: true,
    path: "/", // Must match the setting cookie path
  };

  if (isProduction) {
    // Production settings: must match auth.controller.ts exactly
    options.secure = true;
    options.sameSite = "none" as const;
    options.domain = process.env.COOKIE_DOMAIN || ".anubhanutrition.in";
  } else if (isStaging) {
    // Staging settings: must match auth.controller.ts exactly
    options.secure = true;
    options.sameSite = "none" as const;
    options.domain = process.env.COOKIE_DOMAIN || ".staging.anubhanutrition.in";
  } else {
    // Dev settings: must match auth.controller.ts exactly
    options.secure = false;
    options.sameSite = "lax" as const;
    // No domain set for localhost
  }

  return options;
}

export const logout = async (req: Request, res: Response) => {
  try {
    const cookieOptions = getAuthTokenCookieOptions();
    
    // Clear all possible cookie names (role-specific and legacy)
    // This ensures complete logout regardless of which cookie was used
    res.clearCookie("auth_token_user", cookieOptions);
    res.clearCookie("auth_token_admin", cookieOptions);
    res.clearCookie("auth_token", cookieOptions); // Legacy cookie name

    return res.json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    console.error("LOGOUT ERROR:", error);
    res.status(500).json({ success: false, message: "Server error during logout" });
  }
};
