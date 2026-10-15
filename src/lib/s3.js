const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const path = require("path");

// ── Extension mappings for documents, videos, images, audio ─────────────────────
const MIME_TO_EXT = {
  // Images
  "image/jpeg":      ".jpg",
  "image/jpg":       ".jpg",
  "image/png":       ".png",
  "image/webp":      ".webp",
  "image/gif":       ".gif",
  "image/svg+xml":   ".svg",
  "image/bmp":       ".bmp",
  "image/tiff":      ".tiff",
  "image/heic":      ".heic",
  "image/heif":      ".heif",

  // Documents
  "application/pdf":    ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "text/plain":         ".txt",
  "text/csv":           ".csv",
  "application/rtf":    ".rtf",

  // Videos
  "video/mp4":        ".mp4",
  "video/quicktime":  ".mov",
  "video/x-msvideo":  ".avi",
  "video/webm":       ".webm",
  "video/3gpp":       ".3gp",
  "video/mpeg":       ".mpeg",
  "video/ogg":        ".ogv",

  // Audio
  "audio/mpeg":       ".mp3",
  "audio/mp3":        ".mp3",
  "audio/wav":        ".wav",
  "audio/wave":       ".wav",
  "audio/x-wav":      ".wav",
  "audio/ogg":        ".ogg",
  "audio/aac":        ".aac",
  "audio/m4a":        ".m4a",
  "audio/x-m4a":      ".m4a",
  "audio/webm":       ".weba",
  "audio/flac":       ".flac",
};

/**
 * Configure S3 Client.
 * Automatically picks up credentials from:
 * 1. Explicit AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY if present in environment
 * 2. AWS IAM Role (EC2 instance profile / ECS task role) if running on AWS
 * 3. Default AWS credentials (~/.aws/credentials)
 */
function createS3Client() {
  const region = process.env.AWS_REGION || "eu-north-1";
  const clientConfig = { region };

  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    clientConfig.credentials = {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
    };
  }

  if (process.env.AWS_ENDPOINT) {
    clientConfig.endpoint = process.env.AWS_ENDPOINT;
  }

  return new S3Client(clientConfig);
}

const s3Client = createS3Client();

function getBucketName() {
  return process.env.S3_BUCKET_NAME || "mangalayacheppu-dev";
}

function getRegion() {
  return process.env.AWS_REGION || "eu-north-1";
}

/**
 * Construct public S3 URL
 */
function getPublicUrl(key) {
  const bucket = getBucketName();
  const region = getRegion();
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

/**
 * Generate datewise folder and file name:
 * Folder: YYYY-MM-DD
 * Filename: <userId>_<YYYY-MM-DD>_<timestamp>_<random><ext>
 */
function generateS3Key({ userId = "user", originalname = "", mimetype = "", date = new Date() }) {
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const dateStr = `${yyyy}-${mm}-${dd}`;

  // Extension resolution: prefer original extension, fallback to mime map
  let ext = path.extname(originalname || "").toLowerCase();
  if (!ext && mimetype && MIME_TO_EXT[mimetype]) {
    ext = MIME_TO_EXT[mimetype];
  }

  const cleanUserId = String(userId || "user").replace(/[^a-zA-Z0-9_-]/g, "") || "user";
  const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;

  // Folder: datewise e.g. "2026-10-15"
  // File: userId+date e.g. "user123_2026-10-15_1729000000_123456.jpg"
  return `${dateStr}/${cleanUserId}_${dateStr}_${unique}${ext}`;
}

/**
 * Upload a buffer directly to AWS S3.
 *
 * @param {Object} params
 * @param {Buffer} params.buffer - File buffer
 * @param {string} [params.userId] - ID of the user uploading
 * @param {string} [params.originalname] - Original filename
 * @param {string} [params.mimetype] - MIME type of the file
 * @param {string} [params.key] - Optional predetermined key (if not provided, auto-generated)
 * @returns {Promise<{ key: string, url: string, bucket: string }>}
 */
async function uploadToS3({ buffer, userId, originalname, mimetype, key: customKey }) {
  if (!buffer) {
    throw new Error("No buffer provided for S3 upload");
  }

  const bucket = getBucketName();
  const key = customKey || generateS3Key({ userId, originalname, mimetype });

  const putParams = {
    Bucket:      bucket,
    Key:         key,
    Body:        buffer,
    ContentType: mimetype || "application/octet-stream",
  };

  if (process.env.S3_USE_ACL === "true") {
    putParams.ACL = "public-read";
  }

  console.log(`[S3] Uploading file to bucket="${bucket}", key="${key}", contentType="${putParams.ContentType}", size=${buffer.length} bytes`);

  try {
    await s3Client.send(new PutObjectCommand(putParams));
  } catch (err) {
    // If ACL was rejected because bucket has ACLs disabled (Bucket Owner Enforced), retry without ACL
    if (putParams.ACL && (err.name === "AccessControlListNotSupported" || String(err.message).includes("does not allow ACLs"))) {
      console.warn(`[S3] Bucket does not allow ACLs, retrying without ACL...`);
      delete putParams.ACL;
      await s3Client.send(new PutObjectCommand(putParams));
    } else {
      console.error(`[S3] PutObjectCommand failed for key "${key}":`, err.name, err.message);
      throw err;
    }
  }

  const url = getPublicUrl(key);
  console.log(`[S3] Upload success: ${url}`);
  return { key, url, bucket };
}

/**
 * Extract S3 key from an S3 URL or return the key directly
 */
function extractKeyFromUrl(urlOrKey) {
  if (!urlOrKey) return null;
  const str = String(urlOrKey).trim();
  if (str.startsWith("http://") || str.startsWith("https://")) {
    try {
      const parsed = new URL(str);
      return decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    } catch {
      return str;
    }
  }
  return str;
}

/**
 * Delete an object from S3 by URL or key
 */
async function deleteFromS3(urlOrKey) {
  const key = extractKeyFromUrl(urlOrKey);
  if (!key) return;

  const bucket = getBucketName();
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    console.error(`[S3] delete failed for key ${key}:`, err.message);
  }
}

function isS3Url(url) {
  if (!url || typeof url !== "string") return false;
  return url.startsWith("http://") || url.startsWith("https://");
}

module.exports = {
  s3Client,
  getBucketName,
  getRegion,
  getPublicUrl,
  generateS3Key,
  uploadToS3,
  deleteFromS3,
  extractKeyFromUrl,
  isS3Url,
  MIME_TO_EXT,
};
