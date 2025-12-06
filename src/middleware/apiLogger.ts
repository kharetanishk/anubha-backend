import { Request, Response, NextFunction } from "express";

/**
 * API Request Logger Middleware
 * Logs all incoming API requests with method, path, query params, body, and user info
 */
export function apiLogger(req: Request, res: Response, next: NextFunction) {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  // Log request details
  console.log("==========================================");
  console.log(`[API REQUEST] ${timestamp}`);
  console.log(`  Method: ${req.method}`);
  console.log(`  Path: ${req.path}`);
  console.log(`  Full URL: ${req.protocol}://${req.get("host")}${req.originalUrl}`);

  // Log query parameters if any
  if (Object.keys(req.query).length > 0) {
    console.log(`  Query Params:`, JSON.stringify(req.query, null, 2));
  }

  // Log request body (excluding sensitive data)
  if (req.body && Object.keys(req.body).length > 0) {
    const sanitizedBody = sanitizeRequestBody(req.body);
    console.log(`  Request Body:`, JSON.stringify(sanitizedBody, null, 2));
  }

  // Log user info if available
  if (req.user) {
    console.log(`  User:`, {
      id: req.user.id,
      role: req.user.role,
    });
  } else {
    console.log(`  User: Not authenticated`);
  }

  // Log IP address
  const clientIp =
    req.ip ||
    req.socket.remoteAddress ||
    req.headers["x-forwarded-for"] ||
    "unknown";
  console.log(`  IP Address: ${clientIp}`);

  // Capture response
  const originalSend = res.send;
  res.send = function (body: any) {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;

    // Log response
    console.log(`[API RESPONSE] ${timestamp}`);
    console.log(`  Method: ${req.method}`);
    console.log(`  Path: ${req.path}`);
    console.log(`  Status Code: ${statusCode}`);
    console.log(`  Duration: ${duration}ms`);

    // Log response body (truncated if too long)
    if (body) {
      try {
        const parsedBody = typeof body === "string" ? JSON.parse(body) : body;
        const bodyStr = JSON.stringify(parsedBody);
        if (bodyStr.length > 500) {
          console.log(`  Response Body: ${bodyStr.substring(0, 500)}... (truncated)`);
        } else {
          console.log(`  Response Body:`, parsedBody);
        }
      } catch (e) {
        // Not JSON, log as string (truncated)
        const bodyStr = String(body);
        if (bodyStr.length > 500) {
          console.log(`  Response Body: ${bodyStr.substring(0, 500)}... (truncated)`);
        } else {
          console.log(`  Response Body: ${bodyStr}`);
        }
      }
    }

    console.log("==========================================");

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

