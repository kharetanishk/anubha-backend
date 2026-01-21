/**
 * Reminder Worker Service
 * Background worker that processes reminder jobs from the queue
 * Handles sending WhatsApp and Email reminders
 */

import prisma from "../database/prismaclient";
import { reminderQueue } from "../services/reminder-queue.service";
import {
  sendReminderMessage,
  formatDateForTemplate,
  formatTimeForTemplate,
} from "../services/whatsapp.service";
import { sendReminderEmail } from "../services/email/appointment-email.service";
import { getSingleAdmin } from "../modules/slots/slots.services";

const globalForWorker = globalThis as unknown as {
  __reminderWorkerStarted?: boolean;
  __reminderWorkerInterval?: NodeJS.Timeout;
};

/**
 * Worker configuration
 */
const WORKER_CONFIG = {
  POLL_INTERVAL_MS: 2000, // Poll queue every 2 seconds
  MAX_CONCURRENT_JOBS: 5, // Process max 5 jobs concurrently
  JOB_TIMEOUT_MS: 30000, // 30 second timeout per job
};

/**
 * Start the reminder worker
 * Processes jobs from the queue in the background
 */
export function startReminderWorker(): void {
  // Guard to prevent multiple workers
  if (globalForWorker.__reminderWorkerStarted) {
    return;
  }
  globalForWorker.__reminderWorkerStarted = true;

  // Start processing loop
  processReminderJobs();

  if (process.env.NODE_ENV === "development") {
    console.log(
      `[REMINDER WORKER] ✅ Started reminder worker (polling every ${WORKER_CONFIG.POLL_INTERVAL_MS}ms)`
    );
  }
}

/**
 * Main worker loop
 * Polls the queue and processes jobs
 */
async function processReminderJobs() {
  while (true) {
    try {
      // Process jobs up to MAX_CONCURRENT_JOBS
      const jobsToProcess: string[] = [];
      for (
        let i = 0;
        i < WORKER_CONFIG.MAX_CONCURRENT_JOBS &&
        reminderQueue.processingCount() < WORKER_CONFIG.MAX_CONCURRENT_JOBS;
        i++
      ) {
        const job = reminderQueue.dequeue();
        if (!job) {
          break;
        }
        jobsToProcess.push(job.appointmentId);
        // Process job asynchronously (don't await)
        processReminderJob(job).catch((error) => {
          console.error(
            `[REMINDER WORKER] ❌ Error processing job ${job.appointmentId}:`,
            error
          );
          reminderQueue.fail(job.appointmentId, false);
        });
      }

      // Wait before next poll
      await sleep(WORKER_CONFIG.POLL_INTERVAL_MS);
    } catch (error: any) {
      console.error("[REMINDER WORKER] ❌ Error in worker loop:", error);
      // Continue processing even if one iteration fails
      await sleep(WORKER_CONFIG.POLL_INTERVAL_MS);
    }
  }
}

/**
 * Process a single reminder job
 * Handles sending WhatsApp and Email reminders
 */
