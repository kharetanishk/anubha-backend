import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import uploadRoutes from "./modules/upload/upload.routes";
import { multerErrorHandler } from "./middleware/multerErrorhandler";
import authRoutes from "./modules/auth/auth.routes";
import patientRoutes from "./modules/patient/patient.routes";
import { attachUser } from "./middleware/attachUser";
import slotRoutes from "./modules/slots/slots.routes";
import appointmentRoutes from "./modules/appointment/appointment.routes";
import rawBodyMiddleware from "./middleware/rawBody";
import { razorpayWebhookHandler } from "./modules/payment/payment.controller";
import paymentRoutes from "./modules/payment/payment.routes";
import adminRoutes from "./modules/admin/admin.routes";
import invoiceRoutes from "./modules/invoice/invoice.routes";
import testimonialsRoutes from "./modules/testimonials/testimonials.routes";
import prisma from "./database/prismaclient";
import { startAppointmentReminderCron } from "./cron/reminder";
import { testMsg91Connection } from "./services/whatsapp.service";
import { apiLogger } from "./middleware/apiLogger";
import { env, validateRazorpayConfig } from "./config/env";
// Email service (Resend) - no verification needed, handled by Resend SDK

// Environment variables are validated in ./config/env.ts
// This will throw an error if required variables are missing
const PORT = env.PORT;
const app = express();

app.use(cookieParser());

// CORS must be applied BEFORE other middleware
// CRITICAL: credentials: true allows cookies (auth_token) to be sent/received
// Production: Use CORS_ORIGINS environment variable, or fallback to FRONTEND_URL
// Development: Allow localhost and local network IPs
const getAllowedOrigins = (): (string | RegExp)[] => {
  const origins: (string | RegExp)[] = [];

  // Production: Use CORS_ORIGINS if set (comma-separated list)
  // Otherwise, use FRONTEND_URL as fallback
  if (process.env.CORS_ORIGINS) {
    const envOrigins = process.env.CORS_ORIGINS.split(",").map((origin) =>
      origin.trim()
    );
    origins.push(...envOrigins);
  } else if (
    process.env.FRONTEND_URL &&
    process.env.NODE_ENV === "production"
  ) {
    // Fallback to FRONTEND_URL in production if CORS_ORIGINS is not set
    origins.push(process.env.FRONTEND_URL.trim());
  }

  // Development: Allow localhost and local network
  if (process.env.NODE_ENV !== "production") {
    origins.push(
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://192.168.29.116:3000",
      /^http:\/\/192\.168\.\d+\.\d+:3000$/
    );
    // Also add FRONTEND_URL from env config (defaults to localhost:3000 in dev)
    const frontendUrl = env.FRONTEND_URL || process.env.FRONTEND_URL;
    if (frontendUrl) {
      const trimmedUrl = frontendUrl.trim();
      // Check if URL is already in origins (as string or would match a regex)
      const urlExists = origins.some(
        (origin) =>
          origin === trimmedUrl ||
          (typeof origin === "string" && origin === trimmedUrl)
      );
      if (!urlExists) {
        origins.push(trimmedUrl);
      }
    }
  }

  // In production, fail if no origins configured
  if (process.env.NODE_ENV === "production") {
    if (origins.length === 0) {
      throw new Error(
        "CORS_ORIGINS or FRONTEND_URL must be set in production environment"
      );
    }
    return origins;
  }

  // Development fallback
  return origins.length > 0 ? origins : ["http://localhost:3000"];
};

app.use(
  cors({
    origin: getAllowedOrigins(),
    credentials: true, // REQUIRED: Allows cookies (auth_token)
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
    exposedHeaders: ["Set-Cookie"],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  })
);

// Request body size limit: 20MB total
// Individual field sizes are validated by fieldSizeValidator middleware
app.use(express.json({ limit: "20mb" }));

// API Logger middleware - logs all API calls for debugging
app.use(apiLogger);

app.use(attachUser);

app.post("/api/payment/webhook", rawBodyMiddleware, razorpayWebhookHandler);

app.get("/api/health", (req: Request, res: Response) => {
  return res.json({
    message: "Anubha Nutrition Clinic Backend Connected Successfully!",
  });
});

