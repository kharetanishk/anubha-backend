import { Request, Response } from "express";
import { authService } from "./auth.service";

export class AuthController {
  async sendRegisterOtp(req: Request, res: Response) {
    try {
      const { name, phone } = req.body;

      const response = await authService.sendRegisterOtp(name, phone);

      return res.status(200).json({
        success: true,
        ...response,
      });
    } catch (error: any) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async verifyRegisterOtp(req: Request, res: Response) {
    try {
      const { name, phone, otp } = req.body;

      const response = await authService.verifyRegisterOtp(name, phone, otp);

      res.cookie("access_token", response.tokens.accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 15 * 60 * 1000,
      });

      res.cookie("refresh_token", response.tokens.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });

      return res.status(200).json({
        success: true,
        ...response,
      });
    } catch (error: any) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async sendLoginOtp(req: Request, res: Response) {
    try {
      const { phone } = req.body;

      const response = await authService.sendLoginOtp(phone);

      return res.status(200).json({
        success: true,
        ...response,
      });
    } catch (error: any) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }

  async verifyLoginOtp(req: Request, res: Response) {
    try {
      const { phone, otp } = req.body;

      const response = await authService.verifyLoginOtp(phone, otp);

      res.cookie("access_token", response.tokens.accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 15 * 60 * 1000,
      });

      res.cookie("refresh_token", response.tokens.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });

      return res.status(200).json({
        success: true,
        ...response,
      });
    } catch (error: any) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }
}

export const authController = new AuthController();
