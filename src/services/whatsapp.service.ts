import axios from "axios";
import dotenv from "dotenv";

// Ensure environment variables are loaded
dotenv.config();

/**
 * MSG91 WhatsApp Service
 * Handles sending WhatsApp messages via MSG91 API
 */

const MSG91_API_URL =
  "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/";
const INTEGRATED_NUMBER = process.env.MSG91_INTEGRATED_NUMBER || "917880293523";
const MSG91_NAMESPACE = "bd7eaf00_3a31_451d_8435_6cd400ead584";

// Development mode check
const IS_DEVELOPMENT = process.env.NODE_ENV !== "production";

/**
 * Mask sensitive data (show first 3 and last 3 characters)
 */
function maskKey(key: string): string {
  if (!key || key.length <= 6) return "***";
  return `${key.substring(0, 3)}...${key.substring(key.length - 3)}`;
}

/**
 * Validate and normalize MSG91_AUTH_KEY from environment
 */
function getAuthKey(): string | null {
  const rawKey = process.env.MSG91_AUTH_KEY;

  // 1️⃣ Validate environment variable loading
  if (IS_DEVELOPMENT) {
    console.log("[WHATSAPP DEBUG] Environment variable check:");
    console.log("  - MSG91_AUTH_KEY exists:", !!rawKey);
    console.log("  - Type:", typeof rawKey);
    console.log(
      "  - Raw value (first check):",
      rawKey ? `"${rawKey}"` : "undefined"
    );
  }

  if (!rawKey) {
    if (IS_DEVELOPMENT) {
      console.error("[WHATSAPP DEBUG] ❌ MSG91_AUTH_KEY is undefined");
      console.error("[WHATSAPP DEBUG] Check your .env file for:");
      console.error("  1. Variable name spelling (should be MSG91_AUTH_KEY)");
      console.error("  2. No quotes around the value");
      console.error("  3. No extra spaces");
    }
    return null;
  }

  // Check for extra whitespace
  const trimmedKey = rawKey.trim();
  if (trimmedKey !== rawKey) {
    if (IS_DEVELOPMENT) {
      console.warn(
        "[WHATSAPP DEBUG] ⚠️ MSG91_AUTH_KEY has leading/trailing whitespace"
      );
      console.warn("  - Before trim length:", rawKey.length);
      console.warn("  - After trim length:", trimmedKey.length);
    }
  }

  // Check for quotes inside .env (common mistake: MSG91_AUTH_KEY="value" with quotes)
  if (
    (trimmedKey.startsWith('"') && trimmedKey.endsWith('"')) ||
    (trimmedKey.startsWith("'") && trimmedKey.endsWith("'"))
  ) {
    if (IS_DEVELOPMENT) {
      console.error(
        "[WHATSAPP DEBUG] ❌ MSG91_AUTH_KEY appears to have quotes"
      );
      console.error("  - Remove quotes from .env file");
      console.error("  - Should be: MSG91_AUTH_KEY=your_key_here");
      console.error('  - NOT: MSG91_AUTH_KEY="your_key_here"');
    }
    // Remove quotes
    return trimmedKey.replace(/^["']|["']$/g, "").trim();
  }

  // Check if key is empty after trimming
  if (trimmedKey.length === 0) {
    if (IS_DEVELOPMENT) {
      console.error(
        "[WHATSAPP DEBUG] ❌ MSG91_AUTH_KEY is empty after trimming"
      );
    }
    return null;
  }

  if (IS_DEVELOPMENT) {
    console.log("[WHATSAPP DEBUG] ✅ MSG91_AUTH_KEY validated:");
    console.log("  - Length:", trimmedKey.length, "characters");
    console.log("  - Masked:", maskKey(trimmedKey));
    console.log("  - Starts with:", trimmedKey.substring(0, 5));
  }

  return trimmedKey;
}

// Get normalized auth key
const MSG91_AUTH_KEY = getAuthKey();

// Log configuration status on module load
if (!MSG91_AUTH_KEY) {
  console.warn(
    "[WHATSAPP] ⚠️ MSG91_AUTH_KEY is not set in environment variables"
  );
  console.warn("[WHATSAPP] Please add MSG91_AUTH_KEY to your .env file");
} else {
  console.log(
    "[WHATSAPP] ✅ MSG91_AUTH_KEY is configured (length:",
    MSG91_AUTH_KEY.length,
    "characters)"
  );
}

interface WhatsAppTemplateVariables {
  [key: string]: string | { type: "text" | "numbers"; value: string };
}

/**
 * Test MSG91 connection with a simple request
 */
export async function testMsg91Connection(): Promise<{
  success: boolean;
  message?: string;
  error?: string;
  details?: any;
}> {
  console.log("[WHATSAPP TEST] Starting MSG91 connection test...");

  if (!MSG91_AUTH_KEY) {
    return {
      success: false,
      error: "MSG91_AUTH_KEY is not configured",
    };
  }

  // Use a test phone number (admin phone for testing)
  const testPhone = "916260440241"; // Admin phone
  const testTemplate = "testing_nut";

  // Trim auth key
  const authKeyTrimmed = MSG91_AUTH_KEY.trim();

  try {
    const requestBody = {
      integrated_number: INTEGRATED_NUMBER,
      content_type: "template",
      payload: {
        messaging_product: "whatsapp",
        type: "template",
        template: {
          name: testTemplate,
          language: {
            code: "en_US",
            policy: "deterministic",
          },
          namespace: MSG91_NAMESPACE,
          to_and_components: [
            {
              to: [testPhone],
              components: {},
            },
          ],
        },
      },
    };

    // Try both methods: query parameter and header
    const apiUrlWithAuth = `${MSG91_API_URL}?authkey=${encodeURIComponent(
      authKeyTrimmed
    )}`;

    console.log("[WHATSAPP TEST] Request details:");
    console.log("  - URL:", MSG91_API_URL);
    console.log("  - Auth key (masked):", maskKey(authKeyTrimmed));
    console.log("  - Integrated number:", INTEGRATED_NUMBER);
    console.log("  - Template:", testTemplate);
    console.log("  - Test phone:", testPhone);

    const response = await axios.post(apiUrlWithAuth, requestBody, {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        authkey: authKeyTrimmed, // Also try as header
      },
    });

    console.log("[WHATSAPP TEST] ✅ Success!");
    console.log("  - Status:", response.status);
    console.log("  - Response:", JSON.stringify(response.data, null, 2));

    return {
      success: true,
      message: "MSG91 connection test successful",
      details: {
        status: response.status,
        data: response.data,
      },
    };
  } catch (error: any) {
    const errorData = error?.response?.data || {};
    const errorStatus = error?.response?.status;

    console.error("[WHATSAPP TEST] ❌ Failed!");
    console.error("  - Status:", errorStatus);
    console.error("  - Error:", JSON.stringify(errorData, null, 2));
    console.error("  - Full error:", error?.message);

    return {
      success: false,
      error: `Test failed: ${
        errorData?.message || error?.message || "Unknown error"
      }`,
      details: {
        status: errorStatus,
        error: errorData,
        requestHeaders: {
          authkey: maskKey(authKeyTrimmed),
          "Content-Type": "application/json",
        },
      },
    };
  }
}

/**
 * Send WhatsApp message using MSG91 template
 * @param to - Phone number (with country code, e.g., "919876543210")
 * @param templateName - Template name (e.g., "patient", "testing_nut")
 * @param variables - Template variables (e.g., { body_1: "value1" })
 * @param languageCode - Language code (default: "en" or "en_US")
 */
export async function sendWhatsAppMessage(
  to: string,
  templateName: string,
  variables?: WhatsAppTemplateVariables,
  languageCode: string = "en"
): Promise<{ success: boolean; message?: string; error?: string }> {
  // 5️⃣ Trim and normalize all variables (outside try block for error handling)
  const authKeyTrimmed = MSG91_AUTH_KEY ? MSG91_AUTH_KEY.trim() : null;

  try {
    // Validate MSG91 configuration
    if (!MSG91_AUTH_KEY || !authKeyTrimmed) {
      console.error("[WHATSAPP] MSG91_AUTH_KEY not configured");
      return {
        success: false,
        error: "WhatsApp service not configured",
      };
    }
    const integratedNumberTrimmed = INTEGRATED_NUMBER.trim();

    // Format phone number (ensure it starts with country code)
    const formattedPhone = formatPhoneNumber(to);

    // Determine language code based on template
    const langCode = templateName === "testing_nut" ? "en_US" : languageCode;

    // Build request body
    const requestBody = {
      integrated_number: integratedNumberTrimmed,
      content_type: "template",
      payload: {
        messaging_product: "whatsapp",
        type: "template",
        template: {
          name: templateName,
          language: {
            code: langCode,
            policy: "deterministic",
          },
          namespace: MSG91_NAMESPACE,
          to_and_components: [
            {
              to: [formattedPhone],
              components: variables
                ? {
                    body_1: variables.body_1
                      ? typeof variables.body_1 === "string"
                        ? { type: "text", value: variables.body_1 }
                        : variables.body_1
                      : undefined,
                    body_2: variables.body_2
                      ? typeof variables.body_2 === "string"
                        ? { type: "text", value: variables.body_2 }
                        : variables.body_2
                      : undefined,
                    body_3: variables.body_3
                      ? typeof variables.body_3 === "string"
                        ? { type: "text", value: variables.body_3 }
                        : variables.body_3
                      : undefined,
                  }
                : {},
            },
          ],
        },
      },
    };

    // Remove undefined components
    const components = requestBody.payload.template.to_and_components[0]
      .components as any;
    if (components) {
      Object.keys(components).forEach((key) => {
        if (components[key] === undefined) {
          delete components[key];
        }
      });
      // If all components are removed, set to empty object
      if (Object.keys(components).length === 0) {
        requestBody.payload.template.to_and_components[0].components = {};
      }
    }

    // Validate auth key format (should not be empty)
    if (!authKeyTrimmed || authKeyTrimmed.length === 0) {
      console.error(
        "[WHATSAPP] MSG91_AUTH_KEY is empty or not set in environment variables"
      );
      return {
        success: false,
        error: "WhatsApp service not configured: MSG91_AUTH_KEY is missing",
      };
    }

    // 2️⃣ Verify outgoing Axios request - Log final outgoing headers
    const requestHeaders = {
      "Content-Type": "application/json",
      Accept: "application/json",
      authkey: authKeyTrimmed, // Lowercase header name
    };

    // Build URL with query parameter (MSG91 WhatsApp API v5 supports both)
    const apiUrlWithAuth = `${MSG91_API_URL}?authkey=${encodeURIComponent(
      authKeyTrimmed
    )}`;

    if (IS_DEVELOPMENT) {
      console.log("[WHATSAPP DEBUG] Outgoing request details:");
      console.log("  - Endpoint URL:", MSG91_API_URL);
      console.log(
        "  - Full URL (with auth):",
        apiUrlWithAuth.replace(authKeyTrimmed, maskKey(authKeyTrimmed))
      );
      console.log("  - Headers:");
      console.log("    * Content-Type:", requestHeaders["Content-Type"]);
      console.log("    * Accept:", requestHeaders.Accept);
      console.log("    * authkey (masked):", maskKey(authKeyTrimmed));
      console.log("    * authkey length:", authKeyTrimmed.length);
      console.log("  - Integrated number:", integratedNumberTrimmed);
      console.log("  - Template name:", templateName);
      console.log("  - To:", formattedPhone);
      console.log("  - Payload:", JSON.stringify(requestBody, null, 2));
    }

    // 4️⃣ Check for accidental use of SMS auth key instead of WhatsApp auth key
    if (IS_DEVELOPMENT) {
      console.log("[WHATSAPP DEBUG] Key validation:");
      console.log("  - Key source: process.env.MSG91_AUTH_KEY");
      console.log("  - Key type: WhatsApp API (not SMS)");
      console.log("  - Key format check: Should be alphanumeric string");
      if (!/^[A-Za-z0-9]+$/.test(authKeyTrimmed)) {
        console.warn(
          "  - ⚠️ Key contains non-alphanumeric characters (may be invalid)"
        );
      }
    }

    const response = await axios.post(apiUrlWithAuth, requestBody, {
      headers: requestHeaders,
    });

    if (IS_DEVELOPMENT) {
      console.log("[WHATSAPP DEBUG] ✅ Request successful:");
      console.log("  - Status:", response.status);
      console.log("  - Response:", JSON.stringify(response.data, null, 2));
    }

    console.log("==========================================");
    console.log("[WHATSAPP API] ✅ Message sent successfully");
    console.log("  To:", formattedPhone);
    console.log("  Template:", templateName);
    console.log("  Response Status:", response.status);
    console.log("  Response Data:", JSON.stringify(response.data, null, 2));
    console.log("==========================================");

    return {
      success: true,
      message: "WhatsApp message sent successfully",
    };
  } catch (error: any) {
    const errorData = error?.response?.data || {};
    const errorStatus = error?.response?.status;
    const errorMessage =
      errorData?.message || errorData?.errors || error?.message;

    // 6️⃣ Add clear error output
    if (IS_DEVELOPMENT) {
      console.error("[WHATSAPP DEBUG] ❌ Request failed:");
      console.error("  - Status code:", errorStatus);
      console.error("  - Error message:", errorMessage);
      console.error("  - Full error data:", JSON.stringify(errorData, null, 2));
      console.error("  - Request details:");
      console.error("    * Endpoint:", MSG91_API_URL);
      console.error(
        "    * Auth key (masked):",
        maskKey(MSG91_AUTH_KEY?.trim() || "")
      );
      console.error("    * Integrated number:", INTEGRATED_NUMBER.trim());
      console.error("    * Template:", templateName);
      console.error("    * To:", to);
      if (error?.config) {
        console.error("  - Axios config:");
        console.error(
          "    * URL:",
          error.config.url?.replace(
            MSG91_AUTH_KEY?.trim() || "",
            maskKey(MSG91_AUTH_KEY?.trim() || "")
          )
        );
        console.error(
          "    * Headers:",
          JSON.stringify(error.config.headers, null, 2).replace(
            MSG91_AUTH_KEY?.trim() || "",
            maskKey(MSG91_AUTH_KEY?.trim() || "")
          )
        );
      }
    }

    console.error("==========================================");
    console.error("[WHATSAPP API] ❌ Failed to send message");
    console.error("  To:", to);
    console.error("  Template:", templateName);
    console.error("  Status Code:", errorStatus);
    console.error("  Error Message:", errorMessage);
    console.error("  Error Data:", JSON.stringify(errorData, null, 2));
    console.error("  Auth Key Configured:", !!MSG91_AUTH_KEY);
    console.error("==========================================");

    // Provide more specific error messages
    if (errorStatus === 401) {
      return {
        success: false,
        error: `Authentication failed (401). Please check:
1. MSG91_AUTH_KEY is set in .env file
2. Key is for WhatsApp API (not SMS API)
3. Key has no extra quotes or spaces
4. Key is active in your MSG91 account
Error: ${errorMessage || "Unauthorized"}`,
      };
    }

    if (errorStatus === 400) {
      return {
        success: false,
        error: `Bad request (400). Please check template name and parameters. Error: ${
          errorMessage || "Invalid request"
        }`,
      };
    }

    return {
      success: false,
      error: errorMessage || "Failed to send WhatsApp message",
    };
  }
}

/**
 * Format phone number to include country code
 * @param phone - Phone number (with or without country code)
 * @returns Formatted phone number with country code (91 for India)
 */
function formatPhoneNumber(phone: string): string {
  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, "");

  // If already starts with country code (91), return as is
  if (digits.startsWith("91") && digits.length >= 12) {
    return digits;
  }

  // If starts with 0, remove it and add 91
  if (digits.startsWith("0")) {
    return "91" + digits.substring(1);
  }

  // If 10 digits, assume Indian number and add 91
  if (digits.length === 10) {
    return "91" + digits;
  }

  // Return as is if already formatted
  return digits;
}

