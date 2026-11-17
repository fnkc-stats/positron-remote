#!/usr/bin/env bash
# Picks CRAN_SNAPSHOT for env/Dockerfile from renv.lock: a date by which every version in the lockfile
# was already on CRAN. Packages whose version had already been replaced by a newer one by that date
# (no binary in the snapshot, so renv builds it from source) are listed separately.
#
# Usage: env/snapshot-date.sh [env/renv.lock]
set -euo pipefail
LOCK="${1:-$(dirname "$0")/renv.lock}"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
jq -r '.Packages[] | "\(.Package) \(.Version)"' "$LOCK" > "$TMP/locked"
echo "Release dates for $(wc -l < "$TMP/locked" | tr -d ' ') lockfile entries: querying crandb.r-pkg.org" >&2
cut -d' ' -f1 "$TMP/locked" | xargs -P 10 -I{} curl --connect-timeout 10 --max-time 30 -fsS -o "$TMP/{}.json" "https://crandb.r-pkg.org/{}/all" || true

while read -r p v; do
  if [ -f "$TMP/$p.json" ]; then
    jq -r --arg v "$v" --arg p "$p" '(.timeline[$v] // "NA") as $d
      | ([.timeline | to_entries[] | select($d != "NA" and .value > $d) | .value] | min // "none") as $n
      | "\($d[0:10]) \($n[0:10]) \($p) \($v)"' "$TMP/$p.json"
  else
    echo "NA none $p $v"
  fi
done < "$TMP/locked" > "$TMP/dates"

D="$(grep -v '^NA' "$TMP/dates" | sort | tail -n 1 | cut -c1-10)"
# Snapshot of the day after the latest release: a package may miss the snapshot of its release day
SNAP="$(date -j -v+1d -f %Y-%m-%d "$D" +%Y-%m-%d 2>/dev/null || date -d "$D + 1 day" +%Y-%m-%d)"

if grep -q '^NA' "$TMP/dates"; then
  echo "Cannot choose a verified snapshot: unresolved packages or failed requests:" >&2
  grep '^NA' "$TMP/dates" | cut -d' ' -f3- | sed 's/^/  /' >&2
  exit 1
fi
OLD="$(awk -v d="$SNAP" '$2 != "none" && $2 <= d' "$TMP/dates")"
if [ -n "$OLD" ]; then
  echo "Already replaced by newer versions on $SNAP (renv builds them from source; expected for R's recommended packages):" >&2
  echo "$OLD" | awk '{print "  " $3 " " $4 " (newer version " $2 ")"}' >&2
fi
echo "$SNAP"
