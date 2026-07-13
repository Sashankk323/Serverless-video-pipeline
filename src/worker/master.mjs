import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET;

// playlistKey is an absolute key (processed/{jobId}/{height}p/playlist.m3u8);
// the master playlist needs it relative to its own location
// (processed/{jobId}/master.m3u8), which is just the last two path segments.
function relativePlaylistPath(playlistKey) {
  return playlistKey.split('/').slice(-2).join('/');
}

function buildMasterPlaylist(renditions) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  // Ascending bandwidth is the conventional order - players that don't
  // adapt at all default to the first variant listed, which should be the
  // lowest-bandwidth one.
  const sorted = [...renditions].sort((a, b) => a.bandwidth - b.bandwidth);
  for (const { bandwidth, width, height, playlistKey } of sorted) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${height}`);
    lines.push(relativePlaylistPath(playlistKey));
  }
  return lines.join('\n') + '\n';
}

// Payload shape, set by the WriteMasterPlaylist task in the state machine:
// { jobId, renditions: [{height, width, bandwidth, playlistKey}, ...] }
export const handler = async (event) => {
  const { jobId, renditions } = event;
  const masterKey = `processed/${jobId}/master.m3u8`;

  console.log(`[${jobId}] writing master playlist for ${renditions.length} renditions`);

  await s3.send(new PutObjectCommand({
    Bucket: OUTPUT_BUCKET,
    Key: masterKey,
    Body: buildMasterPlaylist(renditions),
    ContentType: 'application/vnd.apple.mpegurl',
  }));

  console.log(`[${jobId}] master playlist written to ${OUTPUT_BUCKET}/${masterKey}`);

  return { masterKey };
};
