import cron from "node-cron";
import prisma from "../database/prismaclient";
import {
  sendReminderMessage,
  formatDateForTemplate,
  formatTimeForTemplate,
} from "../services/whatsapp.service";
import { getSingleAdmin } from "../modules/slots/slots.services";
import { formatInTimeZone } from "date-fns-tz";

const BUSINESS_TIMEZONE = "Asia/Kolkata";

/**
 * Lock flag to prevent overlapping cron executions
 * If a previous execution is still running, skip the next scheduled run
 */
let isRunning = false;

/**
 * Appointment Reminder Cron Job
 * Runs every 10 minutes to check for appointments with reminderTime in the current window
 * Sends "reminderbooking" template WhatsApp reminders to:
 * - Patients: body_1 = Patient Name
 * - Admin: body_1 = Admin Name
 * Both receive the same template with different body_1 values
 */
export function startAppointmentReminderCron() {
  // console.log(
  // "[CRON] Starting appointment reminder cron job (runs every 10 minutes)
  // "
  // );

  // Run every 10 minutes: */10 * * * *
  cron.schedule("*/10 * * * *", async () => {
    // Skip if previous execution is still running
    if (isRunning) {
      // console.warn(
      // "[CRON] ⚠️ Previous execution still running, skipping this run to prevent overlap"
      // );
      return;
    }

    isRunning = true;
    try {
      await checkAndSendReminders();
    } catch (error: any) {
      console.error("[CRON] Error in appointment reminder cron:", error);
    } finally {
      isRunning = false;
    }
  });

  // console.log("[CRON] ✅ Appointment reminder cron job started");
}

/**
 * Check for upcoming appointments and send reminders
 * Uses reminderTime field to find appointments that need reminders in the current 10-minute window
 */
async function checkAndSendReminders() {
  try {
    // Get current time in UTC (Date.now() returns UTC timestamp)
    // All dates in database are stored in UTC, so we compare UTC times directly
    // The reminderTime field is calculated as 1 hour before slot time (both in UTC)
    const now = new Date();
    now.setSeconds(0, 0); // Round down to minute (seconds & ms = 0)

    // Calculate time window: reminderTime should be between (now - 10 minutes) and now
    // This makes it robust against small drifts - reminders are sent once even if cron runs slightly late
    // Both now and tenMinutesAgo are UTC Date objects, so comparison with reminderTime (also UTC) is correct
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

    // console.log("==========================================");
    // console.log("[CRON REMINDER] Checking for appointments needing reminders");
    // console.log("  Current Time:", now.toISOString()
    // );
    // console.log("  Window Start:", tenMinutesAgo.toISOString()
    // );
    // console.log("  Window End:", now.toISOString()
    // );
    // console.log("==========================================");
    // Find appointments that:
    // 1. Are CONFIRMED
    // 2. Reminder not already sent
    // 3. Have reminderTime within the current window (between 10 minutes ago and now)
    // 4. reminderTime is not null (appointment has a valid slot time)
    const upcomingAppointments = await prisma.appointment.findMany({
      where: {
        status: "CONFIRMED",
        reminderSent: false,
        reminderTime: {
          gte: tenMinutesAgo,
          lte: now,
        },
      },
      include: {
        patient: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
          },
        },
        doctor: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
          },
        },
        slot: {
          select: {
            startAt: true,
            endAt: true,
            mode: true,
          },
        },
      },
    });

    if (upcomingAppointments.length === 0) {
      // No appointments to remind (this is normal, don't log every run)
      // Only log occasionally to show the cron is running
      if (Math.random() < 0.1) {
        // Log ~10% of the time (less frequent since we run every 10 min instead of every minute)
        // console.log(
        // "[CRON REMINDER] No appointments to remind in current window (cron is running)
        // "
        // );
      }
      return;
    }

    // console.log("==========================================");
    // console.log(
    // `[CRON REMINDER] Found ${upcomingAppointments.length} appointment(s)
    // to remind`
    // );
    // console.log("  Current Time:", now.toISOString()
    // );
    // console.log(
    // "  Reminder Time Window:",
    // tenMinutesAgo.toISOString()
    // ,
    // "to",
    // now.toISOString()
    // );
    // console.log("==========================================");
    // Admin phone is fixed: 919713885582 (handled in sendDoctorNotificationMessage)

    // Process each appointment
    for (const appointment of upcomingAppointments) {
      try {
        await sendReminderForAppointment(appointment);
      } catch (error: any) {
        console.error("==========================================");
        console.error(
          `[CRON REMINDER] ❌ Failed to send reminder for appointment ${appointment.id}`
        );
        console.error("  Error:", error.message);
        if (process.env.NODE_ENV !== "production") {
          console.error("  Stack:", error.stack);
        }
        console.error("==========================================");
        // Continue with other appointments even if one fails
      }
    }

    // console.log("==========================================");
    // console.log(
    // `[CRON REMINDER] ✅ Completed processing ${upcomingAppointments.length} appointment(s)
    // `
    // );
    // console.log("==========================================");
  } catch (error: any) {
    console.error("==========================================");
    console.error("[CRON REMINDER] ❌ Error checking reminders");
    console.error("  Error:", error.message);
    if (process.env.NODE_ENV !== "production") {
      console.error("  Stack:", error.stack);
    }
    console.error("==========================================");
  }
}

