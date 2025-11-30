import { Request, Response } from "express";
import crypto from "crypto";
import Razorpay from "razorpay";
import prisma from "../../database/prismaclient";
import { getSingleAdminId } from "../slots/slots.services";
import { PLANS, PlanSlug } from "../../constants/plan";
import { AppointmentMode, Prisma } from "@prisma/client";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

export function normalizeAppointmentMode(input: string): AppointmentMode {
  const v = (input || "").toLowerCase().trim();

  if (["in-person", "in_person", "clinic", "offline", "inperson"].includes(v)) {
    return AppointmentMode.IN_PERSON;
  }

  if (["online", "virtual", "video", "zoom"].includes(v)) {
    return AppointmentMode.ONLINE;
  }

  throw new Error("Invalid appointment mode");
}

export async function razorpayWebhookHandler(req: Request, res: Response) {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET!;
    const signature = req.headers["x-razorpay-signature"] as string | undefined;
    const eventId = req.headers["x-razorpay-event-id"] as string | undefined;

    if (!signature || !eventId) {
      return res
        .status(400)
        .json({ success: false, message: "Missing headers" });
    }

    const exists = await prisma.webhookEvent.findUnique({
      where: { eventId },
    });

    if (exists) {
      console.log("Duplicate webhook ignored:", eventId);
      return res.json({ success: true });
    }

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(req.body)
      .digest("hex");

    if (expectedSignature !== signature) {
      console.error("Invalid Razorpay signature");
      return res.status(400).json({ success: false });
    }

    const event = JSON.parse(req.body.toString());
    const eventType = event.event as string;

    await prisma.webhookEvent.create({
      data: { eventId },
    });

    console.log("Razorpay Event:", eventType);

    if (eventType === "payment.captured") {
      console.log(" [WEBHOOK] Payment captured event received");
      const orderId = event.payload.payment?.entity?.order_id as
        | string
        | undefined;
      const paymentId = event.payload.payment?.entity?.id as string | undefined;

      if (!orderId) {
        console.warn(" [WEBHOOK] payment.captured without order_id");
        return res.json({ success: true });
      }

      console.log(" [WEBHOOK] Finding appointment for order:", orderId);
      const appointment = await prisma.appointment.findFirst({
        where: { paymentId: orderId },
      });

      if (!appointment) {
        console.log(" [WEBHOOK] No appointment found for order:", orderId);
        return res.json({ success: true });
      }

      console.log(" [WEBHOOK] Appointment found:", {
        id: appointment.id,
        currentStatus: appointment.status,
      });

      if (
        appointment.status === "CANCELLED" ||
        appointment.status === "COMPLETED" ||
        appointment.status === "CONFIRMED"
      ) {
        console.log(" [WEBHOOK] Appointment already processed, skipping");
        return res.json({ success: true });
      }

      console.log(" [WEBHOOK] Updating appointment to CONFIRMED");
      await prisma.appointment.update({
        where: { id: appointment.id },
        data: {
          status: "CONFIRMED",
          paymentStatus: "SUCCESS",
        } as any,
      });

      if (appointment.slotId) {
        console.log(" [WEBHOOK] Marking slot as booked:", appointment.slotId);
        await prisma.slot.update({
          where: { id: appointment.slotId },
          data: { isBooked: true },
        });
        console.log(" [WEBHOOK] Slot marked as booked");
      }

      console.log(" [WEBHOOK] Appointment CONFIRMED:", appointment.id);
    }

    if (eventType === "payment.failed") {
      console.log(" [WEBHOOK] Payment failed event received");
      const orderId = event.payload.payment?.entity?.order_id as
        | string
        | undefined;

      if (!orderId) {
        console.warn(" [WEBHOOK] payment.failed without order_id");
        return res.json({ success: true });
      }

      console.log(" [WEBHOOK] Finding appointment for failed order:", orderId);
      const appointment = await prisma.appointment.findFirst({
        where: { paymentId: orderId },
      });

      if (!appointment) {
        console.warn(
          " [WEBHOOK] No appointment found for failed order:",
          orderId
        );
        return res.json({ success: true });
      }

      if (appointment.status === "CONFIRMED") {
        console.log(
          " [WEBHOOK] Appointment already confirmed, ignoring failure"
        );
        return res.json({ success: true });
      }

      console.log(" [WEBHOOK] Updating appointment payment status to FAILED");
      await prisma.appointment.update({
        where: { id: appointment.id },
        data: {
          paymentStatus: "FAILED",
          // Keep status as PENDING so user can retry
        } as any,
      });

      console.log(" [WEBHOOK] Payment FAILED for appointment:", appointment.id);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Webhook Error:", err);
    return res.status(500).json({ success: false });
  }
}

