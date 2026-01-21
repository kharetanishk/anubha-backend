import { Request, Response, NextFunction } from "express";

/**
 * API Request Logger Middleware
 * Logs all incoming API requests with method, path, query params, body, and user info
 *
 * Excludes noisy endpoints like health checks and webhooks to reduce log spam
 */
export function apiLogger(req: Request, res: Response, next: NextFunction) {
  // Skip logging for noisy endpoints
  const skipPaths = [
    "/api/health",
    "/api/payment/webhook", // Webhook logs are handled separately
  ];

  // Skip logging if path matches skip list
  if (skipPaths.some((path) => req.path === path || req.originalUrl === path)) {
    return next();
  }

  // Only log in development or when ENABLE_API_LOGGER=true
  const enableLogger =
    process.env.ENABLE_API_LOGGER === "true" ||
    process.env.NODE_ENV === "development";
  if (!enableLogger) {
    return next();
  }

  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  // Log request details
  console.log("\n" + "=".repeat(80));
  console.log(`[API REQUEST] ${timestamp}`);
  console.log("=".repeat(80));
  console.log(`Method: ${req.method}`);
  console.log(`Path: ${req.path}`);
  console.log(`URL: ${req.originalUrl || req.url}`);

  // Log query parameters
  if (Object.keys(req.query || {}).length > 0) {
    console.log(`Query Params:`, JSON.stringify(req.query, null, 2));
  }

  // Log request headers (excluding sensitive ones)
  const headersToLog: any = {};
  Object.keys(req.headers).forEach((key) => {
    const lowerKey = key.toLowerCase();
    if (
      !lowerKey.includes("authorization") &&
      !lowerKey.includes("cookie") &&
      !lowerKey.includes("token")
    ) {
      headersToLog[key] = req.headers[key];
    } else {
      headersToLog[key] = "***REDACTED***";
    }
  });
  if (Object.keys(headersToLog).length > 0) {
    console.log(`Headers:`, JSON.stringify(headersToLog, null, 2));
  }

  // Log request body (sanitized)
  if (req.body && Object.keys(req.body).length > 0) {
    const sanitizedBody = sanitizeRequestBody(req.body);
    console.log(`Request Body:`, JSON.stringify(sanitizedBody, null, 2));
  }

  // Log user info (if authenticated)
  if (req.user) {
    console.log(`User:`, {
      id: req.user.id,
      role: req.user.role,
      email: (req.user as any).email || "N/A",
    });
  } else {
    console.log(`User: [Unauthenticated]`);
  }

  // Capture response for status code logging
  const originalSend = res.send;
  res.send = function (body: any) {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;

    // Log response details
    console.log("\n" + "-".repeat(80));
    console.log(`[API RESPONSE] ${new Date().toISOString()}`);
    console.log("-".repeat(80));
    console.log(`Status: ${statusCode}`);
    console.log(`Duration: ${duration}ms`);

    // Log response body (truncated for large responses)
    if (body) {
      try {
        const parsedBody = typeof body === "string" ? JSON.parse(body) : body;
        const bodyString = JSON.stringify(parsedBody, null, 2);

        // Truncate very long responses (keep first 2000 chars)
        if (bodyString.length > 2000) {
          console.log(
            `Response Body (truncated):`,
            bodyString.substring(0, 2000) + "\n... (truncated)"
          );
        } else {
          console.log(`Response Body:`, bodyString);
        }

        // Log error details prominently for errors
        if (statusCode >= 400) {
          const errorMessage =
            parsedBody.message || parsedBody.error || "Unknown error";
          console.log("\n" + "⚠️ ".repeat(20));
          console.log(`[API ERROR] ${errorMessage}`);
          if (parsedBody.stack && process.env.NODE_ENV === "development") {
            console.log(`Stack:`, parsedBody.stack);
          }
          console.log("⚠️ ".repeat(20));
        }
      } catch (e) {
        // Not JSON, log as string (truncated)
        const bodyStr = String(body);
        if (bodyStr.length > 500) {
          console.log(`Response Body (string, truncated):`, bodyStr.substring(0, 500) + "...");
        } else {
          console.log(`Response Body (string):`, bodyStr);
        }
      }
    }

    console.log("=".repeat(80) + "\n");

    // Call original send
    return originalSend.call(this, body);
  };

  next();
}

/**
 * Sanitize request body to remove sensitive information
 */
function sanitizeRequestBody(body: any): any {
  if (!body || typeof body !== "object") {
    return body;
  }

  const sensitiveFields = [
    "password",
    "token",
    "auth_token",
    "secret",
    "key",
    "apiKey",
    "authorization",
    "creditCard",
    "cvv",
    "ssn",
  ];

  const sanitized = { ...body };

  for (const field of sensitiveFields) {
    if (sanitized[field]) {
      sanitized[field] = "***REDACTED***";
    }
  }

  return sanitized;
}
