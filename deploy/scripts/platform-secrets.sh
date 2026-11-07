#!/usr/bin/env bash
# Generate the Postgres password straight into Swarm secrets: one for the database server
# and one with the full connection URL for the platform. Values are never printed.
set -euo pipefail

for s in meet_pg_password meet_platform_database_url; do
  if docker secret inspect "$s" >/dev/null 2>&1; then
    echo "secret $s already exists; nothing changed" >&2
    exit 3
  fi
done

password="$(openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-40)"
printf '%s' "$password" | docker secret create --label app=meet-impar meet_pg_password - >/dev/null
printf 'postgres://impa:%s@postgres:5432/impa_meet' "$password" \
  | docker secret create --label app=meet-impar meet_platform_database_url - >/dev/null
unset password
echo "database secrets generated"
