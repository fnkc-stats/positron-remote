#!/usr/bin/env bash
# Pins the Positron build whose server goes into every r-env image: writes env/positron.args (version, commit and
# the checksums of the server archives for amd64 and arm64). Without a version: the latest Positron release.
# Commit the file; CI then builds new images of every R series, and projects move to them by their digests.
# Everyone on the team installs the same Positron version, with automatic updates off (Check Setup).
# Needs network on this computer; downloads both server archives (about 550 MB each) to check them.
#
# --print: write the same lines to stdout instead, for a build of another Positron version (env/build.sh with
# POSITRON=, and the positron input of env-image.yml); messages go to stderr.
#
# Usage: env/positron.sh [--print] [version]      e.g. env/positron.sh 2026.11.1-4, env/positron.sh --print 2026.07.1-5
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
print=""
if [ "${1:-}" = --print ]; then print=1; shift; fi
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
version="${1:-}"
if [ -z "$version" ]; then
  version="$(curl -fsSL https://cdn.posit.co/positron/releases/deb/x86_64/releases.json | jq -r .version)"
fi
[[ "$version" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]+-[0-9]+$ ]] || { echo "not a Positron version: $version" >&2; exit 2; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
commit="" sum_amd64="" sum_arm64=""
for arch in amd64 arm64; do
  case "$arch" in amd64) long=x86_64 short=x64 ;; arm64) long=arm64 short=arm64 ;; esac
  url="https://cdn.posit.co/positron/releases/reh/$long/positron-reh-linux-$short-$version.tar.gz"
  echo "Downloading $url" >&2
  if [ -t 2 ]; then progress=--progress-bar; else progress=-sS; fi
  curl -fL "$progress" -o "$tmp/$arch.tar.gz" "$url"
  sum="$(shasum -a 256 "$tmp/$arch.tar.gz" | cut -d' ' -f1)"
  # awk reads the whole listing: with grep -m1, tar fails writing the rest of it (GNU tar), and pipefail stops here
  product="$(tar -tzf "$tmp/$arch.tar.gz" | awk '/^[^\/]*\/product\.json$/ && !found { print; found = 1 }')"
  got="$(tar -xzOf "$tmp/$arch.tar.gz" "$product" | jq -r .commit)"
  [ -z "$commit" ] || [ "$got" = "$commit" ] || { echo "the archives name different commits: $commit, $got" >&2; exit 1; }
  commit="$got"
  if [ "$arch" = amd64 ]; then sum_amd64="$sum"; else sum_arm64="$sum"; fi
  rm "$tmp/$arch.tar.gz"
done
args="$(printf 'POSITRON_VERSION=%s\nPOSITRON_COMMIT=%s\nPOSITRON_SHA256_AMD64=%s\nPOSITRON_SHA256_ARM64=%s' \
  "$version" "$commit" "$sum_amd64" "$sum_arm64")"
if [ -n "$print" ]; then echo "$args"; exit 0; fi
echo "$args" > "$here/positron.args"
echo "Wrote env/positron.args: Positron $version ($commit)"
