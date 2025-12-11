import cron from "node-cron";
import prisma from "../database/prismaclient";
import { getSingleAdmin } from "../modules/slots/slots.services";
import {
  sendReminderMessage,
  sendDoctorNotificationMessage,
} from "../services/whatsapp.service";

/**
 * Appointment Reminder Cron Job
 * Runs every 10 minutes to check for appointments with reminderTime in the current window
 * Sends SMS/WhatsApp reminders to patients 1 hour before their appointment
 */
export function startAppointmentReminderCron() {
  console.log(
    "[CRON] Starting appointment reminder cron job (runs every 10 minutes)"
  );

  // Run every 10 minutes: */10 * * * *
  cron.schedule("*/10 * * * *", async () => {
    try {
      await checkAndSendReminders();
    } catch (error: any) {
      console.error("[CRON] Error in appointment reminder cron:", error);
    }
  });

  console.log("[CRON] ✅ Appointment reminder cron job started");
}

/**
 * Check for upcoming appointments and send reminders
 * Uses reminderTime field to find appointments that need reminders in the current 10-minute window
 */
async function checkAndSendReminders() {
  try {
    // Get current time and round down to minute (seconds & ms = 0)
    const now = new Date();
    now.setSeconds(0, 0);

    // Calculate time window: reminderTime should be between (now - 10 minutes) and now
    // This makes it robust against small drifts - reminders are sent once even if cron runs slightly late
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

    console.log("==========================================");
    console.log("[CRON REMINDER] Checking for appointments needing reminders");
    console.log("  Current Time:", now.toISOString());
    console.log("  Window Start:", tenMinutesAgo.toISOString());
    console.log("  Window End:", now.toISOString());
    console.log("==========================================");

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
        console.log(
          "[CRON REMINDER] No appointments to remind in current window (cron is running)"
        );
      }
      return;
    }

    console.log("==========================================");
    console.log(
      `[CRON REMINDER] Found ${upcomingAppointments.length} appointment(s) to remind`
    );
    console.log("  Current Time:", now.toISOString());
    console.log(
      "  Reminder Time Window:",
      tenMinutesAgo.toISOString(),
      "to",
      now.toISOString()
    );
    console.log("==========================================");

    // Get admin/doctor phone for fallback
    let adminPhone: string | null = null;
    try {
      const admin = await getSingleAdmin();
      adminPhone = admin.phone;
      console.log(
        "[CRON REMINDER] Admin phone fetched for fallback:",
        adminPhone
      );
    } catch (error: any) {
      console.warn("==========================================");
      console.warn(
        "[CRON REMINDER] ⚠️ Could not fetch admin phone for reminders"
      );
      console.warn("  Error:", error.message);
      console.warn("==========================================");
    }

    // Process each appointment
    for (const appointment of upcomingAppointments) {
      try {
        await sendReminderForAppointment(appointment, adminPhone);
      } catch (error: any) {
        console.error("==========================================");
        console.error(
          `[CRON REMINDER] ❌ Failed to send reminder for appointment ${appointment.id}`
        );
        console.error("  Error:", error.message);
        console.error("  Stack:", error.stack);
        console.error("==========================================");
        // Continue with other appointments even if one fails
      }
    }

    console.log("==========================================");
    console.log(
      `[CRON REMINDER] ✅ Completed processing ${upcomingAppointments.length} appointment(s)`
    );
    console.log("==========================================");
  } catch (error: any) {
    console.error("==========================================");
    console.error("[CRON REMINDER] ❌ Error checking reminders");
    console.error("  Error:", error.message);
    console.error("  Stack:", error.stack);
    console.error("==========================================");
  }
}

/**
 * Send reminder for a single appointment
 */
