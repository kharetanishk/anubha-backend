-- AlterTable
-- Add email column to OTP table to support dual-channel OTP (phone and email)
ALTER TABLE "OTP" ADD COLUMN "email" TEXT;

-- CreateIndex
CREATE INDEX "OTP_email_idx" ON "OTP"("email");

-- CreateIndex
CREATE INDEX "OTP_email_expiresAt_idx" ON "OTP"("email", "expiresAt");

