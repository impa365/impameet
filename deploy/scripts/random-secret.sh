#!/usr/bin/env bash
# Create a Swarm secret holding a fresh random token (e.g. meet_screen_token).
# The value is generated on the server and never printed.
#
#   deploy/scripts/random-secret.sh meet_screen_token
set -euo pipefail

name="${1:?usage: random-secret.sh <secret-name>}"
if docker secret inspect "$name" >/dev/null 2>&1; then
  echo "secret $name already exists; nothing changed" >&2
  exit 3
fi
openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48 \
  | docker secret create --label app=meet-impar "$name" - >/dev/null
echo "secret $name created"