export async function createOrderHandler(req: Request, res: Response) {
  try {
    console.log(" [PAYMENT] Create order request received");
    const userId = req.user?.id;
    if (!userId) {
      console.error(" [PAYMENT] Unauthenticated request");
      return res.status(401).json({ error: "Unauthenticated" });
    }

    // Support both old flow (slotId, patientId) and new flow (appointmentId)
    const { appointmentId, slotId, patientId, planSlug, appointmentMode } =
      req.body as {
        appointmentId?: string;
        slotId?: string;
        patientId?: string;
        planSlug?: PlanSlug;
        appointmentMode?: string;
      };

    console.log(" [PAYMENT] Request body:", {
      appointmentId: appointmentId || "none",
      slotId: slotId || "none",
      planSlug: planSlug || "none",
    });

    let appointment;

    // NEW FLOW: Use existing appointment (created in recall flow)
    if (appointmentId) {
      console.log(" [PAYMENT] Using existing appointment:", appointmentId);
      appointment = await prisma.appointment.findFirst({
        where: {
          id: appointmentId,
          userId,
        },
        include: {
          patient: true,
          slot: true,
        },
      });

      if (!appointment) {
        console.error(" [PAYMENT] Appointment not found or unauthorized");
        return res.status(404).json({ error: "Appointment not found" });
      }

      // Validate appointment is in PENDING status
      if (appointment.status !== "PENDING") {
        console.error(
          " [PAYMENT] Appointment already processed:",
          appointment.status
        );
        return res.status(400).json({
          error: `Appointment is already ${appointment.status.toLowerCase()}`,
        });
      }

      // Validate slot is assigned
      if (!appointment.slotId || !appointment.slot) {
        console.error(" [PAYMENT] Appointment has no slot assigned");
        return res
          .status(400)
          .json({ error: "No slot assigned to appointment" });
      }

      const slot = appointment.slot;
      if (slot.isBooked) {
        console.error(" [PAYMENT] Slot already booked");
        return res.status(400).json({ error: "Slot already booked" });
      }

      // Get plan price from appointment (already validated in recall flow)
      const planPrice = appointment.planPrice;
      const amountInPaise = planPrice * 100;

      console.log(" [PAYMENT] Creating Razorpay order:", {
        amount: amountInPaise,
        planPrice,
        appointmentId: appointment.id,
      });

      // Generate receipt (max 40 chars for Razorpay)
      // Format: rcpt_<short-appointment-id>_<timestamp>
      // Use last 8 chars of appointment ID + timestamp to ensure uniqueness
      const shortApptId = appointment.id.slice(-8); // Last 8 chars of UUID
      const timestamp = Date.now().toString().slice(-10); // Last 10 digits of timestamp
      const receipt = `rcpt_${shortApptId}_${timestamp}`; // Max length: 5 + 8 + 1 + 10 = 24 chars

      const order = await razorpay.orders.create({
        amount: amountInPaise,
        currency: "INR",
        receipt: receipt,
        notes: {
          appointmentId: appointment.id,
          planSlug: appointment.planSlug,
          planName: appointment.planName,
        },
      });

      // Update appointment with payment order ID
      await prisma.appointment.update({
        where: { id: appointment.id },
        data: {
          paymentId: order.id,
          amount: planPrice,
          paymentStatus: "PENDING",
        } as any,
      });

      console.log(" [PAYMENT] Order created and appointment updated:", {
        orderId: order.id,
        appointmentId: appointment.id,
      });

      return res.json({
        success: true,
        order,
        appointmentId: appointment.id,
      });
    }

    // OLD FLOW: Create new appointment (for backward compatibility)
    if (!slotId || !patientId || !planSlug || !appointmentMode) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const plan = PLANS[planSlug];
    if (!plan) {
      return res.status(400).json({ error: "Invalid plan selected" });
    }

    const modeEnum = normalizeAppointmentMode(appointmentMode);
    if (!modeEnum) {
      return res.status(400).json({ error: "Invalid appointment mode" });
    }

    const patient = await prisma.patientDetials.findFirst({
      where: {
        id: patientId,
        userId,
      },
    });

    if (!patient) {
      return res
        .status(403)
        .json({ error: "Patient does not belong to current user" });
    }

    const slot = await prisma.slot.findUnique({
      where: { id: slotId },
    });

    if (!slot) {
      return res.status(400).json({ error: "Slot not found" });
    }

    if (slot.isBooked) {
      return res.status(400).json({ error: "Slot already booked" });
    }

    if (slot.mode !== modeEnum) {
      return res
        .status(400)
        .json({ error: "Slot mode does not match selected mode" });
    }

    if (slot.startAt <= new Date()) {
      return res.status(400).json({ error: "Slot is in the past" });
    }

    const amountInPaise = plan.price * 100;

    // Generate receipt (max 40 chars for Razorpay)
    // Format: rcpt_<timestamp> (timestamp is 13 digits max, so total is 18 chars)
    const receipt = `rcpt_${Date.now()}`;

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: receipt,
    });

    const doctorId = await getSingleAdminId();

    appointment = await prisma.appointment.create({
      data: {
        userId,
        doctorId,
        patientId,
        slotId: slot.id,
        startAt: slot.startAt,
        endAt: slot.endAt,

        paymentId: order.id,
        amount: plan.price,
        status: "PENDING",
        mode: modeEnum,

        planSlug,
        planName: plan.name,
        planPrice: plan.price,
        planDuration: plan.duration,
        planPackageName: plan.packageName,
      },
    });

    return res.json({
      success: true,
      order,
      appointmentId: appointment.id,
    });
  } catch (err: any) {
    // Handle unique constraint -> slot double booking race condition
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002" &&
      Array.isArray(err.meta?.target) &&
      err.meta?.target.includes("slotId")
    ) {
      return res.status(409).json({ error: "Slot already booked" });
    }

    console.error(" [PAYMENT] Create order error:", err);
    return res.status(500).json({ error: "Something went wrong" });
  }
}

