-- AlterTable
-- Make phone column nullable in OTP table to support dual-channel OTP
-- When creating OTP for email-only, phone can be null
ALTER TABLE "OTP" ALTER COLUMN "phone" DROP NOT NULL;

