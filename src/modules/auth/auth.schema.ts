import { z } from "zod";

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^[0-9+ ]+$/, "Phone number contains invalid characters.")
  .transform((val) => val.replace(/\D/g, ""))
  .refine((val) => val.length === 10 || val.length === 12, {
    message: "Phone must be 10 digits or 12 digits with country code.",
  })
  .transform((val) => {
    if (val.length === 10) return "91" + val;
    return val;
  });

export const nameSchema = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters long.")
  .max(50, "Name must be less than 50 characters");

export const otpSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{4,6}$/, "OTP must be a 4–6 digit numeric code.");

export const sendRegisterOtpSchema = z.object({
  name: nameSchema,
  phone: phoneSchema,
});

export const verifyRegisterOtpSchema = z.object({
  name: nameSchema,
  phone: phoneSchema,
  otp: otpSchema,
});

export const sendLoginOtpSchema = z.object({
  phone: phoneSchema,
});

export const verifyLoginOtpSchema = z.object({
  phone: phoneSchema,
  otp: otpSchema,
});
