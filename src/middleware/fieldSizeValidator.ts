import { Request, Response, NextFunction } from "express";

/**
 * Field-Level Size Validation Middleware
 * Validates individual field sizes to prevent DoS attacks via large payloads
 *
 * Limits:
 * - String fields: 10KB per field
 * - Text/Notes fields: 100KB per field
 * - Array fields: 100 items max, 10KB per item
 * - Number fields: Standard JavaScript number limits
 */

interface FieldSizeConfig {
  maxStringLength: number; // Max characters for string fields
  maxTextLength: number; // Max characters for text/notes fields
  maxArrayLength: number; // Max items in array
  maxItemLength: number; // Max characters per array item
  maxNestedDepth: number; // Max nesting depth for objects
}

const DEFAULT_CONFIG: FieldSizeConfig = {
  maxStringLength: 10 * 1024, // 10KB
  maxTextLength: 100 * 1024, // 100KB
  maxArrayLength: 100,
  maxItemLength: 10 * 1024, // 10KB per item
  maxNestedDepth: 10,
};

/**
 * Calculate approximate size of a value in bytes
 */
function calculateSize(value: any, depth: number = 0): number {
  if (depth > DEFAULT_CONFIG.maxNestedDepth) {
    return Infinity; // Too deeply nested
  }

  if (value === null || value === undefined) {
    return 0;
  }

  if (typeof value === "string") {
    // UTF-8 encoding: most characters are 1 byte, but some are 2-4 bytes
    // Use Buffer.byteLength for accurate size
    return Buffer.byteLength(value, "utf8");
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return 8; // Approximate size
  }

  if (Array.isArray(value)) {
    let size = 0;
    for (const item of value) {
      size += calculateSize(item, depth + 1);
      if (size > DEFAULT_CONFIG.maxTextLength) {
        return Infinity; // Too large
      }
    }
    return size;
  }

  if (typeof value === "object") {
    let size = 0;
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        size += Buffer.byteLength(key, "utf8"); // Key size
        size += calculateSize(value[key], depth + 1); // Value size
        if (size > DEFAULT_CONFIG.maxTextLength) {
          return Infinity; // Too large
        }
      }
    }
    return size;
  }

  return 0;
}

/**
 * Validate field size recursively
 */
function validateField(
  key: string,
  value: any,
  path: string = "",
  depth: number = 0,
  errors: string[] = []
): void {
  const currentPath = path ? `${path}.${key}` : key;

  // Check nesting depth
  if (depth > DEFAULT_CONFIG.maxNestedDepth) {
    errors.push(
      `Field "${currentPath}" exceeds maximum nesting depth of ${DEFAULT_CONFIG.maxNestedDepth}`
    );
    return;
  }

  if (value === null || value === undefined) {
    return; // Null/undefined values are fine
  }

  // Validate strings
  if (typeof value === "string") {
    const size = Buffer.byteLength(value, "utf8");

    // Check if it's a text field (notes, description, etc.)
    // Also treat formData as a special case since it contains complex nested doctor notes data
    const isTextField =
      /notes|description|content|message|text|body|comment/i.test(currentPath);
    const isFormDataField = /^formdata$/i.test(currentPath);

    // formData can be large (doctor notes with multiple sections), allow up to 500KB
    const maxLength = isFormDataField
      ? 500 * 1024 // 500KB for formData
      : isTextField
      ? DEFAULT_CONFIG.maxTextLength
      : DEFAULT_CONFIG.maxStringLength;

    if (size > maxLength) {
      errors.push(
        `Field "${currentPath}" exceeds maximum size of ${maxLength} bytes (got ${size} bytes). ${
          isFormDataField
            ? "Form data fields"
            : isTextField
            ? "Text fields"
            : "String fields"
        } are limited to ${maxLength} bytes.`
      );
    }
    return;
  }

  // Validate arrays
  if (Array.isArray(value)) {
    if (value.length > DEFAULT_CONFIG.maxArrayLength) {
      errors.push(
        `Field "${currentPath}" exceeds maximum array length of ${DEFAULT_CONFIG.maxArrayLength} items (got ${value.length} items)`
      );
      return;
    }

    // Validate each array item
    value.forEach((item, index) => {
      if (typeof item === "string") {
        const itemSize = Buffer.byteLength(item, "utf8");
        if (itemSize > DEFAULT_CONFIG.maxItemLength) {
          errors.push(
            `Field "${currentPath}[${index}]" exceeds maximum item size of ${DEFAULT_CONFIG.maxItemLength} bytes (got ${itemSize} bytes)`
          );
        }
      } else {
        validateField(index.toString(), item, currentPath, depth + 1, errors);
      }
    });
    return;
  }

  // Validate objects (recursive)
  if (typeof value === "object" && !Array.isArray(value)) {
    for (const nestedKey in value) {
      if (Object.prototype.hasOwnProperty.call(value, nestedKey)) {
        validateField(
          nestedKey,
          value[nestedKey],
          currentPath,
          depth + 1,
          errors
        );
      }
    }
    return;
  }

  // Numbers and booleans are fine (already validated by type)
}

/**
 * Field-level size validation middleware
 * Validates request body fields to prevent DoS attacks
 */
export function validateFieldSizes(
  config: Partial<FieldSizeConfig> = {}
): (req: Request, res: Response, next: NextFunction) => void {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  return (req: Request, res: Response, next: NextFunction) => {
    // Only validate POST, PUT, PATCH requests with body
    if (!["POST", "PUT", "PATCH"].includes(req.method) || !req.body) {
      return next();
    }

    const errors: string[] = [];

    // Validate each field in the request body
    for (const key in req.body) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        validateField(key, req.body[key], "", 0, errors);
      }
    }

    // If validation errors found, return error response
    if (errors.length > 0) {
      // console.warn("[FIELD VALIDATION] Field size validation failed:", {
      // path: req.path,
      // method: req.method,
      // errors: errors.slice(0, 5)
      // , // Log first 5 errors
      // });

      return res.status(400).json({
        success: false,
        message: "Request contains fields that exceed size limits",
        errors: errors.slice(0, 10), // Return first 10 errors to client
      });
    }

    next();
  };
}

/**
 * Validate specific field sizes (for custom validation)
 */
export function validateSpecificField(
  fieldName: string,
  value: any,
  maxSize: number
): { isValid: boolean; error?: string } {
  if (typeof value === "string") {
    const size = Buffer.byteLength(value, "utf8");
    if (size > maxSize) {
      return {
        isValid: false,
        error: `Field "${fieldName}" exceeds maximum size of ${maxSize} bytes (got ${size} bytes)`,
      };
    }
  }

  return { isValid: true };
}
