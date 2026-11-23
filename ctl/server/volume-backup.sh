#!/usr/bin/env bash
# Encrypted backup of a stopped project's volume. Restic credentials remain on the host.
# backup <volume> <approved-image-digest> | restore <snapshot> <archive-name> fnkc.restore.<name> <image-digest>
set -euo pipefail
umask 077
command -v restic >/dev/null || { echo 'Install restic and configure RESTIC_REPOSITORY and its password source.' >&2; exit 2; }
: "${RESTIC_REPOSITORY:?set an encrypted off-host restic repository}"
# Kernel lock shared with project lifecycle requests. A backup never blocks unrelated projects.
volume_arg="${2:-}"
[ "${1:-}" != restore ] || volume_arg="${4:-}"
lock_name="volume-$volume_arg"
if [[ "$volume_arg" =~ ^fnkc-([a-z][a-z0-9]*)-(.+)-(project|data|library|ext)$ ]]; then
  lock_name="project-${BASH_REMATCH[1]}-${BASH_REMATCH[2]}"
elif [[ "$volume_arg" =~ ^fnkc-ext-([a-z][a-z0-9]*)-(.+)-(x64|arm64)-[0-9a-f]{12}$ ]]; then
  lock_name="project-${BASH_REMATCH[1]}-${BASH_REMATCH[2]}"
fi
[[ "$lock_name" =~ ^[a-zA-Z0-9_.-]+$ ]] || exit 2
lock="${FNKC_BACKUP_LOCK_DIR:-/var/lib/fnkc-ctl/locks}/$lock_name.kernel"
mkdir -p "$(dirname "$lock")"
if [ "${FNKC_BACKUP_LOCKED:-}" != "$lock" ]; then
  exec python3 - "$lock" "$0" "$@" <<'PYLOCK'
import fcntl, os, sys, time
path, script, *args = sys.argv[1:]
fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
if os.geteuid() == 0:
    parent = os.stat(os.path.dirname(path))
    os.fchown(fd, parent.st_uid, parent.st_gid)
end = time.monotonic() + 120
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() >= end:
            raise TimeoutError("project operation is busy: " + path)
        time.sleep(.05)
os.set_inheritable(fd, True)
os.environ['FNKC_BACKUP_LOCKED'] = path
os.execvp('bash', ['bash', script, *args])
PYLOCK
fi
valid_volume() { [[ "$1" =~ ^fnkc-[a-zA-Z0-9][a-zA-Z0-9_.-]+$ ]]; }
# Restore targets live in a staging namespace no project volume can match: those are fnkc-<user>-... and fnkc-ext-...
# (layout.ts), with a user name of letters and digits only, so nothing generated starts with "fnkc." (as fnkc.recovery.*).
# fnkc-ctl also refuses to open any volume labelled fnkc.restore (agent.ts), whatever its name.
valid_restore_target() {
  [[ "$1" =~ ^fnkc\.restore\.[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] && return
  echo "Restore only into a new staging volume fnkc.restore.<name> (for example fnkc.restore.anna-<project>-<date>), never a project's volume name: $1" >&2
  return 1
}
valid_image() { [[ "$1" =~ ^[a-z0-9][a-z0-9./:_-]+@sha256:[0-9a-f]{64}$ ]]; }
# The helper reads private files, so it runs only Docker's immutable ID of the image, resolved by fnkc-ctl (host-image.ts):
# an allowed repository, provenance verified on this host if required, and the local name still pointing at the image
# the digest names. A moved tag, a missing upload record or two names for different images are refused.
local_image() {
  # fnkc-ctl from this script's own release (not through the current link, which an install may switch meanwhile), run
  # by the Node install.sh checked and wrote into /usr/local/bin/fnkc-ctl. FNKC_CTL replaces it only in tests.
  local ctl="${FNKC_CTL:-$(dirname "$(readlink -f "$0")")/fnkc-ctl.cjs}" node id
  node="$(sed -n 's/^exec \(\/[^ ]*\) .*/\1/p' /usr/local/bin/fnkc-ctl 2>/dev/null)"
  [ -n "$node" ] && [ -x "$node" ] || node="$(command -v node)" || { echo 'node is required (the one fnkc-ctl runs with)' >&2; return 1; }
  id="$("$node" "$ctl" admin resolve-image "$1")" || return 1
  [[ "$id" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "unexpected image ID for $1: $id" >&2; return 1; }
  printf '%s\n' "$id"
}
case "${1:-}" in
  backup)
    [ "$#" -eq 3 ] || exit 2
    volume="$2"; image="$3"
    valid_volume "$volume" && valid_image "$image" || exit 2
    image="$(local_image "$image")" || exit 1
    docker volume inspect "$volume" >/dev/null
    [ -z "$(docker ps -q --filter "volume=$volume")" ] || { echo 'Stop all containers using this volume before backing up.' >&2; exit 1; }
    # Restic waits for the producer's exit status before committing the snapshot.
    restic backup --stdin-from-command --stdin-filename "$volume.tar" --tag fnkc --tag "$volume" -- \
      docker run --rm --pull never --network none --read-only --memory 256m --cpus 1 --pids-limit 64 \
        --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges \
        --mount "type=volume,source=$volume,target=/source,readonly" --entrypoint tar "$image" -C /source -cpf - .
    ;;
  restore)
    [ "$#" -eq 5 ] || exit 2
    snapshot="$2"; archive="$3"; volume="$4"; image="$5"
    valid_restore_target "$volume" && valid_image "$image" || exit 2
    image="$(local_image "$image")" || exit 1
    # A restore never overwrites existing work. Reserve a brand-new target under an operator lock.
    docker info >/dev/null
    if docker volume inspect "$volume" >/dev/null 2>&1; then echo 'Restore target already exists; choose a new volume.' >&2; exit 1; fi
    docker volume create --label "fnkc.restore=$snapshot:$archive" "$volume" >/dev/null
    # The target this run created holds only a part of the archive until both stages succeed: a failure or an
    # interruption removes it (still under the lock), so the same command can simply be retried.
    trap 'docker volume rm "$volume" >/dev/null 2>&1 || echo "Remove the incomplete volume $volume before retrying: docker volume rm $volume" >&2' EXIT
    # tar -xp as root needs only CHOWN (owners), FOWNER (modes and times of files it does not own) and DAC_OVERRIDE
    # (writing into directories it does not own); everything else is dropped. FOWNER lets tar's chmod after chown put
    # setuid/setgid bits back, so the same helper then strips them: a restored volume never carries set-ID files.
    if ! restic dump "$snapshot" "$archive" \
      | docker run --rm -i --pull never --network none --read-only --memory 256m --cpus 1 --pids-limit 64 \
          --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --security-opt no-new-privileges \
          --mount "type=volume,source=$volume,target=/restore" \
          --entrypoint sh "$image" -c 'tar -C /restore -xpf - && find /restore -xdev -perm /6000 -exec chmod ug-s {} +'; then
      echo "Restore failed; the incomplete volume $volume is removed. Check the snapshot and archive name, then retry." >&2
      exit 1
    fi
    trap - EXIT
    echo "Restored into $volume; inspect it read-only, then remove it (a restored volume is never connected to a project)."
    ;;
  *) echo 'usage: volume-backup.sh backup <volume> <image@sha256:...> | restore <snapshot> <archive> fnkc.restore.<name> <image@sha256:...>' >&2; exit 2 ;;
esac
