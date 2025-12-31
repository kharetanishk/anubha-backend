import { Resend } from "resend";
import dotenv from "dotenv";

// Ensure environment variables are loaded
dotenv.config();

/**
 * Resend Email Client
 * Centralized Resend client for sending emails
 */

// Get Resend API key from environment variables
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "noreply@resend.dev"; // Fallback to Resend default

// Validate configuration
if (!RESEND_API_KEY) {
  // console.warn(
  // "[RESEND] ⚠️ RESEND_API_KEY not configured in environment variables"
  // );
// console.warn("[RESEND] Email sending will fail if RESEND_API_KEY is not set");
}

// Create Resend client instance
export const resend = new Resend(RESEND_API_KEY);

/**
 * Get the from email address
 * Uses EMAIL_FROM from environment variables
 */
export function getFromEmail(): string {
  if (!EMAIL_FROM) {
    // console.warn(
    // "[RESEND] ⚠️ EMAIL_FROM not configured, using default noreply@resend.dev"
    // );
return "noreply@resend.dev";
  }
  return EMAIL_FROM;
}

