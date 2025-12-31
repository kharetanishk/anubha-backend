import prisma from "../../database/prismaclient";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { hashOtp, validateOtp, isOtpExpired } from "./utils/validateOtp";
import { generateToken } from "./utils/token";
import { AppError } from "../../util/AppError";
import {
  normalizePhoneNumber,
  arePhoneNumbersEqual,
} from "../../utils/phoneNormalizer";
import { sendPasswordResetEmail, sendEmailOtp } from "../../utils/mailer";

export class AuthService {
  /**
   * Normalize phone number using centralized utility
   * Phone normalization is now handled at database level via Prisma middleware
   * This method is kept for backward compatibility and search operations
   */
  private normalizePhone(phone: string): string {
    try {
      // Use centralized normalization utility
      return normalizePhoneNumber(phone);
    } catch (error: any) {
      // Fallback to old normalization for search compatibility
      let digits = phone.replace(/\D/g, "");
      if (digits.startsWith("91") && digits.length === 12) {
        return digits; // Keep full number with country code
      }
      if (digits.length === 10) {
        return `91${digits}`;
      }
      return digits;
    }
  }

  private async findOwnerByPhone(phone: string) {
    // Normalize the phone number (database will normalize on create/update)
    // For search, we need to try both normalized and original formats
    // because older records might not be normalized yet
    let normalizedPhone: string;
    let originalPhone: string;

    try {
      normalizedPhone = normalizePhoneNumber(phone);
    } catch (error: any) {
      // If normalization fails, try original format
      normalizedPhone = phone.replace(/\D/g, "");
      if (normalizedPhone.length === 10) {
        normalizedPhone = `91${normalizedPhone}`;
      }
    }

    // Also try original format (10 digits without country code)
    originalPhone = phone.replace(/\D/g, "");
    const alternativePhone = originalPhone.length === 10 ? originalPhone : null;

    // console.log("[AUTH] Searching for owner with phone:", {
    // original: phone,
    // normalized: normalizedPhone,
    // alternative: alternativePhone,
    // });
// Build search conditions - try both normalized and alternative formats
    const phoneConditions: any[] = [{ phone: normalizedPhone }];
    if (alternativePhone && alternativePhone !== normalizedPhone) {
      phoneConditions.push({ phone: alternativePhone });
    }

    // Try to find user with either phone format
    const user = await prisma.user.findFirst({
      where: {
        OR: phoneConditions,
      },
      select: { id: true, name: true, phone: true },
    });

    // Try to find admin with either phone format
    const admin = await prisma.admin.findFirst({
      where: {
        OR: phoneConditions,
      },
      select: { id: true, name: true, phone: true },
    });

    // console.log("[AUTH] Search results:", {
    // user: user ? { id: user.id, name: user.name, phone: user.phone } : null,
    // admin: admin
    // ? { id: admin.id, name: admin.name, phone: admin.phone }
    // : null,
    // });
    // if (user) return { ...user, role: "USER" as const };
    // if (admin) return { ...admin, role: "ADMIN" as const };

    return null;
  }

  private async createOtp(phone: string) {
    // Rate limiting: Check if OTP was sent recently (within last 60 seconds)
    const recentOtp = await prisma.oTP.findFirst({
      where: {
        phone,
        createdAt: {
          gte: new Date(Date.now() - 60 * 1000), // Last 60 seconds
        },
      },
      orderBy: { createdAt: "desc" },
    });

    if (recentOtp) {
      const secondsSinceLastOtp = Math.floor(
        (Date.now() - recentOtp.createdAt.getTime()) / 1000
      );
      const remainingSeconds = 60 - secondsSinceLastOtp;
      throw new AppError(
        `Please wait ${remainingSeconds} seconds before requesting a new OTP.`,
        429
      );
    }

    const otp = crypto.randomInt(1000, 9999).toString();
    const hashed = await hashOtp(otp);

    // OTP expires in 10 minutes
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Use transaction with atomic operation to prevent race conditions
    // Delete any existing OTPs for this phone first, then create new one
    // This ensures only one active OTP per phone at a time
    // Increased timeout to handle slow database operations (30 seconds)
    try {
      await prisma.$transaction(
        async (tx) => {
          // Delete existing OTPs for this phone (atomic operation)
          await tx.oTP.deleteMany({
            where: { phone },
          });

          // Create new OTP (atomic operation)
          await tx.oTP.create({
            data: { phone, code: hashed, expiresAt },
          });
        },
        {
          timeout: 30000, // 30 seconds timeout
        }
      );
    } catch (error: any) {
      // Handle Prisma transaction timeout or other database errors
      if (
        error.code === "P2028" ||
        error.message?.includes("Transaction") ||
        error.message?.includes("timeout")
      ) {
        console.error(
          "[AUTH] Transaction timeout or database error:",
          error.message
        );
        throw new AppError(
          "The request is taking longer than expected. Please try again in a moment.",
          503
        );
      }
      // Re-throw other errors
      throw error;
    }

    // Send OTP via MSG91 WhatsApp
    try {
      const { sendOtpMessage } = await import(
        "../../services/whatsapp.service"
      );
      const sendResult = await sendOtpMessage(phone, otp);

      if (!sendResult.success) {
        console.error(
          "[AUTH] Failed to send OTP via WhatsApp:",
          sendResult.error
        );
        // Don't throw error - OTP is still created and can be verified
        // Log the error for debugging but allow the flow to continue
      } else {
        // console.log("[AUTH] OTP sent successfully via WhatsApp");
}
    } catch (error: any) {
      console.error("[AUTH] Error sending OTP via WhatsApp:", error);
      // Don't throw error - OTP is still created and can be verified
    }

    // console.log("OTP:", otp);
return otp;
  }

