import { Router } from "express";
import { authController } from "./auth.controller";
import { refreshSession } from "./refresh/auth.refresh";

const authRoutes = Router();

/**
 * ------------------------------
 * REGISTER ROUTES
 * ------------------------------
 */
authRoutes.post("/register/send-otp", (req, res) =>
  authController.sendRegisterOtp(req, res)
);

authRoutes.post("/register/verify-otp", (req, res) =>
  authController.verifyRegisterOtp(req, res)
);

/**
 * ------------------------------
 * LOGIN ROUTES
 * ------------------------------
 */
authRoutes.post("/login/send-otp", (req, res) =>
  authController.sendLoginOtp(req, res)
);

authRoutes.post("/login/verify-otp", (req, res) =>
  authController.verifyLoginOtp(req, res)
);

/* 
--------------------------------------
refresh routes
--------------------------------------
*/
authRoutes.get("/refresh", refreshSession);

export default authRoutes;
