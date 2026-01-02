import { Request, Response } from "express";
import prisma from "../../database/prismaclient";
import cloudinary from "../../util/cloudinary";
import { deleteFromCloudinary } from "../../util/cloudinary";

/**
 * Create a new testimonial
 * POST /admin/testimonials
 */
export async function createTestimonial(req: Request, res: Response) {
  try {
    const { name, text, isActive } = req.body;
    const file = req.file as Express.Multer.File;

    if (!name || !text) {
      return res.status(400).json({
        success: false,
        message: "Name and text are required",
      });
    }

    if (!file) {
      return res.status(400).json({
        success: false,
        message: "Image is required",
      });
    }

    // Upload image to Cloudinary
    const base64 = `data:${file.mimetype};base64,${file.buffer.toString(
      "base64"
    )}`;

    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 15);
    const uniqueId = `testimonials_${timestamp}_${randomStr}`;

    const result = await cloudinary.uploader.upload(base64, {
      folder: "testimonials",
      resource_type: "image",
      public_id: uniqueId,
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

    const testimonial = await prisma.testimonial.create({
      data: {
        name: name.trim(),
        text: text.trim(),
        imageUrl: result.secure_url,
        isActive: isActive === "true" || isActive === true,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Testimonial created successfully",
      testimonial,
    });
  } catch (error: any) {
    console.error("[TESTIMONIALS] Create error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
}

/**
 * Get all testimonials (admin only - includes active and inactive)
 * GET /admin/testimonials
 */
export async function getAllTestimonials(req: Request, res: Response) {
  try {
    const testimonials = await prisma.testimonial.findMany({
      orderBy: { createdAt: "desc" },
    });

    return res.status(200).json({
      success: true,
      testimonials,
    });
  } catch (error: any) {
    console.error("[TESTIMONIALS] Get all error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
}

/**
 * Get active testimonials (public)
 * GET /testimonials
 */
export async function getActiveTestimonials(req: Request, res: Response) {
  try {
    const testimonials = await prisma.testimonial.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        text: true,
        imageUrl: true,
      },
    });

    // Transform to match frontend format
    const formattedTestimonials = testimonials.map((t) => ({
      img: t.imageUrl,
      name: t.name,
      text: t.text,
    }));

    return res.status(200).json({
      success: true,
      testimonials: formattedTestimonials,
    });
  } catch (error: any) {
    console.error("[TESTIMONIALS] Get active error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
}

/**
 * Update a testimonial
 * PUT /admin/testimonials/:id
 */
export async function updateTestimonial(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { name, text, isActive } = req.body;
    const file = req.file as Express.Multer.File | undefined;

    const existingTestimonial = await prisma.testimonial.findUnique({
      where: { id },
    });

    if (!existingTestimonial) {
      return res.status(404).json({
        success: false,
        message: "Testimonial not found",
      });
    }

    let imageUrl = existingTestimonial.imageUrl;

    // If new image is uploaded, delete old one and upload new
    if (file) {
      // Delete old image from Cloudinary
      // Extract public_id from URL (format: https://res.cloudinary.com/.../testimonials/filename)
      const urlParts = existingTestimonial.imageUrl.split("/");
      const folderAndFile = urlParts.slice(-2).join("/");
      const oldPublicId = folderAndFile.split(".")[0];
      
      try {
        await deleteFromCloudinary(oldPublicId);
      } catch (err) {
        console.error("[TESTIMONIALS] Failed to delete old image:", err);
        // Continue even if deletion fails
      }

      // Upload new image
      const base64 = `data:${file.mimetype};base64,${file.buffer.toString(
        "base64"
      )}`;

      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(2, 15);
      const uniqueId = `testimonials_${timestamp}_${randomStr}`;

      const result = await cloudinary.uploader.upload(base64, {
        folder: "testimonials",
        resource_type: "image",
        public_id: uniqueId,
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

      imageUrl = result.secure_url;
    }

    const testimonial = await prisma.testimonial.update({
      where: { id },
      data: {
        name: name !== undefined ? name.trim() : undefined,
        text: text !== undefined ? text.trim() : undefined,
        imageUrl,
        isActive:
          isActive !== undefined
            ? isActive === "true" || isActive === true
            : undefined,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Testimonial updated successfully",
      testimonial,
    });
  } catch (error: any) {
    console.error("[TESTIMONIALS] Update error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
}

/**
 * Delete a testimonial
 * DELETE /admin/testimonials/:id
 */
export async function deleteTestimonial(req: Request, res: Response) {
  try {
    const { id } = req.params;

    const testimonial = await prisma.testimonial.findUnique({
      where: { id },
    });

    if (!testimonial) {
      return res.status(404).json({
        success: false,
        message: "Testimonial not found",
      });
    }

    // Delete image from Cloudinary
    // Extract public_id from URL (format: https://res.cloudinary.com/.../testimonials/filename)
    const urlParts = testimonial.imageUrl.split("/");
    const folderAndFile = urlParts.slice(-2).join("/");
    const publicId = folderAndFile.split(".")[0];
    
    try {
      await deleteFromCloudinary(publicId);
    } catch (err) {
      console.error("[TESTIMONIALS] Failed to delete image:", err);
      // Continue even if deletion fails
    }

    await prisma.testimonial.delete({
      where: { id },
    });

    return res.status(200).json({
      success: true,
      message: "Testimonial deleted successfully",
    });
  } catch (error: any) {
    console.error("[TESTIMONIALS] Delete error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
}