async function processReminderJob(job: {
  appointmentId: string;
  scheduledAt: Date;
}): Promise<void> {
  const { appointmentId } = job;
  const startTime = Date.now();

  try {
    // Fetch appointment details from database
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
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

    if (!appointment) {
      console.error(
        `[REMINDER WORKER] ❌ Appointment not found: ${appointmentId}`
      );
      reminderQueue.fail(appointmentId);
      return;
    }

    // Check if reminder already sent (idempotency check)
    if (appointment.reminderSent) {
      // Reminder already sent, skip
      reminderQueue.complete(appointmentId);
      return;
    }

    // Check if appointment is still CONFIRMED
    if (appointment.status !== "CONFIRMED") {
      // Appointment status changed, skip reminder
      reminderQueue.complete(appointmentId);
      return;
    }

    // Get slot time for reminder
    const slotStartTime = appointment.slot?.startAt || appointment.startAt;
    const slotEndTime = appointment.slot?.endAt || appointment.endAt;

    if (!slotStartTime) {
      // No slot time, mark as sent to prevent retries
      await prisma.appointment.updateMany({
        where: {
          id: appointmentId,
          reminderSent: false,
        },
        data: { reminderSent: true },
      });
      reminderQueue.complete(appointmentId);
      return;
    }

    const slotStartTimeDate = new Date(slotStartTime);
    const slotEndTimeDate = slotEndTime ? new Date(slotEndTime) : undefined;
    const patientName = appointment.patient?.name || "Patient";
    const patientPhone = appointment.patient?.phone;
    const patientEmail = appointment.patient?.email;

    // Send patient reminders (WhatsApp + Email)
    let patientWhatsAppSuccess = false;

    // Send WhatsApp reminder to patient
    if (patientPhone) {
      try {
        const patientResult = await sendReminderMessage(
          patientPhone,
          slotStartTimeDate,
          patientName,
          slotEndTimeDate
        );

        if (patientResult.success) {
          patientWhatsAppSuccess = true;
          if (process.env.NODE_ENV === "development") {
            console.log(
              `[REMINDER WORKER] ✅ Patient WhatsApp reminder sent: ${appointmentId}`
            );
          }
        } else {
          console.error(
            `[REMINDER WORKER] ❌ Patient WhatsApp reminder failed: ${appointmentId}`,
            patientResult.error
          );
        }
      } catch (error: any) {
        console.error(
          `[REMINDER WORKER] ❌ Error sending patient WhatsApp reminder: ${appointmentId}`,
          error.message
        );
      }
    } else {
      // No phone number, treat as success to prevent infinite retries
      patientWhatsAppSuccess = true;
    }

    // Send Email reminder to patient (non-blocking)
    if (patientEmail) {
      try {
        const patientEmailResult = await sendReminderEmail({
          name: patientName,
          email: patientEmail,
          slotStartTime: slotStartTimeDate,
          slotEndTime: slotEndTimeDate,
        });

        if (patientEmailResult.success) {
          if (process.env.NODE_ENV === "development") {
            console.log(
              `[REMINDER WORKER] ✅ Patient email reminder sent: ${appointmentId}`
            );
          }
        } else {
          console.error(
            `[REMINDER WORKER] ❌ Patient email reminder failed: ${appointmentId}`,
            patientEmailResult.error
          );
        }
      } catch (error: any) {
        console.error(
          `[REMINDER WORKER] ❌ Error sending patient email reminder: ${appointmentId}`,
          error.message
        );
      }
    }

    // Send admin reminders (WhatsApp + Email) - non-blocking
    try {
      const admin = await getSingleAdmin();
      const adminPhone = admin.phone || "919713885582";
      const adminName = admin.name || "Admin";
      const adminEmail = admin.email;

      // Send WhatsApp reminder to admin
      try {
        const adminResult = await sendReminderMessage(
          adminPhone,
          slotStartTimeDate,
          adminName,
          slotEndTimeDate
        );

        if (adminResult.success) {
          if (process.env.NODE_ENV === "development") {
            console.log(
              `[REMINDER WORKER] ✅ Admin WhatsApp reminder sent: ${appointmentId}`
            );
          }
        } else {
          console.error(
            `[REMINDER WORKER] ❌ Admin WhatsApp reminder failed: ${appointmentId}`,
            adminResult.error
          );
        }
      } catch (error: any) {
        console.error(
          `[REMINDER WORKER] ❌ Error sending admin WhatsApp reminder: ${appointmentId}`,
          error.message
        );
      }

      // Send Email reminder to admin (non-blocking)
      if (adminEmail) {
        try {
          const adminEmailResult = await sendReminderEmail({
            name: adminName,
            email: adminEmail,
            slotStartTime: slotStartTimeDate,
            slotEndTime: slotEndTimeDate,
          });

          if (adminEmailResult.success) {
            if (process.env.NODE_ENV === "development") {
              console.log(
                `[REMINDER WORKER] ✅ Admin email reminder sent: ${appointmentId}`
              );
            }
          } else {
            console.error(
              `[REMINDER WORKER] ❌ Admin email reminder failed: ${appointmentId}`,
              adminEmailResult.error
            );
          }
        } catch (error: any) {
          console.error(
            `[REMINDER WORKER] ❌ Error sending admin email reminder: ${appointmentId}`,
            error.message
          );
        }
      }
    } catch (error: any) {
      console.error(
        `[REMINDER WORKER] ❌ Error sending admin reminders: ${appointmentId}`,
        error.message
      );
    }

    // Mark reminder as sent if patient WhatsApp was successful (or phone missing)
    // Use atomic update to prevent race conditions
    if (patientWhatsAppSuccess) {
      try {
        const updateResult = await prisma.appointment.updateMany({
          where: {
            id: appointmentId,
            reminderSent: false, // Only update if not already sent
          },
          data: { reminderSent: true },
        });

        if (updateResult.count > 0) {
          const duration = Date.now() - startTime;
          if (process.env.NODE_ENV === "development") {
            console.log(
              `[REMINDER WORKER] ✅ Reminder completed: ${appointmentId} (${duration}ms)`
            );
          }
        } else {
          // Reminder was already sent by another worker instance (race condition handled)
          if (process.env.NODE_ENV === "development") {
            console.log(
              `[REMINDER WORKER] ⚠️ Reminder already sent (duplicate prevented): ${appointmentId}`
            );
          }
        }
      } catch (error: any) {
        console.error(
          `[REMINDER WORKER] ❌ Failed to mark reminder as sent: ${appointmentId}`,
          error.message
        );
        // Don't mark as complete - will retry
        reminderQueue.fail(appointmentId);
        return;
      }
    } else {
      // Patient WhatsApp failed, don't mark as sent - will retry
      reminderQueue.fail(appointmentId);
      return;
    }

    // Mark job as complete
    reminderQueue.complete(appointmentId);
  } catch (error: any) {
    console.error(
      `[REMINDER WORKER] ❌ Error processing reminder job: ${appointmentId}`,
      error
    );
    reminderQueue.fail(appointmentId);
  }
}

/**
 * Sleep utility function
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get worker statistics (for monitoring/debugging)
 */
export function getWorkerStats() {
  return {
    queueSize: reminderQueue.size(),
    processingCount: reminderQueue.processingCount(),
    isRunning: globalForWorker.__reminderWorkerStarted || false,
  };
}
