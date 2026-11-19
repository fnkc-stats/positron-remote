#!/usr/bin/env bash
# Builds the team image r-env of one R series locally, for this computer's architecture, with the build
# arguments of env/versions/<series>/build.args and of env/positron.args (the Positron server in the image).
# CI builds the same way (env-image.yml).
#
# Usage: env/build.sh <series> [tag] [docker build option ...]
#   env/build.sh 4.6                  tag r-env:4.6
#   checks/run.sh r-env:4.6           then check it
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
series="${1:?usage: env/build.sh <series> [tag] [docker build option ...]}"; shift
tag="${1:-r-env:$series}"; [ $# -gt 0 ] && shift
[ -f "$here/versions/$series/build.args" ] || { echo "env/versions/$series/build.args not found" >&2; exit 2; }
args=()
while IFS= read -r line; do [ -n "$line" ] && args+=(--build-arg "$line"); done < <(cat "$here/versions/$series/build.args" "$here/positron.args")
# The tidyverse version of renv.lock, for the image's label
args+=(--build-arg "TIDYVERSE_VERSION=$(jq -r '.Packages.tidyverse.Version // ""' "$here/versions/$series/renv.lock")")
docker build "${args[@]}" -t "$tag" "$@" "$here"
