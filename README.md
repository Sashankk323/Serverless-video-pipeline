# video-pipeline

A serverless video transcoding pipeline on AWS. This repo is built incrementally,
day by day; this README tracks what exists **today**.

## Architecture — Day 3 (Step Functions orchestration, parallel renditions)

```
S3 raw bucket (uploads/{jobId}/{filename})
   │  EventBridge notification, "Object Created", filtered to prefix uploads/
   ▼
EventBridge rule ──▶ starts execution ──▶ Step Functions state machine
```

```
PrepareJob (Pass)
  extract jobId / sourceKey / bucket from the event
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│ JobPipeline (Parallel, single branch — used as a try/catch)   │
│                                                                 │
│  MarkJobStarted          Probe                MarkTranscoding  │
│  ddb:putItem       ──▶  Lambda (ffprobe)  ──▶  ddb:updateItem  │
│  status=PROBING         builds rendition        status=       │
│                         plan (no upscale,       TRANSCODING    │
│                         floor at 480p)               │         │
│                                                       ▼         │
│                          TranscodeFanout (Map, MaxConcurrency 3)│
│                          ┌──────────┬──────────┬──────────┐   │
│                          │Transcode │Transcode │Transcode │   │
│                          │  1080p   │  720p    │  480p    │   │
│                          │ (Lambda) │ (Lambda) │ (Lambda) │   │
│                          └──────────┴──────────┴──────────┘   │
│                                       │                        │
│                                       ▼                        │
│                          MarkCompleted (ddb:updateItem)         │
│                          status=COMPLETED                       │
│                                                                 │
│  Catch: States.ALL ────────────────────────────────────────────┼──▶ MarkFailed
└─────────────────────────────────────────────────────────────────┘   ddb:updateItem
                                                                        status=FAILED
```

`ProbeFunction` and `TranscodeFunction` are two `AWS::Serverless::Function`
resources built from **one** container image (`src/worker/Dockerfile`, holding
both `probe.mjs` and `transcode.mjs`) — they differ only in `ImageConfig.Command`.
Both Lambdas are invoked directly by Step Functions with an explicit JSON
payload; neither parses S3 events anymore, and neither is triggered by S3 at all.

All `Mark*` states write straight to DynamoDB via the direct SDK integration
(`arn:aws:states:::dynamodb:putItem` / `updateItem`) — no Lambda in the loop
just to flip a status field.

### DynamoDB job record shape

| Attribute | Written by | Meaning |
|---|---|---|
| `jobId` (partition key) | — | the `{uuid}` segment of `uploads/{uuid}/{filename}` |
| `status` | every `Mark*` state | `PROBING` → `TRANSCODING` → `COMPLETED`, or `FAILED` |
| `sourceKey`, `createdAt` | MarkJobStarted | original upload key, job start time |
| `sourceHeight`, `plannedRenditions` | MarkTranscoding | source video height, JSON-stringified rendition plan |
| `renditions` | MarkCompleted | JSON-stringified list of `{height, outputKey, transcodeMs}` |
| `errorMessage` | MarkFailed | the Step Functions error name + cause |
| `updatedAt` | every `Mark*` state | last-write timestamp |

`plannedRenditions`/`renditions` are stored as **JSON strings**, not native
DynamoDB Lists — see gotchas below for why.

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

**Superseded on Day 3** — the direct S3 event → Lambda trigger described here
was removed in the same deploy that added the EventBridge rule + state machine
above, so the two trigger paths never coexist (that would double-transcode
every upload). Kept below for history.

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
| HLS output bucket + CloudFront | A second `AWS::S3::Bucket` + `AWS::CloudFront::Distribution` in the same template; doesn't touch the raw bucket or existing Lambdas. |
| hls.js player | Replaces/extends `frontend/index.html`; the upload flow here is unaffected. |

*(Step Functions orchestration — retries, parallel renditions, fan-out, DynamoDB job tracking — shipped in Day 3. See the Day 3 section above.)*

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
(required from Day 2 on — `ProbeFunction`/`TranscodeFunction` are container-image
Lambdas, and `sam build` needs Docker to build the image), an AWS account
(region: `us-east-1`).

```bash
sam build
sam deploy --guided --stack-name video-pipeline --resolve-image-repos
```

On first deploy, `sam deploy --guided` will ask for stack name, region, and save
your answers to `samconfig.toml` for future `sam deploy` runs. `--resolve-image-repos`
lets SAM create and manage an ECR repository per image-based function
automatically — no manual ECR setup needed. `ProbeFunction` and `TranscodeFunction`
still get **two** repos even though they share one image (see gotchas below).

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
the presigned-URL flow produces — `uploads/{jobId}/{filename}`), then poll the
DynamoDB job record as it moves through `PROBING` → `TRANSCODING` → `COMPLETED`:

```bash
JOB_ID=$(uuidgen)
aws s3 cp my-video.mp4 "s3://video-pipeline-raw-<account-id>/uploads/$JOB_ID/my-video.mp4"

# poll until status stops changing
watch -n2 "aws dynamodb get-item --table-name video-pipeline-jobs \
  --key '{\"jobId\":{\"S\":\"$JOB_ID\"}}'"
```

Once `status` is `COMPLETED`, check the parallel outputs:

```bash
aws s3 ls "s3://video-pipeline-output-<account-id>/processed/$JOB_ID/"
```

You should see up to three files (`1080p.mp4`, `720p.mp4`, `480p.mp4`) —
fewer if the source video is shorter than one of those heights, since the
Probe step never upscales.

