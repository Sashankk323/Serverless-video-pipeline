import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const execFileAsync = promisify(execFile);
const s3 = new S3Client({});

// Rendition ladder, largest first. 480p is always included even if the
// source is shorter (a mild, deliberate exception to the no-upscale rule
// below) so every job produces at least one playable output.
const CANDIDATE_HEIGHTS = [1080, 720, 480];
const FLOOR_HEIGHT = 480;

function decodeS3Key(rawKey) {
  return decodeURIComponent(rawKey.replace(/\+/g, ' '));
}

async function ffprobe(inputPath) {
  const { stdout } = await execFileAsync('/usr/local/bin/ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_entries', 'stream=width,height:format=duration',
    inputPath,
  ]);
  const parsed = JSON.parse(stdout);
  const videoStream = (parsed.streams || []).find((s) => s.width && s.height);
  if (!videoStream) {
    throw new Error('ffprobe found no video stream with width/height');
  }
  return {
    width: videoStream.width,
    height: videoStream.height,
    duration: Number(parsed.format?.duration) || null,
  };
}

function buildRenditionPlan(sourceHeight) {
  const renditions = CANDIDATE_HEIGHTS
    .filter((h) => h <= sourceHeight)
    .map((h) => ({ height: h }));

  if (!renditions.some((r) => r.height === FLOOR_HEIGHT)) {
    renditions.push({ height: FLOOR_HEIGHT });
  }
  return renditions;
}

// Payload shape, set by the Probe task in the state machine: { bucket, key, jobId }
export const handler = async (event) => {
  const { bucket, jobId } = event;
  const key = decodeS3Key(event.key);
  const inputPath = `/tmp/${jobId}-probe-input`;

  console.log(`[${jobId}] probe start - bucket=${bucket} key=${key}`);

  try {
    const downloadStart = Date.now();
    const getResult = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await pipeline(getResult.Body, createWriteStream(inputPath));
    console.log(`[${jobId}] probe download complete in ${Date.now() - downloadStart}ms`);

    const { width, height, duration } = await ffprobe(inputPath);
    const renditions = buildRenditionPlan(height);
    console.log(`[${jobId}] probe result - ${width}x${height}, duration=${duration}s, plan=${JSON.stringify(renditions)}`);

    return { width, height, duration, renditions };
  } finally {
    await unlink(inputPath).catch(() => {});
  }
};
