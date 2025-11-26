import { Request, Response } from "express";
import { patientService } from "./patient.service";

export class PatientController {
  async create(req: Request, res: Response) {
    try {
      if (!req.user) {
        return res
          .status(401)
          .json({ success: false, message: "Unauthorized" });
      }

      const patient = await patientService.createPatient(req.user.id, req.body);

      return res.status(201).json({
        success: true,
        message: "Patient form submitted successfully.",
        patient,
      });
    } catch (err: any) {
      console.error("CREATE PATIENT ERROR:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to create patient",
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
