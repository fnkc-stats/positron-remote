#!/usr/bin/env bash
# Writes env/versions/<series>/renv.lock for the team image r-env of one R series: the packages already in it and
# the given ones, with their dependencies, at the versions of the series' CRAN snapshot (CRAN_SNAPSHOT in
# build.args). Every version comes from that one snapshot, so the packages were on CRAN together.
# Resolves versions in the series' Rocker image (the snapshot's packages that need a newer R are left out); nothing
# is installed. Needs Docker and network on this computer (hosts need neither).
#
# Versions already in renv.lock never change: a package whose snapshot version differs is refused. After changing
# CRAN_SNAPSHOT (or R_VERSION) in build.args, pass --update to take every version from the new snapshot.
#
# Usage: env/lock.sh [--update] <series> [package ...]
#   env/lock.sh 4.6 Hmisc rms                  add packages
#   env/lock.sh --update 4.6                   new snapshot for every package
#   A new series: create env/versions/<series>/build.args and copy another series' renv.lock as the package list.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
update=false
if [ "${1:-}" = --update ]; then update=true; shift; fi
series="${1:?usage: env/lock.sh [--update] <series> [package ...]}"; shift
dir="$here/versions/$series"
[ -f "$dir/build.args" ] || { echo "$dir/build.args not found" >&2; exit 2; }
arg() { sed -n "s/^$1=//p" "$dir/build.args"; }
r_version="$(arg R_VERSION)" rocker_digest="$(arg ROCKER_DIGEST)" snapshot="$(arg CRAN_SNAPSHOT)"
[[ "$r_version" == "$series".* ]] || { echo "R_VERSION $r_version is not in series $series" >&2; exit 2; }
image="rocker/r-ver:$r_version@$rocker_digest"

names=("$@")
if [ -f "$dir/renv.lock" ]; then
  while read -r p; do names+=("$p"); done < <(jq -r '.Packages | keys[]' "$dir/renv.lock")
fi
[ ${#names[@]} -gt 0 ] || { echo "no packages: pass package names" >&2; exit 2; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
echo "Image: $image, snapshot $snapshot"
docker run --rm "$image" bash -c '
codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
repo="https://packagemanager.posit.co/cran/__linux__/$codename/$0"
Rscript -e "
repo <- commandArgs(TRUE)[1]
want <- unique(commandArgs(TRUE)[-1])
ap <- available.packages(repos = repo)
base <- rownames(installed.packages(priority = \"base\"))
want <- setdiff(want, base)
deps <- tools::package_dependencies(want, db = ap, which = c(\"Depends\", \"Imports\", \"LinkingTo\"), recursive = TRUE)
all <- sort(setdiff(union(want, unlist(deps)), base))
missing <- setdiff(all, rownames(ap))
if (length(missing)) stop(\"not in the snapshot for R \", getRversion(), \": \", paste(missing, collapse = \", \"), call. = FALSE)
cat(\"#repo\", repo, \"\n\")
cat(sprintf(\"%s %s\n\", all, ap[all, \"Version\"]), sep = \"\")
" "$repo" "${@:1}"
' "$snapshot" "${names[@]}" > "$tmp/resolved"

repo="$(sed -n 's/^#repo \([^ ]*\).*/\1/p' "$tmp/resolved")"
grep -v '^#' "$tmp/resolved" | jq -R 'split(" ") | {key: .[0], value: {Package: .[0], Version: .[1], Source: "Repository", Repository: "CRAN"}}' \
  | jq -s --arg r "$r_version" --arg repo "$repo" \
      '{R: {Version: $r, Repositories: [{Name: "CRAN", URL: $repo}]}, Packages: from_entries}' > "$tmp/renv.lock"

if [ -f "$dir/renv.lock" ] && [ "$update" = false ]; then
  changed="$(jq -r --slurpfile new "$tmp/renv.lock" '.Packages | to_entries[]
    | select($new[0].Packages[.key].Version != .value.Version)
    | "  \(.key) \(.value.Version) -> \($new[0].Packages[.key].Version)"' "$dir/renv.lock")"
  if [ -n "$changed" ] || [ "$(jq -r .R.Version "$dir/renv.lock")" != "$r_version" ]; then
    echo "The snapshot has other versions than renv.lock (pass --update to take them):" >&2
    echo "${changed:-  R $(jq -r .R.Version "$dir/renv.lock") -> $r_version}" >&2
    exit 1
  fi
fi
cp "$tmp/renv.lock" "$dir/renv.lock"
echo "Wrote env/versions/$series/renv.lock: $(jq '.Packages | length' "$dir/renv.lock") packages for R $r_version from $repo"
