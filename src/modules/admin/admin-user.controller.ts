import { Request, Response } from "express";
import { adminUserService } from "./admin-user.service";
import { patientService } from "../patient/patient.service";
import { AppError } from "../../util/AppError";
import prisma from "../../database/prismaclient";
import { normalizePhoneNumber } from "../../utils/phoneNormalizer";

/**
 * Admin User Controller
 * Handles HTTP requests for admin user management operations
 */

/**
 * Create a new user (admin creates on behalf of patient)
 * POST /api/admin/users
 */
export async function createUser(req: Request, res: Response) {
  try {
    // Extract and sanitize input - explicitly prevent using admin's credentials
    const { name, phone, email, password } = req.body;

    // SECURITY: Explicitly ensure we NEVER use admin's credentials from req.user
    // Only use data from req.body, never from req.user

    // Validation - ensure we're using the provided values, not admin's
    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Name is required",
      });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters long",
      });
    }

    // Sanitize phone and email - trim and convert empty strings to null
    const sanitizedPhone =
      phone && typeof phone === "string" && phone.trim() ? phone.trim() : null;
    const sanitizedEmail =
      email && typeof email === "string" && email.trim() ? email.trim() : null;

    // At least one of phone or email is required
    if (!sanitizedPhone && !sanitizedEmail) {
      return res.status(400).json({
        success: false,
        message: "Either phone number or email is required",
      });
    }

    // SECURITY: Prevent admin from using their own credentials for new user
    if (req.user?.id) {
      const admin = await prisma.admin.findUnique({
        where: { id: req.user.id },
        select: { email: true, phone: true },
      });

      if (admin) {
        // Normalize email for comparison
        if (sanitizedEmail && admin.email) {
          const normalizedNewEmail =
            adminUserService.normalizeEmail(sanitizedEmail);
          const normalizedAdminEmail = adminUserService.normalizeEmail(
            admin.email
          );
          if (normalizedNewEmail === normalizedAdminEmail) {
            return res.status(400).json({
              success: false,
              message: "Cannot use admin email address for user account",
            });
          }
        }

        // Normalize phone for comparison
        if (sanitizedPhone && admin.phone) {
          try {
            const normalizedNewPhone = normalizePhoneNumber(sanitizedPhone);
            const normalizedAdminPhone = normalizePhoneNumber(admin.phone);
            if (normalizedNewPhone === normalizedAdminPhone) {
              return res.status(400).json({
                success: false,
                message: "Cannot use admin phone number for user account",
              });
            }
          } catch (error) {
            // Phone normalization error will be caught later in service
          }
        }
      }
    }

    // IMPORTANT: Never use admin's credentials - use only the provided values
    // Explicitly pass null if not provided to prevent any fallback to admin data
    const user = await adminUserService.createUser(
      name.trim(),
      sanitizedPhone, // null if not provided
      sanitizedEmail, // null if not provided
      password
    );

    return res.status(201).json({
      success: true,
      message: "User created successfully",
      user,
    });
  } catch (error: any) {
    console.error("[ADMIN USER] Create error:", error);
    const statusCode = error instanceof AppError ? error.statusCode : 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || "Failed to create user",
    });
  }
}

/**
 * List all users with search and pagination
 * GET /api/admin/users?search=...&page=1&limit=20
 */
export async function listUsers(req: Request, res: Response) {
  const startTime = Date.now(); // For performance monitoring
  try {
    const search = req.query.search as string | undefined;
    const page = req.query.page ? Number(req.query.page) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;

    const result = await adminUserService.listUsers(search, page, limit);

    const durationMs = Date.now() - startTime;

    // Log performance occasionally in development
    if (process.env.NODE_ENV === "development" && Math.random() < 0.1) {
      console.log(
        `[ADMIN USERS PERFORMANCE] Query took ${durationMs}ms. Total: ${result.total}, Page: ${result.page}, Limit: ${result.limit}, Search: ${search || "none"}`
      );
    }

    return res.status(200).json({
      success: true,
      users: result.users,
      total: result.total,
      page: result.page,
      limit: result.limit,
    });
  } catch (error: any) {
    console.error("[ADMIN USER] List error:", error);
    const statusCode = error instanceof AppError ? error.statusCode : 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || "Failed to list users",
    });
  }
}

/**
 * Get user by ID
 * GET /api/admin/users/:id
 */
export async function getUserById(req: Request, res: Response) {
  try {
    const { id } = req.params;

    const user = await adminUserService.getUserById(id);

    return res.status(200).json({
      success: true,
      user,
    });
  } catch (error: any) {
    console.error("[ADMIN USER] Get user error:", error);
    const statusCode = error instanceof AppError ? error.statusCode : 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || "Failed to get user",
    });
  }
}

/**
 * Delete a user (admin operation - soft delete)
 * DELETE /api/admin/users/:id
 */
export async function deleteUser(req: Request, res: Response) {
  try {
    const { id: userId } = req.params;

    const deletedUser = await adminUserService.deleteUser(userId);

    return res.status(200).json({
      success: true,
      message: "User deleted successfully",
      user: deletedUser,
    });
  } catch (error: any) {
    console.error("[ADMIN USER] Delete error:", error);
    const statusCode = error instanceof AppError ? error.statusCode : 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || "Failed to delete user",
    });
  }
}

/**
 * Get patients for a user (admin view)
 * GET /api/admin/users/:id/patients
 */
export async function getUserPatients(req: Request, res: Response) {
  try {
    const { id: userId } = req.params;

    // Verify user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Get patients for this user
    const patients = await prisma.patientDetials.findMany({
      where: {
        userId,
        isArchived: false,
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        gender: true,
        age: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return res.status(200).json({
      success: true,
      patients,
    });
  } catch (error: any) {
    console.error("[ADMIN USER] Get patients error:", error);
    const statusCode = error instanceof AppError ? error.statusCode : 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || "Failed to get patients",
    });
  }
}

/**
 * Create a patient for a specific user (admin operation)
 * POST /api/admin/users/:id/patients
 */
export async function createPatientForUser(req: Request, res: Response) {
  try {
    const { id: userId } = req.params;
    const patientData = req.body;

    // Verify user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Create patient for this user using the patient service
    const patient = await patientService.createPatient(userId, patientData);

    return res.status(201).json({
      success: true,
      message: "Patient created successfully",
      patient,
    });
  } catch (error: any) {
    console.error("[ADMIN USER] Create patient error:", error);

    // Handle validation errors
    if (error.name === "ZodError" || error.errors) {
      const errors = error.errors || error.issues || [];
      const errorMessages = errors.map((e: any) => {
        if (typeof e === "string") return e;
        const path = Array.isArray(e.path) ? e.path.join(".") : e.path;
        return `${path}: ${e.message || "Invalid value"}`;
      });

      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: errorMessages,
      });
    }

    // Handle Prisma errors
    if (error.code === "P2002") {
      return res.status(400).json({
        success: false,
        message: "A patient with this phone number or email already exists.",
      });
    }

    const statusCode = error instanceof AppError ? error.statusCode : 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || "Failed to create patient",
    });
  }
}
