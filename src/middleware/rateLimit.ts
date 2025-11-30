import rateLimit from "express-rate-limit";

export const otpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 100, // Max 5 OTP requests per window
  message: {
    success: false,
    message: "Too many OTP requests. Please wait a moment.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export const patientLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // allow 5 patient form submissions per minute
  message: {
    success: false,
    message: "Too many patient submissions. Please wait a moment.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});
