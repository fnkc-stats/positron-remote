#!/usr/bin/env bash
# Builds the Positron layer on top of an environment image: $REGISTRY/positron:<env name>-<env tag>-<version>
# (a private package, separate from the public environment images).
#
# Usage:
#   ./build-image.sh [local|latest|<version>] [--env <image>] [--host <name>] [--push] [--force] [--prepare-only]
#     local           version of the Positron client installed on this machine (default)
#     latest          latest posit-dev/positron release
#     <version>       e.g. 2026.07.1-5 (Help -> About)
#     --env <image>   tagged environment image, e.g. ghcr.io/<owner>/r-env:2026.11.16-abc1234
#                     (default: DEFAULT_ENV_IMAGE from positron.env)
#     --host <name>   Docker host to build on (default: local; see HOSTS)
#     --push          push the finished image to the registry
#     --force         rebuild even if the image already exists
#     --prepare-only  only download and prepare the build context, no Docker
#
# The server archive is downloaded on this machine and the Dockerfile only uses ADD/COPY, so the build
# also works on a daemon without internet (it only needs the environment image, which this script
# pulls or copies there). Usually called by run-positron.sh or CI (.github/workflows/positron-image.yml).
set -euo pipefail
. "$(dirname "$0")/lib.sh"

VERSION_ARG=local PREPARE_ONLY=0 FORCE=0 PUSH=0 ENV_IMAGE="$DEFAULT_ENV_IMAGE" BUILD_HOST=local
while [ $# -gt 0 ]; do
  case "$1" in
    --prepare-only) PREPARE_ONLY=1 ;;
    --force) FORCE=1 ;;
    --push) PUSH=1 ;;
    --env) ENV_IMAGE="${2:?--env needs an image}"; shift ;;
    --host) BUILD_HOST="${2:?--host needs a host name}"; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    -*) die "unknown flag $1" ;;
    *) VERSION_ARG="$1" ;;
  esac
  shift
done

need curl; need jq; need tar
check_env_image "$ENV_IMAGE"
VERSION="$(resolve_version "$VERSION_ARG")"
TAG="$(positron_tag "$ENV_IMAGE" "$VERSION")"
log "Positron $VERSION on top of $ENV_IMAGE"

if [ "$PREPARE_ONLY" = 0 ]; then
  need docker "brew install docker"
  check_host "$BUILD_HOST"
  host_up "$BUILD_HOST" || die "host '$BUILD_HOST' is unreachable"
  if [ "$FORCE" = 0 ]; then
    if has_image "$BUILD_HOST" "$TAG"; then
      log "$TAG already exists on '$BUILD_HOST', nothing to build (--force to rebuild)"
      [ "$PUSH" = 0 ] || hdocker "$BUILD_HOST" push -q "$TAG"
      exit 0
    fi
    # Already in the registry: getting it onto the host is enough; build only if that fails
    if [ "$PUSH" = 1 ] && hdocker "$BUILD_HOST" manifest inspect "$TAG" >/dev/null 2>&1; then
      if ensure_image "$BUILD_HOST" "$TAG"; then
        log "$TAG already exists in the registry, nothing to build (--force to rebuild)"
        exit 0
      fi
      warn "$TAG is in the registry but cannot be delivered to '$BUILD_HOST', building it there"
    fi
  fi
  ensure_image "$BUILD_HOST" "$ENV_IMAGE" \
    || die "environment image $ENV_IMAGE is not available on '$BUILD_HOST' (not in the registry? docker login ghcr.io?)"
fi

# --- 1. Download the archive (resumable)
subst() { local ph="\${$1}"; URL="${URL//"$ph"/$2}"; }
URL="$POSITRON_REH_URL_TEMPLATE"
subst quality "$POSITRON_QUALITY"
subst version "$VERSION"
subst os linux
subst arch-long "$ARCH_LONG"
subst arch "$ARCH"
[[ "$URL" != *'${'* ]] || die "unsubstituted placeholder left in URL: $URL"

