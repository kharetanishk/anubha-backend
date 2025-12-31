import { PrismaClient } from "@prisma/client";
import { normalizePhoneNumber } from "../utils/phoneNormalizer";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Production: Only log errors and warnings
    // Development: Log queries, info, warnings, and errors
    log:
      process.env.NODE_ENV === "production"
        ? ["error", "warn"]
        : ["query", "info", "warn", "error"],
    errorFormat: process.env.NODE_ENV === "production" ? "minimal" : "pretty",
  });

// Prisma middleware to normalize phone numbers at database level
prisma.$use(async (params, next) => {
  // Normalize phone numbers before create/update operations
  if (
    params.model === "User" ||
    params.model === "Admin" ||
    params.model === "PatientDetials"
  ) {
    if (
      params.action === "create" ||
      params.action === "update" ||
      params.action === "upsert"
    ) {
      if (params.args?.data?.phone) {
        try {
          params.args.data.phone = normalizePhoneNumber(params.args.data.phone);
        } catch (error: any) {
          console.error("[PRISMA] Phone normalization error:", error.message);
          throw new Error(`Invalid phone number: ${error.message}`);
        }
      }
      // Handle nested creates/updates
      if (params.args?.data?.create?.phone) {
        try {
          params.args.data.create.phone = normalizePhoneNumber(
            params.args.data.create.phone
          );
        } catch (error: any) {
          console.error("[PRISMA] Phone normalization error:", error.message);
          throw new Error(`Invalid phone number: ${error.message}`);
        }
      }
      if (params.args?.data?.update?.phone) {
        try {
          params.args.data.update.phone = normalizePhoneNumber(
            params.args.data.update.phone
          );
        } catch (error: any) {
          console.error("[PRISMA] Phone normalization error:", error.message);
          throw new Error(`Invalid phone number: ${error.message}`);
        }
      }
    }
  }

  return next(params);
});

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;
