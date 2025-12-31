import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import {
  getInvoiceByNumber,
  getInvoiceByAppointmentId,
  generateInvoiceForAppointment,
} from "../../services/invoice.service";
import prisma from "../../database/prismaclient";

/**
 * Download invoice PDF by invoice number
 * Validates user ownership before allowing download
 * Returns Cloudinary URL for frontend to handle download/preview
 */
export async function downloadInvoiceHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "Unauthenticated. Please login again.",
      });
    }

    const { invoiceNumber } = req.params;

    if (!invoiceNumber) {
      return res.status(400).json({
        success: false,
        error: "Invoice number is required",
      });
    }

    // Fetch invoice with appointment and user details
    const result = await getInvoiceByNumber(invoiceNumber);

    if (!result.success || !result.invoice) {
      return res.status(404).json({
        success: false,
        error: result.error || "Invoice not found",
      });
    }

    const invoice = result.invoice;

    // SECURITY: Verify user owns this invoice
    // Check if the appointment belongs to the user
    if (invoice.appointment.userId !== userId) {
      // console.warn(
      // `[INVOICE] Unauthorized access attempt: User ${userId} tried to access invoice ${invoiceNumber}`
      // );
return res.status(403).json({
        success: false,
        error:
          "Unauthorized. You don't have permission to access this invoice.",
      });
    }

    // Return Cloudinary URL (preferred) or fallback to local file
    if (invoice.pdfUrl && !invoice.pdfUrl.startsWith("file://")) {
      // Cloudinary URL exists - return it for frontend to handle
      // console.log(
      // `[INVOICE] Returning Cloudinary URL for invoice ${invoiceNumber}`
      // );
return res.json({
        success: true,
        url: invoice.pdfUrl,
        invoiceNumber: invoice.invoiceNumber,
      });
    }

    // FALLBACK: Stream local file if Cloudinary upload failed
    const pdfPath = invoice.pdfPath;
    if (!fs.existsSync(pdfPath)) {
      console.error(`[INVOICE] PDF file not found at path: ${pdfPath}`);
      return res.status(404).json({
        success: false,
        error: "Invoice PDF file not found",
      });
    }

    // console.log(
    // `[INVOICE] Streaming local file for invoice ${invoiceNumber} (Cloudinary fallback)
    // `
    // );

    // Set headers for PDF download
    const fileName = `${invoice.invoiceNumber}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    // Stream PDF file to response
    const fileStream = fs.createReadStream(pdfPath);
    fileStream.pipe(res);

    fileStream.on("error", (error) => {
      console.error("[INVOICE] Error streaming PDF file:", error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: "Error reading invoice file",
        });
      }
    });
  } catch (error: any) {
    console.error("[INVOICE] Error in downloadInvoiceHandler:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to download invoice",
    });
  }
}

/**
 * Get invoice by appointment ID
 * Returns invoice metadata (not PDF file)
 */
export async function getInvoiceByAppointmentHandler(
  req: Request,
  res: Response
) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "Unauthenticated. Please login again.",
      });
    }

    const { appointmentId } = req.params;

    if (!appointmentId) {
      return res.status(400).json({
        success: false,
        error: "Appointment ID is required",
      });
    }

    // First verify user owns the appointment
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { userId: true },
    });

    if (!appointment) {
      return res.status(404).json({
        success: false,
        error: "Appointment not found",
      });
    }

    if (appointment.userId !== userId) {
      return res.status(403).json({
        success: false,
        error:
          "Unauthorized. You don't have permission to access this invoice.",
      });
    }

    // Fetch invoice
    const result = await getInvoiceByAppointmentId(appointmentId);

    if (!result.success) {
      return res.status(404).json({
        success: false,
        error: result.error || "Invoice not found for this appointment",
      });
    }

    return res.json({
      success: true,
      invoice: {
        id: result.invoice?.id,
        invoiceNumber: result.invoice?.invoiceNumber,
        invoiceDate: result.invoice?.invoiceDate,
        appointmentId: result.invoice?.appointmentId,
        pdfUrl: result.invoice?.pdfUrl, // Include Cloudinary URL
        createdAt: result.invoice?.createdAt,
      },
    });
  } catch (error: any) {
    console.error("[INVOICE] Error in getInvoiceByAppointmentHandler:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch invoice",
    });
  }
}

/**
 * Generate invoice for an appointment
 * User-triggered invoice generation
 */
export async function generateInvoiceHandler(req: Request, res: Response) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "Unauthenticated. Please login again.",
      });
    }

    const { appointmentId } = req.params;

    if (!appointmentId) {
      return res.status(400).json({
        success: false,
        error: "Appointment ID is required",
      });
    }

    // First verify user owns the appointment
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { userId: true, status: true, paymentStatus: true },
    });

    if (!appointment) {
      return res.status(404).json({
        success: false,
        error: "Appointment not found",
      });
    }

    if (appointment.userId !== userId) {
      return res.status(403).json({
        success: false,
        error:
          "Unauthorized. You don't have permission to generate invoice for this appointment.",
      });
    }

    // Check if appointment is confirmed
    if (appointment.status !== "CONFIRMED") {
      return res.status(400).json({
        success: false,
        error: `Cannot generate invoice for appointment with status: ${appointment.status}. Invoice can only be generated for CONFIRMED appointments.`,
      });
    }

    // Check payment status
    if (
      appointment.paymentStatus !== "SUCCESS" &&
      appointment.paymentStatus !== "PAID"
    ) {
      return res.status(400).json({
        success: false,
        error: `Cannot generate invoice for appointment with payment status: ${appointment.paymentStatus}. Payment must be successful.`,
      });
    }

    // Generate invoice
    const result = await generateInvoiceForAppointment(appointmentId);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error || "Failed to generate invoice",
      });
    }

    return res.json({
      success: true,
      message: "Invoice generated successfully",
      invoice: {
        id: result.invoice?.id,
        invoiceNumber: result.invoice?.invoiceNumber,
        invoiceDate: result.invoice?.invoiceDate,
        appointmentId: result.invoice?.appointmentId,
        pdfUrl: result.invoice?.pdfUrl,
        createdAt: result.invoice?.createdAt,
      },
    });
  } catch (error: any) {
    console.error("[INVOICE] Error in generateInvoiceHandler:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to generate invoice",
    });
  }
}
