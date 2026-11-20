#!/usr/bin/env bash
# Pins the Quarto version of every r-env image: writes QUARTO_VERSION and the checksums of the amd64 and arm64
# packages into env/Dockerfile. The checksums are computed from the downloaded packages and must match the release's
# own checksum file. Without a version: the latest Quarto release. Commit the change after review; it is an input
# of every environment (env/inputs.sh), so CI builds new environments of every series.
#   env/quarto.sh [<version>]
set -euo pipefail
cd "$(dirname "$0")/.."
version="${1:-$(curl -fsSL https://api.github.com/repos/quarto-dev/quarto-cli/releases/latest | sed -nE 's/^ *"tag_name": *"v([^"]+)".*/\1/p')}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a Quarto version: '$version'" >&2; exit 1; }
base="https://github.com/quarto-dev/quarto-cli/releases/download/v$version"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/sums.txt" "$base/quarto-$version-checksums.txt"
sums=()
for arch in amd64 arm64; do
  file="quarto-$version-linux-$arch.deb"
  echo "Downloading $file" >&2
  curl -fsSL -o "$tmp/$file" "$base/$file"
  sum="$( (sha256sum "$tmp/$file" 2>/dev/null || shasum -a 256 "$tmp/$file") | cut -d' ' -f1)"
  grep -qx "$sum  $file" "$tmp/sums.txt" || { echo "$file does not match the release's checksum file" >&2; exit 1; }
  sums+=("$sum")
done
sed -i.bak -E \
  -e "s/^ARG QUARTO_VERSION=.*/ARG QUARTO_VERSION=$version/" \
  -e "s/^ARG QUARTO_SHA256_AMD64=.*/ARG QUARTO_SHA256_AMD64=${sums[0]}/" \
  -e "s/^ARG QUARTO_SHA256_ARM64=.*/ARG QUARTO_SHA256_ARM64=${sums[1]}/" env/Dockerfile
rm env/Dockerfile.bak
echo "env/Dockerfile: Quarto $version (amd64 ${sums[0]}, arm64 ${sums[1]})"
