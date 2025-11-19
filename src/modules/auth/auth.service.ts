import prisma from "../../database/prismaclient";
import crypto from "crypto";
import { hashOtp, validateOtp, isOtpExpired } from "./utils/validateOtp";
import { generateTokenPair } from "./utils/token";

export class AuthService {
  /**
   * -----------------------------------------
   * SHARED: Resolve account owner (USER / ADMIN)
   * -----------------------------------------
   */
  private async findOwnerByEmail(email: string) {
    const user = await prisma.user.findUnique({ where: { email } });
    const admin = await prisma.admin.findUnique({ where: { email } });

    if (user) return { id: user.id, role: "USER" as const };
    if (admin) return { id: admin.id, role: "ADMIN" as const };

    return null;
  }

  /**
   * -----------------------------------------
   * SHARED: Create & store OTP
   * -----------------------------------------
   */
  private async createOtp(email: string) {
    const otp = crypto.randomInt(1000, 9999).toString();
    const hashed = await hashOtp(otp);

    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min

    await prisma.oTP.create({
      data: { email, code: hashed, expiresAt },
    });

    console.log(`OTP : `, otp); // TODO: Replace with real email/SMS

    return otp;
  }

  /**
   * -----------------------------------------
   * REGISTER → SEND OTP
   * -----------------------------------------
   */
  async sendRegisterOtp(name: string, email: string) {
    const existingOwner = await this.findOwnerByEmail(email);
    if (existingOwner)
      throw new Error("Account already exists with this email.");

    await this.createOtp(email);

    return { message: "OTP sent successfully." };
  }

  /**
   * -----------------------------------------
   * REGISTER → VERIFY OTP
   * -----------------------------------------
   */
  async verifyRegisterOtp(name: string, email: string, otp: string) {
    const existingOwner = await this.findOwnerByEmail(email);
    if (existingOwner) throw new Error("Account already exists.");

    // get latest OTP
    const foundOtp = await prisma.oTP.findFirst({
      where: { email },
      orderBy: { createdAt: "desc" },
    });

    if (!foundOtp) throw new Error("OTP not found.");
    if (isOtpExpired(foundOtp.expiresAt)) throw new Error("OTP expired.");

    const match = await validateOtp(otp, foundOtp.code);
    if (!match) throw new Error("Invalid OTP.");

    await prisma.oTP.delete({ where: { id: foundOtp.id } });

    // CREATE USER
    const user = await prisma.user.create({
      data: { name, email },
    });

    // Generate tokens
    const tokens = await generateTokenPair(user.id, "USER");

    return {
      message: "User registered successfully.",
      user,
      tokens,
    };
  }

  /**
   * -----------------------------------------
   * LOGIN → SEND OTP (USER + ADMIN)
   * -----------------------------------------
   */
  async sendLoginOtp(email: string) {
    const owner = await this.findOwnerByEmail(email);
    if (!owner) throw new Error("No account found with this email.");

    await this.createOtp(email);

    return {
      message: "OTP sent successfully.",
      role: owner.role,
    };
  }

  /**
   * -----------------------------------------
   * LOGIN → VERIFY OTP (USER + ADMIN)
   * -----------------------------------------
   */
  async verifyLoginOtp(email: string, otp: string) {
    const owner = await this.findOwnerByEmail(email);
    if (!owner) throw new Error("No account found.");

    // fetch latest OTP
    const foundOtp = await prisma.oTP.findFirst({
      where: { email },
      orderBy: { createdAt: "desc" },
    });

    if (!foundOtp) throw new Error("OTP not found.");
    if (isOtpExpired(foundOtp.expiresAt)) throw new Error("OTP expired.");

    const match = await validateOtp(otp, foundOtp.code);
    if (!match) throw new Error("Invalid OTP.");

    await prisma.oTP.delete({ where: { id: foundOtp.id } });

    // generate token pair (role-aware)
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
