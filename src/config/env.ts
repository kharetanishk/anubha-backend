import dotenv from "dotenv";

// Load environment variables
dotenv.config();

/**
 * Environment Variable Validation
 * Validates all required environment variables at startup
 * Prevents runtime failures due to missing configuration
 */

interface EnvConfig {
  // Database
  DATABASE_URL: string;

  // Server
  PORT: number;
  NODE_ENV: "development" | "production" | "test";

  // Authentication
  ACCESS_TOKEN_SECRET: string;

  // Payment Gateway (Razorpay)
  RAZORPAY_KEY_ID: string;
  RAZORPAY_KEY_SECRET: string;
  RAZORPAY_WEBHOOK_SECRET?: string; // Optional but recommended

  // File Storage (Cloudinary)
  CLOUDINARY_CLOUD_NAME: string;
  CLOUDINARY_API_KEY: string;
  CLOUDINARY_API_SECRET: string;

  // WhatsApp Messaging (MSG91)
  MSG91_AUTH_KEY: string;
  MSG91_INTEGRATED_NUMBER?: string; // Optional, has default

  // MSG91 Template IDs for SMS/WhatsApp
  MSG91_TEMPLATE_BOOKING_CONFIRMATION?: string; // Booking confirmation template
  MSG91_TEMPLATE_REMINDER?: string; // Reminder (1 hour before) template
  MSG91_TEMPLATE_LAST_MINUTE?: string; // Last-minute combined confirmation + reminder template
  MSG91_TEMPLATE_OTP?: string; // OTP template (if using MSG91 for OTP)

  // Optional/Development only
  WHATSAPP_PHONE_NUMBER_ID?: string;
  META_ACCESS_TOKEN?: string;

  // Frontend URL (required in production for password reset links, etc.)
  FRONTEND_URL?: string;

  // CORS Origins (comma-separated list of allowed origins for production)
  CORS_ORIGINS?: string;
}

interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  config: Partial<EnvConfig>;
}

/**
 * Validate environment variables
 * Returns validation result with errors and warnings
 */
export function validateEnv(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const config: Partial<EnvConfig> = {};

  // ============================================
  // REQUIRED VARIABLES
  // ============================================

  // Database
  if (!process.env.DATABASE_URL) {
    errors.push("DATABASE_URL is required");
  } else {
    config.DATABASE_URL = process.env.DATABASE_URL;
    // Validate DATABASE_URL format (should start with postgresql://)
    if (
      !config.DATABASE_URL.startsWith("postgresql://") &&
      !config.DATABASE_URL.startsWith("postgres://")
    ) {
      errors.push("DATABASE_URL must be a valid PostgreSQL connection string");
    }
  }

  // Authentication
  if (!process.env.ACCESS_TOKEN_SECRET) {
    errors.push("ACCESS_TOKEN_SECRET is required for JWT token generation");
  } else {
    config.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;
    // Validate token secret length (should be at least 32 characters for security)
    if (config.ACCESS_TOKEN_SECRET.length < 32) {
      warnings.push(
        "ACCESS_TOKEN_SECRET should be at least 32 characters long for security"
      );
    }
  }

  // Payment Gateway (Razorpay)
  if (!process.env.RAZORPAY_KEY_ID) {
    errors.push("RAZORPAY_KEY_ID is required for payment processing");
  } else {
    config.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
  }

  if (!process.env.RAZORPAY_KEY_SECRET) {
    errors.push("RAZORPAY_KEY_SECRET is required for payment processing");
  } else {
    config.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
  }

  // Validate Razorpay configuration
  if (config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET) {
    // Razorpay key IDs typically start with "rzp_" and are 20 characters
    if (!config.RAZORPAY_KEY_ID.startsWith("rzp_")) {
      warnings.push(
        "RAZORPAY_KEY_ID format may be invalid (should start with 'rzp_')"
      );
    }
    if (config.RAZORPAY_KEY_ID.length < 20) {
      warnings.push(
        "RAZORPAY_KEY_ID format may be invalid (should be at least 20 characters)"
      );
    }
  }

  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    warnings.push(
      "RAZORPAY_WEBHOOK_SECRET is not set. Webhook signature verification will be disabled."
    );
  } else {
    config.RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
  }

  // File Storage (Cloudinary)
  if (!process.env.CLOUDINARY_CLOUD_NAME) {
    errors.push("CLOUDINARY_CLOUD_NAME is required for file uploads");
  } else {
    config.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
  }

  if (!process.env.CLOUDINARY_API_KEY) {
    errors.push("CLOUDINARY_API_KEY is required for file uploads");
  } else {
    config.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
  }

  if (!process.env.CLOUDINARY_API_SECRET) {
    errors.push("CLOUDINARY_API_SECRET is required for file uploads");
  } else {
    config.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
  }

  // WhatsApp Messaging (MSG91)
  if (!process.env.MSG91_AUTH_KEY) {
    errors.push("MSG91_AUTH_KEY is required for WhatsApp messaging");
  } else {
    config.MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY;
    // MSG91 auth keys are typically 40 characters
    if (config.MSG91_AUTH_KEY.length < 30) {
      warnings.push(
        "MSG91_AUTH_KEY format may be invalid (should be at least 30 characters)"
      );
    }
  }

  // Optional: MSG91 Integrated Number (has default)
  if (process.env.MSG91_INTEGRATED_NUMBER) {
    config.MSG91_INTEGRATED_NUMBER = process.env.MSG91_INTEGRATED_NUMBER;
  }

  // Optional: MSG91 Template IDs (templates can be configured later)
  if (process.env.MSG91_TEMPLATE_BOOKING_CONFIRMATION) {
    config.MSG91_TEMPLATE_BOOKING_CONFIRMATION =
      process.env.MSG91_TEMPLATE_BOOKING_CONFIRMATION;
  }
  if (process.env.MSG91_TEMPLATE_REMINDER) {
    config.MSG91_TEMPLATE_REMINDER = process.env.MSG91_TEMPLATE_REMINDER;
  }
  if (process.env.MSG91_TEMPLATE_LAST_MINUTE) {
    config.MSG91_TEMPLATE_LAST_MINUTE = process.env.MSG91_TEMPLATE_LAST_MINUTE;
  }
  if (process.env.MSG91_TEMPLATE_OTP) {
    config.MSG91_TEMPLATE_OTP = process.env.MSG91_TEMPLATE_OTP;
  }

  // ============================================
  // OPTIONAL VARIABLES
  // ============================================

  // Server Port
  const port = process.env.PORT ? Number(process.env.PORT) : 4000;
  if (isNaN(port) || port < 1 || port > 65535) {
    errors.push(
      `PORT must be a valid number between 1 and 65535, got: ${process.env.PORT}`
    );
  } else {
    config.PORT = port;
  }

  // Node Environment - Default to development for local dev
  const nodeEnv = (process.env.NODE_ENV || "development") as
    | "development"
    | "production"
    | "test";
  if (!["development", "production", "test"].includes(nodeEnv)) {
    warnings.push(
      `NODE_ENV should be 'development', 'production', or 'test', got: ${nodeEnv}`
    );
  }
  config.NODE_ENV = nodeEnv;

  // Log environment in development
  if (nodeEnv === "development") {
    console.log("🔧 Running in DEVELOPMENT mode");
    console.log(
      "   - Frontend URL:",
      config.FRONTEND_URL || "http://localhost:3000"
    );
    console.log("   - Cookies: httpOnly=true, secure=false, sameSite=lax");
    console.log("   - CORS: localhost:3000 enabled");
  }

  // Optional: Meta WhatsApp (for testing)
  if (process.env.WHATSAPP_PHONE_NUMBER_ID) {
    config.WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
  }

  if (process.env.META_ACCESS_TOKEN) {
    config.META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
  }

  // Frontend URL - required in production, defaults to localhost:3000 in development
  if (process.env.FRONTEND_URL) {
    config.FRONTEND_URL = process.env.FRONTEND_URL;
  } else if (process.env.NODE_ENV === "production") {
    warnings.push(
      "FRONTEND_URL is not set. Password reset links may not work correctly in production."
    );
  } else {
    // Default to localhost:3000 in development
    config.FRONTEND_URL = "http://localhost:3000";
  }

  // CORS Origins - recommended in production
  if (process.env.CORS_ORIGINS) {
    config.CORS_ORIGINS = process.env.CORS_ORIGINS;
  } else if (process.env.NODE_ENV === "production") {
    warnings.push(
      "CORS_ORIGINS is not set. CORS will only allow localhost in production. Set CORS_ORIGINS to your production frontend URL(s)."
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    config: config as Partial<EnvConfig>,
  };
}

