# video-pipeline

A serverless video transcoding pipeline on AWS. This repo is built incrementally,
day by day; this README tracks what exists **today**.

## Architecture — Day 1 (upload path only)

```
browser (frontend/index.html)
   │  1. GET  ?filename=...&contentType=video/mp4
   ▼
Lambda Function URL ──▶ get-upload-url Lambda ──▶ generates a presigned S3 PUT URL
   │  2. returns { uploadUrl, key }
   ▼
browser
   │  3. PUT (the video bytes, directly to S3, not through Lambda)
   ▼
S3 raw bucket  (video-pipeline-raw-<account-id>)
   key: uploads/{uuid}/{sanitized-filename}
   - 7-day lifecycle expiration (keeps this stage free)
   - CORS allows PUT from any origin (tighten once the frontend has a real domain)
```

The Lambda never sees or touches the video bytes — it only issues a time-limited
signature. This keeps it fast, cheap (no data transfer through Lambda/API Gateway),
and stateless, which matters once the pipeline fans out to multiple transcode jobs.

### What's intentionally deferred, and why the current shape won't need refactoring

| Future piece | Where it plugs in |
|---|---|
| S3 event → Step Functions trigger | Added as a `NotificationConfiguration` on `RawVideoBucket` — the bucket resource itself doesn't change. |
| Parallel ffmpeg transcode Lambdas | New functions reading from `RawVideoBucket`, writing to a new, separate output bucket. |
| HLS output bucket + CloudFront | A second `AWS::S3::Bucket` + `AWS::CloudFront::Distribution` in the same template; doesn't touch the raw bucket or this Lambda. |
| hls.js player | Replaces/extends `frontend/index.html`; the upload flow here is unaffected. |

Keeping raw uploads and (eventually) HLS output in **separate buckets** is deliberate:
their lifecycle rules, access patterns, and CORS needs are different, and one
bucket's event notifications shouldn't have to filter out the other's writes.

## Presigned-URL security model

- The Lambda Function URL (`AuthType: NONE`) is public — anyone can call it to
  *request* a presigned URL. This is a deliberate Day 1 simplification, not the
  end state; see "Known gaps" below.
- The Lambda validates `contentType` starts with `video/` and sanitizes the
  filename (strips path separators, allow-lists safe characters) **before** it's
  used in an S3 key — this prevents path traversal (`../../etc/passwd`) and key
  injection into unrelated prefixes.
- The presigned URL itself is scoped to exactly one S3 key, one HTTP method
  (`PUT`), one `Content-Type`, and expires after 5 minutes. Whoever holds the URL
  can upload *that one file*, nothing else — they can't list, read, or overwrite
  other objects in the bucket.
- IAM: the Lambda's execution role only has `s3:PutObject` on
  `RawVideoBucket/uploads/*` — it cannot delete, read, or list anything, in this
  bucket or any other.
- The bucket itself has no public read/write access; the only way in is via a
  presigned URL minted by the Lambda.

### Known gaps (acceptable for Day 1, not for production)

- **No auth on the Function URL** — anyone who finds the URL can request presigned
  upload slots (not a data breach, but an abuse/cost vector). Day 2+ should add
  IAM auth, a Cognito authorizer, or at minimum an API key.
- **No rate limiting** — nothing stops someone from requesting many presigned
  URLs quickly. A future iteration should throttle at the Function URL / WAF
  level.
- **CORS is `*`** on both the bucket and the Function URL — fine while the
  frontend has no fixed domain, but should be scoped to it once one exists.
- **No file-size cap enforced server-side** — the presigned PUT doesn't currently
  set `Content-Length-Range`; a determined client could upload something huge
  before the 7-day lifecycle rule cleans it up.

## Deploying

Prerequisites: AWS CLI configured, SAM CLI installed, an AWS account (region:
`us-east-1`).

```bash
sam build
sam deploy --guided --stack-name video-pipeline
```

On first deploy, `sam deploy --guided` will ask for stack name, region, and save
your answers to `samconfig.toml` for future `sam deploy` runs.

After deploy, grab the Lambda Function URL from the stack outputs:

```bash
aws cloudformation describe-stacks \
  --stack-name video-pipeline \
  --query "Stacks[0].Outputs[?OutputKey=='UploadFunctionUrl'].OutputValue" \
  --output text
```

Paste that URL into `frontend/index.html` in place of
`__GET_UPLOAD_URL_ENDPOINT__`, then serve the frontend locally:

```bash
cd frontend && python3 -m http.server 8080
```

Open `http://localhost:8080` and upload a video file.

## Testing the Lambda directly

```bash
curl -i "$FUNCTION_URL?filename=test.mp4&contentType=video/mp4"
```

Should return a JSON body with `uploadUrl`, `key`, and `expiresIn`. Requesting
with a non-video `contentType` (or omitting `filename`) should return `400`.

## Cost

Everything here fits in the AWS always-free / 12-month-free tiers at low volume:
S3 (5GB free, plus a 7-day lifecycle rule bounding storage), Lambda (1M free
requests/month), and Lambda Function URLs (no additional charge beyond Lambda
invocation). No NAT gateways, no always-on compute.
