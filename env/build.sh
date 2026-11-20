#!/usr/bin/env bash
# Builds the team image r-env of one R series locally, for this computer's architecture, with the build
# arguments of env/versions/<series>/build.args and of env/positron.args (the Positron server in the image).
# CI builds the same way (env-image.yml).
#
# POSITRON=<version>: with the server of another Positron version instead (pinned now by env/positron.sh --print).
#
# Usage: env/build.sh <series> [tag] [docker build option ...]
#   env/build.sh 4.6                  tag r-env:4.6
#   POSITRON=2026.07.1-5 env/build.sh 4.6     tag r-env:4.6-positron-2026.07.1-5
#   checks/run.sh r-env:4.6           then check it
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
series="${1:?usage: env/build.sh <series> [tag] [docker build option ...]}"; shift
positron="$here/positron.args" variant="$series"
if [ -n "${POSITRON:-}" ]; then
  positron="$(mktemp)"; trap 'rm -f "$positron"' EXIT
  "$here/positron.sh" --print "$POSITRON" > "$positron"
  variant="$series-positron-$POSITRON"
fi
tag="${1:-r-env:$variant}"; [ $# -gt 0 ] && shift
[ -f "$here/versions/$series/build.args" ] || { echo "env/versions/$series/build.args not found" >&2; exit 2; }
args=()
while IFS= read -r line; do [ -n "$line" ] && args+=(--build-arg "$line"); done < <(cat "$here/versions/$series/build.args" "$positron")
# The tidyverse version of renv.lock, for the image's label
args+=(--build-arg "TIDYVERSE_VERSION=$(jq -r '.Packages.tidyverse.Version // ""' "$here/versions/$series/renv.lock")")
# Its checksum, for the r-env.lock-sha256 label
args+=(--build-arg "RENV_LOCK_SHA256=$(shasum -a 256 "$here/versions/$series/renv.lock" | cut -d' ' -f1)")
docker build "${args[@]}" -t "$tag" "$@" "$here"