/**
 * Validate and get environment configuration
 * Throws error if validation fails
 */
export function getEnvConfig(): EnvConfig {
  const result = validateEnv();

  if (!result.isValid) {
    console.error("==========================================");
    console.error("❌ ENVIRONMENT VARIABLE VALIDATION FAILED");
    console.error("==========================================");
    console.error("Missing or invalid required environment variables:");
    result.errors.forEach((error, index) => {
      console.error(`  ${index + 1}. ${error}`);
    });
    console.error("==========================================");
    console.error(
      "Please check your .env file and ensure all required variables are set."
    );
    console.error("==========================================");
    throw new Error(
      `Environment validation failed: ${result.errors.join(", ")}`
    );
  }

  // Log warnings if any
  if (result.warnings.length > 0) {
    // console.warn("==========================================");
    // console.warn("⚠️  ENVIRONMENT VARIABLE WARNINGS");
    // console.warn("==========================================");
    // result.warnings.forEach((warning, index) => {
    //   console.warn(`  ${index + 1}. ${warning}`);
    // });
    // console.warn("==========================================");
  }

  // Log success
  // console.log("==========================================");
  // console.log("✅ ENVIRONMENT VARIABLES VALIDATED");
  // console.log("==========================================");
  // console.log("Required variables: ✓");
  // if (result.warnings.length > 0) {
  //   console.log(`Warnings: ${result.warnings.length} (see above)`);
  // } else {
  //   console.log("Warnings: None");
  // }
  // console.log("==========================================");

  return result.config as EnvConfig;
}

/**
 * Validate Razorpay configuration specifically
 * Can be called separately to test Razorpay setup
 */
export function validateRazorpayConfig(): {
  isValid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!process.env.RAZORPAY_KEY_ID) {
    errors.push("RAZORPAY_KEY_ID is not set");
  } else {
    if (!process.env.RAZORPAY_KEY_ID.startsWith("rzp_")) {
      warnings.push(
        "RAZORPAY_KEY_ID format may be invalid (should start with 'rzp_')"
      );
    }
    if (process.env.RAZORPAY_KEY_ID.length < 20) {
      warnings.push(
        "RAZORPAY_KEY_ID format may be invalid (should be at least 20 characters)"
      );
    }
  }

  if (!process.env.RAZORPAY_KEY_SECRET) {
    errors.push("RAZORPAY_KEY_SECRET is not set");
  } else {
    if (process.env.RAZORPAY_KEY_SECRET.length < 30) {
      warnings.push(
        "RAZORPAY_KEY_SECRET format may be invalid (should be at least 30 characters)"
      );
    }
  }

  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    warnings.push(
      "RAZORPAY_WEBHOOK_SECRET is not set. Webhook signature verification will be disabled."
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

// Export validated config (will be populated after validation)
export const env = getEnvConfig();
