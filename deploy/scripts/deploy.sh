#!/usr/bin/env bash
# Deploys (or updates) the IMPA Meet stack from the command line.
#
#   cp deploy/.env.example deploy/.env   # then edit it
#   bash deploy/scripts/deploy.sh [stack-name]   (default: impameet)
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
stack="${1:-impameet}"
env_file="$here/.env"

[[ -f "$env_file" ]] || { echo "missing $env_file (copy deploy/.env.example)" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. <(tr -d '\r' < "$env_file")
set +a

for s in meet_livekit_keys meet_livekit_api_key meet_livekit_api_secret meet_pg_password \
         meet_platform_database_url meet_platform_internal_token meet_platform_encryption_key \
         meet_screen_token; do
  docker secret inspect "$s" >/dev/null 2>&1 || {
    echo "missing secret $s: run deploy/scripts/prepare.sh first" >&2
    exit 2
  }
done

docker stack deploy --detach=false --with-registry-auth -c "$here/stack.yml" "$stack"
echo
echo "IMPA Meet is starting at https://${PLATFORM_HOST}"