async function sendReminderForAppointment(
  appointment: any,
  adminPhone: string | null
) {
  const appointmentId = appointment.id;
  const patientName = appointment.patient?.name || "Patient";
  const patientPhone = appointment.patient?.phone;
  const doctorPhone = appointment.doctor?.phone || adminPhone;
  const appointmentStartAt = appointment.slot?.startAt || appointment.startAt;
  const appointmentMode = appointment.slot?.mode || appointment.mode;

  console.log("==========================================");
  console.log(
    `[CRON REMINDER] Sending reminder for appointment ${appointmentId}`
  );
  console.log("  Appointment ID:", appointmentId);
  console.log("  Appointment Start:", appointmentStartAt);
  console.log("  Appointment Mode:", appointmentMode);
  console.log("  Patient Name:", patientName);
  console.log("  Patient Phone:", patientPhone || "Not found");
  console.log("  Doctor Phone:", doctorPhone || "Not found");
  console.log("==========================================");

  // Get slot time for reminder message
  const slotTime = appointment.slot?.startAt || appointment.startAt;
  if (!slotTime) {
    console.warn("==========================================");
    console.warn(`[CRON REMINDER] ⚠️ Slot time not found`);
    console.warn("  Appointment ID:", appointmentId);
    console.warn("==========================================");
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

  const slotTimeDate = new Date(slotTime);

  // Send patient reminder
  let reminderSentSuccessfully = false;

  if (patientPhone) {
    try {
      console.log("[CRON REMINDER] Sending patient reminder...");
      // Send reminder message using the reminder template
      const patientResult = await sendReminderMessage(
        patientPhone,
        slotTimeDate
      );

      if (patientResult.success) {
        console.log("==========================================");
        console.log(`[CRON REMINDER] ✅ Patient reminder sent successfully`);
        console.log("  Appointment ID:", appointmentId);
        console.log("  Patient Phone:", patientPhone);
        console.log("  Patient Name:", patientName);
        console.log("  Slot Time:", slotTimeDate.toISOString());
        console.log("  Template: Reminder (1 hour before)");
        console.log("==========================================");
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
      console.error("  Stack:", error.stack);
      console.error("==========================================");
      // Don't mark as sent - will retry in next cron run
    }
  } else {
    console.warn("==========================================");
    console.warn(`[CRON REMINDER] ⚠️ Patient phone not found`);
    console.warn("  Appointment ID:", appointmentId);
    console.warn("  Patient Name:", patientName);
    console.warn("==========================================");
    // Mark as sent to prevent retrying without phone number
    reminderSentSuccessfully = true; // Treat as "sent" to prevent infinite retries
  }

  // Send doctor reminder (non-blocking - doesn't affect patient reminder status)
  if (doctorPhone) {
    try {
      console.log("[CRON REMINDER] Sending doctor reminder...");
      const doctorResult = await sendDoctorNotificationMessage(doctorPhone);

      if (doctorResult.success) {
        console.log("==========================================");
        console.log(`[CRON REMINDER] ✅ Doctor reminder sent successfully`);
        console.log("  Appointment ID:", appointmentId);
        console.log("  Doctor Phone:", doctorPhone);
        console.log("  Template: testing_nut");
        console.log("==========================================");
      } else {
        console.error("==========================================");
        console.error(`[CRON REMINDER] ❌ Doctor reminder failed`);
        console.error("  Appointment ID:", appointmentId);
        console.error("  Doctor Phone:", doctorPhone);
        console.error("  Error:", doctorResult.error);
        console.error("==========================================");
      }
    } catch (error: any) {
      console.error("==========================================");
      console.error(`[CRON REMINDER] ❌ Error sending doctor reminder`);
      console.error("  Appointment ID:", appointmentId);
      console.error("  Doctor Phone:", doctorPhone);
      console.error("  Error:", error.message);
      console.error("  Stack:", error.stack);
      console.error("==========================================");
    }
  } else {
    console.warn("==========================================");
    console.warn(`[CRON REMINDER] ⚠️ Doctor phone not found`);
    console.warn("  Appointment ID:", appointmentId);
    console.warn("==========================================");
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
        console.log("==========================================");
        console.log(
          `[CRON REMINDER] ✅ Reminder marked as sent (atomic update)`
        );
        console.log("  Appointment ID:", appointmentId);
        console.log("  reminderSent: true");
        console.log("  Rows updated:", updateResult.count);
        console.log("==========================================");
      } else {
        // Reminder was already sent by another cron instance (race condition handled)
        console.log("==========================================");
        console.log(
          `[CRON REMINDER] ⚠️ Reminder already sent (duplicate prevented)`
        );
        console.log("  Appointment ID:", appointmentId);
        console.log(
          "  This is normal if cron runs multiple times simultaneously"
        );
        console.log("==========================================");
      }
    } catch (error: any) {
      console.error("==========================================");
      console.error(`[CRON REMINDER] ❌ Failed to mark reminder as sent`);
      console.error("  Appointment ID:", appointmentId);
      console.error("  Error:", error.message);
      console.error("  Stack:", error.stack);
      console.error("==========================================");
    }
  } else {
    console.log("==========================================");
    console.log(
      `[CRON REMINDER] ⚠️ Reminder not marked as sent (will retry next run)`
    );
    console.log("  Appointment ID:", appointmentId);
    console.log("  Reason: Patient reminder failed or patient phone missing");
    console.log("==========================================");
  }
}
