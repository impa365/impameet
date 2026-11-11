#!/usr/bin/env bash
# Store one secret as an encrypted Docker Swarm secret without it touching disk, shell
# history, process arguments or logs.
#
#   deploy/scripts/secret-set.sh meet_screen_token           # prompts (input hidden)
#   printf '%s' "$VALUE" | deploy/scripts/secret-set.sh NAME  # from a pipe
#
# Swarm keeps secrets encrypted at rest (Raft log) and in transit (mutual TLS), and mounts
# them only into the services that request them, on an in-memory filesystem.
set -euo pipefail

name="${1:?usage: secret-set.sh <secret-name>}"
[[ "$name" =~ ^[a-z0-9_]{1,64}$ ]] || { echo "invalid secret name: $name" >&2; exit 2; }

if docker secret inspect "$name" >/dev/null 2>&1; then
  echo "secret $name already exists; rotate with deploy/scripts/secret-rotate.sh $name" >&2
  exit 3
fi

if [[ -t 0 ]]; then
  read -rsp "Valor para $name (não aparece na tela): " value
  echo
else
  IFS= read -r value || true
fi
value="${value//$'\r'/}"
[[ -n "$value" ]] || { echo "empty value, nothing stored" >&2; exit 4; }

printf '%s' "$value" | docker secret create --label app=meet-impar "$name" - >/dev/null
unset value
echo "secret $name stored"
