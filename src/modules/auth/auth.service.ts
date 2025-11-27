import prisma from "../../database/prismaclient";
import crypto from "crypto";
import { hashOtp, validateOtp, isOtpExpired } from "./utils/validateOtp";
import { generateToken } from "./utils/token";
import { AppError } from "../../util/Apperror";

export class AuthService {
  private async findOwnerByPhone(phone: string) {
    const user = await prisma.user.findUnique({
      where: { phone },
      select: { id: true, name: true, phone: true },
    });

    const admin = await prisma.admin.findUnique({
      where: { phone },
      select: { id: true, name: true, phone: true },
    });

    if (user) return { ...user, role: "USER" as const };
    if (admin) return { ...admin, role: "ADMIN" as const };

    return null;
  }

  private async createOtp(phone: string) {
    const otp = crypto.randomInt(1000, 9999).toString();
    const hashed = await hashOtp(otp);

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await prisma.oTP.create({
      data: { phone, code: hashed, expiresAt },
    });

    console.log("OTP:", otp);
    return otp;
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
      data: { name, phone },
    });

    const token = generateToken(user.id, "USER");

    return {
      message: "User registered successfully.",
      user,
      token,
    };
  }

  /* ---------------- LOGIN OTP ---------------- */
  async sendLoginOtp(phone: string) {
    const owner = await this.findOwnerByPhone(phone);

    console.log("this is the owner i have consoled ", owner);

    if (!owner)
      throw new AppError(
        "No account found with this number.Register your account",
        404
      );

    await this.createOtp(phone);

    return {
      message: "OTP sent successfully.",
      role: owner.role,
    };
  }

  async verifyLoginOtp(phone: string, otp: string) {
    const owner = await this.findOwnerByPhone(phone);

    if (!owner)
      throw new AppError("No account found.Register your account", 404);

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

    const token = generateToken(owner.id, owner.role);

    return {
      message: "Logged in successfully.",
      role: owner.role,
      owner,
      token,
    };
  }

  /* ---------------- GET ME ---------------- */
  async getMe(ownerId: string, role: "USER" | "ADMIN") {
    if (role === "USER") {
      const user = await prisma.user.findUnique({
        where: { id: ownerId },
        select: { id: true, name: true, phone: true },
      });

      if (!user) throw new AppError("User not found", 404);
      return { ...user, role: "USER" };
    }

    if (role === "ADMIN") {
      const admin = await prisma.admin.findUnique({
        where: { id: ownerId },
        select: { id: true, name: true, phone: true },
      });

      if (!admin) throw new AppError("Admin not found", 404);
      return { ...admin, role: "ADMIN" };
    }

    throw new AppError("Invalid role", 400);
  }
}

export const authService = new AuthService();
