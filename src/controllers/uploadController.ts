import { Request, Response } from "express";
import cloudinary from "../util/cloudinary";
import prisma from "../database/prismaclient";

export const uploadImageToCloudinary = async (req: Request, res: Response) => {
  try {
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files uploaded." });
    }

    const uploadedFiles = [];

    for (const file of files) {
      const base64 = `data:${file.mimetype};base64,${file.buffer.toString(
        "base64"
      )}`;

      const result = await cloudinary.uploader.upload(base64, {
        folder: "nutriwell_images",
        resource_type: "image",
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

      // Save to DB with patientId = null
      const saved = await prisma.file.create({
        data: {
          url: result.secure_url,
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
      message: "Images uploaded successfully ✅",
      files: uploadedFiles,
    });
  } catch (error: any) {
    console.error("Cloudinary upload error:", error);

    if (error.code === "LIMIT_FILE_SIZE") {
      return res
        .status(400)
        .json({ error: "File too large. Max size is 10MB." });
    }

    res.status(500).json({ error: "Image upload failed" });
  }
};
