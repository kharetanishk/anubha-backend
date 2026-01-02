import { Request, Response } from "express";
import { patientService } from "./patient.service";

export class PatientController {
  async create(req: Request, res: Response) {
    try {
      // console.log(" [BACKEND] Patient creation request received");
// console.log(
// " [BACKEND] User:",
// req.user
// ? { id: req.user.id, role: req.user.role }
// : "NOT AUTHENTICATED"
// );
// console.log(" [BACKEND] Request body keys:", Object.keys(req.body)
// );
      // console.log(" [BACKEND] Request body (sanitized)
      // :", {
      // ...req.body,
      // phone: req.body.phone
      // ? req.body.phone.substring(0, 3) + "****"
      // : undefined,
      // });

      if (!req.user) {
        console.error(
          " [BACKEND] Patient creation failed: User not authenticated"
        );
        return res
          .status(401)
          .json({ success: false, message: "Unauthorized. Please login." });
      }

      // console.log(" [BACKEND] Calling patientService.createPatient...");
      const patient = await patientService.createPatient(req.user.id, req.body);
      // console.log(" [BACKEND] Patient created successfully:", {
      //   id: patient.id,
      //   name: patient.name,
      // });
      return res.status(201).json({
        success: true,
        message: "Patient form submitted successfully.",
        patient,
      });
    } catch (err: any) {
      // console.error(" [BACKEND] CREATE PATIENT ERROR:", err);
      console.error(" [BACKEND] Error details:", {
        name: err.name,
        message: err.message,
        code: err.code,
        errors: err.errors,
      });

      // Handle validation errors (from Zod)
      if (err.name === "ZodError" || err.errors) {
        const errors = err.errors || err.issues || [];
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
      if (err.code === "P2002") {
        return res.status(400).json({
          success: false,
          message: "A patient with this phone number or email already exists.",
        });
      }

      // Handle foreign key constraint errors (user doesn't exist)
      if (err.code === "P2003") {
        console.error(
          " [BACKEND] Foreign key constraint error - User not found in database:",
          req.user?.id
        );
        return res.status(401).json({
          success: false,
          message: "Your account is not valid. Please logout and login again.",
        });
      }

      // Generic error
      return res.status(500).json({
        success: false,
        message: err.message || "Failed to create patient",
      });
    }
  }

  async listMine(req: Request, res: Response) {
    try {
      if (!req.user) {
        return res
          .status(401)
          .json({ success: false, message: "Unauthorized" });
      }

      const patients = await patientService.getMyPatients(req.user.id);

      return res.json({
        success: true,
        patients,
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch patients",
      });
    }
  }

  async getMineById(req: Request, res: Response) {
    try {
      if (!req.user) {
        return res
          .status(401)
          .json({ success: false, message: "Unauthorized" });
      }

      const { id } = req.params;
      const patient = await patientService.getByIdForUser(id, req.user.id);

      if (!patient) {
        return res.status(404).json({
          success: false,
          message: "Patient not found",
        });
      }

      return res.json({ success: true, patient });
    } catch {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch patient",
      });
    }
  }

  async adminListAll(req: Request, res: Response) {
    try {
      const patients = await patientService.adminListAllPatients();
      return res.json({ success: true, patients });
    } catch {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch patients",
      });
    }
  }

  async adminGetById(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const patient = await patientService.getByIdForAdmin(id);

      if (!patient) {
        return res.status(404).json({
          success: false,
          message: "Patient not found",
        });
      }

      return res.json({ success: true, patient });
    } catch {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch patient",
      });
    }
  }

  async linkFiles(req: Request, res: Response) {
    try {
      if (!req.user) {
        return res
          .status(401)
          .json({ success: false, message: "Unauthorized" });
      }

      const { id } = req.params;
      const { fileIds } = req.body;

      if (!Array.isArray(fileIds)) {
        return res.status(400).json({
          success: false,
          message: "fileIds must be an array",
        });
      }

      const result = await patientService.linkFilesToPatient(
        id,
        fileIds,
        req.user.id
      );

      return res.json(result);
    } catch (err: any) {
      console.error("LINK FILES ERROR:", err);
      return res.status(400).json({
        success: false,
        message: err.message || "Failed to link files",
      });
    }
  }

  async deleteFile(req: Request, res: Response) {
    try {
      if (!req.user) {
        return res
          .status(401)
          .json({ success: false, message: "Unauthorized" });
      }

      const { fileId } = req.params;

      const result = await patientService.deleteFile(fileId, req.user);

      return res.status(result.code).json(result);
    } catch (err) {
      console.error("DELETE FILE ERROR:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to delete file",
      });
    }
  }

  // ADMIN: update patient
  async adminUpdate(req: Request, res: Response) {
    try {
      const { id } = req.params;

      const updated = await patientService.adminUpdatePatient(id, req.body);

      return res.json({
        success: true,
        message: "Patient updated successfully.",
        patient: updated,
      });
    } catch (err) {
      console.error("ADMIN UPDATE PATIENT ERROR:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to update patient",
      });
    }
  }
}

export const patientController = new PatientController();
