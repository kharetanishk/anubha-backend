import jwt from "jsonwebtoken";
import crypto from "crypto";
import prisma from "../../../database/prismaclient";

export function generateAccessToken(payload: any): string {
  return jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET!, {
    expiresIn: "15m",
  });
}

export async function generateRefreshToken(
  ownerId: string,
  role: "USER" | "ADMIN"
) {
  const token = crypto.randomBytes(48).toString("hex");

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30); // 30 days validity

  const data: any = {
    token,
    expiresAt,
    userId: null,
    adminId: null,
  };

  if (role === "USER") data.userId = ownerId;
  if (role === "ADMIN") data.adminId = ownerId;

  await prisma.refreshToken.create({ data });

  return {
    refreshToken: token,
    refreshTokenExpiry: expiresAt,
  };
}

export function verifyAccessToken(token: string) {
  try {
    return jwt.verify(token, process.env.ACCESS_TOKEN_SECRET!);
  } catch {
    return null;
  }
}

export async function verifyRefreshToken(refreshToken: string) {
  const tokenData = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
  });

  if (!tokenData) return null;

  if (new Date() > new Date(tokenData.expiresAt)) return null;

  return tokenData;
}

export async function generateTokenPair(
  userId: string,
  role: "USER" | "ADMIN"
) {
  const accessToken = generateAccessToken({ id: userId, role });

  const { refreshToken, refreshTokenExpiry } = await generateRefreshToken(
    userId,
    role
  );

  return { accessToken, refreshToken, refreshTokenExpiry };
}
