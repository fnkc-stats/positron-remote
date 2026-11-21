#!/bin/sh
# Human workspace commands. Initialization never updates an existing checkout.
set -eu
CMD="${1:-status}"
[ $# -eq 0 ] || shift
case "$CMD" in
  init)
    [ $# -eq 3 ] || { echo 'usage: fnkc-projects init <id> <commit> <repository>' >&2; exit 2; }
    dir="$1"; revision="$2"; url="$3"
    case "$dir" in ''|*[!A-Za-z0-9_.-]*|.*) exit 2 ;; esac
    case "$revision" in ''|*[!0-9a-f]*) exit 2 ;; esac
    [ "${#revision}" -eq 40 ] || exit 2
    d="$HOME/$dir"
    # The lock lives on persistent storage and the kernel releases it after a killed clone.
    # Keep initialization state until every top-level entry has been promoted atomically.
    if [ "${FNKC_INIT_LOCKED:-}" != 1 ]; then
      exec flock -w 120 "$HOME/.fnkc-init-$dir.lock" env FNKC_INIT_LOCKED=1 "$0" init "$dir" "$revision" "$url"
    fi
    stage="$d/.fnkc-init"
    if [ -d "$d/.git" ] && [ ! -d "$stage" ]; then
      [ "$(git -C "$d" remote get-url origin)" = "$url" ] || { echo 'repository mismatch' >&2; exit 1; }
      [ "$(git -C "$d" rev-parse HEAD)" = "$revision" ] || { echo 'checkout changed during Open; retry' >&2; exit 1; }
      [ ! -e "$d/.fnkc-initializing" ] || { echo 'legacy incomplete clone: preserve files and ask administrator to recover' >&2; exit 1; }
      rm -rf "$d/.fnkc-init-done"
      exit 0
    fi
    if [ ! -d "$stage" ]; then
      [ -z "$(ls -A "$d")" ] || { echo 'project directory is not empty' >&2; exit 1; }
      mkdir "$stage"
    fi
    export GIT_TERMINAL_PROMPT=0
    export GIT_SSH_COMMAND='ssh -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=10'
    if [ ! -f "$stage/ready" ]; then
      # Only unexposed staging data is discarded on retry; user files are never overwritten.
      [ "$(find "$d" -mindepth 1 -maxdepth 1 ! -name .fnkc-init -print -quit)" = '' ] || {
        echo 'unexpected files alongside incomplete initialization; preserve and inspect them' >&2; exit 1;
      }
      rm -rf "$stage/repo"
      git clone --no-checkout -- "$url" "$stage/repo"
      git -C "$stage/repo" fetch origin "$revision"
      branch="$(git -C "$stage/repo" symbolic-ref --short refs/remotes/origin/HEAD)"
      branch="${branch#origin/}"
      git -C "$stage/repo" checkout -B "$branch" "$revision"
      [ ! -e "$stage/repo/.fnkc-init" ] && [ ! -e "$stage/repo/.fnkc-init-done" ] || { echo 'repository uses reserved .fnkc-init path' >&2; exit 1; }
      printf '%s\n%s\n' "$url" "$revision" > "$stage/request"
      : > "$stage/ready"
    fi
    [ "$(sed -n '1p' "$stage/request")" = "$url" ] && [ "$(sed -n '2p' "$stage/request")" = "$revision" ] || {
      echo 'initialization belongs to another repository or revision; retry its original revision' >&2; exit 1;
    }
    # Rename within the volume: no second copy and each entry is either staged or promoted after a crash.
    for entry in "$stage/repo"/.[!.]* "$stage/repo"/..?* "$stage/repo"/*; do
      [ -e "$entry" ] || [ -L "$entry" ] || continue
      target="$d/$(basename "$entry")"
      [ ! -e "$target" ] && [ ! -L "$target" ] || { echo "refusing to overwrite $target" >&2; exit 1; }
      mv "$entry" "$target"
    done
    mv "$stage" "$d/.fnkc-init-done"
    rm -rf "$d/.fnkc-init-done"
    ;;
  status)
    git status --short --branch
    keys="$(git rev-parse --git-path git-crypt/keys)"
    if [ -d "$keys" ] && [ -n "$(find "$keys" -type f -print -quit)" ]; then echo 'Data: unlocked (persists until explicitly locked)'; else echo 'Data: locked or unencrypted'; fi
    ;;
  data)
    # none, locked or unlocked: whether tracked files use git-crypt, and whether this checkout is decrypted (Open asks)
    keys="$(git rev-parse --git-path git-crypt/keys)"
    if [ -d "$keys" ] && [ -n "$(find "$keys" -type f -print -quit)" ]; then echo unlocked
    elif git ls-files | git check-attr --stdin filter | grep -q ': filter: git-crypt$'; then echo locked
    else echo none; fi
    ;;
  sync)
    git fetch --prune origin
    echo 'Fetched only. Choose a branch/revision explicitly; reopen if container.json changes.'
    ;;
  snapshot)
    # Serialize against startup restoration; keep installed changes visible to the snapshot process.
    : "${FNKC_PROJECT:?not in a managed project}"
    flock -w 120 "$HOME/$FNKC_PROJECT/renv/.fnkc-environment.lock" \
      env FNKC_RENV_ACTION=snapshot Rscript /usr/local/lib/fnkc/snapshot.R
    ;;
  unlock)
    # unlock <key file>: decrypt the checkout with git-crypt. A GPG key (for repositories with git-crypt add-gpg-user)
    # is imported into this container's keyring first; a git-crypt key file is used as it is. Drag the file into
    # the project folder in Positron, run this, and the file is removed from the folder afterwards.
    [ $# -eq 1 ] && [ -f "$1" ] || { echo 'usage: fnkc-projects unlock <key file>' >&2; exit 2; }
    key="$(realpath "$1")"
    top="$(git rev-parse --show-toplevel)"
    # A key file in the project folder is removed afterwards, also when unlocking fails: never leave it to be committed
    case "$key" in "$top"/*) trap 'rm -f "$key"; echo "Removed ${key#"$top"/} from the project folder (keep your own copy)."' EXIT ;; esac
    if [ "$(head -c 12 "$key" | tr -d '\000')" = GITCRYPTKEY ]; then
      git-crypt unlock "$key"
    else
      gpg --batch --import "$key"
      # The gpg-agent the import started cannot use the imported key ("Bad secret key", GnuPG 2.4); a new one can
      gpgconf --kill gpg-agent
      git-crypt unlock
    fi
    echo 'Decrypted. The checkout stays decrypted until: fnkc-projects lock'
    ;;
  lock)
    git-crypt lock
    echo 'Tracked encrypted files locked. Review/remove plaintext reports and temporary outputs separately.'
    ;;
  run)
    [ $# -gt 0 ] || { echo 'usage: fnkc-projects run <command> [args...]' >&2; exit 2; }
    # PID lease protects I/O-bound jobs. The wrapper stays alive until the command exits.
    mkdir -p /tmp/fnkc-jobs
    lease="/tmp/fnkc-jobs/$$"
    : > "$lease"
    trap 'rm -f "$lease"' EXIT
    "$@"
    ;;
  busy)
    # What is still computing (Stop asks before it ends them): the user's processes that used CPU in the last two
    # seconds, without sshd and Positron's own server (its node processes). R and Python consoles count.
    # One line each: <pid> <percent of a core> <what>
    tick="$(getconf CLK_TCK 2>/dev/null || echo 100)"
    me="$(id -u)"
    snap() {
      for d in /proc/[0-9]*; do
        [ "$(stat -c %u "$d" 2>/dev/null)" = "$me" ] || continue
        stat="$(cat "$d/stat" 2>/dev/null)" || continue
        pid="${d#/proc/}"
        # Fields after the command name, which is in parentheses and may contain spaces: 4 is ppid, 14-15 CPU time
        set -- ${stat##*) }
        [ "$pid" = "$$" ] || [ "$2" = "$$" ] && continue
        echo "$pid $(( ${12} + ${13} ))"
      done
    }
    before="$(snap)"
    sleep 2
    snap | while read -r pid t; do
      t0="$(printf '%s\n' "$before" | sed -n "s/^$pid //p")"
      used=$(( t - ${t0:-$t} ))
      [ "$used" -gt 0 ] || continue
      comm="$(cat "/proc/$pid/comm" 2>/dev/null)" || continue
      args="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-120)"
      case "$comm" in sshd|sshd-session) continue ;; esac
      case "$comm:$args" in node:*.positron-server/*) continue ;; esac
      case "$comm" in ark) what='R console' ;; *) what="${args:-$comm}" ;; esac
      case "$comm:$args" in python*:*positron*) what='Python console' ;; esac
      echo "$pid $(( used * 100 / (2 * tick) )) $what"
    done
    ;;
  *) echo 'commands: init, status, data, sync (fetch only), snapshot, unlock <key file>, lock, run, busy' >&2; exit 2 ;;
esac
