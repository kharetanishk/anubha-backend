import { Router } from "express";
import { otpLimiter } from "../../middleware/rateLimit";
import { authController } from "./auth.controller";
import { refreshSession } from "./refresh/auth.refresh";
import { logout } from "./auth.logout";
import { validateBody } from "../../middleware/validateRequest";

import {
  sendRegisterOtpSchema,
  verifyRegisterOtpSchema,
  sendLoginOtpSchema,
  verifyLoginOtpSchema,
} from "./auth.schema";

const authRoutes = Router();

authRoutes.post(
  "/register/send-otp",
  otpLimiter,
  validateBody(sendRegisterOtpSchema),
  authController.sendRegisterOtp.bind(authController)
);

authRoutes.post(
  "/register/verify-otp",
  otpLimiter,
  validateBody(verifyRegisterOtpSchema),
  authController.verifyRegisterOtp.bind(authController)
);

authRoutes.post(
  "/login/send-otp",
  otpLimiter,
  validateBody(sendLoginOtpSchema),
  authController.sendLoginOtp.bind(authController)
);

authRoutes.post(
  "/login/verify-otp",
  otpLimiter,
  validateBody(verifyLoginOtpSchema),
  authController.verifyLoginOtp.bind(authController)
);

authRoutes.get("/session", refreshSession);
authRoutes.get("/me", authController.getMe.bind(authController));
authRoutes.post("/logout", logout);

export default authRoutes;
