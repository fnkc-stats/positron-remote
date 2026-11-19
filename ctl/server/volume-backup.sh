#!/usr/bin/env bash
# Encrypted backup of a stopped project's volume. Restic credentials remain on the host.
# backup <volume> <approved-image-digest> | restore <snapshot> <archive-name> <new-volume> <image-digest>
set -euo pipefail
umask 077
command -v restic >/dev/null || { echo 'Install restic and configure RESTIC_REPOSITORY and its password source.' >&2; exit 2; }
: "${RESTIC_REPOSITORY:?set an encrypted off-host restic repository}"
# Use the same lock as the installed agent so Open cannot restart a stopped volume during backup.
lock="${FNKC_BACKUP_LOCK_DIR:-/var/lib/fnkc-ctl/locks}/host"
mkdir -p "$(dirname "$lock")"
mkdir "$lock" || { echo "Host operation in progress: $lock" >&2; exit 1; }
printf '%s\n' "$$" > "$lock/pid"
trap 'rm -rf "$lock"' EXIT
valid_volume() { [[ "$1" =~ ^fnkc-[a-zA-Z0-9][a-zA-Z0-9_.-]+$ ]]; }
valid_image() { [[ "$1" =~ ^[a-z0-9][a-z0-9./:_-]+@sha256:[0-9a-f]{64}$ ]]; }
# Docker's name for the image on this host: the reference (pulled) or the tag of an image a client uploaded
local_image() {
  local name="${1%@*}" digest="${1#*@}" tagged
  tagged="${name%:*}"; [[ "${name##*/}" == *:* ]] || tagged="$name"
  for ref in "$1" "$tagged:${digest/:/-}"; do
    if docker image inspect "$ref" >/dev/null 2>&1; then printf '%s\n' "$ref"; return; fi
  done
  echo "Image not on this host: $1 (open a project that pins it first)" >&2; return 1
}
case "${1:-}" in
  backup)
    [ "$#" -eq 3 ] || exit 2
    volume="$2"; image="$3"
    valid_volume "$volume" && valid_image "$image" || exit 2
    image="$(local_image "$image")" || exit 1
    docker volume inspect "$volume" >/dev/null
    [ -z "$(docker ps -q --filter "volume=$volume")" ] || { echo 'Stop all containers using this volume before backing up.' >&2; exit 1; }
    docker run --rm --network none --read-only --memory 256m --cpus 1 --pids-limit 64 \
      --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges \
      --mount "type=volume,source=$volume,target=/source,readonly" --entrypoint tar "$image" -C /source -cpf - . \
      | restic backup --stdin --stdin-filename "$volume.tar" --tag fnkc --tag "$volume"
    ;;
  restore)
    [ "$#" -eq 5 ] || exit 2
    snapshot="$2"; archive="$3"; volume="$4"; image="$5"
    valid_volume "$volume" && valid_image "$image" || exit 2
    image="$(local_image "$image")" || exit 1
    # A restore never overwrites existing work. Reserve a brand-new target under an operator lock.
    docker info >/dev/null
    if docker volume inspect "$volume" >/dev/null 2>&1; then echo 'Restore target already exists; choose a new volume.' >&2; exit 1; fi
    docker volume create "$volume" >/dev/null
    restic dump "$snapshot" "$archive" \
      | docker run --rm -i --network none --read-only --memory 256m --cpus 1 --pids-limit 64 \
          --security-opt no-new-privileges --mount "type=volume,source=$volume,target=/restore" \
          --entrypoint tar "$image" -C /restore -xpf -
    echo "Restored into $volume; inspect it before connecting a project."
    ;;
  *) echo 'usage: volume-backup.sh backup <volume> <image@sha256:...> | restore <snapshot> <archive> <new-volume> <image@sha256:...>' >&2; exit 2 ;;
esac
