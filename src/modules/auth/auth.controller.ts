import { Request, Response } from "express";
import { authService } from "./auth.service";
import { verifyToken } from "./utils/token";
import prisma from "../../database/prismaclient";

/**
 * Helper function to get consistent cookie options
 * Ensures all auth_token cookies are set with the same configuration
 */
function getAuthTokenCookieOptions() {
  const options: any = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const, // Allows cross-site requests with credentials
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: "/", // Available on all paths
  };

  // Set domain in production for proper cookie persistence
  // In development, omit domain to allow localhost
  if (process.env.NODE_ENV === "production" && process.env.COOKIE_DOMAIN) {
    options.domain = process.env.COOKIE_DOMAIN;
  }

  return options;
}

export class AuthController {
  async sendRegisterOtp(req: Request, res: Response) {
    try {
      const { name, phone } = req.body;

      // Additional validation - ensure body is not empty
      if (!name || !phone) {
        return res.status(400).json({
          success: false,
          message: "Name and phone are required",
        });
      }

      const response = await authService.sendRegisterOtp(name, phone);

      return res.status(200).json({
        success: true,
        ...response,
      });
    } catch (error: any) {
      // Return appropriate status code based on error type
      const statusCode = error.statusCode || 400;
      return res.status(statusCode).json({
        success: false,
        message: error.message || "Failed to send OTP",
      });
    }
  }