export async function verifyPaymentHandler(req: Request, res: Response) {
  try {
    console.log(" [PAYMENT] Verify payment request received");
    const { orderId, paymentId, signature } = req.body;

    if (!orderId || !paymentId || !signature) {
      console.error(" [PAYMENT] Missing verification fields");
      return res.status(400).json({ error: "Missing fields" });
    }

    console.log(" [PAYMENT] Verifying signature");
    const body = `${orderId}|${paymentId}`;
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!)
      .update(body)
      .digest("hex");

    if (expected !== signature) {
      console.log(" [PAYMENT] Signature mismatch in manual verification");
      return res
        .status(400)
        .json({ success: false, message: "Invalid signature" });
    }

    console.log(" [PAYMENT] Signature verified, finding appointment");
    const appointment = await prisma.appointment.findFirst({
      where: { paymentId: orderId },
    });

    if (!appointment) {
      console.error(" [PAYMENT] Appointment not found for order:", orderId);
      return res.status(404).json({ error: "Appointment not found" });
    }

    console.log(" [PAYMENT] Appointment found:", {
      id: appointment.id,
      currentStatus: appointment.status,
    });

    if (appointment.status === "CONFIRMED") {
      console.log(" [PAYMENT] Appointment already confirmed");
      return res.json({ success: true, alreadyConfirmed: true });
    }

    console.log(" [PAYMENT] Updating appointment to CONFIRMED");
    await prisma.appointment.update({
      where: { id: appointment.id },
      data: {
        status: "CONFIRMED",
        paymentStatus: "SUCCESS",
      } as any,
    });

    if (appointment.slotId) {
      try {
        console.log(" [PAYMENT] Marking slot as booked:", appointment.slotId);
        await prisma.slot.update({
          where: { id: appointment.slotId },
          data: { isBooked: true },
        });
        console.log(" [PAYMENT] Slot marked as booked");
      } catch (err) {
        console.warn(" [PAYMENT] Slot may already be booked, ignoring error");
        // slot may already be booked → ignore
      }
    }

    console.log(
      " [PAYMENT] Appointment CONFIRMED via verify API:",
      appointment.id
    );

    return res.json({
      success: true,
      message: "Payment verified successfully",
    });
  } catch (err) {
    console.log(" [PAYMENT] verifyPaymentHandler error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// Get plan price from backend
export async function getPlanPriceHandler(req: Request, res: Response) {
  try {
    const { planSlug } = req.query;

    if (!planSlug || typeof planSlug !== "string") {
      return res.status(400).json({ error: "planSlug is required" });
    }

    const plan = PLANS[planSlug as PlanSlug];
    if (!plan) {
      return res.status(404).json({ error: "Plan not found" });
    }

    return res.json({
      success: true,
      plan: {
        slug: planSlug,
        name: plan.name,
        price: plan.price,
        duration: plan.duration,
        packageName: plan.packageName,
      },
    });
  } catch (err) {
    console.log(" [PAYMENT] Get plan price error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
