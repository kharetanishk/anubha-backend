import prisma from "../../database/prismaclient";
import bcrypt from "bcrypt";
import { AppError } from "../../util/AppError";
import { normalizePhoneNumber } from "../../utils/phoneNormalizer";

// Removed MAX_RESULTS - now using pagination with page/limit params

/**
 * Admin User Service
 * Handles user management operations for admin
 */
export class AdminUserService {
  /**
   * Normalize email address
   */
  normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Create a new user (admin creates on behalf of patient)
   * @param name Full name
   * @param phone Phone number
   * @param email Email (optional)
   * @param password Password
   * @returns Created user (without password)
   */
  async createUser(
    name: string,
    phone: string | null,
    email: string | null,
    password: string
  ): Promise<{
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
  }> {
    try {
      // Validate required fields
      if (!name || !name.trim()) {
        throw new AppError("Name is required", 400);
      }

      if (!password || password.length < 6) {
        throw new AppError("Password must be at least 6 characters long", 400);
      }

      // Sanitize phone and email - ensure they are not empty strings
      const sanitizedPhone =
        phone && typeof phone === "string" && phone.trim()
          ? phone.trim()
          : null;
      const sanitizedEmail =
        email && typeof email === "string" && email.trim()
          ? email.trim()
          : null;

      // At least one of phone or email is required
      if (!sanitizedPhone && !sanitizedEmail) {
        throw new AppError("Either phone number or email is required", 400);
      }

      // Normalize email if provided
      let normalizedEmail: string | null = null;
      if (sanitizedEmail) {
        normalizedEmail = this.normalizeEmail(sanitizedEmail);
        // Check if email already exists (unique constraint)
        const existingUserByEmail = await prisma.user.findUnique({
          where: { email: normalizedEmail },
        });

        if (existingUserByEmail) {
          throw new AppError("User with this email already exists", 409);
        }
      }

      // Normalize phone if provided
      let normalizedPhone: string | null = null;
      if (sanitizedPhone) {
        normalizedPhone = normalizePhoneNumber(sanitizedPhone);
        // Check if phone already exists (unique constraint)
        const existingUserByPhone = await prisma.user.findFirst({
          where: { phone: normalizedPhone },
        });

        if (existingUserByPhone) {
          throw new AppError("User with this phone number already exists", 409);
        }
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Create user - ONLY with the provided data, never with admin's credentials
      const userData: any = {
        name: name.trim(),
        password: hashedPassword,
      };

      // Only add email if provided (explicit null check)
      if (normalizedEmail) {
        userData.email = normalizedEmail;
      }

      // Only add phone if provided (explicit null check)
      if (normalizedPhone) {
        userData.phone = normalizedPhone;
      }

      const user = await prisma.user.create({
        data: userData,
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          createdAt: true,
        },
      });

      return user;
    } catch (error: any) {
      if (error instanceof AppError) {
        throw error;
      }
      console.error("[ADMIN USER] Create error:", error);
      throw new AppError(`Failed to create user: ${error.message}`, 500);
    }
  }

  /**
   * List all users with patient count (with pagination)
   * @param search Search query (name, phone, or email)
   * @param page Page number (default: 1)
   * @param limit Number of items per page (default: 20)
   * @returns List of users with patient count, total, page, and limit
   */
  async listUsers(
    search?: string,
    page?: number,
    limit?: number
  ): Promise<{
    users: Array<{
      id: string;
      name: string;
      phone: string | null;
      email: string | null;
      createdAt: Date;
      patientCount: number;
    }>;
    total: number;
    page: number;
    limit: number;
  }> {
    try {
      const where: any = {
        isArchived: false,
      };

      // Add search filter if provided
      if (search && search.trim()) {
        const searchTerm = search.trim();
        where.OR = [
          { name: { contains: searchTerm, mode: "insensitive" } },
          { phone: { contains: searchTerm, mode: "insensitive" } },
          { email: { contains: searchTerm, mode: "insensitive" } },
        ];
      }

      // Pagination
      const pageNum = Math.max(1, page || 1);
      const lim = Math.min(200, Math.max(1, limit || 20));
      const skip = (pageNum - 1) * lim;

      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where,
          skip,
          take: lim,
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            createdAt: true,
            _count: {
              select: {
                patients: {
                  where: {
                    isArchived: false,
                  },
                },
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
        }),
        prisma.user.count({ where }),
      ]);

      // Transform to include patient count
      return {
        users: users.map((user) => ({
          id: user.id,
          name: user.name,
          phone: user.phone,
          email: user.email,
          createdAt: user.createdAt,
          patientCount: user._count.patients,
        })),
        total,
        page: pageNum,
        limit: lim,
      };
    } catch (error: any) {
      console.error("[ADMIN USER] List error:", error);
      throw new AppError(`Failed to list users: ${error.message}`, 500);
    }
  }

  /**
   * Get user by ID with patient count
   * @param userId User ID
   * @returns User with patient count
   */
  async getUserById(userId: string): Promise<{
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    createdAt: Date;
    patientCount: number;
  }> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          createdAt: true,
          _count: {
            select: {
              patients: {
                where: {
                  isArchived: false,
                },
              },
            },
          },
        },
      });

      if (!user) {
        throw new AppError("User not found", 404);
      }

      return {
        id: user.id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        createdAt: user.createdAt,
        patientCount: user._count.patients,
      };
    } catch (error: any) {
      if (error instanceof AppError) {
        throw error;
      }
      console.error("[ADMIN USER] Get user error:", error);
      throw new AppError(`Failed to get user: ${error.message}`, 500);
    }
  }

  /**
   * Soft delete a user (admin operation)
   * Sets isArchived to true and archivedAt to current timestamp
   * @param userId User ID to delete
   * @returns Deleted user
   */
  async deleteUser(userId: string): Promise<{
    id: string;
    name: string;
    isArchived: boolean;
    archivedAt: Date | null;
  }> {
    try {
      // Check if user exists and is not already archived
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          isArchived: true,
          role: true,
        },
      });

      if (!user) {
        throw new AppError("User not found", 404);
      }

      // Prevent deleting already archived users
      if (user.isArchived) {
        throw new AppError("User is already deleted", 400);
      }

      // Soft delete: Set isArchived to true and archivedAt to current timestamp
      const deletedUser = await prisma.user.update({
        where: { id: userId },
        data: {
          isArchived: true,
          archivedAt: new Date(),
        },
        select: {
          id: true,
          name: true,
          isArchived: true,
          archivedAt: true,
        },
      });

      return deletedUser;
    } catch (error: any) {
      if (error instanceof AppError) {
        throw error;
      }
      console.error("[ADMIN USER] Delete error:", error);
      throw new AppError(`Failed to delete user: ${error.message}`, 500);
    }
  }
}

export const adminUserService = new AdminUserService();
