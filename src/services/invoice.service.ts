import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import prisma from "../database/prismaclient";
import { uploadPDFToCloudinary } from "../util/cloudinary";
import { formatInTimeZone } from "date-fns-tz";

const BUSINESS_TIMEZONE = "Asia/Kolkata";

// Invoice directory - relative to project root (temporary storage before Cloudinary upload)
const INVOICE_DIR = path.join(process.cwd(), "invoices");

// Ensure invoice directory exists
if (!fs.existsSync(INVOICE_DIR)) {
  fs.mkdirSync(INVOICE_DIR, { recursive: true });
}

/**
 * Generate sequential invoice number
 * Format: INV-0001, INV-0002, etc.
 */
async function generateInvoiceNumber(): Promise<string> {
  try {
    // Get the latest invoice number
    const latestInvoice = await prisma.invoice.findFirst({
      orderBy: { invoiceNumber: "desc" },
      select: { invoiceNumber: true },
    });

    if (!latestInvoice) {
      // First invoice
      return "INV-0001";
    }

    // Extract number from format INV-XXXX
    const match = latestInvoice.invoiceNumber.match(/INV-(\d+)/);
    if (!match) {
      // Fallback if format is unexpected
      return `INV-${Date.now()}`;
    }

    const lastNumber = parseInt(match[1], 10);
    const nextNumber = lastNumber + 1;
    return `INV-${nextNumber.toString().padStart(4, "0")}`;
  } catch (error: any) {
    console.error("[INVOICE] Error generating invoice number:", error);
    // Fallback to timestamp-based number
    return `INV-${Date.now()}`;
  }
}

/**
 * Format currency (Indian Rupees)
 */
function formatCurrency(amount: number): string {
  return `₹${amount.toLocaleString("en-IN")}`;
}

/**
 * Format date for display in IST timezone.
 * Uses formatInTimeZone to ensure consistent formatting regardless of server timezone.
 */
function formatDate(date: Date): string {
  return formatInTimeZone(date, BUSINESS_TIMEZONE, "d MMMM yyyy");
}

/**
 * Format time for display in IST timezone.
 * Uses formatInTimeZone to ensure consistent formatting regardless of server timezone.
 */
function formatTime(date: Date): string {
  return formatInTimeZone(date, BUSINESS_TIMEZONE, "h:mm a");
}

/**
 * Format time range for display
 */
function formatTimeRange(startDate: Date, endDate: Date): string {
  const startTime = formatTime(startDate);
  const endTime = formatTime(endDate);
  return `${startTime} - ${endTime}`;
}

/**
 * Generate PDF invoice
 */
