/**
 * Phone number normalization utility
 * Normalizes phone numbers to a consistent format at database level
 * Handles formats like: "919713885582", "9713885582", "+919713885582"
 *
 * Normalization rules:
 * - Remove all non-digit characters
 * - If starts with country code 91 and has 12 digits, keep as is
 * - If has 10 digits, prepend country code 91
 * - Result: Always 12 digits starting with 91
 */
export function normalizePhoneNumber(phone: string): string {
  if (!phone || typeof phone !== "string") {
    throw new Error("Phone number must be a non-empty string");
  }

  // Remove all non-digit characters
  let digits = phone.replace(/\D/g, "");

  // Validate we have digits
  if (digits.length === 0) {
    throw new Error("Phone number must contain at least one digit");
  }

  // If starts with country code 91 and has 12 digits, keep as is
  if (digits.startsWith("91") && digits.length === 12) {
    return digits;
  }

  // If has 10 digits, prepend country code 91
  if (digits.length === 10) {
    return `91${digits}`;
  }

  // If already has 12 digits but doesn't start with 91, assume it's already normalized
  if (digits.length === 12) {
    return digits;
  }

  // Invalid length
  throw new Error(
    `Invalid phone number length: ${digits.length}. Expected 10 or 12 digits.`
  );
}

/**
 * Check if two phone numbers are equivalent after normalization
 */
export function arePhoneNumbersEqual(phone1: string, phone2: string): boolean {
  try {
    const normalized1 = normalizePhoneNumber(phone1);
    const normalized2 = normalizePhoneNumber(phone2);
    return normalized1 === normalized2;
  } catch {
    return false;
  }
}