/**
 * Send reminder for a single appointment
 */
async function sendReminderForAppointment(appointment: any) {
  const appointmentId = appointment.id;
  const patientName = appointment.patient?.name || "Patient";
  const patientPhone = appointment.patient?.phone;
  const appointmentStartAt = appointment.slot?.startAt || appointment.startAt;
  const appointmentMode = appointment.slot?.mode || appointment.mode;

  // console.log("==========================================");
  // console.log(
  // `[CRON REMINDER] Sending reminder for appointment ${appointmentId}`
  // );
  // console.log("  Appointment ID:", appointmentId);
  // console.log("  Appointment Start:", appointmentStartAt);
  // console.log("  Appointment Mode:", appointmentMode);
  // console.log("  Patient Name:", patientName);
  // console.log("  Patient Phone:", patientPhone || "Not found");
  // console.log("  Admin Phone: 919713885582 (fixed)
  // ");
  // console.log("==========================================");
  // Get slot time for reminder message
  const slotStartTime = appointment.slot?.startAt || appointment.startAt;
  const slotEndTime = appointment.slot?.endAt || appointment.endAt;
  if (!slotStartTime) {
    // console.warn("==========================================");
    // console.warn(`[CRON REMINDER] ⚠️ Slot time not found`);
    // console.warn("  Appointment ID:", appointmentId);
    // console.warn("==========================================");
    // Mark as sent to prevent retrying without slot time
    await prisma.appointment.updateMany({
      where: {
        id: appointmentId,
        reminderSent: false,
      },
      data: { reminderSent: true },
    });
    return;
  }

  const slotStartTimeDate = new Date(slotStartTime);
  const slotEndTimeDate = slotEndTime ? new Date(slotEndTime) : undefined;

  // Note: The query already filters by reminderSent: false, so appointments
  // with reminderSent: true (last-minute bookings) won't be fetched.
  // This ensures reminders are only sent for non-last-minute bookings.

  // Send patient reminder
  let reminderSentSuccessfully = false;

  if (patientPhone) {
    try {
      // console.log("[CRON REMINDER] Sending patient reminder...");
      // Send reminder message using the reminderbooking template
      // body_1 will be patient name
      const patientResult = await sendReminderMessage(
        patientPhone,
        slotStartTimeDate,
        patientName, // Patient name for body_1
        slotEndTimeDate
      );

      if (patientResult.success) {
        // console.log("==========================================");
        // console.log(`[CRON REMINDER] ✅ Patient reminder sent successfully`);
        // console.log("  Appointment ID:", appointmentId);
        // console.log("  Patient Phone:", patientPhone);
        // console.log("  Patient Name:", patientName);
        // console.log("  Slot Start Time:", slotStartTimeDate.toISOString()
        // );
        if (slotEndTimeDate) {
          // console.log("  Slot End Time:", slotEndTimeDate.toISOString()
          // );
        }
        // console.log("  Template: Reminder (1 hour before)
        // ");
        // console.log("==========================================");
        reminderSentSuccessfully = true;
      } else {
        console.error("==========================================");
        console.error(`[CRON REMINDER] ❌ Patient reminder failed`);
        console.error("  Appointment ID:", appointmentId);
        console.error("  Patient Phone:", patientPhone);
        console.error("  Error:", patientResult.error);
        console.error("==========================================");
        // Don't mark as sent - will retry in next cron run
      }
    } catch (error: any) {
      console.error("==========================================");
      console.error(`[CRON REMINDER] ❌ Error sending patient reminder`);
      console.error("  Appointment ID:", appointmentId);
      console.error("  Patient Phone:", patientPhone);
      console.error("  Error:", error.message);
      if (process.env.NODE_ENV !== "production") {
        console.error("  Stack:", error.stack);
      }
      console.error("==========================================");
      // Don't mark as sent - will retry in next cron run
    }
  } else {
    // console.warn("==========================================");
    // console.warn(`[CRON REMINDER] ⚠️ Patient phone not found`);
    // console.warn("  Appointment ID:", appointmentId);
    // console.warn("  Patient Name:", patientName);
    // console.warn("==========================================");
    // Mark as sent to prevent retrying without phone number
    reminderSentSuccessfully = true; // Treat as "sent" to prevent infinite retries
  }

  // Send admin reminder using reminderbooking template (same as patient reminder)
  // body_1 will be admin name instead of patient name
  // Non-blocking - doesn't affect patient reminder status
  try {
    // console.log("[CRON REMINDER] Sending admin reminder...");
    // Get admin details (name and phone)
    const admin = await getSingleAdmin();
    const adminPhone = admin.phone || "919713885582"; // Fallback to fixed phone if not found
    const adminName = admin.name || "Admin";

    // console.log("  Admin Phone:", adminPhone);
    // console.log("  Admin Name:", adminName);
    // console.log("  Template: reminderbooking");
    // Send reminderbooking template to admin with admin name in body_1
    const adminResult = await sendReminderMessage(
      adminPhone,
      slotStartTimeDate,
      adminName, // Admin name for body_1
      slotEndTimeDate
    );

    if (adminResult.success) {
      // console.log("==========================================");
      // console.log(`[CRON REMINDER] ✅ Admin reminder sent successfully`);
      // console.log("  Appointment ID:", appointmentId);
      // console.log("  Admin Phone:", adminPhone);
      // console.log("  Admin Name:", adminName);
      // console.log("  Template: reminderbooking");
      // console.log("==========================================");
    } else {
      console.error("==========================================");
      console.error(`[CRON REMINDER] ❌ Admin reminder failed`);
      console.error("  Appointment ID:", appointmentId);
      console.error("  Admin Phone:", adminPhone);
      console.error("  Error:", adminResult.error);
      console.error("==========================================");
    }
  } catch (error: any) {
    console.error("==========================================");
    console.error(`[CRON REMINDER] ❌ Error sending admin reminder`);
    console.error("  Appointment ID:", appointmentId);
    console.error("  Error:", error.message);
    if (process.env.NODE_ENV !== "production") {
      console.error("  Stack:", error.stack);
    }
    console.error("==========================================");
  }

  // SECURITY: Mark reminder as sent using atomic update to prevent duplicate reminders
  // Only mark as sent if the patient reminder was successfully sent (or patient phone is missing)
  // Use updateMany with WHERE clause to ensure only one cron instance can mark it as sent
  // This prevents race condition if cron runs twice simultaneously
  if (reminderSentSuccessfully) {
    try {
      const updateResult = await prisma.appointment.updateMany({
        where: {
          id: appointmentId,
          reminderSent: false, // Only update if reminder hasn't been sent yet
        },
        data: { reminderSent: true },
      });

      if (updateResult.count > 0) {
        // console.log("==========================================");
        // console.log(
        // `[CRON REMINDER] ✅ Reminder marked as sent (atomic update)
        // `
        // );
        // console.log("  Appointment ID:", appointmentId);
        // console.log("  reminderSent: true");
        // console.log("  Rows updated:", updateResult.count);
        // console.log("==========================================");
      } else {
        // Reminder was already sent by another cron instance (race condition handled)
        // console.log("==========================================");
        // console.log(
        // `[CRON REMINDER] ⚠️ Reminder already sent (duplicate prevented)
        // `
        // );
        // console.log("  Appointment ID:", appointmentId);
        // console.log(
        // "  This is normal if cron runs multiple times simultaneously"
        // );
        // console.log("==========================================");
      }
    } catch (error: any) {
      console.error("==========================================");
      console.error(`[CRON REMINDER] ❌ Failed to mark reminder as sent`);
      console.error("  Appointment ID:", appointmentId);
      console.error("  Error:", error.message);
      if (process.env.NODE_ENV !== "production") {
        console.error("  Stack:", error.stack);
      }
      console.error("==========================================");
    }
  } else {
    // console.log("==========================================");
    // console.log(
    // `[CRON REMINDER] ⚠️ Reminder not marked as sent (will retry next run)
    // `
    // );
    // console.log("  Appointment ID:", appointmentId);
    // console.log("  Reason: Patient reminder failed or patient phone missing");
    // console.log("==========================================");
  }
}
