#!/bin/sh
# fnkc-idle-watch: stops the container when it has been idle for FNKC_IDLE_MINUTES minutes.
# Idle means both: nobody is connected (no SSH session, so no Positron window), and the container uses
# almost no CPU (so a long R job keeps it running after the window is closed). Started by the entrypoint
# as root; stopping the container is a TERM to PID 1 (docker-init), which passes it on to the entrypoint
# (renv::snapshot, then sshd ends). The project files and
# Positron's settings are on volumes, so nothing is lost; the next Open starts the container again.
#
# The current state is in /run/fnkc-idle (for: docker exec <container> cat /run/fnkc-idle).
set -u

MINUTES="${FNKC_IDLE_MINUTES:-0}"
case "$MINUTES" in ''|*[!0-9]*) echo "fnkc-idle-watch: bad FNKC_IDLE_MINUTES '$MINUTES'" >&2; exit 1 ;; esac
[ "$MINUTES" -gt 0 ] || exit 0

# Seconds per check; one check counts as one idle minute (shorter only for testing)
INTERVAL="${FNKC_IDLE_INTERVAL:-60}"
# Less than 5% of one CPU core on average over a minute counts as quiet
QUIET_USEC=$((INTERVAL * 1000000 / 20))
STAT=/sys/fs/cgroup/cpu.stat

cpu_usec() { sed -n 's/^usage_usec //p' "$STAT" 2>/dev/null; }
# SSH sessions of the user: one "sshd" (or "sshd-session" in newer OpenSSH) process per connection
sessions() { ps -u analyst -o comm= 2>/dev/null | grep -cE '^sshd(-session)?$'; }

if [ -z "$(cpu_usec)" ]; then
  # Without the container's CPU counter a running computation cannot be told from idleness: never stop
  echo "fnkc-idle-watch: $STAT not available, automatic stop is off" >&2
  echo "off: no $STAT" > /run/fnkc-idle
  exit 0
fi

idle=0
last="$(cpu_usec)"
while sleep "$INTERVAL"; do
  now="$(cpu_usec)"
  used=$((now - last))
  last="$now"
  n="$(sessions)"
  for lease in /tmp/fnkc-jobs/*; do
    [ -f "$lease" ] || continue
    pid="${lease##*/}"
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    if kill -0 "$pid" 2>/dev/null; then n=$((n + 1)); else rm -f "$lease"; fi
  done
  if [ "$n" -eq 0 ] && [ "$used" -lt "$QUIET_USEC" ]; then idle=$((idle + 1)); else idle=0; fi
  echo "idle ${idle}/${MINUTES} min; ssh sessions: $n; cpu: $((used / (INTERVAL * 10000)))% of a core" > /run/fnkc-idle
  if [ "$idle" -ge "$MINUTES" ]; then
    echo "fnkc-idle-watch: idle for $MINUTES minutes, stopping the container" >&2
    kill -TERM 1
    exit 0
  fi
done
