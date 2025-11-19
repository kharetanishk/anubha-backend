import express, { Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
// import uploadRoutes from "./routes/uploadRoutes";
// import { multerErrorHandler } from "./middleware/multerErrorhandler";
// import formroutes from "./routes/formroutes";
import authRoutes from "./modules/auth/auth.routes";
import { requireAuth } from "./middleware/requireAuth";
import { requireRole } from "./middleware/requiredRole";
import { attachUser } from "./middleware/attachUser";

dotenv.config();

const app = express();

app.use(cookieParser());

app.use(attachUser);

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(cors());

app.get("/public", (req, res) => {
  return res.json({
    message: "Public route working",
    user: req.user || null,
  });
});

//routes
app.use("/auth", authRoutes);
// app.use("/api/upload", uploadRoutes);
// app.use("/api/forms", formroutes);
// app.use(multerErrorHandler);

/////testing /////_____________________________________________

app.get("/protected", requireAuth, (req, res) => {
  return res.json({
    message: "You are authenticated",
    user: req.user,
  });
});

app.get("/admin-only", requireAuth, requireRole("ADMIN"), (req, res) => {
  return res.json({
    message: "Admin route accessed",
    user: req.user,
  });
});
//_________________________________________________________________________________________
app.get("/", (_req: Request, res: Response) => {
  res.send("Nutriwell backend (TypeScript) running ✅");
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log(`Server running on port http://localhost:${PORT}`)
);
