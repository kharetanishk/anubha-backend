import { S3Client } from "@aws-sdk/client-s3";

/**
 * Cloudflare R2 (S3-compatible) Client
 *
 * Reusable S3Client instance configured for Cloudflare R2.
 * Uses environment variables for configuration:
 * - R2_ACCESS_KEY_ID: R2 access key ID
 * - R2_SECRET_ACCESS_KEY: R2 secret access key
 * - R2_ENDPOINT: R2 endpoint URL (e.g., https://<account-id>.r2.cloudflarestorage.com)
 *
 * Region is set to "auto" as required by Cloudflare R2.
 *
 * @example
 * ```typescript
 * import { r2Client } from '@/services/storage/r2.client';
 * import { PutObjectCommand } from '@aws-sdk/client-s3';
 *
 * const command = new PutObjectCommand({
 *   Bucket: 'my-bucket',
 *   Key: 'path/to/file.jpg',
 *   Body: fileBuffer,
 * });
 *
 * await r2Client.send(command);
 * ```
 */

// Validate required R2 environment variables
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_ENDPOINT = process.env.R2_ENDPOINT;

if (!R2_ACCESS_KEY_ID || !R2_ACCESS_KEY_ID.trim()) {
  throw new Error(
    "R2_ACCESS_KEY_ID environment variable is required but not set. Please configure it in your .env file."
  );
}

if (!R2_SECRET_ACCESS_KEY || !R2_SECRET_ACCESS_KEY.trim()) {
  throw new Error(
    "R2_SECRET_ACCESS_KEY environment variable is required but not set. Please configure it in your .env file."
  );
}

if (!R2_ENDPOINT || !R2_ENDPOINT.trim()) {
  throw new Error(
    "R2_ENDPOINT environment variable is required but not set. Please configure it in your .env file."
  );
}

// Validate R2_ENDPOINT is a valid URL
try {
  new URL(R2_ENDPOINT);
} catch (error) {
  throw new Error(
    `R2_ENDPOINT must be a valid URL. Current value: "${R2_ENDPOINT}". Example: https://<account-id>.r2.cloudflarestorage.com`
  );
}

const r2Client = new S3Client({
  region: "auto", // Cloudflare R2 requires "auto" region
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
  // Force path style for R2 compatibility
  forcePathStyle: true,
});

export default r2Client;
