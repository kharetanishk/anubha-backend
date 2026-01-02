import { Response } from "express";

export interface ApiErrorResponse {
  success: false;
  message: string;
  code?: string;
  details?: any;
}

/**
 * Standardized error response helper
 * Ensures all API errors follow the same format
 */
export function sendErrorResponse(
  res: Response,
  statusCode: number,
  message: string,
  code?: string,
  details?: any
): Response {
  const errorResponse: ApiErrorResponse = {
    success: false,
    message,
    ...(code && { code }),
    ...(details && { details }),
  };

  return res.status(statusCode).json(errorResponse);
}

/**
 * Handle unexpected errors with proper logging and user-safe messages
 */
export function handleUnexpectedError(
  res: Response,
  error: unknown,
  context: string
): Response {
  // Log the full error for debugging (server-side only)
  if (process.env.NODE_ENV !== "production") {
    console.error(`[ERROR] ${context}:`, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      timestamp: new Date().toISOString(),
    });
  } else {
    console.error(`[ERROR] ${context}:`, {
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
  }

  // Return user-safe error message
  return sendErrorResponse(
    res,
    500,
    "An unexpected error occurred. Please try again later.",
    "INTERNAL_SERVER_ERROR"
  );
}

/**
 * Handle database connection errors with retry suggestion
 */
export function handleDatabaseError(
  res: Response,
  error: unknown,
  context: string
): Response {
  const err = error as { code?: string; message?: string };

  // Check for connection errors
  if (
    err.code === "P1017" ||
    err.message?.includes("closed") ||
    err.message?.includes("ConnectionReset")
  ) {
    console.error(`[DB CONNECTION ERROR] ${context}:`, {
      code: err.code,
      message: err.message,
      timestamp: new Date().toISOString(),
    });

    return sendErrorResponse(
      res,
      503,
      "Database connection error. Please try again in a moment.",
      "DB_CONNECTION_ERROR",
      { retryable: true }
    );
  }

  // Handle other Prisma errors
  if (err.code?.startsWith("P")) {
    console.error(`[DB ERROR] ${context}:`, {
      code: err.code,
      message: err.message,
      timestamp: new Date().toISOString(),
    });

    return sendErrorResponse(
      res,
      500,
      "Database error. Please try again later.",
      err.code
    );
  }

  // Fallback to unexpected error handler
  return handleUnexpectedError(res, error, context);
}
