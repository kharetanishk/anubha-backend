import nodemailer from "nodemailer";
import dotenv from "dotenv";

// Ensure environment variables are loaded
dotenv.config();

/**
 * Gmail SMTP Mailer Utility
 * Configures Nodemailer with Gmail SMTP for sending emails
 */

/**
 * Get email credentials from environment variables (reads fresh each time)
 */
function getEmailCredentials(): { user: string; pass: string } | null {
  const EMAIL_USER = process.env.EMAIL_USER;
  const EMAIL_PASS = process.env.EMAIL_PASS;

  if (!EMAIL_USER || !EMAIL_PASS) {
    return null;
  }

  return { user: EMAIL_USER, pass: EMAIL_PASS };
}

// Cache transporter instance
let _transporter: nodemailer.Transporter | null = null;
let _cachedUser: string | undefined = undefined;
let _cachedPass: string | undefined = undefined;

/**
 * Get or create transporter instance with Gmail SMTP configuration
 * Creates a new transporter if credentials have changed (after server restart)
 */
function getTransporter(): nodemailer.Transporter {
  const credentials = getEmailCredentials();

  if (!credentials) {
    throw new Error(
      "EMAIL_USER or EMAIL_PASS not configured in environment variables"
    );
  }

  // Recreate transporter if credentials have changed (after server restart with new .env)
  if (
    !_transporter ||
    _cachedUser !== credentials.user ||
    _cachedPass !== credentials.pass
  ) {
    _cachedUser = credentials.user;
    _cachedPass = credentials.pass;
    _transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: credentials.user,
        pass: credentials.pass,
      },
    });
    console.log(
      `[MAILER] Transporter created/updated for: ${credentials.user}`
    );
  }

  return _transporter;
}

// Export transporter that uses getTransporter internally
// This ensures credentials are read fresh from env vars each time
export const transporter = {
  sendMail: (options: any) => getTransporter().sendMail(options),
  verify: () => getTransporter().verify(),
  close: () => {
    if (_transporter) {
      _transporter.close();
      _transporter = null;
    }
  },
} as nodemailer.Transporter;

/**
 * Verify SMTP connection during server startup
 * Logs connection status for debugging
 */
export async function verifyMailerConnection(): Promise<void> {
  const credentials = getEmailCredentials();

  if (!credentials) {
    console.warn(
      "[MAILER] ⚠️ Email credentials not configured. Skipping verification."
    );
    console.warn(
      "[MAILER] Please set EMAIL_USER and EMAIL_PASS in your .env file"
    );
    return;
  }

  try {
    const transporter = getTransporter();
    await transporter.verify();
    console.log("[MAILER] ✅ SMTP connection verified successfully");
    console.log("[MAILER] Email service ready (Gmail SMTP)");
    console.log(`[MAILER] Using email: ${credentials.user}`);
  } catch (error: any) {
    console.error("[MAILER] ❌ SMTP connection verification failed:");
    console.error("[MAILER] Error:", error.message);
    console.error(
      "[MAILER] Please check your EMAIL_USER and EMAIL_PASS environment variables"
    );
    console.error(
      "[MAILER] For Gmail, you may need to use an App Password instead of your regular password"
    );
    console.error("[MAILER] Steps to create Gmail App Password:");
    console.error("  1. Go to your Google Account settings");
    console.error("  2. Security > 2-Step Verification > App passwords");
    console.error("  3. Generate a new app password for 'Mail'");
    console.error("  4. Use that 16-character password in EMAIL_PASS");
  }
}

/**
 * Send password reset email
 * @param to - Recipient email address
 * @param resetLink - Password reset link with token
 * @returns Promise<boolean> - true if email sent successfully, false otherwise
 */
