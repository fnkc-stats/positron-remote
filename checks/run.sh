#!/usr/bin/env bash
# Runs the R environment checks (checks/README.md) in a throwaway container from an image, with no network,
# as the analyst user (uid 1000). The checks are mounted, not baked in, so any image can be checked as is:
# the one projects pin today, a new candidate, or a local build.
#
# Usage: checks/run.sh [--out DIR] [--library VOLUME|DIR] [IMAGE] [TASK...]
#   IMAGE  default: the image in project-template/container.json
#   TASK   names of files in checks/tasks without .R (default: all), or "packages" for the package check only
#   --out  where results go (default: checks/results/<date-time>, ignored by git); one JSON file per step and
#          summary.json. Docker must be able to mount it: with Colima, only directories under your home are.
#   --library  an R library to use instead of the image's site library, mounted read-only where the image has it,
#          as projects that pin a "library" get it: a library volume (positron-ctl libraries) or a directory
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

out=""
library=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --library) case "$2" in /*) dir="$2" ;; */*|.*) dir="$(cd "$2" && pwd)" ;; *) dir="$2" ;; esac
               library=(-v "$dir:/usr/local/lib/R/site-library:ro"); shift 2 ;;
    *) break ;;
  esac
done
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
  -v "$here:/checks:ro" -v "$out:/out" ${library[@]+"${library[@]}"} -w /tmp \
  -e R_MAX_NUM_DLLS=500 -e HOME=/tmp \
  --entrypoint Rscript "$image" /checks/check.R /out "$@"
