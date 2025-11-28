import jwt from "jsonwebtoken";

export function generateToken(userId: string, role: "USER" | "ADMIN"): string {
  return jwt.sign({ id: userId, role }, process.env.ACCESS_TOKEN_SECRET!, {
    expiresIn: "7d",
  });
}

export function verifyToken(token: string) {
  try {
    return jwt.verify(token, process.env.ACCESS_TOKEN_SECRET!) as {
      id: string;
      role: "USER" | "ADMIN";
    };
  } catch {
    return null;
  }
}
