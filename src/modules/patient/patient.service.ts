import prisma from "../../database/prismaclient";
import { CreatePatientInput } from "./patient.validators";
import { deleteFromCloudinary } from "../../util/cloudinary";
import { regenerateFileSignedUrls } from "../../utils/fileUrlHelper";

export class PatientService {
  async createPatient(
    userId: string,
    data: CreatePatientInput & { fileIds?: string[] }
  ) {
    const { fileIds = [], ...rest } = data;

    // Verify user exists in database before creating patient
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new Error("User not found. Please login again or contact support.");
    }

    const exists = await prisma.patientDetials.findFirst({
      where: {
        userId,
        name: rest.name,
      },
    });

    if (exists) {
      throw new Error("A patient with this name already exists.");
    }

    const patient = await prisma.patientDetials.create({
      data: {
        userId,
        ...rest,
        dateOfBirth: new Date(rest.dateOfBirth),
      },
    });

    if (fileIds.length > 0) {
      await prisma.file.updateMany({
        where: { id: { in: fileIds } },
        data: { patientId: patient.id },
      });
    }

    return patient;
  }

  async getMyPatients(
    userId: string,
    page?: number,
    limit?: number
  ): Promise<{
    patients: Array<{
      id: string;
      name: string;
      phone: string;
      gender: string;
      createdAt: Date;
    }>;
    total: number;
    page: number;
    limit: number;
  }> {
    const where: any = {
      userId,
      isArchived: false,
    };

    // Pagination
    const pageNum = Math.max(1, page || 1);
    const lim = Math.min(200, Math.max(1, limit || 10));
    const skip = (pageNum - 1) * lim;

    const [patients, total] = await Promise.all([
      prisma.patientDetials.findMany({
        where,
        skip,
        take: lim,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          phone: true,
          gender: true,
          createdAt: true,
        },
      }),
      prisma.patientDetials.count({ where }),
    ]);

    return {
      patients,
      total,
      page: pageNum,
      limit: lim,
    };
  }

  async getByIdForUser(patientId: string, userId: string) {
    const patient = await prisma.patientDetials.findUnique({
      where: { id: patientId },
      include: {
        files: true,
        recalls: {
          include: { entries: true },
        },
      },
    });

    if (!patient || patient.userId !== userId) return null;

    // Regenerate signed URLs for files to ensure they're valid
    if (patient.files && patient.files.length > 0) {
      patient.files = regenerateFileSignedUrls(
        patient.files as any
      ) as typeof patient.files;
    }

    return patient;
  }

  async adminListAllPatients(
    page?: number,
    limit?: number,
    search?: string
  ): Promise<{
    patients: Array<any>;
    total: number;
    page: number;
    limit: number;
  }> {
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

    const [patients, total] = await Promise.all([
      prisma.patientDetials.findMany({
        where,
        skip,
        take: lim,
        orderBy: { createdAt: "desc" },
        include: { user: true },
      }),
      prisma.patientDetials.count({ where }),
    ]);

    return {
      patients,
      total,
      page: pageNum,
      limit: lim,
    };
  }

  async getByIdForAdmin(patientId: string) {
    const patient = await prisma.patientDetials.findUnique({
      where: { id: patientId },
      include: {
        user: true,
        appointments: true,
        files: true,
        recalls: {
          include: { entries: true },
        },
      },
    });

    // Regenerate signed URLs for files to ensure they're valid
    if (patient && patient.files && patient.files.length > 0) {
      patient.files = regenerateFileSignedUrls(
        patient.files as any
      ) as typeof patient.files;
    }

    return patient;
  }

  async adminUpdatePatient(
    patientId: string,
    data: Partial<CreatePatientInput>
  ) {
    const updateData: any = { ...data };

    if (updateData.dateOfBirth) {
      updateData.dateOfBirth = new Date(updateData.dateOfBirth);
    }

    const updated = await prisma.patientDetials.update({
      where: { id: patientId },
      data: updateData,
    });

    return updated;
  }

  async linkFilesToPatient(
    patientId: string,
    fileIds: string[],
    userId: string,
    appointmentId?: string
  ) {
    // Verify patient belongs to user
    const patient = await prisma.patientDetials.findFirst({
      where: { id: patientId, userId },
    });

    if (!patient) {
      throw new Error("Patient not found or unauthorized");
    }

    // If appointmentId is provided, verify it belongs to the patient and user
    if (appointmentId) {
      const appointment = await prisma.appointment.findFirst({
        where: {
          id: appointmentId,
          patientId,
          userId,
          isArchived: false,
        },
      });

      if (!appointment) {
        throw new Error(
          "Appointment not found or does not belong to this patient"
        );
      }
    }

    // Link files to patient and optionally to appointment
    // CRITICAL: Files must be scoped to appointments to prevent sharing across appointments
    if (fileIds.length > 0) {
      // NOTE: Prisma client types may not yet include `File.appointmentId` until prisma generate is run.
      // We intentionally cast here so `tsc` remains green in environments that run `tsc` without `prisma generate`.
      await (prisma as any).file.updateMany({
        where: { id: { in: fileIds } },
        data: {
          patientId,
          ...(appointmentId && { appointmentId }), // Link to appointment if provided
        },
      });
    }

    return { success: true, message: "Files linked successfully" };
  }

  async deleteFile(fileId: string, requester: { id: string; role: string }) {
    const file = await prisma.file.findUnique({
      where: { id: fileId },
      include: { patient: true },
    });

    if (!file) {
      return { success: false, code: 404, message: "File not found" };
    }

    const patient = file.patient;

    if (!patient) {
      await prisma.file.delete({ where: { id: fileId } });
      if (file.publicId) await deleteFromCloudinary(file.publicId);

      return {
        success: true,
        code: 200,
        message: "Temporary file deleted",
      };
    }

    const isOwner = patient.userId === requester.id;
    const isAdmin = requester.role === "ADMIN";

    if (!isOwner && !isAdmin) {
      return {
        success: false,
        code: 403,
        message: "Not allowed to delete this file",
      };
    }

    // Delete from cloudinary
    if (file.publicId) await deleteFromCloudinary(file.publicId);

    await prisma.file.delete({ where: { id: fileId } });

    return {
      success: true,
      code: 200,
      message: "File deleted successfully",
    };
  }
}

export const patientService = new PatientService();
