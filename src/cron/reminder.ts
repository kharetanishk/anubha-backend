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
      return;
    }

    console.log(
      `[CRON] Found ${upcomingAppointments.length} appointment(s) to remind`
    );

    // Get admin/doctor phone for fallback
    let adminPhone: string | null = null;
    try {
      const admin = await getSingleAdmin();
      adminPhone = admin.phone;
    } catch (error) {
      console.warn("[CRON] Could not fetch admin phone for reminders");
    }

    // Process each appointment
    for (const appointment of upcomingAppointments) {
      try {
        await sendReminderForAppointment(appointment, adminPhone);
      } catch (error: any) {
        console.error(
          `[CRON] Failed to send reminder for appointment ${appointment.id}:`,
          error.message
        );
        // Continue with other appointments even if one fails
      }
    }
  } catch (error: any) {
    console.error("[CRON] Error checking reminders:", error);
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

  console.log(`[CRON] Sending reminder for appointment ${appointmentId}`);

  // Send patient reminder
  if (patientPhone) {
    try {
      // Send patient reminder
      // Note: body_1 is automatically set to patient phone number (type: "numbers") in sendPatientConfirmationMessage
      const patientResult = await sendPatientConfirmationMessage(patientPhone);

      if (patientResult.success) {
        console.log(
          `[CRON] ✅ Patient reminder sent: ${patientPhone} (Appointment: ${appointmentId})`
        );
      } else {
        console.error(
          `[CRON] ❌ Patient reminder failed: ${patientResult.error} (Appointment: ${appointmentId})`
        );
      }
    } catch (error: any) {
      console.error(
        `[CRON] Error sending patient reminder: ${error.message} (Appointment: ${appointmentId})`
      );
    }
  } else {
    console.warn(
      `[CRON] Patient phone not found for appointment ${appointmentId}`
    );
  }

  // Send doctor reminder
  if (doctorPhone) {
    try {
      const doctorResult = await sendDoctorNotificationMessage(doctorPhone);

      if (doctorResult.success) {
        console.log(
          `[CRON] ✅ Doctor reminder sent: ${doctorPhone} (Appointment: ${appointmentId})`
        );
      } else {
        console.error(
          `[CRON] ❌ Doctor reminder failed: ${doctorResult.error} (Appointment: ${appointmentId})`
        );
      }
    } catch (error: any) {
      console.error(
        `[CRON] Error sending doctor reminder: ${error.message} (Appointment: ${appointmentId})`
      );
    }
  } else {
    console.warn(
      `[CRON] Doctor phone not found for appointment ${appointmentId}`
    );
  }

  // Mark reminder as sent
  try {
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { reminderSent: true },
    });
    console.log(
      `[CRON] ✅ Reminder marked as sent for appointment ${appointmentId}`
    );
  } catch (error: any) {
    console.error(
      `[CRON] Failed to mark reminder as sent: ${error.message} (Appointment: ${appointmentId})`
    );
  }
}
