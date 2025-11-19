import { Router } from "express";
import { otpLimiter } from "../../middleware/rateLimit";
import { authController } from "./auth.controller";
import { refreshSession } from "./refresh/auth.refresh";
import { logout } from "./auth.logout";

const authRoutes = Router();

authRoutes.post("/register/send-otp", otpLimiter, (req, res) =>
  authController.sendRegisterOtp(req, res)
);

authRoutes.post("/register/verify-otp", otpLimiter, (req, res) =>
  authController.verifyRegisterOtp(req, res)
);

authRoutes.post("/login/send-otp", otpLimiter, (req, res) =>
  authController.sendLoginOtp(req, res)
);

authRoutes.post("/login/verify-otp", otpLimiter, (req, res) =>
  authController.verifyLoginOtp(req, res)
);

authRoutes.get("/refresh", refreshSession);

authRoutes.post("/logout", logout);

export default authRoutes;