  /* ---------------- DUAL CHANNEL OTP (NEW) ---------------- */
  private async createDualChannelOtp(phone: string, email: string) {
    // blocked by global rate limit? maybe not per user
    // Check if OTP was sent recently (last 60s) to either phone or email
    const recentOtp = await prisma.oTP.findFirst({
      where: {
        OR: [{ phone }, { email }],
        createdAt: {
          gte: new Date(Date.now() - 60 * 1000),
        },
      },
      orderBy: { createdAt: "desc" },
    });

    if (recentOtp) {
      const secondsSinceLastOtp = Math.floor(
        (Date.now() - recentOtp.createdAt.getTime()) / 1000
      );
      const remainingSeconds = 60 - secondsSinceLastOtp;
      throw new AppError(
        `Please wait ${remainingSeconds} seconds before requesting a new OTP.`,
        429
      );
    }

    const otp = crypto.randomInt(1000, 9999).toString();
    const hashed = await hashOtp(otp);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

    // Transaction to clear old OTPs and create new ones
    // Increased timeout to handle slow database operations (30 seconds)
    try {
      await prisma.$transaction(
        async (tx) => {
          // Delete existing
          await tx.oTP.deleteMany({
            where: {
              OR: [{ phone }, { email }],
            },
          });

          // Create for Phone
          await tx.oTP.create({
            data: { phone, code: hashed, expiresAt },
          });

          // Create for Email
          await tx.oTP.create({
            data: { email, code: hashed, expiresAt },
          });
        },
        {
          timeout: 30000, // 30 seconds timeout
        }
      );
    } catch (error: any) {
      // Handle Prisma transaction timeout or other database errors
      if (
        error.code === "P2028" ||
        error.message?.includes("Transaction") ||
        error.message?.includes("timeout")
      ) {
        console.error(
          "[AUTH] Transaction timeout or database error:",
          error.message
        );
        throw new AppError(
          "The request is taking longer than expected. Please try again in a moment.",
          503
        );
      }
      // Re-throw other errors
      throw error;
    }

    // Send Parallel
    let phoneSent = false;
    let emailSent = false;

    // 1. Send WhatsApp
    try {
      const { sendOtpMessage } = await import(
        "../../services/whatsapp.service"
      );
      const sendResult = await sendOtpMessage(phone, otp);
      if (sendResult.success) phoneSent = true;
      else console.error("[AUTH] WhatsApp Send Failed:", sendResult.error);
    } catch (e) {
      console.error("[AUTH] WhatsApp Exception:", e);
    }

    // 2. Send Email
    try {
      const emailResult = await sendEmailOtp(email, otp);
      if (emailResult) emailSent = true;
      else console.error("[AUTH] Email Send Failed");
    } catch (e) {
      console.error("[AUTH] Email Exception:", e);
    }

    // console.log(
    // `[AUTH] Dual OTP Sent. Phone: ${phoneSent}, Email: ${emailSent}. Code: ${otp}`
    // );
return { otp, phoneSent, emailSent };
  }

