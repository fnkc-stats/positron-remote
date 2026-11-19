#!/usr/bin/env bash
# Writes env/versions/<series>/renv.lock for the team image r-env of one R series: the packages already in it and
# the given ones, with their dependencies, at the versions of the series' CRAN snapshot (CRAN_SNAPSHOT in
# build.args). Every version comes from that one snapshot, so the packages were on CRAN together.
# Resolves versions in the series' Rocker image (the snapshot's packages that need a newer R are left out); nothing
# is installed. Refuses packages whose system requirements (apt packages) are not in env/Dockerfile.
# Needs Docker and network on this computer (hosts need neither).
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
. /etc/os-release && codename="$VERSION_CODENAME" && echo "#os $ID $VERSION_ID"
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
read -r os_id os_release < <(sed -n 's/^#os //p' "$tmp/resolved")

# System requirements: the apt packages the resolved R packages need on this Ubuntu release (Posit's sysreqs
# database), checked against the Dockerfile's apt-get list with an apt dry run in the same image, so aliases and
# packages the base image already has count as present. A package missing from the Dockerfile fails the build or
# the package's loading later; here it is reported before any image is built.
apt_list="$(sed -n '/apt-get install -y --no-install-recommends/,/rm -rf \/var\/lib\/apt\/lists/p' "$here/Dockerfile" \
  | sed '1d;$d' | tr -d '\\' | xargs)"
read -ra apt_list <<< "$apt_list"
[ ${#apt_list[@]} -gt 0 ] || { echo "cannot read the apt-get package list from env/Dockerfile" >&2; exit 2; }
query="$(grep -v '^#' "$tmp/resolved" | cut -d' ' -f1 | sed 's/^/\&pkgname=/' | tr -d '\n')"
curl -fsS --retry 3 \
  "https://packagemanager.posit.co/__api__/repos/cran/sysreqs?all=false&distribution=$os_id&release=$os_release$query" \
  | jq -r '.requirements[] | .name as $n | .requirements.packages[] | "\($n) \(.)"' > "$tmp/sysreqs"
echo "System requirements on $os_id $os_release: $(cut -d' ' -f2 "$tmp/sysreqs" | sort -u | xargs)"
cut -d' ' -f2 "$tmp/sysreqs" | sort -u | docker run --rm -i "$image" bash -c '
set -o pipefail
export LC_ALL=C
apt-get update -qq >/dev/null
sim() { apt-get install -s --no-install-recommends "$@" 2>/dev/null | sed -n "s/^Inst \([^ ]*\).*/\1/p" | sort -u; }
# Packages a dry run adds beyond the base list, without transitional ones (old names of packages already there)
new() {
  local add; add="$(comm -13 <(echo "$base") <(echo "$1") | sed "s/:.*//")"
  [ -n "$add" ] || return 0
  # shellcheck disable=SC2086
  comm -23 <(echo "$add") <(apt-cache show --no-all-versions $add 2>/dev/null \
    | awk "/^Package:/ {p = \$2} /^Description:.*\\(transitional package\\)/ {print p}" | sort -u)
}
base="$(sim "$@")" || { echo "#error the Dockerfile apt-get list does not resolve here"; exit; }
mapfile -t req
[ ${#req[@]} -gt 0 ] || exit 0
# One dry run for all; per package only when something is missing
if all="$(sim "$@" "${req[@]}")" && [ -z "$(new "$all")" ]; then exit 0; fi
for r in "${req[@]}"; do
  if ! extra="$(sim "$@" "$r")"; then echo "$r (no such apt package)"
  elif [ -n "$(new "$extra")" ]; then echo "$r"; fi
done
' _ "${apt_list[@]}" > "$tmp/missing"
if grep -q '^#error' "$tmp/missing"; then sed -n 's/^#error //p' "$tmp/missing" >&2; exit 1; fi
# Packages already in renv.lock passed the image build (verify.R loads each), so for them the database's
# requirements, which also cover building from source and optional tools, are only a warning. New packages fail.
if [ -s "$tmp/missing" ]; then
  [ -f "$dir/renv.lock" ] && jq -r '.Packages | keys[]' "$dir/renv.lock" > "$tmp/locked" || : > "$tmp/locked"
  : > "$tmp/new"; : > "$tmp/old"
  while read -r apt rest; do
    for p in $(awk -v a="$apt" '$2 == a {print $1}' "$tmp/sysreqs"); do
      if grep -qx "$p" "$tmp/locked"; then echo "$apt${rest:+ $rest} $p" >> "$tmp/old"
      else echo "$apt${rest:+ $rest} $p" >> "$tmp/new"; fi
    done
  done < "$tmp/missing"
  report() { awk '{p = $NF; $NF = ""; sub(/ $/, ""); a[$0] = a[$0] " " p} END {for (k in a) print "  " k ", for:" a[k]}' "$1" | sort >&2; }
  if [ -s "$tmp/old" ]; then
    echo "Warning: system packages the database lists for already-locked packages, not in env/Dockerfile" \
      "(the image build loads these packages, so they are only needed to build from source or are optional):" >&2
    report "$tmp/old"
  fi
  if [ -s "$tmp/new" ]; then
    echo "System packages needed by new packages but not in env/Dockerfile's apt-get list" \
      "(add them to the Dockerfile, or drop the R packages):" >&2
    report "$tmp/new"
    exit 1
  fi
fi

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
