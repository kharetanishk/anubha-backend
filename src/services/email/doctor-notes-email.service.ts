import { resend, getFromEmail } from "../../utils/resend";
import { downloadFile } from "../storage/r2.service";
import { AppError } from "../../util/AppError";

/**
 * Email Service for Doctor Notes
 *
 * Handles sending Doctor Notes PDFs via email using Resend.
 * Files are downloaded server-side from R2 and attached directly to emails.
 *
 * Security:
 * - No signed URLs or public URLs generated
 * - Files remain private in R2 at all times
 * - R2 keys never exposed to frontend
 */

const MAX_ATTACHMENT_SIZE_MB = 25; // Resend limit is 25MB per attachment
const MAX_TOTAL_ATTACHMENTS_MB = 50; // Reasonable limit for total email size

interface SendDoctorNotesEmailParams {
  toEmail: string;
  patientName: string;
  appointmentDate: Date;
  attachments: Array<{
    fileName: string;
    filePath: string; // R2 object key
    mimeType: string;
    sizeInBytes: number;
  }>;
  r2Bucket: string;
}

/**
 * Generate HTML email template for Doctor Notes
 */
function generateEmailTemplate(
  patientName: string,
  appointmentDate: Date
): string {
  const formattedDate = appointmentDate.toLocaleDateString("en-IN", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Doctor Notes</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px; font-weight: 600;">Anubha Nutrition Clinic</h1>
  </div>
  
  <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
    <h2 style="color: #10b981; margin-top: 0; font-size: 20px; font-weight: 600;">Your Doctor Notes</h2>
    
    <p style="color: #4b5563; font-size: 16px; margin: 20px 0;">
      Dear ${patientName},
    </p>
    
    <p style="color: #4b5563; font-size: 16px; margin: 20px 0;">
      Please find attached your doctor notes and related documents from your appointment on <strong>${formattedDate}</strong>.
    </p>
    
    <p style="color: #4b5563; font-size: 16px; margin: 20px 0;">
      These documents contain important information about your consultation, diet plan, and recommendations. Please keep them for your records.
    </p>
    
    <div style="background: #f0fdf4; border-left: 4px solid #10b981; padding: 15px; margin: 20px 0; border-radius: 4px;">
      <p style="color: #166534; font-size: 14px; margin: 0;">
        <strong>Note:</strong> These documents are confidential and intended only for you. Please do not share them without consulting your healthcare provider.
      </p>
    </div>
    
    <p style="color: #6b7280; font-size: 14px; margin: 30px 0 10px 0;">
      If you have any questions or concerns, please contact us.
    </p>
    
    <p style="color: #6b7280; font-size: 14px; margin: 10px 0;">
      Best regards,<br>
      <strong>Anubha Nutrition Clinic</strong>
    </p>
  </div>
  
  <div style="text-align: center; margin-top: 20px; color: #9ca3af; font-size: 12px;">
    <p style="margin: 5px 0;">This is an automated email. Please do not reply to this message.</p>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Send Doctor Notes PDFs via email
 *
 * Downloads files from R2 server-side and attaches them to the email.
 * Validates file sizes and handles errors gracefully.
 *
 * @param params - Email parameters including recipient, patient info, and attachments
 * @returns Success message
 *
 * @throws AppError if:
 * - Email validation fails
 * - File size limits exceeded
 * - R2 download fails
 * - Email sending fails
 */
export async function sendDoctorNotesEmail(
  params: SendDoctorNotesEmailParams
): Promise<{ success: true; message: string }> {
  const { toEmail, patientName, appointmentDate, attachments, r2Bucket } =
    params;

  // Validate email address
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(toEmail)) {
    throw new AppError("Invalid email address", 400);
  }

  // Validate attachments exist
  if (!attachments || attachments.length === 0) {
    throw new AppError("No attachments to send", 400);
  }

  // Validate file sizes
  let totalSizeMB = 0;
  for (const attachment of attachments) {
    const sizeMB = attachment.sizeInBytes / (1024 * 1024);
    if (sizeMB > MAX_ATTACHMENT_SIZE_MB) {
      throw new AppError(
        `File "${attachment.fileName}" exceeds maximum size of ${MAX_ATTACHMENT_SIZE_MB}MB`,
        400
      );
    }
    totalSizeMB += sizeMB;
  }

  if (totalSizeMB > MAX_TOTAL_ATTACHMENTS_MB) {
    throw new AppError(
      `Total attachment size (${totalSizeMB.toFixed(2)}MB) exceeds maximum of ${MAX_TOTAL_ATTACHMENTS_MB}MB`,
      400
    );
  }

  // Download files from R2 and prepare attachments
  const emailAttachments: Array<{
    filename: string;
    content: Buffer;
  }> = [];

  try {
    for (const attachment of attachments) {
      // Download file from R2 (server-side only)
      const fileBuffer = await downloadFile(r2Bucket, attachment.filePath);

      emailAttachments.push({
        filename: attachment.fileName,
        content: fileBuffer,
      });
    }
  } catch (error: any) {
    console.error("[EMAIL] Failed to download files from R2:", error);
    throw new AppError(
      `Failed to prepare attachments: ${error.message}`,
      500
    );
  }

  // Generate email content
  const htmlContent = generateEmailTemplate(patientName, appointmentDate);
  const subject = `Your Doctor Notes - ${patientName} - ${appointmentDate.toLocaleDateString("en-IN")}`;

  // Send email via Resend
  try {
    const result = await resend.emails.send({
      from: getFromEmail(),
      to: toEmail,
      subject,
      html: htmlContent,
      attachments: emailAttachments,
    });

    if (result.error) {
      console.error("[EMAIL] Resend error:", result.error);
      throw new AppError(
        `Failed to send email: ${result.error.message || "Unknown error"}`,
        500
      );
    }

    return {
      success: true,
      message: `Email sent successfully to ${toEmail}`,
    };
  } catch (error: any) {
    console.error("[EMAIL] Send error:", error);
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      `Failed to send email: ${error.message || "Unknown error"}`,
      500
    );
  }
}
