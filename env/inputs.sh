#!/usr/bin/env bash
# The inputs of the R environment of one series as one sha256: env/Dockerfile, the files it copies, and the series'
# build.args and renv.lock, at a git revision (default HEAD). Two commits with the same value build the same
# environment, so CI reuses the published one instead of publishing it again under a new digest (env-image.yml,
# env/published.sh).
#   env/inputs.sh <series> [<revision>]
set -euo pipefail
cd "$(dirname "$0")/.."
series="${1:?usage: env/inputs.sh <series> [<revision>]}"
rev="${2:-HEAD}"
files=(env/Dockerfile env/verify.R env/smoke.qmd "env/versions/$series/build.args" "env/versions/$series/renv.lock")

# Every file the Dockerfile copies must be an input: otherwise a change of it would not make a new environment
while read -r src; do
  src="env/${src//'${R_SERIES}'/$series}"
  printf '%s\n' "${files[@]}" | grep -qxF "$src" || { echo "env/Dockerfile copies $src: add it to env/inputs.sh" >&2; exit 1; }
done < <(awk '/^(COPY|ADD) / { for (i = 2; i < NF; i++) if ($i !~ /^--/) print $i }' env/Dockerfile)

for f in "${files[@]}"; do
  printf '%s\n' "$f"
  git show "$rev:$f" | sha256sum
done | sha256sum | cut -d' ' -f1
