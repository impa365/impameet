# syntax=docker/dockerfile:1.10
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

FROM deps AS test
COPY . .
RUN npx prettier --check . \
 && npx eslint src tests --max-warnings 0 \
 && npx tsc --noEmit \
 && npx vitest run --coverage

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
# Alpine security fixes published after the base image was built. The runtime never installs
# packages afterwards: drop npm/corepack/yarn and their dependency trees.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && addgroup -S -g 10001 app && adduser -S -u 10001 -G app app
COPY --from=build /app/.next/standalone ./
RUN rm -rf node_modules/sharp node_modules/@img
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Whiteboard fonts and the camera-background model are served by the platform itself
# (no third-party CDN at runtime).
COPY --from=deps /app/node_modules/@excalidraw/excalidraw/dist/prod/fonts ./public/excalidraw/fonts
COPY --from=deps /app/node_modules/@mediapipe/tasks-vision/wasm ./public/mediapipe/wasm
ADD --checksum=sha256:191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b --chmod=0444 \
  https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite \
  ./public/mediapipe/selfie_segmenter.tflite
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts/migrate.mjs /app/scripts/superadmin.mjs ./scripts/
COPY --from=deps /app/node_modules/postgres ./node_modules/postgres
COPY --chmod=0555 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/bin/sh", "/usr/local/bin/docker-entrypoint.sh"]
