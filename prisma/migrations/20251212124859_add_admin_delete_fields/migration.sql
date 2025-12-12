-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "deletedByAdminAt" TIMESTAMP(3),
ADD COLUMN     "deletedByAdminReason" TEXT,
ADD COLUMN     "isDeletedByAdmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Appointment_isDeletedByAdmin_idx" ON "Appointment"("isDeletedByAdmin");
