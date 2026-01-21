-- Add DoctorNotes.bodyMeasurements column (Section 8: Body Measurements)
-- Mirrors `doctor_notes.form_data->'bodyMeasurements'` for forward-compatible structure and queryability.

ALTER TABLE "doctor_notes"
ADD COLUMN IF NOT EXISTS "body_measurements" JSONB;

-- Backfill from existing JSON form_data (if present)
UPDATE "doctor_notes"
SET "body_measurements" = COALESCE("body_measurements", "formData"->'bodyMeasurements')
WHERE "body_measurements" IS NULL
  AND "formData" IS NOT NULL
  AND ("formData"->'bodyMeasurements') IS NOT NULL;

