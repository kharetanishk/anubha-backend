import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { attachUser } from "../../middleware/attachUser";

import {
  createOrderHandler,
  verifyPaymentHandler,
  getPlanPriceHandler,
} from "./payment.controller";

const paymentRoutes = Router();

paymentRoutes.post("/order", attachUser, requireAuth, createOrderHandler);
paymentRoutes.post("/verify", attachUser, requireAuth, verifyPaymentHandler);
paymentRoutes.get("/plan-price", getPlanPriceHandler); // Public endpoint to get plan price

export default paymentRoutes;
