# Payment Confirmation & WhatsApp Integration - Complete Implementation

## ✅ Implementation Summary

### 1. Payment Verification Flow

**Location:** `src/modules/payment/payment.controller.ts` → `verifyPaymentHandler`

**Steps:**

1. ✅ Verify Razorpay signature using HMAC-SHA256
2. ✅ Mark Appointment as CONFIRMED
3. ✅ Mark Slot as BOOKED (isBooked: true)
4. ✅ Store payment details:
   - `paymentId` field → stores Razorpay Order ID (orderId)
   - `notes` field → stores Razorpay Payment ID (paymentId)
   - `paymentStatus` → "SUCCESS"
   - `status` → "CONFIRMED"

### 2. WhatsApp Notifications (MSG91)

**Location:** `src/services/whatsapp.service.ts`

**Features:**

- ✅ Reusable `sendWhatsAppMessage()` function
- ✅ Patient template: "patient"
- ✅ Doctor template: "testing_nut"
- ✅ Automatic phone number formatting (adds country code 91)
- ✅ Error handling and logging

**Integration:**

- ✅ Called immediately after payment confirmation
- ✅ Non-blocking (errors don't fail payment confirmation)
- ✅ Sends to both patient and doctor

**Templates:**

- **Patient Template:** `patient` (language: `en`)
  - Variables: `body_1` (patient name)
- **Doctor Template:** `testing_nut` (language: `en_US`)
  - No variables required

### 3. Appointment Reminder Cron Job

**Location:** `src/cron/reminder.ts`

**Features:**

- ✅ Runs every minute using node-cron
- ✅ Finds appointments starting in exactly 1 hour
- ✅ Conditions:
  - `status = CONFIRMED`
  - `reminderSent = false`
  - `startAt` within 1-minute window of 1 hour from now
- ✅ Sends WhatsApp reminders to both patient and doctor
- ✅ Marks `reminderSent = true` after sending

**Initialization:**

- ✅ Started automatically in `src/app.ts` on server startup

## 📁 File Structure

```
nutriwell-backend/
├── src/
│   ├── services/
│   │   └── whatsapp.service.ts          # MSG91 WhatsApp service
│   ├── cron/
│   │   └── reminder.ts                   # Appointment reminder cron job
│   ├── modules/
│   │   ├── payment/
│   │   │   └── payment.controller.ts    # Payment verification + WhatsApp
│   │   └── slots/
│   │       └── slots.services.ts        # getSingleAdmin() helper
│   └── app.ts                            # Server startup + cron initialization
```

## 🔧 Environment Variables

Add to `.env`:

```env
# MSG91 WhatsApp Configuration
MSG91_AUTH_KEY="your_msg91_auth_key_here"
MSG91_INTEGRATED_NUMBER="917880293523"  # Default, can be overridden
```

## 📋 Complete Payment Flow

1. **User completes payment** → Razorpay returns payment response
2. **Frontend calls `/payment/verify`** → Sends orderId, paymentId, signature
3. **Backend verifies signature** → HMAC-SHA256 verification
4. **Backend updates appointment** → Status: CONFIRMED, paymentStatus: SUCCESS
5. **Backend marks slot as booked** → isBooked: true
6. **Backend stores payment details** → orderId in paymentId, paymentId in notes
7. **Backend sends WhatsApp notifications** → Patient + Doctor (non-blocking)
8. **Cron job runs every minute** → Checks for appointments 1 hour away
9. **Cron sends reminders** → Patient + Doctor, marks reminderSent: true

## 🧪 Testing

### Test Payment Flow:

1. Complete a test payment
2. Check console logs for:
   - Payment verification
   - Slot booking
   - WhatsApp notifications

### Test Reminder Cron:

1. Create a CONFIRMED appointment with startAt = 1 hour from now
2. Wait for cron to run (runs every minute)
3. Check console logs for reminder sending
4. Verify `reminderSent = true` in database

## 📝 Notes

- WhatsApp notifications are **non-blocking** - payment confirmation succeeds even if WhatsApp fails
- Reminder cron runs **every minute** - checks for appointments exactly 1 hour away
- Phone numbers are **automatically formatted** with country code (91 for India)
- All WhatsApp errors are **logged** but don't break the payment flow
