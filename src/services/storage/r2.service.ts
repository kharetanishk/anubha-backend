import {
  PutObjectCommand,
  PutObjectCommandInput,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import r2Client from "./r2.client";

/**
 * R2 Upload Service
 *
 * Generic service for uploading files to Cloudflare R2 storage (private bucket).
 * Provides utilities for structured key generation, file uploads, and signed URL generation.
 *
 * Security: All files are stored in a private bucket. Access is granted only through
 * time-limited signed URLs generated on-demand. Signed URLs are never stored in the database.
 */

/**
 * Upload a file to R2 storage (private bucket)
 *
 * @param bucket - R2 bucket name
 * @param key - Object key (path) in the bucket
 * @param body - File content (Buffer, Stream, or string)
 * @param contentType - MIME type of the file (optional)
 * @param metadata - Additional metadata (optional)
 * @returns Object key of the uploaded file
 */
export async function uploadFile({
  bucket,
  key,
  body,
  contentType,
  metadata,
}: {
  bucket: string;
  key: string;
  body: Buffer | Uint8Array | string | Readable;
  contentType?: string;
  metadata?: Record<string, string>;
}): Promise<{ key: string }> {
  const params: PutObjectCommandInput = {
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: metadata,
  };

  const command = new PutObjectCommand(params);
  await r2Client.send(command);

  return { key };
}

/**
 * Doctor note file types
 */
export type DoctorNoteFileType = "pdf" | "reports" | "pre-post";
export type PrePostType = "pre" | "post";

/**
 * Generate a structured key for doctor notes files
 *
 * Format: doctor-notes/{type}/{appointmentId}/{uuid}.{ext}
 *
 * @param type - Type of doctor note file (pdf, reports, pre-post)
 * @param appointmentId - Appointment ID
 * @param extension - File extension (without dot, e.g., "pdf", "jpg", "png")
 * @param uuid - Optional custom UUID. If not provided, a random UUID will be generated
 * @returns Structured key for the file
 *
 * @example
 * ```typescript
 * const key = generateDoctorNoteKey("pdf", "appt-123", "pdf");
 * // Returns: "doctor-notes/pdf/appt-123/550e8400-e29b-41d4-a716-446655440000.pdf"
 * ```
 */
export function generateDoctorNoteKey(
  type: DoctorNoteFileType,
  appointmentId: string,
  extension: string,
  uuid?: string
): string {
  const fileUuid = uuid || randomUUID();
  const ext = extension.startsWith(".") ? extension.slice(1) : extension;
  return `doctor-notes/${type}/${appointmentId}/${fileUuid}.${ext}`;
}

/**
 * Generate a structured key for pre/post consultation images
 *
 * Format: doctor-notes/pre-post/{pre|post}/{appointmentId}/{uuid}.{ext}
 *
 * @param prePostType - Type of consultation image ("pre" or "post")
 * @param appointmentId - Appointment ID
 * @param extension - File extension (without dot, e.g., "jpg", "png", "jpeg")
 * @param uuid - Optional custom UUID. If not provided, a random UUID will be generated
 * @returns Structured key for the file
 *
 * @example
 * ```typescript
 * const key = generatePrePostImageKey("pre", "appt-123", "jpg");
 * // Returns: "doctor-notes/pre-post/pre/appt-123/550e8400-e29b-41d4-a716-446655440000.jpg"
 * ```
 */
export function generatePrePostImageKey(
  prePostType: PrePostType,
  appointmentId: string,
  extension: string,
  uuid?: string
): string {
  const fileUuid = uuid || randomUUID();
  const ext = extension.startsWith(".") ? extension.slice(1) : extension;
  return `doctor-notes/pre-post/${prePostType}/${appointmentId}/${fileUuid}.${ext}`;
}

/**
 * Upload a pre/post consultation image with structured key (private bucket)
 *
 * @param bucket - R2 bucket name
 * @param prePostType - Type of consultation image ("pre" or "post")
 * @param appointmentId - Appointment ID
 * @param body - File content
 * @param extension - File extension
 * @param contentType - MIME type (optional)
 * @param metadata - Additional metadata (optional)
 * @param uuid - Optional custom UUID for the file
 * @returns Object containing the key only
 */
export async function uploadPrePostImage({
  bucket,
  prePostType,
  appointmentId,
  body,
  extension,
  contentType,
  metadata,
  uuid,
}: {
  bucket: string;
  prePostType: PrePostType;
  appointmentId: string;
  body: Buffer | Uint8Array | string | Readable;
  extension: string;
  contentType?: string;
  metadata?: Record<string, string>;
  uuid?: string;
}): Promise<{ key: string }> {
  const key = generatePrePostImageKey(
    prePostType,
    appointmentId,
    extension,
    uuid
  );

  await uploadFile({
    bucket,
    key,
    body,
    contentType,
    metadata,
  });

  return { key };
}

/**
 * Upload a doctor note file with structured key (private bucket)
 *
 * @param bucket - R2 bucket name
 * @param type - Type of doctor note file
 * @param appointmentId - Appointment ID
 * @param body - File content
 * @param extension - File extension
 * @param contentType - MIME type (optional)
 * @param metadata - Additional metadata (optional)
 * @param uuid - Optional custom UUID for the file
 * @returns Object containing the key only
 *
 * @example
 * ```typescript
 * const result = await uploadDoctorNoteFile({
 *   bucket: "my-bucket",
 *   type: "pdf",
 *   appointmentId: "appt-123",
 *   body: fileBuffer,
 *   extension: "pdf",
 *   contentType: "application/pdf"
 * });
 * // Returns: { key: "doctor-notes/pdf/appt-123/uuid.pdf" }
 * ```
 */
export async function uploadDoctorNoteFile({
  bucket,
  type,
  appointmentId,
  body,
  extension,
  contentType,
  metadata,
  uuid,
}: {
  bucket: string;
  type: DoctorNoteFileType;
  appointmentId: string;
  body: Buffer | Uint8Array | string | Readable;
  extension: string;
  contentType?: string;
  metadata?: Record<string, string>;
  uuid?: string;
}): Promise<{ key: string }> {
  const key = generateDoctorNoteKey(type, appointmentId, extension, uuid);

  await uploadFile({
    bucket,
    key,
    body,
    contentType,
    metadata,
  });

  return { key };
}

/**
 * Default expiration time for signed URLs (in seconds)
 *
 * 360 seconds = 6 minutes
 * Suitable for medical document access with security and usability balance.
 */
const DEFAULT_SIGNED_URL_EXPIRY = 360; // 6 minutes

/**
 * Minimum expiration time for signed URLs (in seconds)
 * 300 seconds = 5 minutes
 */
const MIN_SIGNED_URL_EXPIRY = 300;

/**
 * Maximum expiration time for signed URLs (in seconds)
 * 600 seconds = 10 minutes
 */
const MAX_SIGNED_URL_EXPIRY = 600;

/**
 * Generate a signed download URL for a private R2 object
 *
 * Creates a time-limited, pre-signed URL that allows secure access to private objects
 * without exposing permanent URLs or storing them in the database.
 *
 * **Security Best Practices:**
 * - URLs expire after the specified duration (default: 6 minutes)
 * - URLs are generated on-demand, never stored persistently
 * - Suitable for medical documents requiring secure, time-limited access
 *
 * @param bucket - R2 bucket name
 * @param key - Object key (path) in the bucket
 * @param expiresInSeconds - Expiration time in seconds (default: 360, range: 300-600)
 * @returns Signed URL that expires after the specified duration
 *
 * @example
 * ```typescript
 * // Generate signed URL with default expiry (6 minutes)
 * const url = await generateSignedDownloadUrl("my-bucket", "doctor-notes/pdf/appt-123/file.pdf");
 *
 * // Generate signed URL with custom expiry (5 minutes)
 * const url = await generateSignedDownloadUrl("my-bucket", "doctor-notes/pdf/appt-123/file.pdf", 300);
 * ```
 *
 * @throws Error if bucket or key is invalid, or if expiry is out of range
 */
export async function generateSignedDownloadUrl(
  bucket: string,
  key: string,
  expiresInSeconds: number = DEFAULT_SIGNED_URL_EXPIRY
): Promise<string> {
  // Validate inputs
  if (!bucket || typeof bucket !== "string" || !bucket.trim()) {
    throw new Error("Bucket name is required and must be a non-empty string");
  }

  if (!key || typeof key !== "string" || !key.trim()) {
    throw new Error("Object key is required and must be a non-empty string");
  }

  // Validate and clamp expiry time to secure range (300-600 seconds)
  let validExpiry = expiresInSeconds || DEFAULT_SIGNED_URL_EXPIRY;

  if (validExpiry < MIN_SIGNED_URL_EXPIRY) {
    validExpiry = MIN_SIGNED_URL_EXPIRY;
  } else if (validExpiry > MAX_SIGNED_URL_EXPIRY) {
    validExpiry = MAX_SIGNED_URL_EXPIRY;
  }

  // Create GetObjectCommand
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  // Generate signed URL using the existing R2 client
  const signedUrl = await getSignedUrl(r2Client, command, {
    expiresIn: validExpiry,
  });

  return signedUrl;
}

/**
 * Download a file from R2 storage (server-side only)
 *
 * Fetches the actual file content from R2 for server-side processing.
 * This is used for operations like email attachments where we need the file
 * content, not a URL.
 *
 * **Security:**
 * - Server-side only - never expose R2 keys to frontend
 * - Files remain private in R2 at all times
 * - No signed URLs or public URLs generated
 *
 * @param bucket - R2 bucket name
 * @param key - Object key (path) in the bucket
 * @returns File content as Buffer
 *
 * @throws Error if bucket/key is invalid or file doesn't exist
 *
 * @example
 * ```typescript
 * const fileBuffer = await downloadFile("my-bucket", "doctor-notes/pdf/appt-123/file.pdf");
 * // Use fileBuffer for email attachments, etc.
 * ```
 */
export async function downloadFile(
  bucket: string,
  key: string
): Promise<Buffer> {
  // Validate inputs
  if (!bucket || typeof bucket !== "string" || !bucket.trim()) {
    throw new Error("Bucket name is required and must be a non-empty string");
  }

  if (!key || typeof key !== "string" || !key.trim()) {
    throw new Error("Object key is required and must be a non-empty string");
  }

  // Create GetObjectCommand
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  try {
    // Execute the command to get the object
    const response = await r2Client.send(command);

    if (!response.Body) {
      throw new Error(`File not found or empty: ${key}`);
    }

    // Convert the response body to a Buffer
    // AWS SDK v3 returns a Readable stream or Uint8Array
    const body = response.Body;
    let buffer: Buffer;

    if (body instanceof Readable) {
      // Node.js Readable stream
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.from(chunk));
      }
      buffer = Buffer.concat(chunks);
    } else if (body instanceof Uint8Array) {
      // Already a Uint8Array
      buffer = Buffer.from(body);
    } else if (
      body &&
      typeof (body as any).transformToByteArray === "function"
    ) {
      // Blob-like object (AWS SDK v3)
      const byteArray = await (body as any).transformToByteArray();
      buffer = Buffer.from(byteArray);
    } else {
      // Fallback: try to convert to string then to buffer
      const text = await (body as any).transformToString();
      buffer = Buffer.from(text, "utf-8");
    }

    return buffer;
  } catch (error: any) {
    if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) {
      throw new Error(`File not found in R2: ${key}`);
    }
    throw new Error(`Failed to download file from R2: ${error.message}`);
  }
}
