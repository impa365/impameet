#!/usr/bin/env bash
# Replace a secret used by the running stack. Swarm secrets are immutable, so each logical
# secret alternates between two names, <base> and <base>_next; deploy.sh always picks the
# one that exists.
#
#   deploy/scripts/secret-rotate.sh meet_screen_token [service]   (default service: meet_agent)
set -euo pipefail

base="${1:?usage: secret-rotate.sh <secret-name> [service]}"
base="${base%_next}"
service="${2:-meet_agent}"
here="$(cd "$(dirname "$0")" && pwd)"

if docker secret inspect "$base" >/dev/null 2>&1; then
  current="$base"; next="${base}_next"
elif docker secret inspect "${base}_next" >/dev/null 2>&1; then
  current="${base}_next"; next="$base"
else
  echo "no secret named $base or ${base}_next" >&2; exit 5
fi

target="$(docker service inspect "$service" \
  --format "{{range .Spec.TaskTemplate.ContainerSpec.Secrets}}{{if eq .SecretName \"$current\"}}{{.File.Name}}{{end}}{{end}}")"
[[ -n "$target" ]] || { echo "$service does not use $current" >&2; exit 6; }

"$here/secret-set.sh" "$next"
docker service update --quiet --detach=false \
  --secret-rm "$current" \
  --secret-add "source=${next},target=${target},mode=0400,uid=10001" \
  "$service"
docker secret rm "$current" >/dev/null
echo "rotated $base on $service ($current -> $next)"
