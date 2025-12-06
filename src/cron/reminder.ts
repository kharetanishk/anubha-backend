import cron from "node-cron";
import prisma from "../database/prismaclient";
import { getSingleAdmin } from "../modules/slots/slots.services";
import {
  sendPatientConfirmationMessage,
  sendDoctorNotificationMessage,
} from "../services/whatsapp.service";

/**
 * Appointment Reminder Cron Job
 * Runs every minute to check for appointments occurring in 1 hour
 * Sends WhatsApp reminders to both patient and doctor
 */
export function startAppointmentReminderCron() {
  console.log(
    "[CRON] Starting appointment reminder cron job (runs every minute)"
  );

  // Run every minute: * * * * *
  cron.schedule("* * * * *", async () => {
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
 */
async function checkAndSendReminders() {
  try {
    // Calculate time range: appointments starting in exactly 1 hour
    const now = new Date();
    const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000); // +1 hour

    // Find appointments that:
    // 1. Are CONFIRMED
    // 2. Start in exactly 1 hour (within 1 minute window)
    // 3. Reminder not already sent
    const upcomingAppointments = await prisma.appointment.findMany({
      where: {
        status: "CONFIRMED",
        reminderSent: false,
        startAt: {
          gte: new Date(oneHourLater.getTime() - 60 * 1000), // 1 minute before 1 hour
          lte: new Date(oneHourLater.getTime() + 60 * 1000), // 1 minute after 1 hour
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
      // No appointments to remind (this is normal, don't log every minute)
      // Only log occasionally to show the cron is running
      if (Math.random() < 0.01) {
        // Log ~1% of the time
        console.log(
          "[CRON REMINDER] No appointments to remind (cron is running)"
        );
      }
      return;
    }

    console.log("==========================================");
    console.log(
      `[CRON REMINDER] Found ${upcomingAppointments.length} appointment(s) to remind`
    );
    console.log("  Current Time:", now.toISOString());
    console.log("  Target Time (1 hour later):", oneHourLater.toISOString());
    console.log("  Time Window: ±1 minute around 1 hour mark");
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

  // Send patient reminder
  if (patientPhone) {
    try {
      console.log("[CRON REMINDER] Sending patient reminder...");
      // Send patient reminder
      // Note: body_1 is automatically set to patient phone number (type: "numbers") in sendPatientConfirmationMessage
      const patientResult = await sendPatientConfirmationMessage(patientPhone);

      if (patientResult.success) {
        console.log("==========================================");
        console.log(`[CRON REMINDER] ✅ Patient reminder sent successfully`);
        console.log("  Appointment ID:", appointmentId);
        console.log("  Patient Phone:", patientPhone);
        console.log("  Patient Name:", patientName);
        console.log("  Template: patient");
        console.log("==========================================");
      } else {
        console.error("==========================================");
        console.error(`[CRON REMINDER] ❌ Patient reminder failed`);
        console.error("  Appointment ID:", appointmentId);
        console.error("  Patient Phone:", patientPhone);
        console.error("  Error:", patientResult.error);
        console.error("==========================================");
      }
    } catch (error: any) {
      console.error("==========================================");
      console.error(`[CRON REMINDER] ❌ Error sending patient reminder`);
      console.error("  Appointment ID:", appointmentId);
      console.error("  Patient Phone:", patientPhone);
      console.error("  Error:", error.message);
      console.error("  Stack:", error.stack);
      console.error("==========================================");
    }
  } else {
    console.warn("==========================================");
    console.warn(`[CRON REMINDER] ⚠️ Patient phone not found`);
    console.warn("  Appointment ID:", appointmentId);
    console.warn("  Patient Name:", patientName);
    console.warn("==========================================");
  }

  // Send doctor reminder
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

  // Mark reminder as sent
  try {
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { reminderSent: true },
    });
    console.log("==========================================");
    console.log(`[CRON REMINDER] ✅ Reminder marked as sent`);
    console.log("  Appointment ID:", appointmentId);
    console.log("  reminderSent: true");
    console.log("==========================================");
  } catch (error: any) {
    console.error("==========================================");
    console.error(`[CRON REMINDER] ❌ Failed to mark reminder as sent`);
    console.error("  Appointment ID:", appointmentId);
    console.error("  Error:", error.message);
    console.error("  Stack:", error.stack);
    console.error("==========================================");
  }
}