  /* ---------------- UNIFIED SIGNUP (NEW) ---------------- */
  async signupInitiate(name: string, phone: string, email: string) {
    // Check if user exists with phone or email
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { phone: phone }, // Expect normalized phone from controller/input
          { email: email.toLowerCase() },
        ],
      },
    });

    if (existingUser) {
      throw new AppError(
        "Account already exists with this phone or email. Please login.",
        409
      );
    }

    await this.createDualChannelOtp(phone, email);
    return { message: "OTP sent to your email and phone." };
  }

  async signupVerify(
    name: string,
    phone: string,
    email: string,
    password: string,
    otp: string
  ) {
    // Re-check uniqueness (race condition)
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ phone: phone }, { email: email.toLowerCase() }],
      },
    });
    if (existingUser) throw new AppError("Account already exists.", 409);

    // Verify OTP against Phone OR Email record
    const foundOtp = await prisma.oTP.findFirst({
      where: {
        OR: [{ phone: phone }, { email: email }],
      },
      orderBy: { createdAt: "desc" },
    });

    if (!foundOtp) throw new AppError("OTP not found.", 404);
    if (isOtpExpired(foundOtp.expiresAt))
      throw new AppError("OTP expired.", 410);

    const match = await validateOtp(otp, foundOtp.code);
    if (!match) throw new AppError("Invalid OTP.", 401);

    // Verify success - delete used OTPs
    await prisma.oTP.deleteMany({
      where: {
        OR: [{ phone: phone }, { email: email }],
      },
    });

    // Create User
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        name,
        phone,
        email: email.toLowerCase(),
        password: hashedPassword,
        role: "USER",
      },
    });

    const token = generateToken(user.id, "USER");

    return {
      message: "Account created successfully.",
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: "USER",
      },
      token,
    };
  }

  /* ---------------- UNIFIED LOGIN (NEW) ---------------- */
  async loginInitiate(phone: string, email: string) {
    // Normalize phone number first
    let normalizedPhone: string;
    try {
      normalizedPhone = this.normalizePhone(phone);
    } catch (error: any) {
      throw new AppError(
        "Invalid phone number format. Please enter a valid phone number.",
        400
      );
    }

    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();

    // Check if phone exists in User or Admin tables
    const userByPhone = await prisma.user.findFirst({
      where: { phone: normalizedPhone },
      select: { id: true, phone: true, email: true },
    });

    const adminByPhone = await prisma.admin.findFirst({
      where: { phone: normalizedPhone },
      select: { id: true, phone: true, email: true },
    });

    // Check if email exists in User or Admin tables
    const userByEmail = await prisma.user.findFirst({
      where: { email: normalizedEmail },
      select: { id: true, phone: true, email: true },
    });

    const adminByEmail = await prisma.admin.findFirst({
      where: { email: normalizedEmail },
      select: { id: true, phone: true, email: true },
    });

    // Determine if phone and email belong to accounts and check if they match
    // Case 1: Both phone and email exist in User table
    if (userByPhone && userByEmail) {
      if (userByPhone.id !== userByEmail.id) {
        throw new AppError(
          "Phone number and email do not belong to the same account. Please verify your credentials.",
          400
        );
      }
      // They belong to the same user - proceed with OTP sending
    }
    // Case 2: Both phone and email exist in Admin table
    else if (adminByPhone && adminByEmail) {
      if (adminByPhone.id !== adminByEmail.id) {
        throw new AppError(
          "Phone number and email do not belong to the same account. Please verify your credentials.",
          400
        );
      }
      // They belong to the same admin - proceed with OTP sending
    }
    // Case 3: Phone exists in User, email exists in Admin (or vice versa) - mismatch
    else if ((userByPhone || adminByPhone) && (userByEmail || adminByEmail)) {
      throw new AppError(
        "Phone number and email do not belong to the same account. Please verify your credentials.",
        400
      );
    }
    // Case 4: Phone exists but email doesn't exist in any table
    else if (userByPhone || adminByPhone) {
      const phoneOwner = userByPhone || adminByPhone;
      if (phoneOwner) {
        // Check if the phone owner's email matches the provided email
        // If phone owner has an email, it must match
        if (phoneOwner.email) {
          const ownerEmail = phoneOwner.email.toLowerCase().trim();
          if (ownerEmail !== normalizedEmail) {
            throw new AppError(
              "The provided email does not match the phone number's account.",
              400
            );
          }
        }
        // If phone owner has no email (phone-only account), allow - email will be used for linking
      }
    }
    // Case 5: Email exists but phone doesn't exist in any table
    else if (userByEmail || adminByEmail) {
      const emailOwner = userByEmail || adminByEmail;
      if (emailOwner) {
        // Check if the email owner's phone matches the provided phone
        // If email owner has a phone, it must match
        if (emailOwner.phone) {
          const ownerPhone = this.normalizePhone(emailOwner.phone);
          if (ownerPhone !== normalizedPhone) {
            throw new AppError(
              "The provided phone number does not match the email's account.",
              400
            );
          }
        }
        // If email owner has no phone (email-only account), allow - phone will be used for linking
      }
    }
    // Case 6: Neither phone nor email exists - allow OTP sending for account linking flow

    // Send OTP to both channels
    await this.createDualChannelOtp(normalizedPhone, normalizedEmail);
    return { message: "OTP sent to your email and phone." };
  }

  async loginVerify(phone: string, email: string, otp: string) {
    // 1. Find the OTP record
    const foundOtp = await prisma.oTP.findFirst({
      where: {
        OR: [{ phone: phone }, { email: email }],
      },
      orderBy: { createdAt: "desc" },
    });

    if (!foundOtp) throw new AppError("OTP not found.", 404);
    if (isOtpExpired(foundOtp.expiresAt))
      throw new AppError("OTP expired.", 410);

    const match = await validateOtp(otp, foundOtp.code);
    if (!match) throw new AppError("Invalid OTP.", 401);

    // 2. Identify User
    // If foundOtp was for Phone -> find User by Phone
    // If foundOtp was for Email -> find User by Email
    let user = null;
    let role: "USER" | "ADMIN" = "USER"; // Default

    if (foundOtp.phone) {
      const owner = await this.findOwnerByPhone(foundOtp.phone);
      if (owner) {
        user = owner;
        role = owner.role;
      }
    } else if (foundOtp.email) {
      user = await prisma.user.findUnique({ where: { email: foundOtp.email } });
      // Admin?
      if (!user) {
        const admin = await prisma.admin.findUnique({
          where: { email: foundOtp.email },
        });
        if (admin) {
          user = admin;
          role = "ADMIN";
        }
      }
    }

    // Cleanup
    await prisma.oTP.deleteMany({
      where: {
        OR: [{ phone: phone }, { email: email }],
      },
    });

    if (!user) {
      return { userNotFound: true, message: "No account found." };
    }

    const token = generateToken(user.id, role);

    return {
      message: "Logged in successfully.",
      user: { ...user, role },
      token,
    };
  }

  /* ---------------- REGISTER OTP ---------------- */
  async sendRegisterOtp(name: string, phone: string) {
    const existingOwner = await this.findOwnerByPhone(phone);

    if (existingOwner) {
      throw new AppError(
        "Account already exists with this number.Try login",
        409
      );
    }

    await this.createOtp(phone);

    return { message: "OTP sent successfully." };
  }

  async verifyRegisterOtp(name: string, phone: string, otp: string) {
    const existingOwner = await this.findOwnerByPhone(phone);

    if (existingOwner) {
      throw new AppError("Account already exists.Try login", 409);
    }

    const foundOtp = await prisma.oTP.findFirst({
      where: { phone },
      orderBy: { createdAt: "desc" },
    });

    if (!foundOtp) throw new AppError("OTP not found.", 404);
    if (isOtpExpired(foundOtp.expiresAt))
      throw new AppError("OTP expired.", 410);

    const match = await validateOtp(otp, foundOtp.code);
    if (!match) throw new AppError("Invalid OTP.", 401);

    await prisma.oTP.delete({ where: { id: foundOtp.id } });

    const user = await prisma.user.create({
      data: {
        name,
        phone,
        email: null, // Phone-only registration, no email
        password: null, // Phone-only registration, no password
      },
    });

    const safeUser = {
      id: user.id,
      name: user.name,
      phone: user.phone,
      role: "USER" as const,
    };

    const token = generateToken(user.id, "USER");

    return {
      message: "User registered successfully.",
      user: safeUser,
      token,
    };
  }

  /* ---------------- LOGIN OTP ---------------- */
  async sendLoginOtp(phone: string) {
    // console.log("[AUTH] sendLoginOtp called with phone:", phone);
// Normalize phone number first to ensure consistency
    let normalizedPhone: string;
    try {
      normalizedPhone = this.normalizePhone(phone);
    } catch (error: any) {
      throw new AppError(
        "Invalid phone number format. Please enter a valid phone number.",
        400
      );
    }

    // Validate phone number uniqueness - check if it exists in User or Admin tables
    // This ensures we don't have duplicate phone numbers across tables
    const userWithPhone = await prisma.user.findFirst({
      where: { phone: normalizedPhone },
      select: { id: true, phone: true },
    });

    const adminWithPhone = await prisma.admin.findFirst({
      where: { phone: normalizedPhone },
      select: { id: true, phone: true },
    });

    // If phone exists in both tables (shouldn't happen, but check for data integrity)
    if (userWithPhone && adminWithPhone) {
      throw new AppError(
        "This phone number is associated with multiple accounts. Please contact support.",
        409
      );
    }

    // Find owner to determine role (but allow OTP sending even if not found)
    const owner = await this.findOwnerByPhone(normalizedPhone);

    // console.log(
    // "[AUTH] Owner found:",
    // owner
    // ? {
    // id: owner.id,
    // name: owner.name,
    // phone: owner.phone,
    // role: owner.role,
    // }
    // : null
    // );
// Allow OTP sending even if user doesn't exist
    // We'll check user existence during OTP verification instead
    // This prevents user enumeration and allows linking phone flow
    // Use normalized phone number for OTP creation
    await this.createOtp(normalizedPhone);

    return {
      message: "OTP sent successfully.",
      role: owner?.role || "USER", // Default to USER if not found
    };
  }

  async verifyLoginOtp(phone: string, otp: string) {
    // First verify OTP before checking user existence
    const foundOtp = await prisma.oTP.findFirst({
      where: { phone },
      orderBy: { createdAt: "desc" },
    });

    if (!foundOtp) throw new AppError("OTP not found.", 404);
    if (isOtpExpired(foundOtp.expiresAt))
      throw new AppError("OTP expired.", 410);

    const match = await validateOtp(otp, foundOtp.code);
    if (!match) throw new AppError("Invalid OTP.", 401);

    // OTP is valid, now check if user exists
    const owner = await this.findOwnerByPhone(phone);

    // Delete OTP after verification (regardless of user existence)
    await prisma.oTP.delete({ where: { id: foundOtp.id } });

    // If user doesn't exist, return special response instead of throwing error
    if (!owner) {
      return {
        userNotFound: true,
        message: "No account found with this phone number",
      };
    }

    const token = generateToken(owner.id, owner.role);

    return {
      message: "Logged in successfully.",
      role: owner.role,
      owner,
      user: owner,
      token,
    };
  }

  /* ---------------- GET ME ---------------- */
  async getMe(ownerId: string, role: "USER" | "ADMIN") {
    // console.log("[AUTH SERVICE] getMe called with:", { ownerId, role });
if (role === "USER") {
      const user = await prisma.user.findUnique({
        where: { id: ownerId },
        select: { id: true, name: true, phone: true, email: true },
      });

      if (!user) {
        console.error("[AUTH SERVICE] User not found:", ownerId);
        throw new AppError("User not found", 404);
      }

      // console.log("[AUTH SERVICE] User found:", {
      // id: user.id,
      // name: user.name,
      // });
      // return { ...user, role: "USER" };
      // }

    if (role === "ADMIN") {
      const admin = await prisma.admin.findUnique({
        where: { id: ownerId },
        select: { id: true, name: true, phone: true, email: true },
      });

      if (!admin) {
        console.error("[AUTH SERVICE] Admin not found:", ownerId);
        throw new AppError("Admin not found", 404);
      }

      // console.log("[AUTH SERVICE] Admin found:", {
      // id: admin.id,
      // name: admin.name,
      // });
      // return { ...admin, role: "ADMIN" };
      // }

    console.error("[AUTH SERVICE] Invalid role:", role);
    throw new AppError(`Invalid role: ${role}. Expected USER or ADMIN.`, 400);
  }

  /* ---------------- FORGOT PASSWORD ---------------- */
  /**
   * STEP-2: Forgot Password - Token Generation
   * Checks if user exists with the email (without revealing existence)
   * If user exists: generates secure reset token and stores it
   * Returns same response for both existing and non-existing emails
   * Security: Prevents user enumeration
   */
  async forgotPassword(email: string): Promise<{ message: string }> {
    // console.log("[AUTH] forgotPassword called with email:", email);
// Normalize email (trim and lowercase)
    const normalizedEmail = email.trim().toLowerCase();

    // Check if user exists with this email
    // Note: Only User table for password reset (not Admin)
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true }, // Only select necessary fields
    });

    // If user exists, generate reset token
    if (user) {
      // console.log(
      // "[AUTH] User found for password reset:",
      // user.id,
      // "(email:",
      // normalizedEmail,
      // ")
      // "
      // );

      // Generate cryptographically secure random token (32 bytes = 64 hex characters)
      const rawToken = crypto.randomBytes(32).toString("hex");

      // Hash the token using SHA-256 before storing
      const hashedToken = crypto
        .createHash("sha256")
        .update(rawToken)
        .digest("hex");

      // Set token expiry to 15 minutes from now
      const resetPasswordExpiry = new Date(Date.now() + 15 * 60 * 1000);

      // Update user record with hashed token and expiry
      // Overwrite any existing token (one-time use)
      await prisma.user.update({
        where: { id: user.id },
        data: {
          resetPasswordToken: hashedToken,
          resetPasswordExpiry: resetPasswordExpiry,
        },
      });

      // Generate reset password link with raw token
      // Production: Use FRONTEND_URL environment variable
      // Development: Fallback to localhost
      const frontendUrl = process.env.FRONTEND_URL || (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000");
      if (!frontendUrl) {
        throw new Error("FRONTEND_URL environment variable is required in production");
      }
      const resetLink = `${frontendUrl}/reset-password?token=${rawToken}`;

      // Send password reset email (only if user exists)
      try {
        // console.log(
        // "[AUTH] Attempting to send password reset email to:",
        // normalizedEmail
        // );
// console.log("[AUTH] Reset link:", resetLink);
const emailSent = await sendPasswordResetEmail(
          normalizedEmail,
          resetLink
        );

        if (emailSent) {
          // console.log(
          // "[AUTH] ✅ Password reset email sent successfully to:",
          // normalizedEmail
          // );
} else {
          console.error(
            "[AUTH] ❌ Failed to send password reset email to:",
            normalizedEmail,
            "- Email sending function returned false"
          );
          // Don't throw error - log only to prevent breaking the response
        }
      } catch (error: any) {
        // Catch and log SMTP errors without breaking the response
        console.error(
          "[AUTH] ❌ Exception occurred while sending password reset email:"
        );
        console.error("[AUTH] Error message:", error.message);
        console.error("[AUTH] Error stack:", error.stack);
        console.error("[AUTH] Recipient email:", normalizedEmail);
        // Continue execution - don't break the response
      }

      // Log reset link in development only (for testing)
      if (process.env.NODE_ENV === "development") {
        // console.log("[AUTH] Password reset link generated (DEV ONLY)
        // :");
        // console.log("  - User ID:", user.id);
// console.log("  - Reset Link:", resetLink);
// console.log("  - Expires at:", resetPasswordExpiry.toISOString()
// );
      }
    } else {
      // console.log(
      // "[AUTH] No user found for password reset (email:",
      // normalizedEmail,
      // ")
      // "
      // );
      // Do nothing - same response time and message
    }

    // Always return the same generic message (prevents user enumeration)
    return {
      message:
        "If an account exists with this email, we've sent a password reset link.",
    };
  }

  /* ---------------- RESET PASSWORD ---------------- */
  /**
   * Reset user password using reset token
   * @param rawToken - The raw token from the reset link (will be hashed for comparison)
   * @param newPassword - The new password to set
   */
  async resetPassword(
    rawToken: string,
    newPassword: string
  ): Promise<{ message: string }> {
    // console.log("[AUTH] resetPassword called");
// Validate inputs
    if (!rawToken || !rawToken.trim()) {
      throw new AppError("Reset token is required", 400);
    }

    if (!newPassword || newPassword.length < 6) {
      throw new AppError("Password must be at least 6 characters long", 400);
    }

    // Hash the raw token using SHA-256 (same method as forgotPassword)
    const hashedToken = crypto
      .createHash("sha256")
      .update(rawToken.trim())
      .digest("hex");

    // Find user with matching reset token
    const user = await prisma.user.findFirst({
      where: {
        resetPasswordToken: hashedToken,
      },
      select: {
        id: true,
        email: true,
        resetPasswordExpiry: true,
      },
    });

    // If user not found or token doesn't match, return generic error
    if (!user) {
      // console.log("[AUTH] Invalid reset token provided");
throw new AppError("Invalid or expired reset token", 400);
    }

    // Check if token has expired
    if (!user.resetPasswordExpiry) {
      // console.log("[AUTH] Reset token has no expiry date");
throw new AppError("Invalid or expired reset token", 400);
    }

    const now = new Date();
    if (now > user.resetPasswordExpiry) {
      // console.log("[AUTH] Reset token has expired");
// Clear expired token
      await prisma.user.update({
        where: { id: user.id },
        data: {
          resetPasswordToken: null,
          resetPasswordExpiry: null,
        },
      });
      throw new AppError("Invalid or expired reset token", 400);
    }

    // Hash the new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update user password and clear reset token (one-time use)
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetPasswordToken: null,
        resetPasswordExpiry: null,
      },
    });

    // console.log(
    // `[AUTH] Password reset successfully for user ${user.id} (email: ${user.email})
    // `
    // );

    return {
      message:
        "Password reset successfully. You can now login with your new password.",
    };
  }

  /* ---------------- LINK PHONE TO EXISTING ACCOUNT ---------------- */
  /**
   * Send email OTP to link phone number to existing account
   * @param email - User's registered email
   * @param phone - Phone number to link
   */
  async sendLinkPhoneEmailOtp(email: string, phone: string) {
    // console.log("[AUTH SERVICE] sendLinkPhoneEmailOtp called:", {
    // email,
    // phone,
    // });
// Normalize email
    const normalizedEmail = email.trim().toLowerCase();

    // Check if user exists with this email
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true, phone: true },
    });

    if (!user) {
      throw new AppError("No account found with this email", 404);
    }

    // Check if phone is already taken by another user
    const normalizedPhone = this.normalizePhone(phone);
    if (normalizedPhone !== user.phone) {
      const existingUserWithPhone = await prisma.user.findFirst({
        where: {
          phone: normalizedPhone,
          id: { not: user.id }, // Exclude current user
        },
      });

      if (existingUserWithPhone) {
        throw new AppError(
          "This phone number is already registered to another account",
          409
        );
      }

      // Check if phone is taken by an admin
      const existingAdminWithPhone = await prisma.admin.findFirst({
        where: { phone: normalizedPhone },
      });

      if (existingAdminWithPhone) {
        throw new AppError(
          "This phone number is already registered to an admin account",
          409
        );
      }
    }

    // Generate and store OTP in database (using email as identifier for this flow)
    // Store phone in OTP record for later retrieval during verification
    const otp = await this.createEmailOtp(normalizedEmail, normalizedPhone);

    // Send OTP via email
    try {
      const { sendEmailOtp } = await import("../../utils/mailer");
      const sendResult = await sendEmailOtp(normalizedEmail, otp);

      if (!sendResult) {
        console.error("[AUTH] Failed to send email OTP");
        // Don't throw error - OTP is still created and can be verified
      } else {
        // console.log("[AUTH] Email OTP sent successfully");
}
    } catch (error: any) {
      console.error("[AUTH] Error sending email OTP:", error);
      // Don't throw error - OTP is still created
    }

    return {
      message: "Verification code sent to your email",
    };
  }

  /**
   * Verify email OTP and link phone number to existing account
   * @param email - User's registered email
   * @param phone - Phone number to link
   * @param otp - OTP code from email
   */
  async verifyLinkPhoneEmailOtp(email: string, phone: string, otp: string) {
    // console.log("[AUTH SERVICE] verifyLinkPhoneEmailOtp called:", {
    // email,
    // phone,
    // });
// Normalize inputs
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = this.normalizePhone(phone);

    // Find user
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true, phone: true },
    });

    if (!user) {
      throw new AppError("No account found with this email", 404);
    }

    // Find OTP (stored with format "EMAIL:email:phone")
    const otpIdentifier = `EMAIL:${normalizedEmail}:${normalizedPhone}`;
    const emailOtp = await prisma.oTP.findFirst({
      where: {
        phone: otpIdentifier,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!emailOtp) throw new AppError("OTP not found", 404);
    if (isOtpExpired(emailOtp.expiresAt))
      throw new AppError("OTP expired", 410);

    const match = await validateOtp(otp, emailOtp.code);
    if (!match) throw new AppError("Invalid OTP", 401);

    // Delete OTP after verification
    await prisma.oTP.delete({ where: { id: emailOtp.id } });

    // Check if phone is still available (race condition check)
    if (normalizedPhone !== user.phone) {
      const existingUserWithPhone = await prisma.user.findFirst({
        where: {
          phone: normalizedPhone,
          id: { not: user.id },
        },
      });

      if (existingUserWithPhone) {
        throw new AppError(
          "This phone number is already registered to another account",
          409
        );
      }

      const existingAdminWithPhone = await prisma.admin.findFirst({
        where: { phone: normalizedPhone },
      });

      if (existingAdminWithPhone) {
        throw new AppError(
          "This phone number is already registered to an admin account",
          409
        );
      }
    }

    // Update user's phone number
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { phone: normalizedPhone },
      select: { id: true, name: true, phone: true, email: true },
    });

    // Generate token for the user
    const token = generateToken(updatedUser.id, "USER");

    return {
      message: "Phone number linked successfully",
      user: { ...updatedUser, role: "USER" as const },
      token,
    };
  }

  /**
   * Create email OTP (similar to createOtp but for email)
   * Stores OTP with format "EMAIL:email:phone" in phone field
   * This allows us to store both email and phone to link in the identifier
   */
  private async createEmailOtp(
    email: string,
    phoneToLink: string
  ): Promise<string> {
    // Generate 4-digit OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    // Hash OTP
    const hashedOtp = await bcrypt.hash(otp, 10);

    // Set expiry to 10 minutes
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Store OTP with format "EMAIL:email:phone" to include both email and phone
    const otpIdentifier = `EMAIL:${email}:${phoneToLink}`;

    // Delete any existing OTPs for this identifier first
    await prisma.oTP.deleteMany({
      where: {
        phone: otpIdentifier,
      },
    });

    // Create new OTP
    await prisma.oTP.create({
      data: {
        phone: otpIdentifier,
        code: hashedOtp,
        expiresAt,
      },
    });

    // console.log(
    // "[AUTH] Email OTP created for:",
    // email,
    // "to link phone:",
    // phoneToLink
    // );
return otp;
  }

  /* ---------------- ADD EMAIL TO PHONE-ONLY ACCOUNT ---------------- */
  /**
   * Send email OTP to add email to phone-only account
   * @param userId - Current user's ID
   * @param email - Email address to add and verify
   */
  async sendAddEmailOtp(userId: string, email: string) {
    // console.log("[AUTH SERVICE] sendAddEmailOtp called:", {
    // userId,
    // email,
    // });
// Normalize email
    const normalizedEmail = email.trim().toLowerCase();

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      throw new AppError("Invalid email address", 400);
    }

    // Get current user
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, phone: true },
    });

    if (!user) {
      throw new AppError("User not found", 404);
    }

    // Check if user already has an email
    if (user.email) {
      throw new AppError("User already has an email address", 400);
    }

    // Check if email is already taken by another user
    const existingUserWithEmail = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });

    if (existingUserWithEmail) {
      throw new AppError(
        "This email is already linked to another account",
        409
      );
    }

    // Check if email is taken by an admin
    const existingAdminWithEmail = await prisma.admin.findFirst({
      where: { email: normalizedEmail },
    });

    if (existingAdminWithEmail) {
      throw new AppError(
        "This email is already registered with an account",
        409
      );
    }

    // Generate and store OTP
    // Use format "ADD_EMAIL:userId:email" to identify this flow
    const otp = await this.createAddEmailOtp(userId, normalizedEmail);

    // Send OTP via email using the "Add & Verify Email" template
    try {
      const { sendAddEmailVerificationOtp } = await import(
        "../../utils/mailer"
      );
      const sendResult = await sendAddEmailVerificationOtp(
        normalizedEmail,
        otp
      );

      if (!sendResult) {
        console.error("[AUTH] Failed to send email verification OTP");
        // Don't throw error - OTP is still created and can be verified
      } else {
        // console.log(
        // "[AUTH] Email verification OTP sent successfully for adding email"
        // );
}
    } catch (error: any) {
      console.error("[AUTH] Error sending email verification OTP:", error);
      // Don't throw error - OTP is still created
    }

    return {
      message: "Verification code sent to your email",
    };
  }

  /**
   * Verify email OTP and add email to phone-only account
   * @param userId - Current user's ID
   * @param email - Email address to add
   * @param otp - OTP code from email
   */
  async verifyAddEmailOtp(userId: string, email: string, otp: string) {
    // console.log("[AUTH SERVICE] verifyAddEmailOtp called:", {
    // userId,
    // email,
    // });
// Normalize email
    const normalizedEmail = email.trim().toLowerCase();

    // Get current user
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, phone: true, name: true, role: true },
    });

    if (!user) {
      throw new AppError("User not found", 404);
    }

    // Check if user already has an email
    if (user.email) {
      throw new AppError("User already has an email address", 400);
    }

    // Find OTP (stored with format "ADD_EMAIL:userId:email")
    const otpIdentifier = `ADD_EMAIL:${userId}:${normalizedEmail}`;
    const emailOtp = await prisma.oTP.findFirst({
      where: {
        phone: otpIdentifier,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!emailOtp) throw new AppError("OTP not found", 404);
    if (isOtpExpired(emailOtp.expiresAt))
      throw new AppError("OTP expired", 410);

    const match = await validateOtp(otp, emailOtp.code);
    if (!match) throw new AppError("Invalid OTP", 401);

    // Delete OTP after verification
    await prisma.oTP.delete({ where: { id: emailOtp.id } });

    // Final check if email is still available (race condition check)
    const existingUserWithEmail = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });

    if (existingUserWithEmail) {
      throw new AppError(
        "This email is already linked to another account",
        409
      );
    }

    const existingAdminWithEmail = await prisma.admin.findFirst({
      where: { email: normalizedEmail },
    });

    if (existingAdminWithEmail) {
      throw new AppError(
        "This email is already registered with an account",
        409
      );
    }

    // Update user with email
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { email: normalizedEmail },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
      },
    });

    // Generate new auth token with updated user info
    // Ensure role is always "USER" or "ADMIN" (default to "USER" if undefined)
    const userRole = (updatedUser.role as "USER" | "ADMIN") || "USER";
    const token = generateToken(updatedUser.id, userRole);

    // console.log("[AUTH] Email successfully added to user account");