// Development-only: Test MSG91 WhatsApp connection
if (process.env.NODE_ENV !== "production") {
  app.get("/api/test/whatsapp", async (req: Request, res: Response) => {
    try {
      const result = await testMsg91Connection();
      return res.status(result.success ? 200 : 400).json(result);
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || "Test failed",
      });
    }
  });
}

app.use("/api/auth", authRoutes);
app.use("/api/patients", patientRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/slots", slotRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/invoice", invoiceRoutes);
app.use("/api/testimonials", testimonialsRoutes);

app.use(multerErrorHandler);

/**
 * Validate Razorpay configuration
 */
function validatePaymentConfig() {
  // console.log("==========================================");
  // console.log("🔍 Validating Razorpay Configuration...");
  // console.log("==========================================");
  const razorpayValidation = validateRazorpayConfig();

  if (!razorpayValidation.isValid) {
    console.error("❌ Razorpay configuration validation failed:");
    razorpayValidation.errors.forEach((error, index) => {
      console.error(`  ${index + 1}. ${error}`);
    });
    console.error("==========================================");
    console.error(
      "Payment processing will not work without valid Razorpay configuration."
    );
    console.error(
      "Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in your .env file."
    );
    console.error("==========================================");
    throw new Error(
      `Razorpay configuration invalid: ${razorpayValidation.errors.join(", ")}`
    );
  }

  if (razorpayValidation.warnings.length > 0) {
    // console.warn("⚠️  Razorpay configuration warnings:");
    razorpayValidation.warnings.forEach((warning, index) => {
      // console.warn(`  ${index + 1}. ${warning}`);
    });
  }

  // console.log("✅ Razorpay configuration validated successfully");
  // console.log("  - Key ID: Set");
  // console.log("  - Key Secret: Set");
  if (env.RAZORPAY_WEBHOOK_SECRET) {
    // console.log("  - Webhook Secret: Set");
  } else {
    // console.log("  - Webhook Secret: Not set (webhook verification disabled)
    // ");
  }
  // console.log("==========================================");
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check database connection with automatic retry logic
 * Implements exponential backoff for transient connection errors
 * Useful for serverless databases (like Neon) that may "wake up" slowly
 */
async function checkDatabaseConnection(
  maxRetries: number = 5,
  initialDelay: number = 1000
): Promise<void> {
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // console.log("==========================================");
      // console.log(
      // `🔍 Testing database connection... (Attempt ${attempt}/${maxRetries})
      // `
      // );
      // console.log("==========================================");
      // Connect to database
      await prisma.$connect();
      // console.log("✅ Database is running and connected!");
      // Test query to ensure database is responsive
      await prisma.$queryRaw`SELECT 1`;
      // console.log("✅ Database connection test successful!");
      // console.log("==========================================");
      // Success! Exit the retry loop
      return;
    } catch (error: any) {
      lastError = error;
      const errorCode = error?.code || "";
      const errorMessage = error?.message || String(error);

      console.error("==========================================");
      console.error(
        `❌ Database connection failed (Attempt ${attempt}/${maxRetries})`
      );
      console.error("Error Code:", errorCode);
      console.error("Error Message:", errorMessage);
      console.error("==========================================");

      // Check if it's a connection error that might be transient
      const isTransientError =
        errorCode === "P1001" || // Can't reach database server
        errorCode === "P1002" || // Database timeout
        errorCode === "P1017" || // Server closed connection
        errorMessage.includes("ECONNREFUSED") ||
        errorMessage.includes("ETIMEDOUT") ||
        errorMessage.includes("Can't reach database");

      if (isTransientError && attempt < maxRetries) {
        // Calculate delay with exponential backoff
        const delay = initialDelay * Math.pow(2, attempt - 1);
        // console.log(
        // `🔄 Retrying in ${
        // delay / 1000
        // } seconds... (Database may be waking up)
        // `
        // );
        // console.log("==========================================");
        await sleep(delay);
      } else if (attempt >= maxRetries) {
        // Max retries reached
        console.error("==========================================");
        console.error("❌ Max retry attempts reached");
        console.error("==========================================");
        console.error("Please check:");
        console.error("1. DATABASE_URL in .env file is correct");
        console.error("2. Database server is running and accessible");
        console.error("3. Network connection is stable");
        console.error("4. Firewall/security groups allow connections");
        console.error(
          "Expected format: postgresql://user:password@host:port/database"
        );
        console.error("==========================================");
        throw lastError;
      } else {
        // Non-transient error, fail immediately
        console.error("==========================================");
        console.error("❌ Non-recoverable database error");
        console.error("==========================================");
        throw error;
      }
    }
  }

  // If we get here, throw the last error
  throw lastError;
}