DL_DIR="$CACHE_DIR/downloads"; mkdir -p "$DL_DIR"
ARCHIVE="$DL_DIR/positron-reh-linux-$ARCH-$VERSION.tar.gz"
if [ ! -f "$ARCHIVE" ]; then
  log "Downloading $URL"
  curl -fL --progress-bar --retry 3 --connect-timeout 15 -C - -o "$ARCHIVE.part" "$URL" \
    || die "could not download the archive (check the version: $VERSION)"
  mv "$ARCHIVE.part" "$ARCHIVE"
else
  log "Archive already downloaded: $ARCHIVE"
fi

# --- 2. Unpack and verify
CTX="$CACHE_DIR/build/$VERSION-$ARCH"
STAGE="$CTX/stage"
rm -rf "$CTX"; mkdir -p "$STAGE"
log "Unpacking"
tar -xzf "$ARCHIVE" -C "$STAGE" --strip-components=1 || { rm -f "$ARCHIVE"; die "archive is corrupt and was deleted; run again"; }

PJ="$STAGE/product.json"
[ -f "$PJ" ] || die "no product.json in the archive"
COMMIT="$(jq -r .commit "$PJ")"
APP_NAME="$(jq -r '.serverApplicationName // "positron-server"' "$PJ")"
ARCHIVE_VERSION="$(jq -r '"\(.positronVersion)-\(.positronBuildNumber)"' "$PJ")"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "invalid commit in product.json: $COMMIT"
[ "$ARCHIVE_VERSION" = "$VERSION" ] || die "archive version ($ARCHIVE_VERSION) does not match the requested one ($VERSION)"
[ -x "$STAGE/bin/$APP_NAME" ] || die "no executable bin/$APP_NAME in the archive"

# For the local client's version, also compare the commit
if [ "$VERSION" = "$(local_positron_version 2>/dev/null || true)" ]; then
  LOCAL_COMMIT="$(jq -r .commit "$POSITRON_APP/Contents/Resources/app/product.json")"
  [ "$LOCAL_COMMIT" = "$COMMIT" ] || die "server commit ($COMMIT) != client commit ($LOCAL_COMMIT)"
  log "Commit matches the local client"
fi

# Layout expected by Remote SSH: ~/.positron-server/bin/<commit>/bin/<serverApplicationName>.
# data/ and extensions/ are created up front: volumes are mounted on them, and owned by analyst
# a new volume gets the right permissions. Repacking into a tar.gz with the owner in the headers
# makes the build context ~3x smaller than unpacked (matters when building on a remote host),
# and ADD unpacks it with these uid:gid.
mkdir -p "$CTX/data/bin" "$CTX/data/data" "$CTX/data/extensions"
mv "$STAGE" "$CTX/data/bin/$COMMIT"
log "Packing the build context"
if tar --version 2>/dev/null | grep -q bsdtar; then
  COPYFILE_DISABLE=1 tar -czf "$CTX/server.tar.gz" -C "$CTX/data" \
    --uid "$POSITRON_UID" --gid "$POSITRON_GID" --no-xattrs --no-mac-metadata --no-acls .
else
  tar -czf "$CTX/server.tar.gz" -C "$CTX/data" \
    --numeric-owner --owner "$POSITRON_UID" --group "$POSITRON_GID" .
fi
rm -rf "$CTX/data"
install -m 0755 "$ROOT/positron/positron-entrypoint" "$ROOT/positron/positron-projects" "$CTX/"
log "Build context: $CTX ($(du -h "$CTX/server.tar.gz" | cut -f1), commit $COMMIT)"

if [ "$PREPARE_ONLY" = 1 ]; then
  echo "$CTX"
  exit 0
fi

# --- 3. Build
log "Building $TAG on '$BUILD_HOST'"
hdocker "$BUILD_HOST" build \
  --platform "$DOCKER_PLATFORM" \
  -f "$ROOT/positron/Dockerfile" \
  --build-arg ENV_IMAGE="$ENV_IMAGE" \
  --build-arg POSITRON_VERSION="$VERSION" \
  --build-arg POSITRON_COMMIT="$COMMIT" \
  -t "$TAG" \
  "$CTX"
rm -rf "$CTX"

if [ "$PUSH" = 1 ]; then
  log "Pushing $TAG to the registry"
  hdocker "$BUILD_HOST" push -q "$TAG"
fi
log "Done: $TAG"
