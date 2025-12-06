import express, { Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
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
import prisma from "./database/prismaclient";
import { startAppointmentReminderCron } from "./cron/reminder";
import { testMsg91Connection } from "./services/whatsapp.service";
import { apiLogger } from "./middleware/apiLogger";

dotenv.config();

const PORT = Number(process.env.PORT) || 4000;
const app = express();

app.use(cookieParser());

// CORS must be applied BEFORE other middleware
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://192.168.29.116:3000",
      /^http:\/\/192\.168\.\d+\.\d+:3000$/,
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["Set-Cookie"],
  })
);

app.use(express.json({ limit: "20mb" }));

// API Logger middleware - logs all API calls for debugging
app.use(apiLogger);

app.use(attachUser);

app.post("/api/payment/webhook", rawBodyMiddleware, razorpayWebhookHandler);

app.get("/api/health", (req: Request, res: Response) => {
  return res.json({ message: "Nutriwell Backend Connected Successfully!" });
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

app.use(multerErrorHandler);

/**
 * Check database connection before starting server
 */
async function checkDatabaseConnection() {
  try {
    await prisma.$connect();
    console.log("✅ Database is running and connected!");

    // Test query to ensure database is responsive
    await prisma.$queryRaw`SELECT 1`;
    console.log("✅ Database connection test successful!");
  } catch (error) {
    console.error("❌ Database connection failed:", error);
    console.error("Please check your DATABASE_URL in .env file");
    process.exit(1);
  }
}

// Start server after database check
async function startServer() {
  // Check database connection first
  await checkDatabaseConnection();

  // Start appointment reminder cron job
  startAppointmentReminderCron();

  // Start Express server
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
  });
}

// Start the application
startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
