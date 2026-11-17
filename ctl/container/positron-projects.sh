#!/bin/sh
# Human workspace commands. Initialization never updates an existing checkout.
set -eu
CMD="${1:-status}"
[ $# -eq 0 ] || shift
case "$CMD" in
  init)
    [ $# -eq 3 ] || { echo 'usage: positron-projects init <id> <commit> <repository>' >&2; exit 2; }
    dir="$1"; revision="$2"; url="$3"
    case "$dir" in ''|*[!A-Za-z0-9_.-]*|.*) exit 2 ;; esac
    case "$revision" in ''|*[!0-9a-f]*) exit 2 ;; esac
    [ "${#revision}" -eq 40 ] || exit 2
    d="$HOME/$dir"
    if [ -d "$d/.git" ]; then
      [ "$(git -C "$d" remote get-url origin)" = "$url" ] || { echo 'repository mismatch' >&2; exit 1; }
      [ "$(git -C "$d" rev-parse HEAD)" = "$revision" ] || { echo 'checkout changed during Open; retry' >&2; exit 1; }
      [ ! -e "$d/.positron-initializing" ] || { echo 'incomplete clone: administrator recovery required' >&2; exit 1; }
      exit 0
    fi
    [ -z "$(ls -A "$d")" ] || { echo 'project directory is not empty' >&2; exit 1; }
    export GIT_TERMINAL_PROMPT=0
    export GIT_SSH_COMMAND='ssh -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=10'
    # The caller sends trusted Gitea host keys before this command.
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    git clone --no-checkout -- "$url" "$tmp/repo"
    git -C "$tmp/repo" fetch origin "$revision"
    branch="$(git -C "$tmp/repo" symbolic-ref --short refs/remotes/origin/HEAD)"
    branch="${branch#origin/}"
    git -C "$tmp/repo" checkout -B "$branch" "$revision"
    touch "$d/.positron-initializing"
    cp -a "$tmp/repo/." "$d/"
    rm "$d/.positron-initializing"
    ;;
  status)
    git status --short --branch
    keys="$(git rev-parse --git-path git-crypt/keys)"
    if [ -d "$keys" ] && [ -n "$(find "$keys" -type f -print -quit)" ]; then echo 'Data: unlocked (persists until explicitly locked)'; else echo 'Data: locked or unencrypted'; fi
    ;;
  sync)
    git fetch --prune origin
    echo 'Fetched only. Choose a branch/revision explicitly; reopen if container.json changes.'
    ;;
  lock)
    git-crypt lock
    echo 'Tracked encrypted files locked. Review/remove plaintext reports and temporary outputs separately.'
    ;;
  run)
    [ $# -gt 0 ] || { echo 'usage: positron-projects run <command> [args...]' >&2; exit 2; }
    # PID lease protects I/O-bound jobs. The wrapper stays alive until the command exits.
    mkdir -p /tmp/positron-jobs
    lease="/tmp/positron-jobs/$$"
    : > "$lease"
    trap 'rm -f "$lease"' EXIT
    "$@"
    ;;
  *) echo 'commands: init, status, sync (fetch only), lock, run' >&2; exit 2 ;;
esac
