import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET;

// S3 event keys arrive URL-encoded, and spaces are encoded as '+' rather than
// '%20' (a leftover from S3's form-encoding heritage) - decodeURIComponent
// alone leaves literal '+' characters in the filename, so swap those first.
function decodeS3Key(rawKey) {
  return decodeURIComponent(rawKey.replace(/\+/g, ' '));
}

async function runFfmpeg(inputPath, outputPath) {
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn('/usr/local/bin/ffmpeg', [
      '-i', inputPath,
      '-vf', 'scale=-2:720',
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

async function processRecord(record) {
  const bucket = record.s3.bucket.name;
  const key = decodeS3Key(record.s3.object.key);

  // Expected shape: uploads/{uuid}/{filename}
  const parts = key.split('/');
  if (parts.length < 3 || parts[0] !== 'uploads') {
    console.warn(`Skipping key with unexpected shape: ${key}`);
    return;
  }
  const uuid = parts[1];

  const inputPath = `/tmp/${uuid}-input`;
  const outputPath = `/tmp/${uuid}-720p.mp4`;

  console.log(`[${uuid}] start - bucket=${bucket} key=${key}`);

  try {
    const downloadStart = Date.now();
    const getResult = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await pipeline(getResult.Body, createWriteStream(inputPath));
    console.log(`[${uuid}] download complete in ${Date.now() - downloadStart}ms`);

    const transcodeStart = Date.now();
    await runFfmpeg(inputPath, outputPath);
    console.log(`[${uuid}] transcode complete in ${Date.now() - transcodeStart}ms`);

    const outputKey = `processed/${uuid}/720p.mp4`;
    const uploadStart = Date.now();
    await s3.send(new PutObjectCommand({
      Bucket: OUTPUT_BUCKET,
      Key: outputKey,
      Body: createReadStream(outputPath),
      ContentType: 'video/mp4',
    }));
    console.log(`[${uuid}] upload complete in ${Date.now() - uploadStart}ms - output=${OUTPUT_BUCKET}/${outputKey}`);
  } finally {
    await Promise.all([
      unlink(inputPath).catch(() => {}),
      unlink(outputPath).catch(() => {}),
    ]);
  }
}

export const handler = async (event) => {
  for (const record of event.Records) {
    await processRecord(record);
  }
};