return {
      message: "Email verified and added successfully",
      token,
      user: { ...updatedUser, role: userRole },
    };
  }

  /**
   * Create email OTP for adding email to account
   * Stores OTP with format "ADD_EMAIL:userId:email" in phone field
   */
  private async createAddEmailOtp(
    userId: string,
    email: string
  ): Promise<string> {
    // Generate 4-digit OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    // Hash OTP
    const hashedOtp = await bcrypt.hash(otp, 10);

    // Set expiry to 10 minutes
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Store OTP with format "ADD_EMAIL:userId:email"
    const otpIdentifier = `ADD_EMAIL:${userId}:${email}`;

    // Delete any existing OTPs for this identifier first
    await prisma.oTP.deleteMany({
      where: {
        phone: otpIdentifier,
      },
    });

    // Create new OTP
    await prisma.oTP.create({
      data: {
        phone: otpIdentifier,
        code: hashedOtp,
        expiresAt,
      },
    });

    // console.log(
    // "[AUTH] Add Email OTP created for user:",
    // userId,
    // "email:",
    // email
    // );
return otp;
  }

  /* ---------------- UPDATE PHONE NUMBER ---------------- */
  /**
   * Update user phone number
   * - If phone is provided: Add or update phone number
   * - If phone is null/empty: Delete phone number (set to null)
   */
  async updatePhone(userId: string, phone: string | null) {
    // console.log("[AUTH SERVICE] updatePhone called with:", {
    // userId,
    // phone: phone ? "provided" : "null (delete)
    // ",
    // });

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phone: true },
    });

    if (!user) {
      console.error("[AUTH SERVICE] User not found:", userId);
      throw new AppError("User not found", 404);
    }

    // If phone is null or empty, delete it
    if (!phone || phone.trim() === "") {
      // console.log("[AUTH SERVICE] Deleting phone number for user:", userId);
const updatedUser = await prisma.user.update({
        where: { id: userId },
        data: { phone: null } as any, // Phone is nullable in schema
        select: { id: true, name: true, phone: true, email: true },
      });

      // console.log("[AUTH SERVICE] Phone number deleted successfully");
return { ...updatedUser, role: "USER" as const };
    }

    // Normalize phone number
    let normalizedPhone: string;
    try {
      normalizedPhone = this.normalizePhone(phone);
    } catch (error: any) {
      console.error(
        "[AUTH SERVICE] Phone normalization failed:",
        error.message
      );
      throw new AppError(`Invalid phone number: ${error.message}`, 400);
    }

    // Check if phone is already taken by another user
    const existingUserWithPhone = await prisma.user.findFirst({
      where: {
        phone: normalizedPhone,
        id: { not: userId }, // Exclude current user
      },
    });

    if (existingUserWithPhone) {
      console.error(
        "[AUTH SERVICE] Phone number already in use by another user:",
        normalizedPhone
      );
      throw new AppError(
        "This phone number is already registered to another account.",
        409
      );
    }

    // CRITICAL: Check if phone is already taken by an admin
    // Both User and Admin tables have unique phone constraints
    const existingAdminWithPhone = await prisma.admin.findFirst({
      where: {
        phone: normalizedPhone,
      },
    });

    if (existingAdminWithPhone) {
      console.error(
        "[AUTH SERVICE] Phone number already in use by an admin:",
        normalizedPhone
      );
      throw new AppError(
        "This phone number is already registered to an admin account. Please use a different phone number.",
        409
      );
    }

    // Update phone number with error handling for unique constraint violations
    // console.log("[AUTH SERVICE] Updating phone number:", {
    // oldPhone: user.phone,
    // newPhone: normalizedPhone,
    // });
    // try {
    // const updatedUser = await prisma.user.update({
    // where: { id: userId },
    // data: { phone: normalizedPhone },
    // select: { id: true, name: true, phone: true, email: true },
    // });

      // console.log("[AUTH SERVICE] Phone number updated successfully");
