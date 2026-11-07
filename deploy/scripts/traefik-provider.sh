#!/usr/bin/env bash
# Points the existing Traefik at the platform's dynamic-config endpoint, so every verified
# customer domain gets a router and its own Let's Encrypt certificate automatically.
#
# Generates the shared token, stores it as the platform's secret and passes it to Traefik as
# a request header, in one step; the value is never written to disk or printed.
#
#   bash deploy/scripts/traefik-provider.sh [traefik-service]   (default: traefik_traefik)
#   PLATFORM_CONFIG_URL=http://<stack>_platform:3000/api/internal/traefik overrides the endpoint
set -euo pipefail

traefik="${1:-traefik_traefik}"
endpoint="${PLATFORM_CONFIG_URL:-http://impameet_platform:3000/api/internal/traefik}"

if docker secret inspect meet_platform_internal_token >/dev/null 2>&1; then
  echo "meet_platform_internal_token already exists; rotate it by removing it first" >&2
  exit 3
fi
token="$(openssl rand -hex 32)"
printf '%s' "$token" | docker secret create --label app=impameet meet_platform_internal_token - >/dev/null

mapfile -t args < <(docker service inspect "$traefik" \
  --format '{{range .Spec.TaskTemplate.ContainerSpec.Args}}{{println .}}{{end}}' \
  | grep -v '^--providers.http' | grep -v '^$')
args+=("--providers.http.endpoint=${endpoint}" "--providers.http.pollinterval=30s"
       "--providers.http.headers.X-Internal-Token=${token}")
unset token

# docker service update takes the whole argument list as one shell-quoted --args string.
docker service update --quiet --detach=false --args "$(printf '%q ' "${args[@]}")" "$traefik" >/dev/null
echo "traefik now polls ${endpoint}"
