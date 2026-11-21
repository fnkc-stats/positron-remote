#!/usr/bin/env bash
# The checks CI's image.yml runs on an R environment image before it is published, in the same order: labels and no
# Positron server; verify.R and a rendered synthetic report (as analyst, no network); the team's Positron server built
# on top and run without network; the R environment checks (checks/run.sh); real SSH and broker behaviour (test:ssh).
# CI runs this script; run it on a local build before pushing a change to env/ or checks/:
#   env/build.sh 4.6 && env/check-image.sh r-env:4.6-env
#   env/check-image.sh <env image> [--no-r-checks] [--out <dir>] [--positron-args <file>]
# --no-r-checks skips verify.R, the report and checks/run.sh (CI: an unchanged environment whose checks did not change).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
env_image="${1:?usage: env/check-image.sh <env image> [--no-r-checks] [--out <dir>] [--positron-args <file>]}"; shift
r_checks=1 out="" positron_args="$here/positron.args"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-r-checks) r_checks="" ;;
    --out) out="${2:?--out needs a directory}"; shift ;;
    --positron-args) positron_args="${2:?--positron-args needs a file}"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
summary() { echo "$*"; [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "$*" >> "$GITHUB_STEP_SUMMARY"; }
step() { printf '\n==> %s\n' "$*"; }

step "The environment has no Positron server, and its labels"
labels="$(docker image inspect "$env_image" --format '{{json .Config.Labels}}')"
echo "$labels" | jq -e '(."positron.commit" // "") == "" and (."r-env.lock-sha256" // "") != "" and (."r-env.r-series" // "") != ""' >/dev/null \
  || { echo "labels are not those of an R environment: $labels" >&2; exit 1; }
test -z "$(docker run --rm --entrypoint sh "$env_image" -c 'ls /home/analyst/.positron-server/bin 2>/dev/null')"

if [ -n "$r_checks" ]; then
  step "verify.R and a rendered synthetic report, as analyst, without network"
  docker run --rm --network none --user 1000:1000 --entrypoint sh "$env_image" -c \
    'Rscript /usr/local/share/r-env/verify.R && d=$(mktemp -d) && cp /usr/local/share/r-env/smoke.qmd "$d/" && cd "$d" && quarto render smoke.qmd && test -s smoke.html'
fi

step "The team's Positron server on top (env/positron.Dockerfile), run as analyst without network"
positron_tag="r-env:positron"
args=(--build-arg "BASE=$env_image")
while IFS= read -r line; do [ -n "$line" ] && args+=(--build-arg "$line"); done < "$positron_args"
docker build -q "${args[@]}" -f "$here/positron.Dockerfile" -t "$positron_tag" "$here" >/dev/null
commit="$(docker image inspect "$positron_tag" --format '{{index .Config.Labels "positron.commit"}}')"
test -n "$commit"
test "$(docker image inspect "$positron_tag" --format '{{index .Config.Labels "r-env.base"}}')" = "$env_image"
docker run --rm --network none --user 1000:1000 --entrypoint sh "$positron_tag" -c \
  "/home/analyst/.positron-server/bin/$commit/bin/positron-server --version | grep -qx 'Positron SHA: $commit'"
summary "Positron $(docker image inspect "$positron_tag" --format '{{index .Config.Labels "positron.version"}}') ($commit) on top: ok"

if [ -n "$r_checks" ]; then
  step "R environment checks (no network, as analyst)"
  "$root/checks/run.sh" ${out:+--out "$out"} "$env_image"
fi

step "Real SSH and broker behaviour (test:ssh)"
[ -d "$root/ctl/node_modules" ] || npm ci --prefix "$root/ctl" --silent --no-audit --no-fund
FNKC_TEST_IMAGE="$positron_tag" npm --prefix "$root/ctl" run -s test:ssh
summary "Checks of $env_image passed${r_checks:+ (with the R checks)}"