return { ...updatedUser, role: "USER" as const };
    } catch (error: any) {
      // Handle Prisma unique constraint violation (P2002)
      if (error.code === "P2002" && error.meta?.target?.includes("phone")) {
        console.error(
          "[AUTH SERVICE] Unique constraint violation on phone:",
          normalizedPhone
        );
        throw new AppError(
          "This phone number is already registered. Please use a different phone number.",
          409
        );
      }

      // Re-throw other errors
      throw error;
    }
  }

  /* ---------------- PASSWORD-BASED SIGNUP ---------------- */
  async signupWithPassword(
    name: string,
    phone: string | null,
    email: string, // email is required, not nullable
    password: string
  ) {
    // console.log("[AUTH] signupWithPassword called with:", {
    // name,
    // phone,
    // email,
    // });
// Check if user already exists by email
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new AppError("User with this email already exists", 409);
    }

    // Check if phone is provided and already exists
    if (phone) {
      const normalizedPhone = this.normalizePhone(phone);
      const existingUserByPhone = await prisma.user.findFirst({
        where: { phone: normalizedPhone },
      });

      if (existingUserByPhone) {
        throw new AppError("User with this phone number already exists", 409);
      }
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    // email is required in signup, so it's guaranteed to be a string (not null)
    const userData: any = {
      name,
      email: email, // email is required in signup
      password: hashedPassword,
    };

    // Only include phone if provided (omit if null to allow database default)
    if (phone) {
      userData.phone = this.normalizePhone(phone);
    }

    const user = await prisma.user.create({
      data: userData,
    });

    const token = generateToken(user.id, "USER");

    return {
      message: "User registered successfully",
      user: { ...user, role: "USER" as const },
      token,
    };
  }

  /* ---------------- PASSWORD-BASED LOGIN ---------------- */
  async loginWithPassword(identifier: string, password: string) {
    // console.log("[AUTH] loginWithPassword called with identifier:", identifier);
// Check if identifier is email or phone
    const isEmail = identifier.includes("@");

    // First, check if this is an admin email/phone
    let admin = null;
    if (isEmail) {
      const normalizedEmail = identifier.trim().toLowerCase();
      admin = await prisma.admin.findUnique({
        where: { email: normalizedEmail },
      });
    } else {
      const normalizedPhone = this.normalizePhone(identifier);
      admin = await prisma.admin.findFirst({
        where: { phone: normalizedPhone },
      });
    }

    // If admin found, authenticate as admin
    if (admin) {
      // console.log("[AUTH] Admin login attempt detected");
const adminWithAuth = admin as any;

      if (!adminWithAuth.password) {
        throw new AppError(
          "This admin account doesn't have a password set.",
          400
        );
      }

      // Verify password
      const isPasswordValid = await bcrypt.compare(
        password,
        adminWithAuth.password
      );

      if (!isPasswordValid) {
        // console.log("[AUTH] Admin password verification failed");
throw new AppError("Invalid credentials", 401);
      }

      // console.log("[AUTH] Admin login successful");
const token = generateToken(admin.id, "ADMIN");

      // Return admin without password
      const { password: _, ...safeAdmin } = adminWithAuth;

      return {
        message: "Logged in successfully",
        user: { ...safeAdmin, role: "ADMIN" as const },
        token,
      };
    }

    // If not admin, check User table
    let user;
    if (isEmail) {
      user = await prisma.user.findUnique({
        where: { email: identifier },
      });
    } else {
      const normalizedPhone = this.normalizePhone(identifier);
      user = await prisma.user.findFirst({
        where: { phone: normalizedPhone },
      });
    }

    // Account not found - show registration message
    if (!user) {
      throw new AppError("Account not found, register your account", 404);
    }

    // Type assertion to access password field
    const userWithAuth = user as any;

    // CRITICAL: Email is the primary identifier
    // Only reject if password is missing (account was never set up with password)
    if (!userWithAuth.password) {
      throw new AppError(
        "This account doesn't have a password. Please login with Google or set a password.",
        400
      );
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(
      password,
      userWithAuth.password
    );

    if (!isPasswordValid) {
      // console.log("[AUTH] User password verification failed");
throw new AppError("Invalid credentials", 401);
    }

    // Use the actual role from the database (USER or ADMIN)
    const userRole = (user.role as "USER" | "ADMIN") || "USER";
    const token = generateToken(user.id, userRole);

    // Return user without password
    const { password: _, provider: __, ...safeUser } = userWithAuth;

    return {
      message: "Logged in successfully",
      user: { ...safeUser, role: userRole },
      token,
    };
  }

  /* ---------------- GOOGLE AUTH ---------------- */
  /**
   * CRITICAL: Email is the primary unique identifier
   * - Always find user by email FIRST
   * - If user exists, link Google login to existing account (preserve role)
   * - Only create new user if NO user exists with that email
   * - NEVER create duplicate users for the same email
   */
  async googleAuth(email: string, name: string, googleId?: string) {
    // console.log("[AUTH] googleAuth called with:", { email, name });
// CRITICAL: Normalize email (trim, lowercase) to ensure consistent matching
    const normalizedEmail = email.trim().toLowerCase();

    // STEP 1: Find user by email (email is globally unique)
    let user = (await prisma.user.findUnique({
      where: { email: normalizedEmail },
    })) as any; // Type assertion to access provider field

    if (user) {
      // User exists with this email - link Google login to existing account
      // console.log(
      // `[AUTH] User exists with email ${normalizedEmail}, linking Google login`
      // );
// CRITICAL: Preserve existing role from database (never override)
      // At this point, user is guaranteed to be non-null (we're inside if (user) block)
      if (!user) throw new Error("User should not be null here"); // Type guard
      const userRole = (user.role as "USER" | "ADMIN") || "USER";
      const token = generateToken(user.id, userRole);

      return {
        message: "Logged in successfully",
        user: { ...user, role: userRole },
        token,
        isExistingUser: true,
      };
    }

    // STEP 2: User doesn't exist - create new user
    // console.log(
    // `[AUTH] No user found with email ${normalizedEmail}, creating new user`
    // );
// Create new user for Google OAuth
    // email is required for Google OAuth, so it's guaranteed to be a string (not null)
    user = await prisma.user.create({
      data: {
        name,
        email: normalizedEmail, // Use normalized email
        password: null,
        phone: null,
        role: "USER", // New Google users default to USER (can be changed to ADMIN manually in DB)
      } as any, // Type assertion for Prisma nullable field
    });

    // Use actual role from database (defaults to USER for new users)
    const userRole = (user.role as "USER" | "ADMIN") || "USER";
    const token = generateToken(user.id, userRole);

    return {
      message: "User registered successfully",
      user: { ...user, role: userRole },
      token,
      isNewUser: true,
    };
  }

  /* ---------------- HELPER METHODS FOR SESSION SYNC ---------------- */

  /**
   * Find user by email or phone (for session sync)
   * CRITICAL: Email is normalized (trimmed, lowercase) for consistent matching
   */
  async findOwnerByEmailOrPhone(identifier: string) {
    // Normalize identifier (trim, lowercase) for email matching
    const normalizedIdentifier = identifier.trim().toLowerCase();

    // STEP 1: Try to find by email first (email is globally unique)
    // Use findUnique for exact email match (faster and more reliable)
    let user = await prisma.user.findUnique({
      where: { email: normalizedIdentifier },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
      },
    });

    // STEP 2: If not found by email, try by phone
    if (!user) {
      try {
        const normalizedPhone = this.normalizePhone(identifier);
        user = await prisma.user.findFirst({
          where: { phone: normalizedPhone },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            role: true,
          },
        });
      } catch (error) {
        // If phone normalization fails, identifier is not a valid phone
        // Return null (user not found)
        return null;
      }
    }

    return user;
  }

  /**
   * Generate JWT token for a user (for session sync)
   */
  generateTokenForUser(userId: string, role: "USER" | "ADMIN"): string {
    return generateToken(userId, role);
  }
}

export const authService = new AuthService();
