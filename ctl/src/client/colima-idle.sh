#!/bin/sh
# fnkc-colima-idle: stops FNKC's own Colima profile once it has been quiet for a while.
# Quiet means both: no container runs in that profile (project containers stop themselves when idle,
# see container/idle-watch.sh), and no FNKC operation touched the lease file in the last two minutes
# (an image pull runs no container). Only the profile FNKC created is ever stopped: other Colima
# profiles and other projects on this computer are never touched. Started detached by the extension
# whenever it uses the profile; one copy runs at a time (pid file). Exits when the profile is stopped.
#
# Arguments: profile, docker context, lease file, pid file, quiet minutes.
set -u
PROFILE="$1" CONTEXT="$2" LEASE="$3" PIDFILE="$4" MINUTES="$5"
case "$MINUTES" in ''|*[!0-9]*) echo "fnkc-colima-idle: bad minutes '$MINUTES'" >&2; exit 1 ;; esac
[ "$MINUTES" -gt 0 ] || exit 0
# Seconds per check; one check counts as one quiet minute (shorter only for testing)
INTERVAL="${FNKC_COLIMA_IDLE_INTERVAL:-60}"

echo $$ > "$PIDFILE"
trap '[ "$(cat "$PIDFILE" 2>/dev/null)" = $$ ] && rm -f "$PIDFILE"' EXIT

# Succeeds when something runs (a container, a fresh lease) or Docker cannot tell; fails when quiet
busy() {
  [ -n "$(find "$LEASE" -mmin -2 2>/dev/null)" ] && return 0
  out="$(docker --context "$CONTEXT" ps -q 2>/dev/null)" || return 0
  [ -n "$out" ]
}

quiet=0
while sleep "$INTERVAL"; do
  colima status -p "$PROFILE" >/dev/null 2>&1 || exit 0
  if busy; then quiet=0; continue; fi
  quiet=$((quiet + 1))
  [ "$quiet" -ge "$MINUTES" ] || continue
  busy && { quiet=0; continue; }
  colima stop -p "$PROFILE" >/dev/null 2>&1
  exit 0
done