/**
 * Send patient confirmation WhatsApp message
 * @param patientPhone - Patient phone number (recipient)
 * @param variables - Optional additional template variables
 * Note: The patient template requires body_1 to be of type "numbers" with the patient's phone number
 */
export async function sendPatientConfirmationMessage(
  patientPhone: string,
  variables?: WhatsAppTemplateVariables
): Promise<{ success: boolean; message?: string; error?: string }> {
  // Format the patient phone number for the template variable
  const formattedPatientPhone = formatPhoneNumber(patientPhone);

  // Build variables with body_1 as type "numbers" containing the patient phone number
  const templateVariables: WhatsAppTemplateVariables = {
    body_1: {
      type: "numbers",
      value: formattedPatientPhone,
    },
    ...variables, // Allow additional variables to override or add more
  };

  return sendWhatsAppMessage(patientPhone, "patient", templateVariables, "en");
}

/**
 * Send doctor notification WhatsApp message
 * @param doctorPhone - Doctor phone number
 */
export async function sendDoctorNotificationMessage(
  doctorPhone: string
): Promise<{ success: boolean; message?: string; error?: string }> {
  return sendWhatsAppMessage(doctorPhone, "testing_nut", undefined, "en_US");
}

/**
 * Send booking confirmation SMS/WhatsApp message
 * Uses MSG91_TEMPLATE_BOOKING_CONFIRMATION template or falls back to "patient"
 */
