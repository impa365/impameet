#!/usr/bin/env bash
# Create the master key that encrypts provider API keys (Integrações) in the database.
# Generated on the server, never printed. Losing it makes saved integration keys unreadable
# (they would have to be typed again), so keep an offline backup of the Swarm secret store.
#
#   deploy/scripts/encryption-key.sh
set -euo pipefail

name="meet_platform_encryption_key"
if docker secret inspect "$name" >/dev/null 2>&1; then
  echo "secret $name already exists; nothing changed" >&2
  exit 3
fi
openssl rand -base64 32 | tr -d '\n' | docker secret create --label app=meet-impar "$name" - >/dev/null
echo "secret $name created"
