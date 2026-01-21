import prisma from "../../database/prismaclient";
import {
  uploadImageToCloudinary,
  deleteFromCloudinary,
} from "../../util/cloudinary";
import { AppError } from "../../util/AppError";

/**
 * Admin Profile Service
 * Handles all business logic for admin profile picture operations
 */
export class AdminProfileService {
  /**
   * Extract public ID from Cloudinary URL
   * Handles various Cloudinary URL formats:
   * - https://res.cloudinary.com/{cloud_name}/image/upload/{folder}/{public_id}.{ext}
   * - https://res.cloudinary.com/{cloud_name}/image/upload/v{version}/{folder}/{public_id}.{ext}
   * - URLs with transformations
   * @param url Cloudinary secure URL
   * @returns Public ID or null if extraction fails
   */
  private extractPublicIdFromUrl(url: string): string | null {
    try {
      // Remove query parameters if any
      const urlWithoutParams = url.split("?")[0];

      // Cloudinary URL format: https://res.cloudinary.com/{cloud_name}/image/upload/{folder}/{public_id}.{ext}
      const urlParts = urlWithoutParams.split("/");
      const uploadIndex = urlParts.findIndex((part) => part === "upload");

      if (uploadIndex === -1) {
        console.warn("[ADMIN PROFILE] Invalid Cloudinary URL format:", url);
        return null;
      }

      // Get everything after "upload" (skip version if present)
      const pathAfterUpload = urlParts.slice(uploadIndex + 1);

      // Remove version number if present (format: v1234567890)
      const pathWithoutVersion =
        pathAfterUpload[0]?.startsWith("v") && /^v\d+$/.test(pathAfterUpload[0])
          ? pathAfterUpload.slice(1)
          : pathAfterUpload;

      // Join the path and remove file extension
      const fullPath = pathWithoutVersion.join("/");
      const publicId = fullPath.split(".").slice(0, -1).join("."); // Remove last part (extension)

      return publicId || null;
    } catch (error) {
      console.error("[ADMIN PROFILE] Failed to extract public ID:", error);
      return null;
    }
  }

  /**
   * Upload admin profile picture
   * @param adminId Admin ID
   * @param file Multer file object
   * @returns Updated admin with profile picture URL
   */
  async uploadProfilePicture(
    adminId: string,
    file: Express.Multer.File
  ): Promise<{ profilePictureUrl: string }> {
    try {
      // Verify admin exists
      const admin = await prisma.admin.findUnique({
        where: { id: adminId },
        select: { id: true, profilePictureUrl: true },
      });

      if (!admin) {
        throw new AppError("Admin not found", 404);
      }

      // Delete old profile picture if exists
      if (admin.profilePictureUrl) {
        const oldPublicId = this.extractPublicIdFromUrl(
          admin.profilePictureUrl
        );
        if (oldPublicId) {
          try {
            await deleteFromCloudinary(oldPublicId);
          } catch (error) {
            console.error(
              "[ADMIN PROFILE] Failed to delete old picture:",
              error
            );
            // Continue with upload even if deletion fails
          }
        }
      }

      // Convert file to base64
      const base64 = `data:${file.mimetype};base64,${file.buffer.toString(
        "base64"
      )}`;

      // Generate unique public ID
      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(2, 15);
      const publicId = `admin-profiles/${adminId}_${timestamp}_${randomStr}`;

      // Upload to Cloudinary
      const uploadResult = await uploadImageToCloudinary(base64, {
        folder: "admin-profiles",
        publicId: publicId,
        context: {
          admin_id: adminId,
          uploaded_at: new Date().toISOString(),
        },
      });

      // Update admin with new profile picture URL
      const updatedAdmin = await prisma.admin.update({
        where: { id: adminId },
        data: {
          profilePictureUrl: uploadResult.secure_url,
        },
        select: {
          profilePictureUrl: true,
        },
      });

      return {
        profilePictureUrl: updatedAdmin.profilePictureUrl!,
      };
    } catch (error: any) {
      if (error instanceof AppError) {
        throw error;
      }

      // Handle Prisma connection errors specifically
      if (error?.code === "P1001" || error?.code === "P1000") {
        console.error("[ADMIN PROFILE] Database connection error:", error);
        throw new AppError(
          "Database connection failed. Please check your database server and try again.",
          503 // Service Unavailable
        );
      }

      // Handle other Prisma errors
      if (error?.code?.startsWith("P")) {
        console.error("[ADMIN PROFILE] Prisma error:", error);
        throw new AppError(
          "Database operation failed. Please try again later.",
          500
        );
      }

      console.error("[ADMIN PROFILE] Upload error:", error);
      throw new AppError(
        `Failed to upload profile picture: ${error.message || "Unknown error"}`,
        500
      );
    }
  }