export async function sendBookingConfirmationMessage(
  patientPhone: string,
  slotTime: Date,
  variables?: WhatsAppTemplateVariables
): Promise<{ success: boolean; message?: string; error?: string }> {
  const templateName =
    process.env.MSG91_TEMPLATE_BOOKING_CONFIRMATION || "patient";
  const formattedPatientPhone = formatPhoneNumber(patientPhone);

  // Format slot time for template (you may need to adjust format based on template requirements)
  const slotTimeFormatted = slotTime.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });

  const templateVariables: WhatsAppTemplateVariables = {
    body_1: {
      type: "numbers",
      value: formattedPatientPhone,
    },
    body_2: {
      type: "text",
      value: slotTimeFormatted,
    },
    ...variables,
  };

  return sendWhatsAppMessage(
    patientPhone,
    templateName,
    templateVariables,
    "en"
  );
}

/**
 * Send reminder SMS/WhatsApp message (1 hour before appointment)
 * Uses MSG91_TEMPLATE_REMINDER template or falls back to "patient"
 */
export async function sendReminderMessage(
  patientPhone: string,
  slotTime: Date,
  variables?: WhatsAppTemplateVariables
): Promise<{ success: boolean; message?: string; error?: string }> {
  const templateName = process.env.MSG91_TEMPLATE_REMINDER || "patient";
  const formattedPatientPhone = formatPhoneNumber(patientPhone);

  const slotTimeFormatted = slotTime.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });

  const templateVariables: WhatsAppTemplateVariables = {
    body_1: {
      type: "numbers",
      value: formattedPatientPhone,
    },
    body_2: {
      type: "text",
      value: slotTimeFormatted,
    },
    ...variables,
  };

  return sendWhatsAppMessage(
    patientPhone,
    templateName,
    templateVariables,
    "en"
  );
}

