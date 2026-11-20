#!/usr/bin/env bash
# The published environment of a series with the same inputs as this checkout (env/inputs.sh), pinned by digest, or
# nothing if there is none: then it has to be built. Looks at the newest environment tags of the series
# (<series>-env-<commit>-<run>-<attempt>, image.yml) and compares the inputs at their commits, so it needs the git
# history (actions/checkout with fetch-depth: 0). Reads the public registry without credentials.
#   env/published.sh <owner> <series>
set -euo pipefail
cd "$(dirname "$0")/.."
owner="$(tr '[:upper:]' '[:lower:]' <<< "${1:?usage: env/published.sh <owner> <series>}")"
series="${2:?usage: env/published.sh <owner> <series>}"
path="$owner/r-env"
want="$(env/inputs.sh "$series")"

# Tags of the repository (none if it does not exist yet), following the registry's pages
token="$(curl -fsS "https://ghcr.io/token?scope=repository:$path:pull" | jq -r .token)" || exit 0
headers="$(mktemp)"
trap 'rm -f "$headers"' EXIT
tags=""
url="/v2/$path/tags/list?n=1000"
while [ -n "$url" ]; do
  body="$(curl -fsS -D "$headers" -H "Authorization: Bearer $token" "https://ghcr.io$url")" || exit 0
  tags+="$(jq -r '.tags[]?' <<< "$body")"$'\n'
  url="$(tr -d '\r' < "$headers" | sed -nE 's/^[Ll]ink: *<([^>]+)>.*/\1/p')"
done

lock="$(sha256sum "env/versions/$series/renv.lock" | cut -d' ' -f1)"
# Newest first (run id, then attempt); at most 20, older ones are not worth the lookups
while read -r tag; do
  commit="$(cut -d- -f3 <<< "$tag")"
  git cat-file -e "$commit^{commit}" 2>/dev/null || continue
  [ "$(env/inputs.sh "$series" "$commit" 2>/dev/null)" = "$want" ] || continue
  image="ghcr.io/$path:$tag"
  digest="$(docker buildx imagetools inspect "$image" --format '{{json .Manifest}}' | jq -r .digest)"
  # The same check positron.yml makes: an environment (no server built in) with this renv.lock
  labels="$(docker buildx imagetools inspect "$image" --format '{{json .Image}}' | jq -c 'if has("config") then .config.Labels else (to_entries | map(select(.key | startswith("linux/"))) | .[0].value.config.Labels) end')"
  jq -e --arg lock "$lock" '(."positron.commit" // "") == "" and ."r-env.lock-sha256" == $lock' <<< "$labels" >/dev/null || continue
  echo "ghcr.io/$path@$digest"
  exit 0
done < <(grep -E "^${series//./\\.}-env-[0-9a-f]{40}-[0-9]+-[0-9]+$" <<< "$tags" | sort -t- -k4,4nr -k5,5nr | head -20)
