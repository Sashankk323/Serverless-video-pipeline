import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const execFileAsync = promisify(execFile);
const s3 = new S3Client({});
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET;

const CONTENT_TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
};

// Keys can still arrive URL-encoded with '+' for spaces (form-encoding
// heritage) - harmless to run on an already-clean key, but cheap insurance
// since this key traces back to an S3 object key however it reaches us.
function decodeS3Key(rawKey) {
  return decodeURIComponent(rawKey.replace(/\+/g, ' '));
}

async function runFfmpegHls(inputPath, outputDir, height) {
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn('/usr/local/bin/ffmpeg', [
      '-i', inputPath,
      '-vf', `scale=-2:${height}`,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-hls_time', '6',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(outputDir, 'segment%05d.ts'),
      '-y',
      path.join(outputDir, 'playlist.m3u8'),
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

// Probes the first emitted segment (not the source) for the *actual* encoded
// width - scale=-2:height rounds to the nearest even number, so deriving
// width from the source aspect ratio in JS can be off by a pixel or two from
// what ffmpeg really wrote. RESOLUTION in the master playlist should match
// the bytes on disk exactly.
async function probeSegmentWidth(segmentPath) {
  const { stdout } = await execFileAsync('/usr/local/bin/ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_entries', 'stream=width,height',
    segmentPath,
  ]);
  const parsed = JSON.parse(stdout);
  const videoStream = (parsed.streams || []).find((s) => s.width && s.height);
  if (!videoStream) {
    throw new Error(`ffprobe found no video stream in segment ${segmentPath}`);
  }
  return videoStream.width;
}

async function uploadRendition(outputDir, outputPrefix, jobId, height) {
  const files = await readdir(outputDir);
  let totalSegmentBytes = 0;

  await Promise.all(files.map(async (file) => {
    const filePath = path.join(outputDir, file);
    const ext = path.extname(file);
    if (ext === '.ts') {
      totalSegmentBytes += (await stat(filePath)).size;
    }
    await s3.send(new PutObjectCommand({
      Bucket: OUTPUT_BUCKET,
      Key: `${outputPrefix}/${file}`,
      Body: createReadStream(filePath),
      ContentType: CONTENT_TYPES[ext] || 'application/octet-stream',
    }));
  }));

  console.log(`[${jobId}] ${height}p uploaded ${files.length} files to ${OUTPUT_BUCKET}/${outputPrefix}/`);
  return totalSegmentBytes;
}

// Payload shape, set by the TranscodeFanout Map state in the state machine:
// { bucket, key, jobId, height, outputKey, duration }
// duration is the source's runtime in seconds (from Probe) - used to
// estimate bandwidth from encoded segment size, since ffmpeg's HLS muxer
// doesn't hand back a clean summary bitrate the way a single-file mux does.
export const handler = async (event) => {
  const { bucket, jobId, height, outputKey, duration } = event;
  const key = decodeS3Key(event.key);

  const inputPath = `/tmp/${jobId}-${height}p-input`;
  const outputDir = `/tmp/${jobId}-${height}p`;

  console.log(`[${jobId}] start ${height}p HLS - bucket=${bucket} key=${key}`);

  try {
    await mkdir(outputDir, { recursive: true });

    const downloadStart = Date.now();
    const getResult = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await pipeline(getResult.Body, createWriteStream(inputPath));
    console.log(`[${jobId}] ${height}p download complete in ${Date.now() - downloadStart}ms`);

    const transcodeStart = Date.now();
    await runFfmpegHls(inputPath, outputDir, height);
    const transcodeMs = Date.now() - transcodeStart;
    console.log(`[${jobId}] ${height}p transcode complete in ${transcodeMs}ms`);

    // segment00000.ts is guaranteed to exist for VOD output (hls_playlist_type
    // vod always emits at least one segment) - this would need to pick the
    // first segment from the playlist instead if this pipeline ever produces
    // live/event playlists where segments can roll off before this runs.
    const width = await probeSegmentWidth(path.join(outputDir, 'segment00000.ts'));

    const uploadStart = Date.now();
    const totalSegmentBytes = await uploadRendition(outputDir, outputKey, jobId, height);
    console.log(`[${jobId}] ${height}p upload complete in ${Date.now() - uploadStart}ms`);

    // bits/sec, from total segment bytes over the source's duration.
    const bandwidth = duration > 0
      ? Math.round((totalSegmentBytes * 8) / duration)
      : Math.round((totalSegmentBytes * 8) / 1); // guard against a missing/zero duration

    const playlistKey = `${outputKey}/playlist.m3u8`;
    return { height, width, bandwidth, playlistKey };
  } finally {
    await Promise.all([
      unlink(inputPath).catch(() => {}),
      rm(outputDir, { recursive: true, force: true }).catch(() => {}),
    ]);
  }
};
