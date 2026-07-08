import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({});
const BUCKET_NAME = process.env.BUCKET_NAME;
const URL_EXPIRY_SECONDS = 300; // 5 minutes

// Strips paths and anything that isn't safe in an S3 key, so a filename like
// "../../etc/passwd" or "my video!.mp4" can't escape the uploads/ prefix or
// produce a key S3/CloudFront would mishandle.
function sanitizeFilename(rawName) {
  const baseName = rawName.split(/[/\\]/).pop() || 'video';
  const cleaned = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.slice(0, 200) || 'video';
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  const params = event.queryStringParameters || {};
  const filename = params.filename;
  const contentType = params.contentType;

  if (!filename || typeof filename !== 'string') {
    return jsonResponse(400, { error: 'Missing required query parameter: filename' });
  }
  if (!contentType || !contentType.startsWith('video/')) {
    return jsonResponse(400, { error: 'contentType must be a video/* MIME type' });
  }

  const safeFilename = sanitizeFilename(filename);
  const key = `uploads/${randomUUID()}/${safeFilename}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: URL_EXPIRY_SECONDS });

  return jsonResponse(200, { uploadUrl, key, expiresIn: URL_EXPIRY_SECONDS });
};
