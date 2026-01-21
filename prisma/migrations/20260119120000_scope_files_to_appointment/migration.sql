-- Scope uploaded reports/files to an appointment to prevent cross-appointment sharing.
-- This fixes a data-integrity bug where patient-level files were being shown for unrelated appointments.

-- 1) Add appointmentId column
ALTER TABLE "File" ADD COLUMN IF NOT EXISTS "appointmentId" TEXT;

-- 2) Index for common lookups
CREATE INDEX IF NOT EXISTS "File_appointmentId_idx" ON "File"("appointmentId");

-- 3) Foreign key to Appointment (cascade delete so appointment-scoped files are cleaned up)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'File_appointmentId_fkey'
  ) THEN
    ALTER TABLE "File"
      ADD CONSTRAINT "File_appointmentId_fkey"
      FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