  /**
   * Get admin profile picture
   * @param adminId Admin ID
   * @returns Profile picture URL or null
   */
  async getProfilePicture(adminId: string): Promise<{
    profilePictureUrl: string | null;
  }> {
    try {
      const admin = await prisma.admin.findUnique({
        where: { id: adminId },
        select: { profilePictureUrl: true },
      });

      if (!admin) {
        throw new AppError("Admin not found", 404);
      }

      return {
        profilePictureUrl: admin.profilePictureUrl,
      };
    } catch (error: any) {
      if (error instanceof AppError) {
        throw error;
      }

      // Handle Prisma connection errors specifically
      if (error?.code === "P1001" || error?.code === "P1000") {
        console.error("[ADMIN PROFILE] Database connection error:", error);
        throw new AppError(
          "Database connection failed. Please check your database server and try again.",
          503 // Service Unavailable
        );
      }

      // Handle other Prisma errors
      if (error?.code?.startsWith("P")) {
        console.error("[ADMIN PROFILE] Prisma error:", error);
        throw new AppError(
          "Database operation failed. Please try again later.",
          500
        );
      }

      console.error("[ADMIN PROFILE] Get error:", error);
      throw new AppError(
        `Failed to get profile picture: ${error.message || "Unknown error"}`,
        500
      );
    }
  }

  /**
   * Update admin profile picture
   * @param adminId Admin ID
   * @param file Multer file object
   * @returns Updated admin with profile picture URL
   */
  async updateProfilePicture(
    adminId: string,
    file: Express.Multer.File
  ): Promise<{ profilePictureUrl: string }> {
    // Update is same as upload (replaces existing)
    return this.uploadProfilePicture(adminId, file);
  }

  /**
   * Delete admin profile picture
   * @param adminId Admin ID
   * @returns Success message
   */
  async deleteProfilePicture(adminId: string): Promise<{ message: string }> {
    try {
      // Verify admin exists and get current profile picture
      const admin = await prisma.admin.findUnique({
        where: { id: adminId },
        select: { id: true, profilePictureUrl: true },
      });

      if (!admin) {
        throw new AppError("Admin not found", 404);
      }

      if (!admin.profilePictureUrl) {
        throw new AppError("Profile picture not found", 404);
      }

      // Extract public ID and delete from Cloudinary
      const publicId = this.extractPublicIdFromUrl(admin.profilePictureUrl);
      if (publicId) {
        try {
          await deleteFromCloudinary(publicId);
        } catch (error) {
          console.error(
            "[ADMIN PROFILE] Failed to delete from Cloudinary:",
            error
          );
          // Continue with database update even if Cloudinary deletion fails
        }
      }

      // Update admin to remove profile picture URL
      await prisma.admin.update({
        where: { id: adminId },
        data: {
          profilePictureUrl: null,
        },
      });

      return {
        message: "Profile picture deleted successfully",
      };
    } catch (error: any) {
      if (error instanceof AppError) {
        throw error;
      }

      // Handle Prisma connection errors specifically
      if (error?.code === "P1001" || error?.code === "P1000") {
        console.error("[ADMIN PROFILE] Database connection error:", error);
        throw new AppError(
          "Database connection failed. Please check your database server and try again.",
          503 // Service Unavailable
        );
      }

      // Handle other Prisma errors
      if (error?.code?.startsWith("P")) {
        console.error("[ADMIN PROFILE] Prisma error:", error);
        throw new AppError(
          "Database operation failed. Please try again later.",
          500
        );
      }

      console.error("[ADMIN PROFILE] Delete error:", error);
      throw new AppError(
        `Failed to delete profile picture: ${error.message || "Unknown error"}`,
        500
      );
    }
  }
}

export const adminProfileService = new AdminProfileService();
