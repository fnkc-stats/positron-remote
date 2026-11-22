#!/usr/bin/env bash
# The checks CI's image.yml runs on an R environment image before it is published, in the same order: labels and no
# Positron server; verify.R and a rendered synthetic report (as analyst, no network); the team's Positron server built
# on top and run without network, its Quarto the pinned one; the R environment checks (checks/run.sh); real SSH and broker behaviour (test:ssh).
# CI runs this script; run it on a local build before pushing a change to env/ or checks/:
#   env/build.sh 4.6 && env/check-image.sh r-env:4.6-env
#   env/check-image.sh <env image> [--no-r-checks] [--out <dir>] [--positron-args <file>] [--positron-image <image>]
# --no-r-checks skips verify.R, the report and checks/run.sh (CI: an unchanged environment whose checks did not change).
# --positron-image: an image that already has the server on top of <env image> (CI: the published runnable image of an
# unchanged environment), checked and used for test:ssh instead of building the layer again. Its positron.recipe label
# must be the recipe of --positron-args (env/positron-recipe.sh) and its layers must start with those of <env image>.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
env_image="${1:?usage: env/check-image.sh <env image> [--no-r-checks] [--out <dir>] [--positron-args <file>] [--positron-image <image>]}"; shift
r_checks=1 out="" positron_args="$here/positron.args" positron_image=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-r-checks) r_checks="" ;;
    --out) out="${2:?--out needs a directory}"; shift ;;
    --positron-args) positron_args="${2:?--positron-args needs a file}"; shift ;;
    --positron-image) positron_image="${2:?--positron-image needs an image}"; shift ;;
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

if [ -z "$positron_image" ]; then
  step "The team's Positron server on top (env/positron.Dockerfile), run as analyst without network"
  positron_tag="r-env:positron"
  args=(--build-arg "BASE=$env_image")
  while IFS= read -r line; do [ -n "$line" ] && args+=(--build-arg "$line"); done < "$positron_args"
  docker build -q "${args[@]}" -f "$here/positron.Dockerfile" -t "$positron_tag" "$here" >/dev/null
  test "$(docker image inspect "$positron_tag" --format '{{index .Config.Labels "r-env.base"}}')" = "$env_image"
else
  step "The team's Positron server on top, published from the same recipe ($positron_image), run as analyst without network"
  positron_tag="$positron_image"
  recipe="$("$here/positron-recipe.sh" < "$positron_args")"
  have="$(docker image inspect "$positron_tag" --format '{{index .Config.Labels "positron.recipe"}}')"
  [ "$have" = "$recipe" ] || { echo "$positron_tag was made from recipe '$have', not $recipe (--positron-args)" >&2; exit 1; }
fi
# Exactly this environment underneath: its layers come first
docker image inspect "$env_image" "$positron_tag" --format '{{json .RootFS.Layers}}' \
  | jq -se '.[0] == .[1][0:(.[0] | length)]' >/dev/null \
  || { echo "$positron_tag is not built on $env_image" >&2; exit 1; }
commit="$(docker image inspect "$positron_tag" --format '{{index .Config.Labels "positron.commit"}}')"
test -n "$commit"
docker run --rm --network none --user 1000:1000 --entrypoint sh "$positron_tag" -c \
  "/home/analyst/.positron-server/bin/$commit/bin/positron-server --version | grep -qx 'Positron SHA: $commit'"
quarto="$(docker image inspect "$positron_tag" --format '{{index .Config.Labels "r-env.quarto-version"}}')"
test -n "$quarto"
docker run --rm --network none --user 1000:1000 --entrypoint sh "$positron_tag" -c \
  "test -L /home/analyst/.positron-server/bin/$commit/quarto && test \"\$(/home/analyst/.positron-server/bin/$commit/quarto/bin/quarto --version)\" = '$quarto'"
summary "Positron $(docker image inspect "$positron_tag" --format '{{index .Config.Labels "positron.version"}}') ($commit) on top: ok${positron_image:+ (the published image, same recipe)}"

if [ -n "$r_checks" ]; then
  step "R environment checks (no network, as analyst)"
  "$root/checks/run.sh" ${out:+--out "$out"} "$env_image"
fi

step "Real SSH and broker behaviour (test:ssh)"
[ -d "$root/ctl/node_modules" ] || npm ci --prefix "$root/ctl" --ignore-scripts --silent --no-audit --no-fund
FNKC_TEST_IMAGE="$positron_tag" npm --prefix "$root/ctl" run -s test:ssh
summary "Checks of $env_image passed${r_checks:+ (with the R checks)}"
