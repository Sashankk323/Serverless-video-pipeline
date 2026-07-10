# Container-image Lambda (not zip+layers): ffmpeg has no officially supported
# Lambda layer, and hand-rolled layers routinely break on glibc/shared-lib
# mismatches between build and execution environments. A static binary baked
# into the image sidesteps that entirely.
FROM public.ecr.aws/lambda/nodejs:20

# The base image is minimal AL2023 and ships without tar/xz - needed to unpack
# the static ffmpeg archive below.
RUN dnf install -y tar xz && dnf clean all

# Static ffmpeg build (amd64) - self-contained binary, no shared-lib dependency
# on whatever happens to be in the Lambda exec environment. Not date-pinned:
# johnvansickle.com doesn't expose a browsable index to bots, so this tracks
# upstream's current stable "release" build rather than guessing a dated
# filename that might 404.
RUN curl -sL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -o /tmp/ffmpeg.tar.xz \
    && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp \
    && mv /tmp/ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/ffmpeg \
    && mv /tmp/ffmpeg-*-amd64-static/ffprobe /usr/local/bin/ffprobe \
    && chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe \
    && rm -rf /tmp/ffmpeg.tar.xz /tmp/ffmpeg-*-amd64-static

COPY package.json ${LAMBDA_TASK_ROOT}/
RUN npm install --omit=dev --prefix ${LAMBDA_TASK_ROOT}

# One image, two handlers - probe.mjs (ffprobe) and transcode.mjs (ffmpeg).
# Which one runs is chosen per-Lambda-resource via ImageConfig.Command in
# template.yaml, not by building two images.
COPY probe.mjs transcode.mjs ${LAMBDA_TASK_ROOT}/

# Default only - ProbeFunction overrides this via ImageConfig.Command.
CMD ["transcode.handler"]
