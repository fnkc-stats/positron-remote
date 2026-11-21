#!/bin/sh
# fnkc-idle-watch: stops the container when nobody uses it. Started by the entrypoint as root when FNKC_IDLE_MINUTES
# is more than 0 (on a server; on the user's own computer it is 0: never). Stopping is a TERM to PID 1 (docker-init),
# which passes it on to the entrypoint (sshd ends; dependencies stay unchanged). The project files and Positron's
# settings are on volumes, so only what R and Python sessions hold in memory is lost; the next Open starts it again.
#
# Two rules, checked once a minute (one check counts as one minute):
#   idle:   no window (no SSH session) and quiet (under 5% of a core, no fnkc-projects run job) for FNKC_IDLE_MINUTES
#   no window, but busy: a long computation keeps running, for FNKC_BUSY_STOP_MINUTES (3 days) after the last window
#           closed. From FNKC_BUSY_NOTICE_MINUTES (24 h) on, the user's Positron offers Keep (fnkc-ctl agent keep):
#           it creates /run/fnkc-keep, which gives FNKC_BUSY_STOP_MINUTES more from then on.
# A window that connects again resets both.
#
# The state, as key=value lines, is in /run/fnkc-idle (agent list reads it; docker exec <container> cat /run/fnkc-idle).
set -u

MINUTES="${FNKC_IDLE_MINUTES:-0}"
NOTICE="${FNKC_BUSY_NOTICE_MINUTES:-1440}"
LIMIT="${FNKC_BUSY_STOP_MINUTES:-4320}"
for v in "$MINUTES" "$NOTICE" "$LIMIT"; do
  case "$v" in ''|*[!0-9]*) echo "fnkc-idle-watch: bad setting '$v'" >&2; exit 1 ;; esac
done
[ "$MINUTES" -gt 0 ] || exit 0

# Seconds per check (shorter only for testing), and where things are (other places only for testing)
INTERVAL="${FNKC_IDLE_INTERVAL:-60}"
STAT="${FNKC_IDLE_STAT:-/sys/fs/cgroup/cpu.stat}"
STATE="${FNKC_IDLE_STATE:-/run/fnkc-idle}"
KEEP="${FNKC_IDLE_KEEP:-/run/fnkc-keep}"
JOBS="${FNKC_IDLE_JOBS:-/tmp/fnkc-jobs}"
STOP="${FNKC_IDLE_STOP:-kill -TERM 1}"
# Less than 5% of one CPU core on average over a check counts as quiet
QUIET_USEC=$((INTERVAL * 1000000 / 20))

cpu_usec() { sed -n 's/^usage_usec //p' "$STAT" 2>/dev/null; }
# SSH sessions of the user: one "sshd" (or "sshd-session" in newer OpenSSH) process per connection
sessions() { ps -u analyst -o comm= 2>/dev/null | grep -cE '^sshd(-session)?$'; }

if [ -z "$(cpu_usec)" ]; then
  # Without the container's CPU counter a running computation cannot be told from idleness: never stop
  echo "fnkc-idle-watch: $STAT not available, automatic stop is off" >&2
  echo "off=no $STAT" > "$STATE"
  exit 0
fi

idle=0
nowindow=0
limit="$LIMIT"
last="$(cpu_usec)"
while sleep "$INTERVAL"; do
  now="$(cpu_usec)"
  used=$((now - last))
  last="$now"
  s="$(sessions)"
  jobs=0
  for lease in "$JOBS"/*; do
    [ -f "$lease" ] || continue
    pid="${lease##*/}"
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    if kill -0 "$pid" 2>/dev/null; then jobs=$((jobs + 1)); else rm -f "$lease"; fi
  done
  busy=0
  if [ "$jobs" -gt 0 ] || [ "$used" -ge "$QUIET_USEC" ]; then busy=1; fi

  if [ "$s" -gt 0 ]; then
    nowindow=0; limit="$LIMIT"; rm -f "$KEEP"
  else
    nowindow=$((nowindow + 1))
    # Keep: the full time again, from now
    if [ -f "$KEEP" ]; then limit=$((nowindow + LIMIT)); rm -f "$KEEP"; fi
  fi
  if [ "$s" -eq 0 ] && [ "$busy" -eq 0 ]; then idle=$((idle + 1)); else idle=0; fi

  {
    echo "idle=$idle"; echo "idle_limit=$MINUTES"; echo "sessions=$s"; echo "jobs=$jobs"
    echo "cpu=$((used / (INTERVAL * 10000)))"; echo "busy=$busy"; echo "no_window=$nowindow"
    if [ "$s" -eq 0 ]; then
      echo "stop_in=$((limit - nowindow))"
      if [ "$busy" -eq 1 ] && [ "$nowindow" -ge "$NOTICE" ]; then echo 'notice=1'; fi
    fi
  } > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"

  if [ "$idle" -ge "$MINUTES" ]; then
    echo "fnkc-idle-watch: idle for $MINUTES minutes, stopping the container" >&2
    $STOP
    exit 0
  fi
  if [ "$s" -eq 0 ] && [ "$nowindow" -ge "$limit" ]; then
    echo "fnkc-idle-watch: no window for $nowindow minutes (still busy), stopping the container" >&2
    $STOP
    exit 0
  fi
done
