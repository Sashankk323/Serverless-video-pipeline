# video-pipeline

A serverless video transcoding pipeline on AWS. This repo is built incrementally,
day by day; this README tracks what exists **today**.

## Architecture — Day 2 (adds automatic transcoding)

```
S3 raw bucket (uploads/{uuid}/{filename})
   │  1. ObjectCreated event, filtered to prefix uploads/
   ▼
TranscodeFunction (container-image Lambda, PackageType: Image)
   │  2. GetObject  → download source to /tmp
   │  3. spawn ffmpeg → scale to 720p, H.264 + AAC, +faststart
   │  4. PutObject  → write result to the OUTPUT bucket
   ▼
S3 output bucket (video-pipeline-output-<account-id>)
   key: processed/{uuid}/720p.mp4
   - 7-day lifecycle expiration, same as the raw bucket
```

`TranscodeFunction` is a container-image Lambda (`public.ecr.aws/lambda/nodejs:20`
+ a static ffmpeg binary baked into the image via `src/transcode/Dockerfile`),
not a zip Lambda with an ffmpeg layer — layers built from third-party ffmpeg
binaries routinely break on glibc/shared-library mismatches between build and
execution environments; a static binary in the image sidesteps that class of
bug entirely.

No Step Functions yet — this is a direct S3 event → Lambda trigger. Step
Functions orchestration (retries, parallel renditions, fan-out) is Day 3.

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
| Step Functions orchestration (Day 3) | Replaces the direct S3 → Lambda trigger on `TranscodeFunction` with a state machine; retries/fan-out/multiple renditions live there instead of in Lambda code. |
| HLS output bucket + CloudFront | A second `AWS::S3::Bucket` + `AWS::CloudFront::Distribution` in the same template; doesn't touch the raw bucket or existing Lambdas. |
| hls.js player | Replaces/extends `frontend/index.html`; the upload flow here is unaffected. |

*(Automatic transcoding via a direct S3 event → Lambda trigger shipped in Day 2 — see the Day 2 section above.)*

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

Prerequisites: AWS CLI configured, SAM CLI installed, **Docker running**
(required from Day 2 on — `TranscodeFunction` is a container-image Lambda, and
`sam build` needs Docker to build its image), an AWS account (region:
`us-east-1`).

```bash
sam build
sam deploy --guided --stack-name video-pipeline --resolve-image-repos
```

On first deploy, `sam deploy --guided` will ask for stack name, region, and save
your answers to `samconfig.toml` for future `sam deploy` runs. `--resolve-image-repos`
lets SAM create and manage the ECR repository for `TranscodeFunction`'s image
automatically — no manual ECR setup needed.

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

## Testing the transcode pipeline end-to-end

Upload a file directly to the raw bucket's `uploads/` prefix (mimicking what
the presigned-URL flow produces — `uploads/{uuid}/{filename}`), then check the
output bucket a few seconds later:

```bash
UUID=$(uuidgen)
aws s3 cp my-video.mp4 "s3://video-pipeline-raw-<account-id>/uploads/$UUID/my-video.mp4"
sleep 15
aws s3 ls "s3://video-pipeline-output-<account-id>/processed/$UUID/"
```

If nothing shows up, check the Lambda's logs — each invocation logs a
download/transcode/upload timeline:

```bash
aws logs tail /aws/lambda/transcode-video --since 10m
```

## Gotchas I handled

- **Recursive invocation risk** — a Lambda that reads from and writes to the
  *same* bucket via an `ObjectCreated` trigger will re-invoke itself forever
  the moment it writes its output, silently burning through the account
  (this is a well-known S3 + Lambda footgun). Guarded against twice, on
  purpose: `TranscodeFunction` writes exclusively to a **separate**
  `OutputVideoBucket` that has no event notifications configured on it at
  all — so even a future misconfiguration can't create a self-loop — and the
  S3 event trigger on `RawVideoBucket` is additionally scoped to the
  `uploads/` prefix as a second, independent guard.
- **`/tmp` sizing** — Lambda's default ephemeral storage is 512MB, which is
  too small once you're holding both the source video and the 720p output in
  `/tmp` simultaneously. Set `EphemeralStorage.Size: 2048` explicitly in
  `template.yaml`; without it, ffmpeg fails partway through with a
  `No space left on device` error that's easy to misdiagnose as a codec issue.
- **S3 event keys are URL-encoded, and spaces are `+` not `%20`** — S3 event
  notifications percent-encode the object key, but (for historical reasons
  tied to `application/x-www-form-urlencoded`) encode spaces as `+` rather
  than `%20`. Calling `decodeURIComponent` alone on a key like
  `uploads/uuid/my+video.mp4` leaves a literal `+` in the filename instead of
  a space. Fixed by replacing `+` with a space *before* `decodeURIComponent`
  in `src/transcode/index.mjs`. Verified against a real upload with a space
  in the filename (`test clip.mp4`) — the transcoded output key came out
  correct.
- **CloudFormation circular dependency between the S3 trigger and the IAM
  policy** — `sam deploy` failed with `Circular dependency between resources`
  the first time: the S3 `Events:` trigger makes `RawVideoBucket` depend on
  `TranscodeFunction`'s invoke permission, while the Lambda's `s3:GetObject`
  policy originally referenced the bucket via `!Sub arn:aws:s3:::${RawVideoBucket}/uploads/*`
  (an implicit `!Ref`), which makes the function depend back on the bucket —
  a cycle CloudFormation refuses to resolve. Fixed by building that ARN from
  the bucket's deterministic name (`video-pipeline-raw-${AWS::AccountId}`)
  instead of referencing the bucket resource, which breaks the dependency
  edge without changing what the policy actually grants.
- **`Runtime`/`Architectures` in `Globals` conflict with an Image-package-type
  function** — SAM's `Globals.Function` block applied `Runtime: nodejs20.x`
  to *every* function by default, including `TranscodeFunction`, but
  `PackageType: Image` functions must not have `Runtime` set at all (SAM
  rejects it even when it only arrives via Globals). Similarly, merging a
  function-level `Architectures` override with a Globals default errored on
  the image function. Fixed by removing both from `Globals` and setting them
  explicitly on each function instead — `GetUploadUrlFunction` gets
  `arm64`/`nodejs20.x`, `TranscodeFunction` gets `x86_64` (matching the static
  ffmpeg binary's architecture).
- **Base Lambda image has no `tar`/`xz`** — `public.ecr.aws/lambda/nodejs:20`
  is a minimal AL2023 image without `tar` or `xz` installed, so extracting the
  static ffmpeg `.tar.xz` archive failed with `tar: command not found` until
  the Dockerfile installed both via `dnf` first.

## Cost

Everything here fits in the AWS always-free / 12-month-free tiers at low volume:
S3 (5GB free, plus a 7-day lifecycle rule bounding storage), Lambda (1M free
requests/month), and Lambda Function URLs (no additional charge beyond Lambda
invocation). No NAT gateways, no always-on compute.
