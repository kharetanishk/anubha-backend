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

dotenv.config();

const PORT = process.env.PORT || 4000;
const app = express();

app.use(cookieParser());

app.use(attachUser);

app.post("/api/payment/webhook", rawBodyMiddleware, razorpayWebhookHandler);

app.use(express.json({ limit: "20mb" }));

const allowedOrigins = ["http://localhost:3000", "http://192.168.29.116:3000"];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

app.get("/api/health", (req: Request, res: Response) => {
  return res.json({ message: "Nutriwell Backend Connected Successfully!" });
});


app.use("/api/auth", authRoutes);
app.use("/api/patients", patientRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/slots", slotRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/payment", paymentRoutes);

app.use(multerErrorHandler);


app.listen(PORT, () =>
  console.log(`Server running on port http://localhost:${PORT}`)
);
