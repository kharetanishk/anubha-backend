/**
 * REMINDER CRON JOB (LIGHTWEIGHT)
 * 
 * IMPORTANT: This cron job ONLY enqueues reminder jobs to the queue.
 * It does NOT send WhatsApp or Email messages directly.
 * All heavy operations are handled by the background worker.
 * 
 * Responsibilities:
 * - Query database for appointments needing reminders
 * - Enqueue jobs to the reminder queue
 * - Return immediately (non-blocking)
 */

import cron from "node-cron";
import prisma from "../database/prismaclient";
import { reminderQueue } from "../services/reminder-queue.service";

const globalForCron = globalThis as unknown as {
  __appointmentReminderCronStarted?: boolean;
};

/**
 * Appointment Reminder Cron Job (LIGHTWEIGHT)
 * 
 * Runs every 10 minutes to check for appointments with reminderTime in the current window.
 * Only enqueues jobs to the reminder queue - does NOT send messages directly.
 * 
 * Worker handles all heavy operations (WhatsApp, Email sending).
 */
export function startAppointmentReminderCron() {
  // Guard to prevent multiple cron jobs
  if (globalForCron.__appointmentReminderCronStarted) {
    return;
  }
  globalForCron.__appointmentReminderCronStarted = true;

  // Run every 10 minutes: */10 * * * *
  cron.schedule("*/10 * * * *", async () => {
    try {
      await enqueueReminderJobs();
    } catch (error: any) {
      console.error("[CRON] Error in appointment reminder cron:", error);
      // Continue running even if one execution fails
    }
  });

  if (process.env.NODE_ENV === "development") {
    console.log("[CRON] ✅ Appointment reminder cron job started (lightweight)");
  }
}

/**
 * Enqueue reminder jobs for appointments needing reminders
 * 
 * LIGHTWEIGHT OPERATION: Only queries database and enqueues jobs.
 * Returns immediately - does NOT send any messages.
 * 
 * Worker processes jobs asynchronously in the background.
 */
async function enqueueReminderJobs() {
  try {
    // Get current time in UTC
    // All dates in database are stored in UTC, so we compare UTC times directly
    // The reminderTime field is calculated as 1 hour before slot time (both in UTC)
    const now = new Date();
    now.setSeconds(0, 0); // Round down to minute (seconds & ms = 0)

    // Calculate time window: reminderTime should be between (now - 10 minutes) and now
    // This makes it robust against small drifts - reminders are sent once even if cron runs slightly late
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

    // Find appointments that need reminders
    // 1. Are CONFIRMED
    // 2. Reminder not already sent
    // 3. Have reminderTime within the current window (between 10 minutes ago and now)
    // 4. reminderTime is not null (appointment has a valid slot time)
    // 
    // NOTE: Only select minimal fields - heavy data loading is done by worker
    const upcomingAppointments = await prisma.appointment.findMany({
      where: {
        status: "CONFIRMED",
        reminderSent: false,
        reminderTime: {
          gte: tenMinutesAgo,
          lte: now,
        },
      },
      select: {
        id: true,
        reminderTime: true,
      },
    });

    if (upcomingAppointments.length === 0) {
      // No appointments to remind - this is normal
      return;
    }

    // Enqueue each appointment as a job
    let enqueuedCount = 0;
    for (const appointment of upcomingAppointments) {
      // Skip if job already in queue or being processed
      if (reminderQueue.hasJob(appointment.id)) {
        continue;
      }

      // Enqueue job for processing by worker
      reminderQueue.enqueue({
        appointmentId: appointment.id,
        scheduledAt: appointment.reminderTime || new Date(),
        priority: 0, // Standard priority
      });
      enqueuedCount++;
    }

    if (process.env.NODE_ENV === "development" && enqueuedCount > 0) {
      console.log(
        `[CRON] ✅ Enqueued ${enqueuedCount} reminder job(s) (queue size: ${reminderQueue.size()})`
      );
    }
  } catch (error: any) {
    console.error("[CRON] ❌ Error enqueueing reminder jobs:", error.message);
    // Don't throw - allow cron to continue running
  }
}
