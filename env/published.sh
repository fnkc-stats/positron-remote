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

# Tags of the repository (none if it does not exist yet), following the registry's pages. Only a registry answer that
# the repository does not exist means "build": a lookup that fails otherwise (outage, rate limit) fails the job, so
# an unreachable registry never leads to a new environment digest for unchanged inputs.
inconclusive() { echo "cannot tell whether $path has an environment for R $series: $1; re-run when ghcr.io answers" >&2; exit 1; }
curl_() { curl -sS --retry 4 --retry-all-errors --retry-delay 5 --max-time 60 "$@"; }
headers="$(mktemp)"
body_file="$(mktemp)"
trap 'rm -f "$headers" "$body_file"' EXIT
code="$(curl_ -o "$body_file" -w '%{http_code}' "https://ghcr.io/token?scope=repository:$path:pull")" || inconclusive 'no registry token'
# ghcr.io refuses an anonymous token for a repository that does not exist (or is not public): nothing published
case "$code" in 200) ;; 403|404) exit 0 ;; *) inconclusive "the token request answered HTTP $code" ;; esac
token="$(jq -er .token "$body_file")" || inconclusive 'no token in the registry answer'
tags=""
url="/v2/$path/tags/list?n=1000"
while [ -n "$url" ]; do
  code="$(curl_ -o "$body_file" -w '%{http_code}' -D "$headers" -H "Authorization: Bearer $token" "https://ghcr.io$url")" \
    || inconclusive 'the tag list could not be read'
  if [ "$code" = 404 ] && jq -e '[.errors[]?.code] | index("NAME_UNKNOWN")' "$body_file" >/dev/null 2>&1; then exit 0; fi
  [ "$code" = 200 ] || inconclusive "the tag list answered HTTP $code"
  tags+="$(jq -r '.tags[]?' "$body_file")"$'\n'
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
