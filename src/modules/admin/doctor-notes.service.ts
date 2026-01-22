import prisma from "../../database/prismaclient";

export type ParsedDoctorNotesFormData = any;

export class DoctorNotesServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Parse `formData` coming from multipart/form-data or JSON requests.
 * Behavior is intentionally identical to the existing controller behavior:
 * - If `formDataStr` is a string, JSON.parse it
 * - Otherwise return as-is
 * - Throw a typed error when parsing fails
 */
export function parseDoctorNotesFormData(
  formDataStr: unknown
): ParsedDoctorNotesFormData {
  try {
    return typeof formDataStr === "string" ? JSON.parse(formDataStr) : formDataStr;
  } catch (e) {
    throw new DoctorNotesServiceError("INVALID_FORM_DATA", "Invalid formData format");
  }
}

/**
 * Deep merge utility for merging partial updates with existing form data.
 * NOTE: This logic is copied verbatim (behavior-wise) from the previous controller implementation.
 */
export function deepMerge(target: any, source: any): any {
  const output = { ...target };
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach((key) => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

function isObject(item: any): boolean {
  return item && typeof item === "object" && !Array.isArray(item);
}

export interface UpsertDoctorNotesParams {
  appointmentId: string;
  adminId: string;
  formData: any;
  isDraft: boolean;
  sectionKey?: string | null; // Optional: if provided, update only this section
  isPatch?: boolean; // If true, expects existing record; if false, may create new
}

/**
 * Valid section keys that can be updated individually.
 * These correspond to top-level keys in the DoctorNotesFormData.
 */
const VALID_SECTION_KEYS = [
  "personalHistory",
  "reasonForJoiningProgram",
  "ethnicity",
  "joiningDate",
  "expiryDate",
  "dietPrescriptionDate",
  "durationOfDiet",
  "previousDietTaken",
  "previousDietDetails",
  "typeOfDietTaken",
  "maritalStatus",
  "numberOfChildren",
  "dietPreference",
  "wakeupTime",
  "bedTime",
  "dayNap",
  "workoutTiming",
  "workoutType",
  "morningIntake",
  "breakfast",
  "midMorning",
  "lunch",
  "midDay",
  "eveningSnack",
  "dinner",
  "baseInfo", // Special composite key for atomic Section 1 updates
  "foodRecall", // Special composite key for atomic meal updates
  "weekendDiet",
  "questionnaire",
  "foodFrequency",
  "healthProfile",
  "dietPrescribed",
  "bodyMeasurements",
  "notes",
] as const;

/**
 * Prisma upsert for DoctorNotes.
 * 
 * NEW: If `sectionKey` is provided, updates ONLY that section in formData JSONB
 * using PostgreSQL jsonb_set, avoiding full merge and preserving other sections.
 * 
 * BACKWARD COMPATIBLE: If `sectionKey` is NOT provided, falls back to full merge behavior.
 */
export async function upsertDoctorNotes(params: UpsertDoctorNotesParams) {
  const { appointmentId, adminId, formData, isDraft, sectionKey, isPatch } = params;

  // If sectionKey is provided, use section-aware partial update
  if (sectionKey && isPatch) {
    // Validate section key
    if (!VALID_SECTION_KEYS.includes(sectionKey as any)) {
      throw new DoctorNotesServiceError(
        "INVALID_SECTION_KEY",
        `Invalid sectionKey: "${sectionKey}". Must be one of: ${VALID_SECTION_KEYS.join(", ")}`
      );
    }

    // Extract only the section data from formData
    // Support both { sectionKey: {...} } and { formData: { sectionKey: {...} } } formats
    const sectionData = formData[sectionKey] ?? formData.formData?.[sectionKey] ?? formData;

    // Fetch existing record to ensure it exists
    const existing = await prisma.doctorNotes.findUnique({
      where: { appointmentId },
      select: { id: true, formData: true },
    });

    if (!existing) {
      throw new DoctorNotesServiceError(
        "NOT_FOUND",
        "Doctor notes not found. Cannot perform section update on non-existent record. Use POST without sectionKey to create."
      );
    }

    // Special handling for "foodRecall": atomically update all 7 meal keys as top-level fields
    if (sectionKey === "foodRecall") {
      // Validate that sectionData contains meal objects
      if (!sectionData || typeof sectionData !== "object" || Array.isArray(sectionData)) {
        throw new DoctorNotesServiceError(
          "INVALID_FORM_DATA",
          "foodRecall sectionData must be an object containing meal data"
        );
      }

      // Define all 7 meal keys that should be updated atomically
      const mealKeys = [
        "morningIntake",
        "breakfast",
        "midMorning",
        "lunch",
        "midDay",
        "eveningSnack",
        "dinner",
      ];

      // Extract existing formData
      const existingFormData = (existing.formData as any) || {};

      // Use Prisma transaction to atomically update all 7 meal keys in formData
      // This ensures either all meals are updated or none (no partial updates)
      return await prisma.$transaction(async (tx) => {
        // Merge meal data into existing formData (preserve other sections)
        const updatedFormData = {
          ...existingFormData,
        };

        // Update all 7 meal keys from sectionData
        mealKeys.forEach((mealKey) => {
          if (mealKey in sectionData) {
            updatedFormData[mealKey] = (sectionData as any)[mealKey];
          }
        });

        // Single atomic update with all 7 meals merged into formData
        const updated = await tx.doctorNotes.update({
          where: { appointmentId },
          data: {
            formData: updatedFormData as any,
            isDraft: isDraft ?? false,
            isCompleted: !isDraft,
            submittedAt: isDraft ? null : new Date(),
            updatedBy: adminId,
            updatedAt: new Date(),
          },
        });

        return updated;
      });
    }

    // Special handling for "baseInfo": atomically update all 18 Section 1 flat fields as top-level keys
    // IMPORTANT: We do NOT create `formData.baseInfo` in the DB. We merge into top-level formData.
    if (sectionKey === "baseInfo") {
      if (!sectionData || typeof sectionData !== "object" || Array.isArray(sectionData)) {
        throw new DoctorNotesServiceError(
          "INVALID_FORM_DATA",
          "baseInfo sectionData must be an object containing Section 1 fields"
        );
      }

      const baseInfoKeys = [
        "personalHistory",
        "reasonForJoiningProgram",
        "ethnicity",
        "joiningDate",
        "expiryDate",
        "dietPrescriptionDate",
        "durationOfDiet",
        "previousDietTaken",
        "previousDietDetails",
        "typeOfDietTaken",
        "maritalStatus",
        "numberOfChildren",
        "dietPreference",
        "wakeupTime",
        "bedTime",
        "dayNap",
        "workoutTiming",
        "workoutType",
      ];

      const existingFormData = (existing.formData as any) || {};

      // One Prisma transaction + one UPDATE = atomic section save (no partial field updates possible)
      return await prisma.$transaction(async (tx) => {
        const updatedFormData = { ...existingFormData };

        baseInfoKeys.forEach((fieldKey) => {
          if (fieldKey in sectionData) {
            const nextValue = (sectionData as any)[fieldKey];
            // Avoid overwriting existing values with undefined/null if client sends them.
            if (nextValue !== undefined && nextValue !== null) {
              updatedFormData[fieldKey] = nextValue;
            }
          }
        });

        return await tx.doctorNotes.update({
          where: { appointmentId },
          data: {
            formData: updatedFormData as any,
            isDraft: isDraft ?? false,
            isCompleted: !isDraft,
            submittedAt: isDraft ? null : new Date(),
            updatedBy: adminId,
            updatedAt: new Date(),
          },
        });
      });
    }

    // Standard section update for other sections (using jsonb_set)
    // Use PostgreSQL jsonb_set for efficient partial update (JSONB operation, not full rewrite)
    // jsonb_set(target, path, new_value, create_missing)
    // This avoids deep merging the entire formData object
    await prisma.$executeRawUnsafe(
      `UPDATE doctor_notes
       SET 
         "formData" = jsonb_set(
           COALESCE("formData", '{}'::jsonb),
           ARRAY[$1]::text[],
           $2::jsonb,
           true
         ),
         "isDraft" = $3,
         "isCompleted" = $4,
         "submittedAt" = $5,
         "updatedBy" = $6,
         "updatedAt" = NOW()
       WHERE "appointmentId" = $7`,
      sectionKey, // $1: path key (e.g., "foodFrequency")
      JSON.stringify(sectionData), // $2: new section value as JSONB
      isDraft ?? false, // $3: isDraft
      !isDraft, // $4: isCompleted
      isDraft ? null : new Date(), // $5: submittedAt
      adminId, // $6: updatedBy
      appointmentId, // $7: WHERE clause
    );

    // Fetch and return updated record (guaranteed to exist after update)
    const updated = await prisma.doctorNotes.findUnique({
      where: { appointmentId },
    });

    if (!updated) {
      // This should never happen, but handle it for type safety
      throw new DoctorNotesServiceError(
        "UPDATE_FAILED",
        "Failed to retrieve updated doctor notes after section update"
      );
    }

    return updated;
  }

  // Fallback to full upsert (original behavior)
  return prisma.doctorNotes.upsert({
    where: {
      appointmentId,
    },
    update: {
      formData: formData as any,
      isDraft: isDraft ?? false,
      isCompleted: !isDraft,
      submittedAt: isDraft ? null : new Date(),
      updatedBy: adminId,
      updatedAt: new Date(),
    },
    create: {
      appointmentId,
      formData: formData as any,
      isDraft: isDraft ?? false,
      isCompleted: !isDraft,
      submittedAt: isDraft ? null : new Date(),
      createdBy: adminId,
      updatedBy: adminId,
    },
  });
}

export type UploadedFileInfo = {
  fileName: string;
  filePath: string;
  mimeType: string;
  sizeInBytes: number;
};

export interface SyncDoctorNoteAttachmentsParams {
  doctorNotesId: string;
  uploadedFiles: UploadedFileInfo[];
}

/**
 * Create/update DoctorNoteAttachment records for uploaded R2/Cloudinary files.
 * Behavior is intentionally identical to the existing controller behavior.
 */
export async function syncDoctorNoteAttachments(
  params: SyncDoctorNoteAttachmentsParams
) {
  const { doctorNotesId, uploadedFiles } = params;

  if (!uploadedFiles || uploadedFiles.length === 0) return;

  for (const uploadedFile of uploadedFiles) {
    // Check if attachment with same filePath (R2 key) already exists
    const existingAttachment = await prisma.doctorNoteAttachment.findFirst({
      where: {
        doctorNotesId,
        filePath: uploadedFile.filePath, // Match by R2 object key
        isArchived: false,
      },
    });

    if (existingAttachment) {
      // Determine file category and section based on filePath pattern
      let fileCategory: string = "DIET_CHART";
      let section: string | null = "DietPrescribed";

      // Check if this is a medical report
      if (uploadedFile.filePath.includes("/reports/")) {
        fileCategory = "LAB_REPORT";
        section = "HealthProfile";
      } else if (uploadedFile.filePath.includes("/pre-post/pre/")) {
        fileCategory = "IMAGE";
        section = "PrePostConsultation";
      } else if (uploadedFile.filePath.includes("/pre-post/post/")) {
        fileCategory = "IMAGE";
        section = "PrePostConsultation";
      } else if (uploadedFile.filePath.includes("/pdf/")) {
        fileCategory = "DIET_CHART";
        section = "DietPrescribed";
      }

      // Update existing attachment
      await prisma.doctorNoteAttachment.update({
        where: { id: existingAttachment.id },
        data: {
          fileName: uploadedFile.fileName,
          fileUrl: null, // No public URLs for R2 files
          mimeType: uploadedFile.mimeType,
          sizeInBytes: uploadedFile.sizeInBytes,
          provider: "S3", // Ensure provider is set to S3 for R2 files
          fileCategory: fileCategory as any,
          section,
          updatedAt: new Date(),
        },
      });
    } else {
      // Determine file category and section based on filePath pattern
      let fileCategory: string = "DIET_CHART";
      let section: string | null = "DietPrescribed";

      // Check if this is a medical report
      if (uploadedFile.filePath.includes("/reports/")) {
        fileCategory = "LAB_REPORT"; // Use LAB_REPORT category for medical reports
        section = "HealthProfile";
      } else if (uploadedFile.filePath.includes("/pre-post/pre/")) {
        fileCategory = "IMAGE";
        section = "PrePostConsultation";
      } else if (uploadedFile.filePath.includes("/pre-post/post/")) {
        fileCategory = "IMAGE";
        section = "PrePostConsultation";
      } else if (uploadedFile.filePath.includes("/pdf/")) {
        // PDF files (diet charts)
        fileCategory = "DIET_CHART";
        section = "DietPrescribed";
      }

      // Create new attachment
      const newAttachment = await prisma.doctorNoteAttachment.create({
        data: {
          doctorNotesId,
          fileName: uploadedFile.fileName,
          filePath: uploadedFile.filePath, // Store R2 object key
          fileUrl: null, // No public URLs for R2 files (use signed URLs on-demand)
          mimeType: uploadedFile.mimeType,
          sizeInBytes: uploadedFile.sizeInBytes,
          provider: "S3", // R2 uses S3-compatible API
          fileCategory: fileCategory as any,
          section,
        },
      });

      // Debug logging for medical reports
      if (uploadedFile.filePath.includes("/reports/")) {
        console.log("[BACKEND] Medical report attachment created:", {
          id: newAttachment.id,
          fileName: newAttachment.fileName,
          filePath: newAttachment.filePath,
          fileCategory: newAttachment.fileCategory,
          section: newAttachment.section,
          provider: newAttachment.provider,
        });
      }
    }
  }
}

