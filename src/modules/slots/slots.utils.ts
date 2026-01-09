import {
  OFFLINE_SLOT_TEMPLATES,
  ONLINE_SLOT_TEMPLATES,
  IST_TIMEZONE_OFFSET,
  APPOINTMENT_MODES,
  AppointmentModeType,
} from "./slots.constants";
import { formatInTimeZone, zonedTimeToUtc } from "date-fns-tz";

const BUSINESS_TIMEZONE = "Asia/Kolkata";

/**
 * Build a JS Date in UTC from a YYYY-MM-DD + HH:mm (24h) in IST.
 * Uses zonedTimeToUtc to properly convert IST time to UTC Date object.
 */
export function buildDateInIST(dateStr: string, timeStr: string): Date {
  // Create date string in IST: "2025-11-23T10:00:00"
  const istDateTimeString = `${dateStr}T${timeStr}:00`;
  // Convert IST time to UTC Date object
  return zonedTimeToUtc(istDateTimeString, BUSINESS_TIMEZONE);
}

/**
 * Returns YYYY-MM-DD from a Date object in IST timezone.
 * Uses formatInTimeZone to ensure consistent date string regardless of server timezone.
 */
export function toDateString(d: Date): string {
  return formatInTimeZone(d, BUSINESS_TIMEZONE, "yyyy-MM-dd");
}

/**
 * Generate 40-minute slot Date objects for a given date + mode.
 * Uses fixed templates from frontend.
 */
export function generateSlotsForDate(
  dateStr: string,
  mode: AppointmentModeType
) {
  const templates =
    mode === APPOINTMENT_MODES.IN_PERSON
      ? OFFLINE_SLOT_TEMPLATES
      : ONLINE_SLOT_TEMPLATES;

  return templates.map(({ start, end }) => ({
    startAt: buildDateInIST(dateStr, start),
    endAt: buildDateInIST(dateStr, end),
  }));
}

/**
 * Format slot Date objects into strings like "10:00 AM – 10:40 AM"
 * for returning to frontend.
 * Uses formatInTimeZone to ensure consistent formatting in IST regardless of server timezone.
 */
export function formatSlotLabel(startAt: Date, endAt: Date): string {
  const start = formatInTimeZone(startAt, BUSINESS_TIMEZONE, "h:mm a");
  const end = formatInTimeZone(endAt, BUSINESS_TIMEZONE, "h:mm a");

  return `${start} – ${end}`;
}

/**
 * Utility to check if a JS Date (slot start) is already in the past.
 * Both date and Date.now() are UTC timestamps internally, so direct comparison works.
 * The slot date was created from IST time using zonedTimeToUtc, so this comparison
 * effectively checks if the slot time in IST has passed the current IST time.
 */
export function isPastDate(date: Date) {
  // Compare UTC timestamps - both date and Date.now() are UTC internally
  // Since slot dates are created from IST times using zonedTimeToUtc,
  // this comparison correctly checks if the IST time has passed
  return date.getTime() < Date.now();
}
