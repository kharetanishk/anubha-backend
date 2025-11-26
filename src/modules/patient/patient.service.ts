import prisma from "../../database/prismaclient";
import { CreatePatientInput } from "./patient.validators";
import { deleteFromCloudinary } from "../../util/cloudinary";

export class PatientService {
  async createPatient(
    userId: string,
    data: CreatePatientInput & { fileIds?: string[] }
  ) {
    const { fileIds = [], ...rest } = data;

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

  async getMyPatients(userId: string) {
    return prisma.patientDetials.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        phone: true,
        gender: true,
        createdAt: true,
      },
    });
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
    return patient;
  }

  async adminListAllPatients() {
    return prisma.patientDetials.findMany({
      orderBy: { createdAt: "desc" },
      include: { user: true },
    });
  }

  async getByIdForAdmin(patientId: string) {
    return prisma.patientDetials.findUnique({
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
