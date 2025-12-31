import { Request, Response } from "express";
import cloudinary, {
  uploadPDFToCloudinary,
  generateSignedUrl,
} from "../../util/cloudinary";
import prisma from "../../database/prismaclient";

/**
 * Upload PDF files to Cloudinary for doctor notes
 * Accepts only PDF files (max 10MB each, max 15 files)
 */
export const uploadPDFHandler = async (req: Request, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No files uploaded.",
      });
    }

    // Validate max 15 files
    if (files.length > 15) {
      return res.status(400).json({
        success: false,
        message: "Maximum 15 PDF files allowed per upload.",
      });
    }

    const uploadedFiles = [];

    for (const file of files) {
      // Validate file is PDF
      if (file.mimetype !== "application/pdf") {
        console.error(
          `[PDF UPLOAD] File ${file.originalname} is not a PDF: ${file.mimetype}`
        );
        return res.status(400).json({
          success: false,
          message: `File "${file.originalname}" is not a PDF file. Only PDF files are allowed.`,
        });
      }

      // Validate file size (10MB max)
      const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
      if (file.size > MAX_FILE_SIZE) {
        console.error(
          `[PDF UPLOAD] File ${file.originalname} exceeds size limit: ${file.size} bytes`
        );
        return res.status(400).json({
          success: false,
          message: `File "${file.originalname}" exceeds maximum size of 10MB`,
        });
      }

      // Validate file is not empty
      if (file.size === 0) {
        console.error(`[PDF UPLOAD] File ${file.originalname} is empty`);
        return res.status(400).json({
          success: false,
          message: `File "${file.originalname}" is empty`,
        });
      }

      const base64 = `data:${file.mimetype};base64,${file.buffer.toString(
        "base64"
      )}`;

      // Upload to Cloudinary using utility function
      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(2, 15);
      const uniqueId = `nutriwell_pdf_${timestamp}_${randomStr}`;

      const result = await uploadPDFToCloudinary(base64, {
        folder: "nutriwell_diet_charts",
        publicId: uniqueId,
        context: {
          uploaded_at: new Date().toISOString(),
          uploaded_by: (req as any).user?.id || "unknown",
          original_filename: file.originalname,
        },
      });

      const pdfUrl = result.secure_url;

      const saved = await prisma.file.create({
        data: {
          url: pdfUrl, // Store Cloudinary secure_url with proper Content-Type
          publicId: result.public_id,
          fileName: file.originalname,
          mimeType: file.mimetype,
          sizeInBytes: file.size,
          patientId: null,
        },
      });

      uploadedFiles.push(saved);
    }

    // console.log(
    // `[PDF UPLOAD] ✅ Successfully uploaded ${uploadedFiles.length} PDF file(s)
    // `
    // );

    res.status(200).json({
      success: true,
      message: "PDF files uploaded successfully",
      files: uploadedFiles,
    });
  } catch (error: any) {
    console.error("[PDF UPLOAD] Error:", error);

    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message: "File too large. Max size is 10MB.",
      });
    }

    // Handle database errors
    if (error.code?.startsWith("P")) {
      console.error("[PDF UPLOAD] Database error:", {
        code: error.code,
        message: error.message,
      });
      return res.status(503).json({
        success: false,
        message: "Database error. Please try again in a moment.",
        code: "DB_ERROR",
        retryable: true,
      });
    }

    console.error("[PDF UPLOAD] Unexpected error:", error);
    return res.status(500).json({
      success: false,
      message: "PDF upload failed. Please try again later.",
    });
  }
};

export const uploadImageToCloudinary = async (req: Request, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No files uploaded.",
      });
    }

    const uploadedFiles = [];

    for (const file of files) {
      // Additional security: Validate file size (redundant check after middleware)
      const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
      if (file.size > MAX_FILE_SIZE) {
        console.error(
          `[UPLOAD] File ${file.originalname} exceeds size limit: ${file.size} bytes`
        );
        return res.status(400).json({
          success: false,
          message: `File "${file.originalname}" exceeds maximum size of 10MB`,
        });
      }

      // Additional security: Validate file is not empty
      if (file.size === 0) {
        console.error(`[UPLOAD] File ${file.originalname} is empty`);
        return res.status(400).json({
          success: false,
          message: `File "${file.originalname}" is empty`,
        });
      }

      const base64 = `data:${file.mimetype};base64,${file.buffer.toString(
        "base64"
      )}`;

      // Upload to Cloudinary with security measures
      // Security: Generate unique public_id with timestamp and random string to prevent guessing
      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(2, 15);
      const uniqueId = `nutriwell_${timestamp}_${randomStr}`;

      const result = await cloudinary.uploader.upload(base64, {
        folder: "nutriwell_images",
        resource_type: "image",
        // Security: Use unique public_id to prevent guessing attacks
        public_id: uniqueId,
        // Security: Add metadata for tracking and audit
        context: {
          uploaded_at: new Date().toISOString(),
          uploaded_by: (req as any).user?.id || "unknown",
          original_filename: file.originalname,
        },
        transformation: [
          {
            quality: "auto:best",
            fetch_format: "auto",
            crop: "limit",
            width: 2000,
            height: 2000,
          },
        ],
      });

      // Generate signed URL for secure access
      // Signed URLs include a signature parameter that prevents URL tampering
      // Expires after 1 year (can be adjusted based on requirements)
      // Note: Cloudinary signed URLs are validated server-side when accessed
      const signedUrl = generateSignedUrl(result.public_id, 365 * 24 * 60 * 60);

      const saved = await prisma.file.create({
        data: {
          url: signedUrl, // Store signed URL instead of public URL
          publicId: result.public_id,
          fileName: file.originalname,
          mimeType: file.mimetype,
          sizeInBytes: file.size,
          patientId: null,
        },
      });

      uploadedFiles.push(saved);
    }

    res.status(200).json({
      message: "Images uploaded successfully ",
      files: uploadedFiles,
    });
  } catch (error: any) {
    console.error("Cloudinary upload error:", error);

    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        success: false,
        message: "File too large. Max size is 10MB.",
      });
    }

    // Handle database errors
    if (error.code?.startsWith("P")) {
      console.error("[UPLOAD] Database error:", {
        code: error.code,
        message: error.message,
      });
      return res.status(503).json({
        success: false,
        message: "Database error. Please try again in a moment.",
        code: "DB_ERROR",
        retryable: true,
      });
    }

    console.error("[UPLOAD] Unexpected error:", error);
    return res.status(500).json({
      success: false,
      message: "Image upload failed. Please try again later.",
    });
  }
};
