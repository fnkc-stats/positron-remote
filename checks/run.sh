#!/usr/bin/env bash
# Runs the R environment checks (checks/README.md) in a throwaway container from an image, with no network,
# as the analyst user (uid 1000). The checks are mounted, not baked in, so any image can be checked as is:
# the one projects pin today, a new candidate, or a local build.
#
# Usage: checks/run.sh [--out DIR] [IMAGE] [TASK...]
#   IMAGE  default: the image in project-template/container.json
#   TASK   names of files in checks/tasks without .R (default: all), or "packages" for the package check only
#   --out  where results go (default: checks/results/<date-time>, ignored by git); one JSON file per step and
#          summary.json. Docker must be able to mount it: with Colima, only directories under your home are.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

out=""
if [ "${1:-}" = --out ]; then out="$2"; shift 2; fi
image="${1:-}"
[ $# -gt 0 ] && shift
if [ -z "$image" ]; then
  command -v jq >/dev/null || { echo "jq is required to read container.json (or pass IMAGE)" >&2; exit 2; }
  image="$(jq -r .image "$here/../project-template/container.json")"
fi
[ -n "$out" ] || out="$here/results/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
# The container user is uid 1000, which may not be the owner of this directory on the host
chmod 0777 "$out"

echo "Image:   $image"
echo "Results: $out"
docker run --rm --network none --user 1000:1000 \
  -v "$here:/checks:ro" -v "$out:/out" -w /tmp \
  -e R_MAX_NUM_DLLS=500 -e HOME=/tmp \
  --entrypoint Rscript "$image" /checks/check.R /out "$@"
