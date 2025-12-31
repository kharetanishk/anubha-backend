const MAGIC_BYTES: Record<string, number[][]> = {
  "image/jpeg": [
    [0xff, 0xd8, 0xff], // JPEG
  ],
  "image/jpg": [
    [0xff, 0xd8, 0xff], // JPEG (same as jpeg)
  ],
  "image/png": [
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // PNG full signature (preferred)
    [0x89, 0x50, 0x4e, 0x47], // PNG first 4 bytes (fallback - always present)
  ],
  "image/x-png": [
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // PNG full signature (preferred)
    [0x89, 0x50, 0x4e, 0x47], // PNG first 4 bytes (fallback - always present)
  ],
  "application/pdf": [
    [0x25, 0x50, 0x44, 0x46], // PDF signature: %PDF
  ],
};

/**
 * Check if file buffer matches expected magic bytes for MIME type
 * @param buffer File buffer
 * @param mimeType Expected MIME type
 * @returns true if file content matches MIME type, false otherwise
 */
export function validateFileContent(buffer: Buffer, mimeType: string): boolean {
  if (!buffer || buffer.length === 0) {
    // console.warn(`[FILE VALIDATOR] Empty buffer for MIME type: ${mimeType}`);
return false;
  }

  const normalizedMimeType = mimeType.toLowerCase();
  const expectedSignatures = MAGIC_BYTES[normalizedMimeType];
  if (!expectedSignatures) {
    // Unknown MIME type - reject for security
    // console.warn(`[FILE VALIDATOR] Unknown MIME type: ${mimeType}`);
return false;
  }

  // For PNG files, prioritize the 4-byte check as it's more reliable
  // Some PNG files may have line ending variations in the full 8-byte signature
  if (
    normalizedMimeType === "image/png" ||
    normalizedMimeType === "image/x-png"
  ) {
    // Check 4-byte signature first (most reliable)
    const png4Byte = [0x89, 0x50, 0x4e, 0x47];
    if (buffer.length >= 4) {
      let matches4Byte = true;
      for (let i = 0; i < 4; i++) {
        if (buffer[i] !== png4Byte[i]) {
          matches4Byte = false;
          break;
        }
      }
      if (matches4Byte) {
        return true;
      }
    }
    // If 4-byte check fails, try full 8-byte signature
    const png8Byte = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (buffer.length >= 8) {
      let matches8Byte = true;
      for (let i = 0; i < 8; i++) {
        if (buffer[i] !== png8Byte[i]) {
          matches8Byte = false;
          break;
        }
      }
      if (matches8Byte) {
        return true;
      }
    }
    return false;
  }

  // For other file types, check all expected signatures
  for (const signature of expectedSignatures) {
    if (buffer.length < signature.length) {
      continue;
    }

    let matches = true;
    for (let i = 0; i < signature.length; i++) {
      if (buffer[i] !== signature[i]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return true;
    }
  }

  return false;
}

/**
 * Validate file upload with both MIME type and content validation
 * @param file Multer file object
 * @param allowedMimeTypes Array of allowed MIME types
 * @returns true if valid, throws error if invalid
 */
export function validateFileUpload(
  file: Express.Multer.File,
  allowedMimeTypes: string[]
): void {
  if (!file || !file.buffer) {
    throw new Error("File buffer is required");
  }

  const mimeType = file.mimetype.toLowerCase();

  // Check MIME type
  if (!allowedMimeTypes.includes(mimeType)) {
    throw new Error(
      `Invalid MIME type: ${mimeType}. Allowed types: ${allowedMimeTypes.join(
        ", "
      )}`
    );
  }

  // Normalize PNG MIME types (x-png should be treated as png for content validation)
  const normalizedMimeType =
    mimeType === "image/x-png" ? "image/png" : mimeType;

  // Validate file content matches MIME type (prevent MIME type spoofing)
  if (!validateFileContent(file.buffer, normalizedMimeType)) {
    const bufferStart = Array.from(file.buffer.slice(0, 12))
      .map((b) => `0x${b.toString(16).padStart(2, "0")}`)
      .join(" ");
    const bufferHex = Array.from(file.buffer.slice(0, 12))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");

    const expectedSignatures = MAGIC_BYTES[normalizedMimeType] || [];

    console.error(`[FILE VALIDATOR] File content validation failed.`, {
      mimeType,
      normalizedMimeType,
      fileName: file.originalname,
      fileSize: file.size,
      bufferLength: file.buffer.length,
      bufferStart,
      bufferHex,
      expectedSignatures,
    });
    throw new Error(
      `File content does not match declared MIME type. Possible file type spoofing detected.`
    );
  }
}
