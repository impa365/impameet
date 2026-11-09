#!/usr/bin/env bash
# Prepares a Docker Swarm manager for IMPA Meet: creates every secret the stack needs.
# Values are generated on the server and never printed, written to disk or kept in history.
# Safe to run again: secrets that already exist are left untouched.
#
#   bash deploy/scripts/prepare.sh
#
# Custom domains per organization (optional): pass your Traefik service so the shared token
# is also handed to Traefik's HTTP provider (see docs/deploy.md):
#
#   TRAEFIK_SERVICE=traefik_traefik bash deploy/scripts/prepare.sh
set -euo pipefail

command -v docker >/dev/null || { echo "docker is not installed" >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is not installed" >&2; exit 1; }
[[ "$(docker info --format '{{.Swarm.ControlAvailable}}' 2>/dev/null)" == "true" ]] || {
  echo "run this on a Docker Swarm manager (docker swarm init)" >&2
  exit 1
}

here="$(cd "$(dirname "$0")" && pwd)"
label="app=impameet"

exists() { docker secret inspect "$1" >/dev/null 2>&1; }
store() { docker secret create --label "$label" "$1" - >/dev/null && echo "  created  $1"; }
skip() { echo "  exists   $1"; }
random() { openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-"$1"; }

echo "LiveKit API key pair"
if exists meet_livekit_keys || exists meet_livekit_api_key || exists meet_livekit_api_secret; then
  for s in meet_livekit_keys meet_livekit_api_key meet_livekit_api_secret; do
    exists "$s" && skip "$s" || { echo "  missing  $s (remove the other two and run again)" >&2; exit 2; }
  done
else
  key="API$(openssl rand -hex 8)"
  secret="$(random 48)"
  printf '%s: %s\n' "$key" "$secret" | store meet_livekit_keys
  printf '%s' "$key" | store meet_livekit_api_key
  printf '%s' "$secret" | store meet_livekit_api_secret
  unset key secret
fi

echo "Database"
if exists meet_pg_password || exists meet_platform_database_url; then
  for s in meet_pg_password meet_platform_database_url; do
    exists "$s" && skip "$s" || { echo "  missing  $s (remove the other one and run again)" >&2; exit 2; }
  done
else
  password="$(random 40)"
  printf '%s' "$password" | store meet_pg_password
  printf 'postgres://impa:%s@postgres:5432/impa_meet' "$password" | store meet_platform_database_url
  unset password
fi

echo "Encryption key for provider API keys saved in the database"
if exists meet_platform_encryption_key; then
  skip meet_platform_encryption_key
else
  openssl rand -base64 32 | tr -d '\n' | store meet_platform_encryption_key
fi

echo "Service tokens"
if exists meet_platform_internal_token; then
  skip meet_platform_internal_token
elif [[ -n "${TRAEFIK_SERVICE:-}" ]]; then
  "$here/traefik-provider.sh" "$TRAEFIK_SERVICE"
else
  openssl rand -hex 32 | tr -d '\n' | store meet_platform_internal_token
fi
if exists meet_screen_token; then
  skip meet_screen_token
else
  random 48 | store meet_screen_token
fi
if exists meet_qdrant_api_key; then
  skip meet_qdrant_api_key
else
  random 48 | store meet_qdrant_api_key
fi

cat <<'EOF'

Done. The encryption key exists only inside the Swarm state: include /var/lib/docker/swarm in
your server backups, otherwise the provider keys saved in the admin panel cannot be recovered.
Next: set the variables from deploy/.env.example and deploy the stack.
EOF
