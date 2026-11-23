#!/usr/bin/env bash
# Run THIS on a Linux host that already has Docker + Hub login (e.g. the VPS),
# so the heavy build never touches a laptop Docker Desktop.
#
#   cd /path/to/impameet
#   git fetch && git checkout main && git pull
#   docker login
#   bash deploy/scripts/release-on-host.sh 1.10.0
#   APPS=platform bash deploy/scripts/release-on-host.sh 1.10.0   # only platform
#
# Unchanged apps are re-tagged from the previous Hub tag (PREV=1.9.3) so the
# stack can keep a single IMPAMEET_VERSION.
set -euo pipefail

version="${1:?usage: release-on-host.sh <version>}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must look like 1.2.0" >&2; exit 2; }
namespace="${DOCKERHUB_NAMESPACE:-impa365}"
apps="${APPS:-platform}"
prev="${PREV:-}"
cd "$(dirname "$0")/../.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "uncommitted changes on this host — pull a clean main first" >&2
  exit 3
fi

bash deploy/scripts/release.sh "$version"

# If only some apps were built, retag the rest from PREV so :$version exists for all.
if [[ -n "$prev" ]]; then
  for app in platform agent screen; do
    case " $apps " in
      *" $app "*) continue ;;
    esac
    image="$namespace/impameet-$app"
    echo "== retag $image:$prev -> :$version and :latest"
    docker pull "$image:$prev"
    docker tag "$image:$prev" "$image:$version"
    docker tag "$image:$prev" "$image:latest"
    if [[ "${PUSH:-1}" == "1" ]]; then
      docker push "$image:$version"
      docker push "$image:latest"
    fi
  done
fi