async function generateInvoicePDF(invoiceData: {
  invoiceNumber: string;
  invoiceDate: Date;
  appointment: any;
  patient: any;
  paymentId?: string | null;
  orderId?: string | null;
  amount: number;
}): Promise<string> {
  const {
    invoiceNumber,
    invoiceDate,
    appointment,
    patient,
    paymentId,
    orderId,
    amount,
  } = invoiceData;

  // Generate file path
  const fileName = `${invoiceNumber}.pdf`;
  const filePath = path.join(INVOICE_DIR, fileName);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: "A4" });

      // Create write stream
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      // Header Section
      // Center: INVOICE heading
      doc
        .fontSize(28)
        .font("Helvetica-Bold")
        .text("INVOICE", 50, 50, { align: "center" });

      // Clinic details below heading
      doc
        .fontSize(10)
        .font("Helvetica")
        .text("Anubha Nutrition Clinic", 50, 90, { align: "center" })
        .text("Office no. 1, Upper Ground Floor,", 50, 105, { align: "center" })
        .text("Kanaksai CHS Ltd., S.No.56,", 50, 120, { align: "center" })
        .text("Jagdamba Bhavan Marg, Undri,", 50, 135, { align: "center" })
        .text("Pune (411060), India", 50, 150, { align: "center" })
        .text("📞 +91 9713885582", 50, 165, { align: "center" })
        .text("📧 anubhasnutritionclinic@gmail.com", 50, 180, {
          align: "center",
        });

      let yPosition = 220;

      // Invoice Metadata Section
      doc
        .fontSize(12)
        .font("Helvetica-Bold")
        .text("Invoice Number:", 50, yPosition)
        .font("Helvetica")
        .text(invoiceNumber, 200, yPosition);

      yPosition += 20;
      doc
        .font("Helvetica-Bold")
        .text("Invoice Date:", 50, yPosition)
        .font("Helvetica")
        .text(formatDate(invoiceDate), 200, yPosition);

      yPosition += 40;

      // Bill To Section
      doc.fontSize(14).font("Helvetica-Bold").text("Bill To:", 50, yPosition);

      yPosition += 20;
      doc
        .fontSize(11)
        .font("Helvetica")
        .text(patient.name || "N/A", 50, yPosition);

      yPosition += 15;
      doc.text(patient.phone || "N/A", 50, yPosition);

      yPosition += 15;
      if (patient.email) {
        doc.text(patient.email, 50, yPosition);
        yPosition += 15;
      }
      if (patient.address) {
        doc.text(patient.address, 50, yPosition);
        yPosition += 15;
      }

      yPosition += 20;

      // Order Details Section
      doc
        .fontSize(14)
        .font("Helvetica-Bold")
        .text("Order Details:", 50, yPosition);

      yPosition += 25;

      // Table header
      doc
        .fontSize(10)
        .font("Helvetica-Bold")
        .text("Plan Name", 50, yPosition)
        .text("Package", 350, yPosition)
        .text("Amount", 450, yPosition);

      yPosition += 20;
      doc.moveTo(50, yPosition).lineTo(550, yPosition).stroke();

      yPosition += 15;

      // Table row
      doc
        .fontSize(10)
        .font("Helvetica")
        .text(appointment.planName || "N/A", 50, yPosition, { width: 280 })
        .text(appointment.planPackageName || "N/A", 350, yPosition, {
          width: 90,
        })
        .text(formatCurrency(amount), 450, yPosition, { width: 100 });

      yPosition += 30;

      // Payment Details
      doc
        .fontSize(11)
        .font("Helvetica-Bold")
        .text("Payment Information:", 50, yPosition);

      yPosition += 20;
      doc
        .fontSize(10)
        .font("Helvetica")
        .text(`Order ID (Razorpay): ${orderId || "N/A"}`, 50, yPosition);

      yPosition += 15;
      doc.text(`Payment ID (Razorpay): ${paymentId || "N/A"}`, 50, yPosition);

      yPosition += 15;
      doc.text(`Payment Mode: Online`, 50, yPosition);

      yPosition += 15;
      doc.font("Helvetica-Bold").text(`Payment Status: PAID`, 50, yPosition);

      yPosition += 40;

      // Summary Section
      doc.fontSize(14).font("Helvetica-Bold").text("Summary:", 400, yPosition);

      yPosition += 25;
      doc
        .fontSize(11)
        .font("Helvetica")
        .text("Subtotal:", 400, yPosition)
        .text(formatCurrency(amount), 500, yPosition, { align: "right" });

      yPosition += 20;
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .text("Total:", 400, yPosition)
        .text(formatCurrency(amount), 500, yPosition, { align: "right" });

      yPosition += 40;

      // Comments Section
      doc.fontSize(12).font("Helvetica-Bold").text("Comments:", 50, yPosition);

      yPosition += 20;
      doc
        .fontSize(10)
        .font("Helvetica")
        .text(
          `Booking Date: ${formatDate(new Date(appointment.createdAt))}`,
          50,
          yPosition
        );

      yPosition += 15;
      doc.text(
        `Booking Time: ${formatTime(new Date(appointment.createdAt))}`,
        50,
        yPosition
      );

      yPosition += 15;
      const slotStartTime = appointment.slot?.startAt || appointment.startAt;
      const slotEndTime = appointment.slot?.endAt || appointment.endAt;
      if (slotStartTime && slotEndTime) {
        doc.text(
          `Slot Time: ${formatTimeRange(
            new Date(slotStartTime),
            new Date(slotEndTime)
          )}`,
          50,
          yPosition
        );
      } else if (slotStartTime) {
        doc.text(
          `Slot Time: ${formatTime(new Date(slotStartTime))}`,
          50,
          yPosition
        );
      }

      // Footer
      const pageHeight = doc.page.height;
      doc
        .fontSize(9)
        .font("Helvetica-Oblique")
        .text("This is a system-generated invoice.", 50, pageHeight - 50, {
          align: "center",
        });

      // Finalize PDF
      doc.end();

      stream.on("finish", () => {
        // console.log(`[INVOICE] PDF generated successfully: ${filePath}`);
        resolve(filePath);
      });

      stream.on("error", (error) => {
        console.error("[INVOICE] Error writing PDF file:", error);
        reject(error);
      });
    } catch (error: any) {
      console.error("[INVOICE] Error generating PDF:", error);
      reject(error);
    }
  });
}

/**
 * Generate invoice for an appointment
 * Only generates if appointment is confirmed and invoice doesn't exist
 */
