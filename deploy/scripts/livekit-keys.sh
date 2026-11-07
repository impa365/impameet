#!/usr/bin/env bash
# Generate a fresh LiveKit API key pair directly into Swarm secrets. The values are never
# printed: the server reads meet_livekit_keys, the agent reads the other two.
set -euo pipefail

for s in meet_livekit_keys meet_livekit_api_key meet_livekit_api_secret; do
  if docker secret inspect "$s" >/dev/null 2>&1; then
    echo "secret $s already exists; nothing changed" >&2
    exit 3
  fi
done

key="API$(openssl rand -hex 8)"
secret="$(openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48)"

printf '%s: %s\n' "$key" "$secret" | docker secret create --label app=meet-impar meet_livekit_keys - >/dev/null
printf '%s' "$key" | docker secret create --label app=meet-impar meet_livekit_api_key - >/dev/null
printf '%s' "$secret" | docker secret create --label app=meet-impar meet_livekit_api_secret - >/dev/null
unset key secret
echo "LiveKit key pair generated into Swarm secrets"
