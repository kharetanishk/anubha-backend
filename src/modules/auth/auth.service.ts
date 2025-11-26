import prisma from "../../database/prismaclient";
import crypto from "crypto";
import { hashOtp, validateOtp, isOtpExpired } from "./utils/validateOtp";
import { generateTokenPair } from "./utils/token";

export class AuthService {
  private async findOwnerByPhone(phone: string) {
    const user = await prisma.user.findUnique({ where: { phone } });
    const admin = await prisma.admin.findUnique({ where: { phone } });

    if (user) return { id: user.id, role: "USER" as const };
    if (admin) return { id: admin.id, role: "ADMIN" as const };

    return null;
  }

  private async createOtp(phone: string) {
    const otp = crypto.randomInt(1000, 9999).toString();
    const hashed = await hashOtp(otp);

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min

    await prisma.oTP.create({
      data: { phone, code: hashed, expiresAt },
    });

    console.log(`OTP : `, otp);

    return otp;
  }

  async sendRegisterOtp(name: string, phone: string) {
    const existingOwner = await this.findOwnerByPhone(phone);
    if (existingOwner)
      throw new Error("Account already exists with this email.");

    await this.createOtp(phone);

    return { message: "OTP sent successfully." };
  }

  async verifyRegisterOtp(name: string, phone: string, otp: string) {
    const existingOwner = await this.findOwnerByPhone(phone);
    if (existingOwner) throw new Error("Account already exists.");

    const foundOtp = await prisma.oTP.findFirst({
      where: { phone },
      orderBy: { createdAt: "desc" },
    });

    if (!foundOtp) throw new Error("OTP not found.");
    if (isOtpExpired(foundOtp.expiresAt)) throw new Error("OTP expired.");

    const match = await validateOtp(otp, foundOtp.code);
    if (!match) throw new Error("Invalid OTP.");

    await prisma.oTP.delete({ where: { id: foundOtp.id } });

    const user = await prisma.user.create({
      data: { name, phone },
    });
    const tokens = await generateTokenPair(user.id, "USER");

    return {
      message: "User registered successfully.",
      user,
      tokens,
    };
  }

  async sendLoginOtp(phone: string) {
    const owner = await this.findOwnerByPhone(phone);
    if (!owner) throw new Error("No account found with this phone number.");

    await this.createOtp(phone);

    return {
      message: "OTP sent successfully.",
      role: owner.role,
    };
  }

  async verifyLoginOtp(phone: string, otp: string) {
    const owner = await this.findOwnerByPhone(phone);
    if (!owner) throw new Error("No account found.");

    const foundOtp = await prisma.oTP.findFirst({
      where: { phone },
      orderBy: { createdAt: "desc" },
    });

    if (!foundOtp) throw new Error("OTP not found.");
    if (isOtpExpired(foundOtp.expiresAt)) throw new Error("OTP expired.");

    const match = await validateOtp(otp, foundOtp.code);
    if (!match) throw new Error("Invalid OTP.");

    await prisma.oTP.delete({ where: { id: foundOtp.id } });

    const tokens = await generateTokenPair(owner.id, owner.role);

    return {
      message: "Logged in successfully.",
      role: owner.role,
      owner,
      tokens,
    };
  }
}

export const authService = new AuthService();