To test the failure path, upload something that isn't a video (a `.txt` file
renamed `.mp4` works) and poll the same way — `status` should land on `FAILED`
with an `errorMessage`, never stuck on `TRANSCODING`.

If a job doesn't show up in DynamoDB at all, the EventBridge rule likely isn't
firing — check the state machine's executions and event history first:

```bash
aws stepfunctions list-executions --state-machine-arn <PipelineStateMachineArn output>
aws stepfunctions get-execution-history --execution-arn <execution ARN>
```

Note: a Step Functions **execution** status of `SUCCEEDED` does not mean the
*job* succeeded — a job that hits `MarkFailed` via the Catch still completes
its execution normally (the state machine did its job by recording the
failure). Always check the DynamoDB `status` field, not the execution status,
for job outcome.

For Lambda-level detail (download/probe/transcode/upload timings), check the
individual function logs:

```bash
aws logs tail /aws/lambda/probe-video --since 10m
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

### Day 4 additions

- **CORS is wide open (`*`) on the CloudFront response headers policy** — fine for this demo's `watch.html` running off `localhost`, tighten to the real frontend origin once one exists.

### Day 3 additions

- **Removing the double-trigger footgun** — the whole point of Day 3's deploy
  was to swap trigger mechanisms, not add a second one. `TranscodeFunction`'s
  `Events: S3` block was deleted in the *same* template change that added the
  EventBridge rule, so there was never a deploy where both were live at once —
  a sequenced two-step migration (add EventBridge first, remove S3 trigger
  later) would have double-transcoded every upload landing in the gap.
- **No-upscale logic lives in the Probe Lambda, not in ASL** — comparing
  `candidate height <= source height` is a one-line JS filter; expressing the
  same comparison in Step Functions' JSONPath/intrinsic-function language would
  need a `Choice` state per candidate height. The state machine just `Map`s
  over whatever list `probe.mjs` returns — see `buildRenditionPlan()`. The one
  wrinkle: "always include 480p" can mean upscaling a source shorter than
  480p, which technically contradicts "never upscale" — resolved in 480p's
  favor since a job should never finish with zero renditions.
- **Map, not Parallel, for the fanout** — `Parallel` requires a fixed,
  hardcoded number of branches at deploy time. The rendition count here is
  *dynamic* (1-3 renditions depending on the source's height), which is
  exactly what `Map` is for: it iterates over a runtime-determined list
  (`ItemsPath: $.probe.renditions`) with `MaxConcurrency` capping how many run
  at once. `Parallel` is still used once in this state machine — but only as
  a single-branch try/catch scope around the whole job (`JobPipeline`), not
  for the fanout.
- **Step Functions' direct DynamoDB integration can't auto-convert a plain
  JSON array into a native DynamoDB List** — `arn:aws:states:::dynamodb:putItem`/
  `updateItem` require every attribute value to already be in DynamoDB's typed
  `AttributeValue` JSON shape (`{"S": "..."}`, `{"N": "..."}`, `{"L": [...]}` with
  each element *also* typed). A Map/Lambda result like
  `[{"height":1080,"outputKey":"..."}]` isn't that shape, and hand-building the
  nested `L`/`M` wrapper in ASL for a dynamic-length list is the kind of thing
  that turns a 5-line Task state into an unreadable 40-line one. Sidestepped by
  storing `plannedRenditions`/`renditions` as a single **String** attribute via
  the `States.JsonToString(...)` intrinsic instead — you lose native Dynamo
  querying into individual renditions, but at this scale nothing queries by
  rendition anyway.
- **A Step Functions execution can `SUCCEED` even when the job `FAILED`** —
  the `Catch` on `JobPipeline` routes any error to `MarkFailed`, which then
  completes normally. That makes the *execution's* status `SUCCEEDED` for both
  the happy path and the handled-failure path; the only place the real outcome
  lives is the `status` attribute in DynamoDB. Confusing the two the first
  time cost a few minutes of "why does the corrupt-file test show SUCCEEDED."
- **EventBridge's S3 notification event needs an explicit `InputPath`** — the
  raw EventBridge event envelope (`source`, `account`, `region`, `detail-type`,
  `detail`, ...) isn't what the state machine should operate on; only
  `detail.bucket.name` / `detail.object.key` matter. `UploadCreatedRule` sets
  `InputPath: $.detail` so the execution's actual input is just
  `{bucket, object, request-id, ...}` — confirmed against a live execution's
  `input` field, not just assumed from docs.
- **One image, two ECR repos** — `ProbeFunction` and `TranscodeFunction` share
  a single `Dockerfile`/build context (`src/worker/`), and SAM's build step
  correctly deduplicates the actual `docker build` into one local image when
  both functions' `Metadata` blocks match byte-for-byte. `sam deploy
  --resolve-image-repos` still provisions one ECR repository *per function*
  though, so the identical image gets pushed twice. At this project's size
  (a few hundred MB, free-tier ECR storage) that's not worth fighting SAM's
  per-function image model to avoid.

## Cost

Everything here fits in the AWS always-free / 12-month-free tiers at low volume:
S3 (5GB free, plus a 7-day lifecycle rule bounding storage), Lambda (1M free
requests/month), Lambda Function URLs (no additional charge beyond Lambda
invocation), DynamoDB on-demand (25GB + generous request-unit free tier, no
provisioned capacity to forget about), Step Functions Standard workflows
(4,000 free state transitions/month), and EventBridge (no charge for rules
matching AWS service events like S3 notifications). No NAT gateways, no
always-on compute.