export async function generateInvoiceForAppointment(
  appointmentId: string
): Promise<{ success: boolean; invoice?: any; error?: string }> {
  try {
    // Check if invoice already exists
    const existingInvoice = await prisma.invoice.findUnique({
      where: { appointmentId },
    });

    if (existingInvoice) {
      // console.log(
      // `[INVOICE] Invoice already exists for appointment ${appointmentId}: ${existingInvoice.invoiceNumber}`
      // );
      return {
        success: true,
        invoice: existingInvoice,
      };
    }

    // Fetch appointment with related data
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        patient: true,
        slot: true,
      },
    });

    if (!appointment) {
      return {
        success: false,
        error: "Appointment not found",
      };
    }

    // Only generate invoice for confirmed appointments
    if (appointment.status !== "CONFIRMED") {
      return {
        success: false,
        error: `Cannot generate invoice for appointment with status: ${appointment.status}. Invoice can only be generated for CONFIRMED appointments.`,
      };
    }

    // Check payment status (accept both SUCCESS and PAID)
    if (
      appointment.paymentStatus !== "SUCCESS" &&
      appointment.paymentStatus !== "PAID"
    ) {
      return {
        success: false,
        error: `Cannot generate invoice for appointment with payment status: ${appointment.paymentStatus}. Payment must be successful.`,
      };
    }

    // Generate invoice number
    const invoiceNumber = await generateInvoiceNumber();

    // Get payment details
    const paymentId = appointment.notes; // Razorpay Payment ID stored in notes
    const orderId = appointment.paymentId; // Razorpay Order ID stored in paymentId field
    const amount = appointment.amount || appointment.planPrice || 0;

    // Generate PDF (temporarily stored locally)
    const pdfPath = await generateInvoicePDF({
      invoiceNumber,
      invoiceDate: new Date(),
      appointment,
      patient: appointment.patient,
      paymentId,
      orderId,
      amount,
    });

    // Upload PDF to Cloudinary
    let pdfUrl: string;
    try {
      // console.log(
      // `[INVOICE] Uploading invoice to Cloudinary: ${invoiceNumber}`
      // );
      const cloudinaryResult = await uploadPDFToCloudinary(pdfPath, {
        folder: "nutriwell_invoices",
        publicId: invoiceNumber,
        context: {
          uploaded_at: new Date().toISOString(),
          appointment_id: appointment.id,
          invoice_number: invoiceNumber,
        },
      });

      pdfUrl = cloudinaryResult.secure_url;
      // console.log(`[INVOICE] ✅ Invoice uploaded to Cloudinary: ${pdfUrl}`);
      // Delete local file after successful upload to save disk space
      try {
        fs.unlinkSync(pdfPath);
        // console.log(`[INVOICE] 🗑️ Local invoice file deleted: ${pdfPath}`);
      } catch (deleteError) {
        // Non-critical error - log but don't fail
        // console.warn(
        // `[INVOICE] ⚠️ Failed to delete local file: ${deleteError}`
        // );
      }
    } catch (cloudinaryError: any) {
      console.error("[INVOICE] ❌ Cloudinary upload failed:", cloudinaryError);
      // Keep local file as fallback
      pdfUrl = `file://${pdfPath}`; // Fallback URL (indicates local storage)
      // console.warn(`[INVOICE] ⚠️ Using local file as fallback: ${pdfPath}`);
    }

    // Save invoice to database with Cloudinary URL
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber,
        appointmentId: appointment.id,
        paymentId: paymentId || null,
        orderId: orderId || null,
        invoiceDate: new Date(),
        pdfPath, // Keep path for reference (even if file is deleted)
        pdfUrl, // Cloudinary URL for downloads
      },
    });

    // console.log(
    // `[INVOICE] ✅ Invoice generated successfully: ${invoiceNumber} for appointment ${appointmentId}`
    // );
    return {
      success: true,
      invoice,
    };
  } catch (error: any) {
    console.error("[INVOICE] Error generating invoice:", error);
    return {
      success: false,
      error: error.message || "Failed to generate invoice",
    };
  }
}

/**
 * Get invoice by invoice number
 */
export async function getInvoiceByNumber(
  invoiceNumber: string
): Promise<{ success: boolean; invoice?: any; error?: string }> {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { invoiceNumber },
      include: {
        appointment: {
          include: {
            patient: true,
            user: true,
          },
        },
      },
    });

    if (!invoice) {
      return {
        success: false,
        error: "Invoice not found",
      };
    }

    return {
      success: true,
      invoice,
    };
  } catch (error: any) {
    console.error("[INVOICE] Error fetching invoice:", error);
    return {
      success: false,
      error: error.message || "Failed to fetch invoice",
    };
  }
}

/**
 * Get invoice by appointment ID
 */
export async function getInvoiceByAppointmentId(
  appointmentId: string
): Promise<{ success: boolean; invoice?: any; error?: string }> {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { appointmentId },
      include: {
        appointment: {
          include: {
            patient: true,
            user: true,
          },
        },
      },
    });

    if (!invoice) {
      return {
        success: false,
        error: "Invoice not found",
      };
    }

    return {
      success: true,
      invoice,
    };
  } catch (error: any) {
    console.error("[INVOICE] Error fetching invoice:", error);
    return {
      success: false,
      error: error.message || "Failed to fetch invoice",
    };
  }
}