/**
 * Send last-minute combined confirmation + reminder SMS/WhatsApp message
 * Uses MSG91_TEMPLATE_LAST_MINUTE template or falls back to "patient"
 */
export async function sendLastMinuteConfirmationMessage(
  patientPhone: string,
  slotTime: Date,
  variables?: WhatsAppTemplateVariables
): Promise<{ success: boolean; message?: string; error?: string }> {
  const templateName = process.env.MSG91_TEMPLATE_LAST_MINUTE || "patient";
  const formattedPatientPhone = formatPhoneNumber(patientPhone);

  const slotTimeFormatted = slotTime.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });

  const templateVariables: WhatsAppTemplateVariables = {
    body_1: {
      type: "numbers",
      value: formattedPatientPhone,
    },
    body_2: {
      type: "text",
      value: slotTimeFormatted,
    },
    ...variables,
  };

  return sendWhatsAppMessage(
    patientPhone,
    templateName,
    templateVariables,
    "en"
  );
}

/**
 * Send OTP SMS/WhatsApp message
 * Uses MSG91_TEMPLATE_OTP template if configured
 * Note: Currently OTP is not sent via MSG91 in the codebase, but this function is available for future use
 */
export async function sendOtpMessage(
  phone: string,
  otp: string,
  variables?: WhatsAppTemplateVariables
): Promise<{ success: boolean; message?: string; error?: string }> {
  const templateName = process.env.MSG91_TEMPLATE_OTP;
  if (!templateName) {
    return {
      success: false,
      error:
        "MSG91_TEMPLATE_OTP not configured. OTP sending via MSG91 is disabled.",
    };
  }

  const formattedPhone = formatPhoneNumber(phone);

  const templateVariables: WhatsAppTemplateVariables = {
    body_1: {
      type: "text",
      value: otp,
    },
    ...variables,
  };

  return sendWhatsAppMessage(phone, templateName, templateVariables, "en");
}
