-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "reminderTime" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Appointment_reminderTime_reminderSent_idx" ON "Appointment"("reminderTime", "reminderSent");

-- CreateIndex
CREATE INDEX "OTP_phone_expiresAt_idx" ON "OTP"("phone", "expiresAt");
