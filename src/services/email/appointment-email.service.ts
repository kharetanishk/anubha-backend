import { resend, getFromEmail } from "../../utils/resend";
import { formatInTimeZone } from "date-fns-tz";

const BUSINESS_TIMEZONE = "Asia/Kolkata";
const DOCTOR_EMAIL = "anubhasnutritionclinic@gmail.com";

/**
 * Format date to readable string with day of week
 * Example: "Tuesday, 12th January 2026"
 */
function formatDateForEmail(date: Date): string {
  const dayOfWeek = formatInTimeZone(date, BUSINESS_TIMEZONE, "EEEE");
  const day = parseInt(formatInTimeZone(date, BUSINESS_TIMEZONE, "d"), 10);
  const ordinalSuffix = getOrdinalSuffix(day);
  const month = formatInTimeZone(date, BUSINESS_TIMEZONE, "MMMM");
  const year = formatInTimeZone(date, BUSINESS_TIMEZONE, "yyyy");
  return `${dayOfWeek}, ${day}${ordinalSuffix} ${month} ${year}`;
}

/**
 * Get ordinal suffix for a day number (1st, 2nd, 3rd, etc.)
 */
function getOrdinalSuffix(day: number): string {
  if (day > 3 && day < 21) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/**
 * Format time to readable string
 * Example: "10:00 AM - 10:40 AM"
 */
function formatTimeForEmail(startDate: Date, endDate?: Date): string {
  const startTime = formatInTimeZone(startDate, BUSINESS_TIMEZONE, "hh:mm a");
  if (endDate) {
    const endTime = formatInTimeZone(endDate, BUSINESS_TIMEZONE, "hh:mm a");
    return `${startTime} – ${endTime}`;
  }
  return startTime;
}

/**
 * Get day of week abbreviation
 * Example: "Tuesday"
 */
function getDayOfWeek(date: Date): string {
  return formatInTimeZone(date, BUSINESS_TIMEZONE, "EEEE");
}

interface AppointmentEmailData {
  patientName: string;
  patientEmail: string;
  planName: string;
  slotStartTime: Date;
  slotEndTime?: Date;
}

/**
 * Send appointment confirmation email to patient
 */
export async function sendPatientAppointmentEmail(
  data: AppointmentEmailData
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!data.patientEmail) {
      return { success: false, error: "Patient email not provided" };
    }

    const fullDate = formatDateForEmail(data.slotStartTime);
    const day = getDayOfWeek(data.slotStartTime);
    const timeRange = formatTimeForEmail(data.slotStartTime, data.slotEndTime);

    const emailContent = `
Anubha Nutrition Clinic

Dear ${data.patientName},

Your booking has been successfully confirmed for
${day}, ${fullDate} at ${timeRange}.

Please be available at the scheduled time.

Regards,
Anubha Nutrition Clinic
    `.trim();

    await resend.emails.send({
      from: getFromEmail(),
      to: data.patientEmail,
      subject: "Appointment Confirmed – Anubha Nutrition Clinic",
      text: emailContent,
    });

    if (process.env.NODE_ENV === "development") {
      console.log("[EMAIL] ✅ Patient appointment email sent:", data.patientEmail);
    }

    return { success: true };
  } catch (error: any) {
    console.error("[EMAIL] ❌ Failed to send patient appointment email:", error);
    return {
      success: false,
      error: error?.message || "Failed to send patient email",
    };
  }
}

/**
 * Send appointment notification email to doctor
 */
export async function sendDoctorAppointmentEmail(
  data: AppointmentEmailData
): Promise<{ success: boolean; error?: string }> {
  try {
    const fullDate = formatDateForEmail(data.slotStartTime);
    const day = getDayOfWeek(data.slotStartTime);
    const timeRange = formatTimeForEmail(data.slotStartTime, data.slotEndTime);

    const emailContent = `
New Appointment Alert – General Consultation (${data.planName})

Appointment scheduled for ${data.patientName} on
${day}, ${fullDate} at ${timeRange}.

Please check the admin dashboard for details.
    `.trim();

    await resend.emails.send({
      from: getFromEmail(),
      to: DOCTOR_EMAIL,
      subject: `New Appointment Alert – ${data.planName}`,
      text: emailContent,
    });

    if (process.env.NODE_ENV === "development") {
      console.log("[EMAIL] ✅ Doctor appointment email sent:", DOCTOR_EMAIL);
    }

    return { success: true };
  } catch (error: any) {
    console.error("[EMAIL] ❌ Failed to send doctor appointment email:", error);
    return {
      success: false,
      error: error?.message || "Failed to send doctor email",
    };
  }
}

/**
 * Reminder email data interface
 * Name changes based on role (patient name for patient, admin name for admin)
 */
interface ReminderEmailData {
  name: string; // Patient name for patient email, Admin name for admin email
  email: string; // Recipient email
  slotStartTime: Date;
  slotEndTime?: Date;
}

/**
 * Send appointment reminder email (1 hour before appointment)
 * Uses the same template format as WhatsApp reminder but via email
 * Template variables match WhatsApp reminderbooking template:
 * - body_1: Name (Patient name for user, Admin name for admin)
 * - body_2: Appointment Date
 * - body_3: Slot Time (e.g., "10:00 AM - 10:40 AM")
 */
export async function sendReminderEmail(
  data: ReminderEmailData
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!data.email) {
      return { success: false, error: "Email not provided" };
    }

    const fullDate = formatDateForEmail(data.slotStartTime);
    const day = getDayOfWeek(data.slotStartTime);
    const timeRange = formatTimeForEmail(data.slotStartTime, data.slotEndTime);

    // Same template content as WhatsApp reminderbooking template
    // Template variables match:
    // body_1: ${data.name} (Patient name for user, Admin name for admin)
    // body_2: ${fullDate} (Appointment Date)
    // body_3: ${timeRange} (Slot Time)
    const emailContent = `
Anubha Nutrition Clinic

Dear ${data.name},

This is a reminder that you have an appointment scheduled for
${day}, ${fullDate} at ${timeRange}.

Please be available at the scheduled time.

Regards,
Anubha Nutrition Clinic
    `.trim();

    await resend.emails.send({
      from: getFromEmail(),
      to: data.email,
      subject: "Appointment Reminder – Anubha Nutrition Clinic",
      text: emailContent,
    });

    if (process.env.NODE_ENV === "development") {
      console.log("[EMAIL REMINDER] ✅ Reminder email sent:", data.email);
    }

    return { success: true };
  } catch (error: any) {
    console.error("[EMAIL REMINDER] ❌ Failed to send reminder email:", error);
    return {
      success: false,
      error: error?.message || "Failed to send reminder email",
    };
  }
}