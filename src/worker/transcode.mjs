import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET;

// Keys can still arrive URL-encoded with '+' for spaces (form-encoding
// heritage) - harmless to run on an already-clean key, but cheap insurance
// since this key traces back to an S3 object key however it reaches us.
function decodeS3Key(rawKey) {
  return decodeURIComponent(rawKey.replace(/\+/g, ' '));
}

async function runFfmpeg(inputPath, outputPath, height) {
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn('/usr/local/bin/ffmpeg', [
      '-i', inputPath,
      '-vf', `scale=-2:${height}`,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      '-y',
      outputPath,
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        // ffmpeg writes its diagnostic output to stderr even on success, so only
        // the tail is useful here - the actual error is usually the last few lines.
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
      }
    });
  });
}

// Payload shape, set by the TranscodeFanout Map state in the state machine:
// { bucket, key, jobId, height, outputKey }
export const handler = async (event) => {
  const { bucket, jobId, height, outputKey } = event;
  const key = decodeS3Key(event.key);

  const inputPath = `/tmp/${jobId}-${height}p-input`;
  const outputPath = `/tmp/${jobId}-${height}p-output.mp4`;

  console.log(`[${jobId}] start ${height}p - bucket=${bucket} key=${key}`);

  try {
    const downloadStart = Date.now();
    const getResult = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await pipeline(getResult.Body, createWriteStream(inputPath));
    console.log(`[${jobId}] ${height}p download complete in ${Date.now() - downloadStart}ms`);

    const transcodeStart = Date.now();
    await runFfmpeg(inputPath, outputPath, height);
    const transcodeMs = Date.now() - transcodeStart;
    console.log(`[${jobId}] ${height}p transcode complete in ${transcodeMs}ms`);

    const uploadStart = Date.now();
    await s3.send(new PutObjectCommand({
      Bucket: OUTPUT_BUCKET,
      Key: outputKey,
      Body: createReadStream(outputPath),
      ContentType: 'video/mp4',
    }));
    console.log(`[${jobId}] ${height}p upload complete in ${Date.now() - uploadStart}ms - output=${OUTPUT_BUCKET}/${outputKey}`);

    return { height, outputKey, transcodeMs };
  } finally {
    await Promise.all([
      unlink(inputPath).catch(() => {}),
      unlink(outputPath).catch(() => {}),
    ]);
  }
};
