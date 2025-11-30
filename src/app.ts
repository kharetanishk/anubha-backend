import express, { Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import uploadRoutes from "./routes/uploadRoutes";
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
      /^http:\/\/192\.168\.\d+\.\d+:3000$/,
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["Set-Cookie"],
  })
);

app.use(express.json({ limit: "20mb" }));

app.use(attachUser);

app.post("/api/payment/webhook", rawBodyMiddleware, razorpayWebhookHandler);

app.get("/api/health", (req: Request, res: Response) => {
  return res.json({ message: "Nutriwell Backend Connected Successfully!" });
});

app.use("/api/auth", authRoutes);
app.use("/api/patients", patientRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/slots", slotRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/admin", adminRoutes);

app.use(multerErrorHandler);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