  async verifyRegisterOtp(req: Request, res: Response) {
    try {
      const { name, phone, otp } = req.body;

      const response = await authService.verifyRegisterOtp(name, phone, otp);

      res.cookie("auth_token", response.token, getAuthTokenCookieOptions());

      return res.status(200).json({
        success: true,
        message: response.message,
        user: response.user,
      });
    } catch (error: any) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async sendLoginOtp(req: Request, res: Response) {
    try {
      const { phone } = req.body;

      // Additional validation - ensure body is not empty
      if (!phone) {
        return res.status(400).json({
          success: false,
          message: "Phone number is required",
        });
      }

      const response = await authService.sendLoginOtp(phone);

      return res.status(200).json({
        success: true,
        ...response,
      });
    } catch (error: any) {
      // Return appropriate status code based on error type
      const statusCode = error.statusCode || 400;
      return res.status(statusCode).json({
        success: false,
        message: error.message || "Failed to send OTP",
      });
    }
  }

  async verifyLoginOtp(req: Request, res: Response) {
    try {
      const { phone, otp } = req.body;

      const response = await authService.verifyLoginOtp(phone, otp);

      // If user not found, return special response
      if ((response as any).userNotFound) {
        return res.status(200).json({
          success: true,
          userNotFound: true,
          message: "No account found with this phone number",
        });
      }

      res.cookie("auth_token", response.token, getAuthTokenCookieOptions());

      return res.status(200).json({
        success: true,
        message: response.message,
        role: response.role,
        user: response.owner,
      });
    } catch (error: any) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async getMe(req: Request, res: Response) {
    try {
      // console.log("[AUTH /me] Request received:", {
      // hasUser: !!req.user,
      // userId: req.user?.id,
      // userRole: req.user?.role,
      // });
      if (!req.user) {
        // console.log("[AUTH /me] No user found - returning 401");
        return res.status(401).json({
          success: false,
          message: "Not authenticated",
        });
      }

      // Validate role before calling service
      if (req.user.role !== "USER" && req.user.role !== "ADMIN") {
        console.error("[AUTH /me] Invalid role:", req.user.role);
        return res.status(400).json({
          success: false,
          message: `Invalid role: ${req.user.role}. Expected USER or ADMIN.`,
        });
      }

      // console.log("[AUTH /me] Calling authService.getMe with:", {
      //   id: req.user.id,
      //   role: req.user.role,
      // });
      const response = await authService.getMe(req.user.id, req.user.role);

      // console.log("[AUTH /me] Success - returning user data");
      return res.status(200).json({
        success: true,
        user: response,
      });
    } catch (error: any) {
      if (process.env.NODE_ENV !== "production") {
        console.error("[AUTH /me] Error:", {
          message: error.message,
          statusCode: error.statusCode,
          errorCode: error.code,
          errorName: error.name,
          stack: error.stack,
        });
      } else {
        console.error("[AUTH /me] Error:", {
          message: error.message,
          statusCode: error.statusCode,
          errorCode: error.code,
          errorName: error.name,
        });
      }

      // Check if it's a database connection error
      // Prisma error codes: https://www.prisma.io/docs/reference/api-reference/error-reference
      const isDatabaseError =
        error.code === "P1001" || // Can't reach database server
        error.code === "P1002" || // Database connection timeout
        error.code === "P1003" || // Database does not exist
        error.code === "P1008" || // Operations timed out
        error.code === "P1017" || // Server has closed the connection
        error.code === "P2002" || // Unique constraint violation (might indicate DB issues)
        error.code === "P2024" || // Connection pool timeout
        error.code === "P2025" || // Record not found (but could be DB issue)
        error.message?.includes("Can't reach database server") ||
        error.message?.includes("database server") ||
        error.message?.includes("connection") ||
        error.message?.includes("timeout") ||
        error.name === "PrismaClientInitializationError" ||
        error.name === "PrismaClientKnownRequestError" ||
        (error.name === "Error" && error.message?.includes("prisma"));

      // Use error statusCode if available
      // Database errors should be 500 (server error), not 400 (client error)
      // Authentication errors (AppError with statusCode) should use that statusCode
      let statusCode = error.statusCode;

      if (!statusCode) {
        // If no statusCode, determine based on error type
        if (isDatabaseError) {
          statusCode = 500; // Server error - database unavailable
        } else {
          statusCode = 400; // Client error - invalid request
        }
      }

      // Never expose stack traces or internal error details to client
      return res.status(statusCode).json({
        success: false,
        message: error.message || "Failed to get user information",
        ...(isDatabaseError && {
          errorType: "database_error",
          retryable: true,
        }),
      });
    }
  }

  /* ---------------- UPDATE PHONE NUMBER ---------------- */
  async updatePhone(req: Request, res: Response) {
    try {
      // console.log("[AUTH /update-phone] Request received:", {
      // hasUser: !!req.user,
      // userId: req.user?.id,
      // userRole: req.user?.role,
      // });
      if (!req.user) {
        // console.log("[AUTH /update-phone] No user found - returning 401");
        return res.status(401).json({
          success: false,
          message: "Not authenticated. Please login.",
        });
      }

      // Only allow USER role to update phone (not ADMIN)
      if (req.user.role !== "USER") {
        console.error("[AUTH /update-phone] Invalid role:", req.user.role);
        return res.status(403).json({
          success: false,
          message: "Only users can update their phone number.",
        });
      }

      const { phone } = req.body;

      // console.log(
      // "[AUTH /update-phone] Calling authService.updatePhone with:",
      // {
      // userId: req.user.id,
      // phone: phone ? "provided" : "null (delete)
      // ",
      // }
      // );

      const updatedUser = await authService.updatePhone(req.user.id, phone);

      // console.log("[AUTH /update-phone] Success - phone updated");
      return res.status(200).json({
        success: true,
        message: phone
          ? "Phone number updated successfully."
          : "Phone number removed successfully.",
        user: updatedUser,
      });
    } catch (error: any) {
      console.error("[AUTH /update-phone] Error:", {
        message: error.message,
        statusCode: error.statusCode,
        errorCode: error.code,
        errorName: error.name,
      });

      const statusCode = error.statusCode || 500;
      return res.status(statusCode).json({
        success: false,
        message: error.message || "Failed to update phone number",
      });
    }
  }

  /* ---------------- PASSWORD-BASED SIGNUP ---------------- */
  async signupWithPassword(req: Request, res: Response) {
    try {
      const { name, phone, email, password } = req.body;

      // Validation
      if (!name || !email || !password) {
        return res.status(400).json({
          success: false,
          message: "Name, email, and password are required",
        });
      }

      const response = await authService.signupWithPassword(
        name,
        phone || null,
        email,
        password
      );

      res.cookie("auth_token", response.token, getAuthTokenCookieOptions());

      return res.status(201).json({
        success: true,
        message: response.message,
        user: response.user,
      });
    } catch (error: any) {
      const statusCode = error.statusCode || 400;
      return res.status(statusCode).json({
        success: false,
        message: error.message || "Failed to register user",
      });
    }
  }

  /* ---------------- PASSWORD-BASED LOGIN ---------------- */
  async loginWithPassword(req: Request, res: Response) {
    try {
      const { identifier, password } = req.body;

      // Validation
      if (!identifier || !password) {
        return res.status(400).json({
          success: false,
          message: "Email/phone and password are required",
        });
      }

      const response = await authService.loginWithPassword(
        identifier,
        password
      );

      res.cookie("auth_token", response.token, getAuthTokenCookieOptions());

      return res.status(200).json({
        success: true,
        message: response.message,
        user: response.user,
      });
    } catch (error: any) {
      const statusCode = error.statusCode || 400;
      return res.status(statusCode).json({
        success: false,
        message: error.message || "Failed to login",
      });
    }
  }

  /* ---------------- GOOGLE AUTH ---------------- */
  async googleAuth(req: Request, res: Response) {
    try {
      const { email, name, googleId } = req.body;

      // Validation
      if (!email || !name) {
        return res.status(400).json({
          success: false,
          message: "Email and name are required",
        });
      }

      const response = await authService.googleAuth(email, name, googleId);

      res.cookie("auth_token", response.token, getAuthTokenCookieOptions());

      return res.status(200).json({
        success: true,
        message: response.message,
        user: response.user,
        isNewUser: response.isNewUser || false,
      });
    } catch (error: any) {
      const statusCode = error.statusCode || 400;
      return res.status(statusCode).json({
        success: false,
        message: error.message || "Failed to authenticate with Google",
      });
    }
  }

  /**
   * TOKEN VALIDATION ENDPOINT
   * Checks if auth_token cookie exists and is valid
   * Returns user info if valid, 401 if invalid/missing
   */
  async forgotPassword(req: Request, res: Response) {
    try {
      const { email } = req.body;

      // Additional validation - ensure email is provided
      if (!email || !email.trim()) {
        return res.status(400).json({
          success: false,
          message: "Invalid email input",
        });
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email.trim())) {
        return res.status(400).json({
          success: false,
          message: "Invalid email input",
        });
      }

      const response = await authService.forgotPassword(email);

      // Always return 200 with generic message (prevents user enumeration)
      return res.status(200).json({
        success: true,
        ...response,
      });
    } catch (error: any) {
      // Should not reach here in normal flow, but handle just in case
      console.error("[AUTH CONTROLLER] Error in forgotPassword:", error);
      return res.status(500).json({
        success: false,
        message: "An error occurred. Please try again later.",
      });
    }
  }

  async resetPassword(req: Request, res: Response) {
    try {
      const { token, password } = req.body;

      // Additional validation
      if (!token || !token.trim()) {
        return res.status(400).json({
          success: false,
          message: "Reset token is required",
        });
      }

      if (!password || password.length < 6) {
        return res.status(400).json({
          success: false,
          message: "Password must be at least 6 characters long",
        });
      }

      const response = await authService.resetPassword(token.trim(), password);

      return res.status(200).json({
        success: true,
        ...response,
      });
    } catch (error: any) {
      const statusCode = error.statusCode || 400;
      return res.status(statusCode).json({
        success: false,
        message: error.message || "Failed to reset password",
      });
    }
  }

  /**
   * Send email OTP to link phone to existing account
   */
  async sendLinkPhoneEmailOtp(req: Request, res: Response) {
    try {
      const { email, phone } = req.body;

      const response = await authService.sendLinkPhoneEmailOtp(email, phone);

      return res.status(200).json({
        success: true,
        ...response,
      });
    } catch (error: any) {
      const statusCode = error.statusCode || 400;
      return res.status(statusCode).json({
        success: false,
        message: error.message || "Failed to send email OTP",
      });
    }
  }

  /**
   * Verify email OTP and link phone to existing account
   */
  async verifyLinkPhoneEmailOtp(req: Request, res: Response) {
    try {
      const { email, phone, otp } = req.body;

      const response = await authService.verifyLinkPhoneEmailOtp(
        email,
        phone,
        otp
      );

      res.cookie("auth_token", response.token, getAuthTokenCookieOptions());

      return res.status(200).json({
        success: true,
        message: response.message,
        user: response.user,
      });
    } catch (error: any) {
      const statusCode = error.statusCode || 400;
      return res.status(statusCode).json({
        success: false,
        message: error.message || "Failed to verify email OTP",
      });
    }
  }

  /**
   * Send email OTP to add email to phone-only account
   */
  async sendAddEmailOtp(req: Request, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized",
        });
      }

      const { email } = req.body;

      const response = await authService.sendAddEmailOtp(userId, email);

      return res.status(200).json({
        success: true,
        ...response,
      });
    } catch (error: any) {
      const statusCode = error.statusCode || 400;
      return res.status(statusCode).json({
        success: false,
        message: error.message || "Failed to send email OTP",
      });
    }
  }

  /**
   * Verify email OTP and add email to phone-only account
   */
  async verifyAddEmailOtp(req: Request, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized",
        });
      }

      const { email, otp } = req.body;

      const response = await authService.verifyAddEmailOtp(userId, email, otp);

      res.cookie("auth_token", response.token, getAuthTokenCookieOptions());

      return res.status(200).json({
        success: true,
        message: response.message,
        user: response.user,
      });
    } catch (error: any) {
      const statusCode = error.statusCode || 400;
      return res.status(statusCode).json({
        success: false,
        message: error.message || "Failed to verify email OTP",
      });
    }
  }

  async validateToken(req: Request, res: Response) {
    try {
      const token = req.cookies?.auth_token;

      if (!token) {
        return res.status(401).json({
          success: false,
          valid: false,
          message: "Token not found",
        });
      }

      const decoded = verifyToken(token);

      if (!decoded) {
        return res.status(401).json({
          success: false,
          valid: false,
          message: "Invalid or expired token",
        });
      }

      // Fetch user from database using user ID from token
      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
        },
      });

      if (!user) {
        return res.status(401).json({
          success: false,
          valid: false,
          message: "User not found",
        });
      }

      return res.status(200).json({
        success: true,
        valid: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          role: user.role,
        },
      });
    } catch (error: any) {
      console.error("[AUTH] Token validation error:", error);
      return res.status(401).json({
        success: false,
        valid: false,
        message: "Token validation failed",
      });
    }
  }

  /* ---------------- UNIFIED SIGNUP (NEW) ---------------- */
  async signupInitiate(req: Request, res: Response) {
    try {
      const { name, phone, email } = req.body;
      if (!name || !phone || !email) {
        return res.status(400).json({
          success: false,
          message: "Name, phone, and email are required.",
        });
      }
      const response = await authService.signupInitiate(name, phone, email);
      return res.status(200).json({ success: true, ...response });
    } catch (error: any) {
      return res
        .status(error.statusCode || 400)
        .json({ success: false, message: error.message });
    }
  }

  async signupComplete(req: Request, res: Response) {
    try {
      const { name, phone, email, password, otp } = req.body;
      // Validations
      if (!name || !phone || !email || !password || !otp) {
        return res
          .status(400)
          .json({ success: false, message: "All fields are required." });
      }

      const response = await authService.signupVerify(
        name,
        phone,
        email,
        password,
        otp
      );
      res.cookie("auth_token", response.token, getAuthTokenCookieOptions());

      return res.status(201).json({
        success: true,
        message: response.message,
        user: response.user,
      });
    } catch (error: any) {
      return res
        .status(error.statusCode || 400)
        .json({ success: false, message: error.message });
    }
  }

  /* ---------------- UNIFIED LOGIN (NEW) ---------------- */
  async loginInitiate(req: Request, res: Response) {
    try {
      const { phone, email } = req.body;
      if (!phone || !email) {
        return res
          .status(400)
          .json({ success: false, message: "Phone and email are required." });
      }
      const response = await authService.loginInitiate(phone, email);
      return res.status(200).json({ success: true, ...response });
    } catch (error: any) {
      return res
        .status(error.statusCode || 400)
        .json({ success: false, message: error.message });
    }
  }

  async loginComplete(req: Request, res: Response) {
    try {
      const { phone, email, otp } = req.body;
      if (!phone || !email || !otp) {
        return res.status(400).json({
          success: false,
          message: "Phone, email, and OTP are required.",
        });
      }

      const response = await authService.loginVerify(phone, email, otp);
      if ((response as any).userNotFound) {
        // Should not happen easily in this flow unless User explicitly enters wrong details
        // But if it does, we handle it
        return res.status(200).json({
          success: true,
          userNotFound: true,
          message: "No account found matching these credentials.",
        });
      }

      res.cookie("auth_token", response.token, getAuthTokenCookieOptions());
      return res.status(200).json({
        success: true,
        message: response.message,
        user: (response as any).user, // .user includes role
      });
    } catch (error: any) {
      return res
        .status(error.statusCode || 400)
        .json({ success: false, message: error.message });
    }
  }
}

export const authController = new AuthController();
