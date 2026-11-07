#!/usr/bin/env bash
# Builds, tests, scans and publishes the IMPA Meet images to Docker Hub from this machine
# (Docker Desktop, or any Docker logged in to the Docker Hub account).
# Nothing is pushed unless every test suite and the vulnerability scan pass.
#
#   bash deploy/scripts/release.sh 1.2.0          # publishes :1.2.0 and :latest
#   PUSH=0 bash deploy/scripts/release.sh 1.2.0   # everything except the push
#   APPS="platform" bash deploy/scripts/release.sh 1.2.1
set -euo pipefail

version="${1:?usage: release.sh <version, e.g. 1.2.0>}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must look like 1.2.0" >&2; exit 2; }
namespace="${DOCKERHUB_NAMESPACE:-impa365}"
apps="${APPS:-platform agent screen}"
trivy_image="aquasec/trivy:0.76.2"
cd "$(dirname "$0")/../.."
revision="$(git rev-parse HEAD)"
# Git Bash on Windows: keep container paths such as /var/run/docker.sock as they are. Every
# host path below is relative to the repository root, so nothing needs converting.
export MSYS_NO_PATHCONV=1

log() { printf '\n== %s\n' "$*"; }

if [[ -n "$(git status --porcelain)" ]]; then
  echo "uncommitted changes: commit them first so the images match the code" >&2
  exit 3
fi

# Build from the commit itself, not the working tree: exactly the published code, with the
# LF line endings .gitattributes guarantees (a Windows checkout may have CRLF).
src="$(mktemp -d)"
trap 'rm -rf "$src"' EXIT
git archive HEAD apps | tar -x -C "$src"
# Docker Desktop on Windows needs a Windows path for the build context.
ctx="$(cygpath -m "$src" 2>/dev/null || echo "$src")"

for app in $apps; do
  log "$app: tests inside the image"
  docker build --target test -t "impameet-$app:test" "$ctx/apps/$app"

  if [[ "$app" == "platform" ]]; then
    log "platform: integration tests against a throwaway Postgres"
    net="impameet-it-$$"
    docker network create "$net" >/dev/null
    trap 'docker rm -f "$net-pg" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; rm -rf "$src"' EXIT
    docker run -d --name "$net-pg" --network "$net" --network-alias pg -e POSTGRES_PASSWORD=it \
      -e POSTGRES_DB=it --tmpfs /var/lib/postgresql/data postgres:17-alpine >/dev/null
    for _ in $(seq 1 30); do
      docker exec "$net-pg" pg_isready -U postgres -d it >/dev/null 2>&1 && break
      sleep 1
    done
    docker run --rm --network "$net" -e TEST_DATABASE_URL=postgres://postgres:it@pg:5432/it \
      "impameet-platform:test" npx vitest run --config vitest.integration.config.ts
    docker rm -f "$net-pg" >/dev/null
    docker network rm "$net" >/dev/null
    trap 'rm -rf "$src"' EXIT
  fi

  image="$namespace/impameet-$app"
  log "$app: runtime image $image:$version"
  docker build --target runtime --platform linux/amd64 \
    --label "org.opencontainers.image.version=$version" \
    --label "org.opencontainers.image.revision=$revision" \
    --label "org.opencontainers.image.source=https://github.com/impa365/impameet" \
    --label "org.opencontainers.image.licenses=Apache-2.0" \
    --label "org.opencontainers.image.vendor=Impa 365" \
    -t "$image:$version" -t "$image:latest" "$ctx/apps/$app"

  log "$app: vulnerability scan (HIGH/CRITICAL with a fix available stop the release)"
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v impameet-trivy-cache:/root/.cache \
    "$trivy_image" image --quiet --scanners vuln,secret --severity HIGH,CRITICAL \
    --ignore-unfixed --exit-code 1 "$image:$version"
done

if [[ "${PUSH:-1}" == "0" ]]; then
  log "PUSH=0: built, tested and scanned; nothing was published"
  exit 0
fi

for app in $apps; do
  log "push $namespace/impameet-$app:$version and :latest"
  docker push --quiet "$namespace/impameet-$app:$version"
  docker push --quiet "$namespace/impameet-$app:latest"
done

cat <<EOF

Published $version. Tag the code to match:
  git tag -a v$version -m "IMPA Meet $version" && git push origin v$version
EOF
