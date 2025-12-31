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

  // Optional: Only log in development or when ENABLE_API_LOGGER=true
  const enableLogger =
    process.env.ENABLE_API_LOGGER === "true" ||
    process.env.NODE_ENV === "development";
  if (!enableLogger) {
    return next();
  }

  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  // Simplified logging - just method, path, and status
  // console.log(
  //   `[API] ${req.method} ${req.path} ${
  //     req.user ? `[User: ${req.user.id}]` : "[Unauthenticated]"
  //   }`
  // );

  // Capture response for status code logging
  const originalSend = res.send;
  res.send = function (body: any) {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;

    // Only log errors or slow requests (>1000ms) in detail
    if (statusCode >= 400 || duration > 1000) {
      // console.log(
      //   `[API] ${req.method} ${req.path} → ${statusCode} (${duration}ms)`
      // );

      // Log error details
      if (statusCode >= 400 && body) {
        try {
          const parsedBody = typeof body === "string" ? JSON.parse(body) : body;
          const errorMessage =
            parsedBody.message || parsedBody.error || "Unknown error";
          // console.log(`[API ERROR] ${errorMessage}`);
        } catch (e) {
          // Not JSON, skip
        }
      }
    }

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
