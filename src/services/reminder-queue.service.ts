/**
 * Reminder Queue Service
 * Lightweight in-memory job queue for appointment reminders
 * Jobs are persisted via database (Appointment.reminderSent flag) for reliability
 */

interface ReminderJob {
  appointmentId: string;
  scheduledAt: Date;
  priority?: number; // Lower number = higher priority
}

class ReminderQueue {
  private queue: ReminderJob[] = [];
  private processing: Set<string> = new Set(); // Track currently processing jobs
  private maxRetries = 3;

  /**
   * Enqueue a reminder job
   * Jobs are added to the queue and will be processed by the worker
   */
  enqueue(job: ReminderJob): void {
    // Avoid duplicate jobs for the same appointment
    if (this.queue.find((j) => j.appointmentId === job.appointmentId)) {
      return;
    }

    if (this.processing.has(job.appointmentId)) {
      return;
    }

    // Insert job in priority order (lower priority number = higher priority)
    const priority = job.priority || 0;
    let insertIndex = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if ((this.queue[i].priority || 0) > priority) {
        insertIndex = i;
        break;
      }
    }

    this.queue.splice(insertIndex, 0, job);
  }

  /**
   * Dequeue the next job to process
   * Returns null if queue is empty
   */
  dequeue(): ReminderJob | null {
    if (this.queue.length === 0) {
      return null;
    }

    const job = this.queue.shift()!;
    this.processing.add(job.appointmentId);
    return job;
  }

  /**
   * Mark a job as completed
   * Removes it from the processing set
   */
  complete(appointmentId: string): void {
    this.processing.delete(appointmentId);
  }

  /**
   * Mark a job as failed and retry if attempts remaining
   */
  fail(appointmentId: string, retry: boolean = true): void {
    this.processing.delete(appointmentId);
    // Note: Retry logic is handled at the worker level
    // Database state (reminderSent flag) ensures idempotency
  }

  /**
   * Get queue size
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Get number of jobs being processed
   */
  processingCount(): number {
    return this.processing.size;
  }

  /**
   * Check if a job is already in queue or being processed
   */
  hasJob(appointmentId: string): boolean {
    return (
      this.queue.some((j) => j.appointmentId === appointmentId) ||
      this.processing.has(appointmentId)
    );
  }

  /**
   * Clear the queue (useful for testing or cleanup)
   */
  clear(): void {
    this.queue = [];
    this.processing.clear();
  }
}

// Export singleton instance
export const reminderQueue = new ReminderQueue();