export async function sendPasswordResetEmail(
  to: string,
  resetLink: string
): Promise<boolean> {
  console.log("[MAILER] sendPasswordResetEmail called");
  console.log("[MAILER] Recipient:", to);

  const credentials = getEmailCredentials();
  console.log("[MAILER] EMAIL_USER configured:", !!credentials?.user);
  console.log("[MAILER] EMAIL_PASS configured:", !!credentials?.pass);

  if (!credentials) {
    console.error(
      "[MAILER] ❌ Cannot send email: EMAIL_USER or EMAIL_PASS not configured"
    );
    console.error(
      "[MAILER] Please set EMAIL_USER and EMAIL_PASS in your .env file"
    );
    return false;
  }

  try {
    const transporter = getTransporter();
    console.log("[MAILER] Creating mail options...");
    const mailOptions = {
      from: `"Anubha Nutrition Clinic" <${credentials.user}>`,
      to: to,
      subject: "Reset your password",
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Reset Your Password</title>
          </head>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
              <h1 style="color: white; margin: 0; font-size: 24px;">Reset Your Password</h1>
            </div>
            
            <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
              <p style="font-size: 16px; margin-bottom: 20px;">
                Hello,
              </p>
              
              <p style="font-size: 16px; margin-bottom: 20px;">
                We received a request to reset your password for your Anubha Nutrition Clinic account.
              </p>
              
              <div style="text-align: center; margin: 30px 0;">
                <a href="${resetLink}" 
                   style="display: inline-block; background-color: #10b981; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">
                  Reset Password
                </a>
              </div>
              
              <p style="font-size: 14px; color: #6b7280; margin-top: 30px; margin-bottom: 10px;">
                Or copy and paste this link into your browser:
              </p>
              <p style="font-size: 12px; color: #9ca3af; word-break: break-all; background: #f9fafb; padding: 10px; border-radius: 5px; margin-bottom: 20px;">
                ${resetLink}
              </p>
              
              <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 5px;">
                <p style="font-size: 14px; color: #92400e; margin: 0;">
                  <strong>⚠️ Important:</strong> This link will expire in <strong>15 minutes</strong> for security reasons.
                </p>
              </div>
              
              <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
                If you did not request a password reset, please ignore this email. Your password will remain unchanged.
              </p>
              
              <p style="font-size: 14px; color: #6b7280; margin-top: 20px;">
                Best regards,<br>
                <strong>Anubha Nutrition Clinic</strong>
              </p>
            </div>
            
            <div style="text-align: center; margin-top: 20px; padding: 20px; color: #9ca3af; font-size: 12px;">
              <p style="margin: 0;">This is an automated email. Please do not reply.</p>
            </div>
          </body>
        </html>
      `,
    };

    console.log("[MAILER] Sending email via transporter...");
    const info = await transporter.sendMail(mailOptions);
    console.log("[MAILER] ✅ Password reset email sent successfully");
    console.log("[MAILER] Message ID:", info.messageId);
    console.log("[MAILER] Accepted recipients:", info.accepted);
    console.log("[MAILER] Rejected recipients:", info.rejected);
    return true;
  } catch (error: any) {
    console.error("[MAILER] ❌ Failed to send password reset email:");
    console.error("[MAILER] Error type:", error.constructor?.name);
    console.error("[MAILER] Error message:", error.message);
    console.error("[MAILER] Error code:", error.code);
    console.error("[MAILER] Error response:", error.response);
    console.error("[MAILER] Recipient:", to);
    console.error("[MAILER] From:", credentials.user);
    console.error("[MAILER] Full error:", error);
    // Don't throw error - log only to prevent breaking the response
    return false;
  }
}

/**
 * Send email OTP for adding email to phone-only account
 * @param to - Recipient email address
 * @param otp - 4-digit OTP code
 * @returns Promise<boolean> - true if email sent successfully, false otherwise
 */
export async function sendAddEmailVerificationOtp(
  to: string,
  otp: string
): Promise<boolean> {
  const credentials = getEmailCredentials();

  if (!credentials) {
    console.error(
      "[MAILER] Cannot send email: EMAIL_USER or EMAIL_PASS not configured"
    );
    return false;
  }

  try {
    const transporter = getTransporter();
    const mailOptions = {
      from: `"Anubha Nutrition Clinic" <${credentials.user}>`,
      to: to,
      subject: "Verify Your Email Address - Verification Code",
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Verify Your Email Address</title>
          </head>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
              <h1 style="color: white; margin: 0; font-size: 24px;">Verify Your Email Address</h1>
            </div>
            
            <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
              <p style="font-size: 16px; margin-bottom: 20px;">
                Hello,
              </p>
              
              <p style="font-size: 16px; margin-bottom: 20px;">
                You requested to add and verify your email address to your Anubha Nutrition Clinic account. Please use the verification code below to complete the process.
              </p>
              
              <div style="text-align: center; margin: 30px 0;">
                <div style="background: #f0fdf4; border: 2px solid #10b981; border-radius: 8px; padding: 20px; display: inline-block;">
                  <p style="font-size: 12px; color: #6b7280; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 1px;">Your Verification Code</p>
                  <p style="font-size: 36px; font-weight: bold; color: #10b981; margin: 0; letter-spacing: 8px; font-family: 'Courier New', monospace;">
                    ${otp}
                  </p>
                </div>
              </div>
              
              <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 5px;">
                <p style="font-size: 14px; color: #92400e; margin: 0;">
                  <strong>⚠️ Important:</strong> This code will expire in <strong>10 minutes</strong> for security reasons.
                </p>
              </div>
              
              <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
                If you did not request to add this email address, please ignore this email. Your account remains secure.
              </p>
              
              <p style="font-size: 14px; color: #6b7280; margin-top: 20px;">
                Best regards,<br>
                <strong>Anubha Nutrition Clinic</strong>
              </p>
            </div>
            
            <div style="text-align: center; margin-top: 20px; padding: 20px; color: #9ca3af; font-size: 12px;">
              <p style="margin: 0;">This is an automated email. Please do not reply.</p>
            </div>
          </body>
        </html>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log("[MAILER] ✅ Email verification OTP sent successfully");
    console.log("[MAILER] Message ID:", info.messageId);
    return true;
  } catch (error: any) {
    console.error("[MAILER] ❌ Failed to send email verification OTP:");
    console.error("[MAILER] Error:", error.message);
    console.error("[MAILER] Recipient:", to);
    return false;
  }
}

/**
 * Send email OTP for linking phone to existing account
 * @param to - Recipient email address
 * @param otp - 4-digit OTP code
 * @returns Promise<boolean> - true if email sent successfully, false otherwise
 */
export async function sendEmailOtp(to: string, otp: string): Promise<boolean> {
  const credentials = getEmailCredentials();

  if (!credentials) {
    console.error(
      "[MAILER] Cannot send email: EMAIL_USER or EMAIL_PASS not configured"
    );
    return false;
  }

  try {
    const transporter = getTransporter();
    const mailOptions = {
      from: `"Anubha Nutrition Clinic" <${credentials.user}>`,
      to: to,
      subject: "Verify Your Account - Verification Code",
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Verify Your Account</title>
          </head>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
              <h1 style="color: white; margin: 0; font-size: 24px;">Verify Your Account</h1>
            </div>
            
            <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
              <p style="font-size: 16px; margin-bottom: 20px;">
                Hello,
              </p>
              
              <p style="font-size: 16px; margin-bottom: 20px;">
                You requested to verify your account with Anubha Nutrition Clinic. Please use the verification code below to complete the process.
              </p>
              
              <div style="text-align: center; margin: 30px 0;">
                <div style="background: #f0fdf4; border: 2px solid #10b981; border-radius: 8px; padding: 20px; display: inline-block;">
                  <p style="font-size: 12px; color: #6b7280; margin: 0 0 10px 0; text-transform: uppercase; letter-spacing: 1px;">Your Verification Code</p>
                  <p style="font-size: 36px; font-weight: bold; color: #10b981; margin: 0; letter-spacing: 8px; font-family: 'Courier New', monospace;">
                    ${otp}
                  </p>
                </div>
              </div>
              
              <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 5px;">
                <p style="font-size: 14px; color: #92400e; margin: 0;">
                  <strong>⚠️ Important:</strong> This code will expire in <strong>10 minutes</strong> for security reasons.
                </p>
              </div>
              
              <p style="font-size: 14px; color: #6b7280; margin-top: 30px;">
                If you did not request this verification code, please ignore this email. Your account remains secure.
              </p>
              
              <p style="font-size: 14px; color: #6b7280; margin-top: 20px;">
                Best regards,<br>
                <strong>Anubha Nutrition Clinic</strong>
              </p>
            </div>
            
            <div style="text-align: center; margin-top: 20px; padding: 20px; color: #9ca3af; font-size: 12px;">
              <p style="margin: 0;">This is an automated email. Please do not reply.</p>
            </div>
          </body>
        </html>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log("[MAILER] ✅ Email OTP sent successfully");
    console.log("[MAILER] Message ID:", info.messageId);
    return true;
  } catch (error: any) {
    console.error("[MAILER] ❌ Failed to send email OTP:");
    console.error("[MAILER] Error:", error.message);
    console.error("[MAILER] Recipient:", to);
    return false;
  }
}
