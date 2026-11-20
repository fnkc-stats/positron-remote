#!/usr/bin/env bash
# Builds the images of one R series locally, for this computer's architecture, as CI does (env-image.yml):
#   r-env:<series>-env   the R environment (env/Dockerfile, with env/versions/<series>/build.args): what a project
#                        pins in container.json
#   r-env:<series>       that environment with the Positron server (env/positron.Dockerfile, with env/positron.args):
#                        what a project container runs
#
# POSITRON=<version>: the server of another Positron version instead (pinned now by env/positron.sh --print).
# BASE=<image>: only add the server, to this environment image (for example a published one, by digest).
#
# Usage: env/build.sh <series> [tag] [docker build option ...]
#   env/build.sh 4.6                              r-env:4.6-env and r-env:4.6
#   POSITRON=2026.07.1-5 env/build.sh 4.6         r-env:4.6-env and r-env:4.6-positron-2026.07.1-5
#   checks/run.sh r-env:4.6-env                   then check the environment
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

base="${BASE:-}"
if [ -z "$base" ]; then
  base="r-env:$series-env"
  args=()
  while IFS= read -r line; do [ -n "$line" ] && args+=(--build-arg "$line"); done < "$here/versions/$series/build.args"
  # The tidyverse version and the checksum of renv.lock, for the image's labels
  args+=(--build-arg "TIDYVERSE_VERSION=$(jq -r '.Packages.tidyverse.Version // ""' "$here/versions/$series/renv.lock")")
  args+=(--build-arg "RENV_LOCK_SHA256=$(shasum -a 256 "$here/versions/$series/renv.lock" | cut -d' ' -f1)")
  docker build "${args[@]}" -t "$base" "$@" "$here"
fi

args=(--build-arg "BASE=$base")
while IFS= read -r line; do [ -n "$line" ] && args+=(--build-arg "$line"); done < "$positron"
docker build "${args[@]}" -f "$here/positron.Dockerfile" -t "$tag" "$@" "$here"
echo "Built $tag (the environment $base with the Positron server)"
