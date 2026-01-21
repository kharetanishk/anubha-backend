import {
  sendPatientAppointmentEmail,
  sendDoctorAppointmentEmail,
} from "../email/appointment-email.service";

interface AppointmentNotificationData {
  appointment: {
    id: string;
    planName?: string;
    patient?: {
      name?: string;
      phone?: string;
      email?: string;
    };
    slot?: {
      startAt: Date;
      endAt?: Date;
    };
    startAt?: Date;
    endAt?: Date;
  };
}

/**
 * Send appointment confirmation email notifications
 * Errors in email sending do not break appointment confirmation
 * WhatsApp notifications are handled separately to preserve existing reminder logic
 */
export async function sendAppointmentConfirmationNotifications(
  data: AppointmentNotificationData
): Promise<void> {
  const { appointment } = data;

  // Extract appointment details
  const patientName = appointment.patient?.name || "Patient";
  const patientEmail = appointment.patient?.email;
  const planName = appointment.planName || "Consultation Plan";
  const slotStartTime = appointment.slot?.startAt || appointment.startAt;
  const slotEndTime = appointment.slot?.endAt || appointment.endAt;

  if (!slotStartTime) {
    console.error(
      "[EMAIL NOTIFICATION] ❌ Slot time not found, cannot send email notifications"
    );
    return;
  }

  const slotTimeDate = new Date(slotStartTime);
  const slotEndTimeDate = slotEndTime ? new Date(slotEndTime) : undefined;

  // Send Email notifications
  try {
    // Send patient email if email is available
    if (patientEmail) {
      const patientResult = await sendPatientAppointmentEmail({
        patientName,
        patientEmail,
        planName,
        slotStartTime: slotTimeDate,
        slotEndTime: slotEndTimeDate,
      });

      if (patientResult.success) {
        if (process.env.NODE_ENV === "development") {
          console.log(
            "[EMAIL NOTIFICATION] ✅ Patient email sent:",
            patientEmail
          );
        }
      } else {
        console.error(
          "[EMAIL NOTIFICATION] ❌ Patient email failed:",
          patientResult.error
        );
      }
    }

    // Always send doctor email
    const doctorResult = await sendDoctorAppointmentEmail({
      patientName,
      patientEmail: "", // Not needed for doctor email
      planName,
      slotStartTime: slotTimeDate,
      slotEndTime: slotEndTimeDate,
    });

    if (doctorResult.success) {
      if (process.env.NODE_ENV === "development") {
        console.log("[EMAIL NOTIFICATION] ✅ Doctor email sent");
      }
    } else {
      console.error(
        "[EMAIL NOTIFICATION] ❌ Doctor email failed:",
        doctorResult.error
      );
    }
  } catch (emailError: any) {
    console.error(
      "[EMAIL NOTIFICATION] ❌ Email notification failed (non-blocking):",
      emailError?.message || emailError
    );
  }
}