/**
 * Database connection health check middleware
 * Automatically attempts reconnection if database connection is lost
 */
async function ensureDatabaseConnection(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    // Quick health check
    await prisma.$queryRaw`SELECT 1`;
    next();
  } catch (error: any) {
    const errorCode = error?.code || "";

    // Check if it's a connection error
    if (
      errorCode === "P1001" ||
      errorCode === "P1002" ||
      errorCode === "P1017"
    ) {
      // console.log("[DATABASE] Connection lost, attempting to reconnect...");
      try {
        // Attempt to reconnect (with single retry)
        await prisma.$disconnect();
        await sleep(1000);
        await prisma.$connect();
        await prisma.$queryRaw`SELECT 1`;

        // console.log("[DATABASE] ✅ Reconnection successful");
        next();
      } catch (reconnectError) {
        console.error("[DATABASE] ❌ Reconnection failed:", reconnectError);
        return res.status(503).json({
          success: false,
          error: "Database connection unavailable. Please try again.",
          code: "DB_CONNECTION_ERROR",
          retryable: true,
        });
      }
    } else {
      // Other database errors
      next(error);
    }
  }
}

// Start server after database check
async function startServer() {
  try {
    // Validate payment configuration
    validatePaymentConfig();

    // Check database connection with retry logic
    await checkDatabaseConnection();

    // Apply database health check middleware to all routes
    app.use(ensureDatabaseConnection);

    // Start appointment reminder cron job
    startAppointmentReminderCron();

    // Email service (Resend) is ready - no connection verification needed

    // Start Express server
    app.listen(PORT, "0.0.0.0", () => {
      if (env.NODE_ENV === "development") {
        console.log("==========================================");
        console.log(`🚀 Server running on http://localhost:${PORT}`);
        console.log(`📝 Environment: ${env.NODE_ENV}`);
        console.log("🔧 Development Mode Configuration:");
        console.log(
          `   - Frontend URL: ${env.FRONTEND_URL || "http://localhost:3000"}`
        );
        console.log("   - Cookie settings:");
        console.log("     * httpOnly: true");
        console.log("     * secure: false (localhost allowed)");
        console.log("     * sameSite: lax");
        console.log("   - CORS: localhost:3000 enabled");
        console.log("   - Allowed origins:");
        const origins = getAllowedOrigins();
        origins.forEach((origin) => {
          console.log(`     * ${origin}`);
        });
        console.log("==========================================");
      }
      // Production: Minimal logging
      if (env.NODE_ENV === "production") {
        console.log(`Server started on port ${PORT}`);
      }
    });
  } catch (error: any) {
    console.error("==========================================");
    console.error("❌ Failed to start server");
    console.error("==========================================");
    console.error("Error:", error.message);
    console.error("==========================================");
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler
 * Properly closes database connections on server shutdown
 */
async function gracefulShutdown(signal: string) {
  // console.log("\n==========================================");
  // console.log(`⚠️  ${signal} signal received: closing server gracefully`);
  // console.log("==========================================");
  try {
    // Close database connection
    // console.log("Disconnecting from database...");
    await prisma.$disconnect();
    // console.log("✅ Database disconnected");
    // console.log("==========================================");
    // console.log("✅ Server closed gracefully");
    // console.log("==========================================");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error during graceful shutdown:", error);
    process.exit(1);
  }
}

// Register shutdown handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("==========================================");
  console.error("❌ Uncaught Exception:");
  console.error(error);
  console.error("==========================================");
  gracefulShutdown("uncaughtException");
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("==========================================");
  console.error("❌ Unhandled Promise Rejection:");
  console.error("Promise:", promise);
  console.error("Reason:", reason);
  console.error("==========================================");
});

// Start the application
startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
