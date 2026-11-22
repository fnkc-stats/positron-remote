#!/usr/bin/env bash
# Installs fnkc-ctl on a Linux server. Run as root from the unpacked bundle (npm run server-bundle):
#   tar -xzf fnkc-ctl-server.tar.gz && sudo ./fnkc-ctl-server/install.sh
# Safe to run again (e.g. to update fnkc-ctl): existing settings and users are kept, and the replaced program is kept
# in /opt/fnkc-ctl/previous/ for a rollback:
#   sudo /opt/fnkc-ctl/install.sh --rollback [--yes]    swaps the installed and the previous program (again: back)
# Offline: FNKC_TRUSTED_ROOT=<file> installs GitHub's Sigstore trust root from a file made on a computer with gh
# (gh attestation trusted-root > trusted-root.jsonl) instead of downloading it; needed only on a first install.
#
# What it sets up:
#   /opt/fnkc-ctl/fnkc-ctl.cjs     the program (also as the fnkc-ctl command for admins)
#   /etc/fnkc-ctl/agent.json           rules: allowed images, limits, idle time (created once)
#   /etc/fnkc-ctl/keys/                users' public keys (fnkc-ctl admin add-user)
#   account "fnkc" in group docker     users log in as it; their key only runs the agent
# Requirements: Docker Engine, GitHub CLI, and Node.js 22.18 or newer.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ACCOUNT="${FNKC_ACCOUNT:-fnkc}"
PREFIX=/opt/fnkc-ctl
ETC=/etc/fnkc-ctl

# The program's files, installed into $PREFIX; the replaced ones are kept in $PREFIX/previous
FILES=(fnkc-ctl.cjs volume-backup.sh render-reviewed.py refresh-trust-root.sh install.sh)

say() { printf '==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
# Replaces a file in one step (rename), so an SSH request never runs a half-written program
put() { cp -- "$1" "$2.new.$$" && chmod 0755 "$2.new.$$" && mv -f -- "$2.new.$$" "$2"; }
version_of() { "${NODE:-node}" "$1" --version 2>/dev/null || echo unknown; }

ROLLBACK=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --rollback) ROLLBACK=1 ;;
    --yes) YES=1 ;;
    *) die "unknown option '$arg' (options: --rollback [--yes])" ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run as root (sudo $0)"

if [ "$ROLLBACK" = 1 ]; then
  NODE="$(command -v node || true)"
  [ -f "$PREFIX/previous/fnkc-ctl.cjs" ] || die "there is no previous version in $PREFIX/previous to roll back to"
  current="$(version_of "$PREFIX/fnkc-ctl.cjs")"
  previous="$(version_of "$PREFIX/previous/fnkc-ctl.cjs")"
  printf 'Installed: fnkc-ctl %s\nPrevious:  fnkc-ctl %s\n' "$current" "$previous"
  echo 'Running projects keep running; settings, users and images stay as they are. Running this again rolls forward.'
  if [ "$YES" != 1 ]; then
    [ -t 0 ] || die "confirmation needed: run this in a terminal, or add --yes"
    read -r -p "Roll back to $previous? [y/N] " answer
    case "$answer" in y|Y|yes|YES) ;; *) echo 'Nothing changed.'; exit 0 ;; esac
  fi
  # The installed files go to a new "previous" (so a second rollback undoes this one); then each previous file
  # replaces its installed one in one step
  rm -rf "$PREFIX/previous.new"
  install -d -m 0755 "$PREFIX/previous.new"
  for f in "${FILES[@]}"; do [ ! -f "$PREFIX/$f" ] || cp -p -- "$PREFIX/$f" "$PREFIX/previous.new/$f"; done
  for f in "${FILES[@]}"; do [ ! -f "$PREFIX/previous/$f" ] || put "$PREFIX/previous/$f" "$PREFIX/$f"; done
  rm -rf "$PREFIX/previous"
  mv "$PREFIX/previous.new" "$PREFIX/previous"
  say "Rolled back: fnkc-ctl $(version_of "$PREFIX/fnkc-ctl.cjs") is installed (fnkc-ctl $current is kept in $PREFIX/previous)"
  echo 'Users whose FNKC Projects needs the newer server see that in Check Setup: they install the matching older'
  echo 'extension from GitHub Releases and turn off fnkcProjects.checkForUpdates until the server is upgraded again.'
  exit 0
fi

[ "$HERE" != "$PREFIX" ] || die "run the installer from an unpacked fnkc-ctl-server.tar.gz; here it only rolls back (--rollback)"
[ -f "$HERE/fnkc-ctl.cjs" ] || die "fnkc-ctl.cjs not found next to this script"

command -v python3 >/dev/null || die "Python 3 is required for kernel-owned locks"
command -v flock >/dev/null || die "flock (util-linux) is required for backups"
command -v docker >/dev/null || die "Docker is not installed (https://docs.docker.com/engine/install/)"
docker info >/dev/null 2>&1 || die "Docker is not running (systemctl enable --now docker)"
command -v gh >/dev/null || die "GitHub CLI is required to verify offline image attestations (https://cli.github.com/)"
getent group docker >/dev/null || die "there is no docker group"

NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "Node.js is not installed (22.18 or newer; e.g. https://nodejs.org or the NodeSource packages)"
"$NODE" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 18)) process.exit(1)' \
  || die "Node.js 22.18 or newer is required"

install -d -m 0755 "$PREFIX"
# Keep the installed version for --rollback, unless this is the same program again
if [ -f "$PREFIX/fnkc-ctl.cjs" ] && ! cmp -s "$HERE/fnkc-ctl.cjs" "$PREFIX/fnkc-ctl.cjs"; then
  say "Keeping fnkc-ctl $(version_of "$PREFIX/fnkc-ctl.cjs") in $PREFIX/previous (sudo $PREFIX/install.sh --rollback)"
  rm -rf "$PREFIX/previous"
  install -d -m 0755 "$PREFIX/previous"
  for f in "${FILES[@]}"; do [ ! -f "$PREFIX/$f" ] || cp -p -- "$PREFIX/$f" "$PREFIX/previous/$f"; done
fi
say "Installing $PREFIX/fnkc-ctl.cjs ($(version_of "$HERE/fnkc-ctl.cjs"))"
for f in "${FILES[@]}"; do put "$HERE/$f" "$PREFIX/$f"; done
# For admins: fnkc-ctl admin ..., fnkc-ctl agent list --user <name>
printf '#!/bin/sh\nexec %s %s/fnkc-ctl.cjs "$@"\n' "$NODE" "$PREFIX" > /usr/local/bin/fnkc-ctl
chmod 0755 /usr/local/bin/fnkc-ctl

install -d -m 0755 "$ETC" "$ETC/keys"
say "Installing GitHub's Sigstore trust root for offline provenance checks"
ROOT="$ETC/trusted-root.jsonl"
OFFLINE_HINT="on a computer with gh run: gh attestation trusted-root > trusted-root.jsonl; copy the file here and run: sudo FNKC_TRUSTED_ROOT=trusted-root.jsonl $0"
if [ -n "${FNKC_TRUSTED_ROOT:-}" ]; then
  "$PREFIX/refresh-trust-root.sh" --from "$FNKC_TRUSTED_ROOT" "$ROOT" >/dev/null || die "could not install the trust root from $FNKC_TRUSTED_ROOT"
elif ! "$PREFIX/refresh-trust-root.sh" "$ROOT" >/dev/null; then
  # An upgrade needs no network: the installed root stays (the weekly timer keeps trying)
  [ -s "$ROOT" ] || die "could not download GitHub's attestation trust root; without GitHub access, $OFFLINE_HINT"
  printf 'Warning: could not refresh the trust root; keeping the one from %s. To replace it without GitHub access, %s\n' \
    "$(date -r "$ROOT" +%F)" "$OFFLINE_HINT" >&2
fi
# Sigstore rotates keys: refreshed weekly while the server reaches GitHub (the current file stays if it cannot)
if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
  cat > /etc/systemd/system/fnkc-ctl-trust-root.service <<EOF_UNIT
[Unit]
Description=Refresh GitHub's Sigstore trust root for fnkc-ctl provenance checks
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$PREFIX/refresh-trust-root.sh $ETC/trusted-root.jsonl
EOF_UNIT
  cat > /etc/systemd/system/fnkc-ctl-trust-root.timer <<'EOF_UNIT'
[Unit]
Description=Weekly refresh of GitHub's Sigstore trust root for fnkc-ctl

[Timer]
OnCalendar=weekly
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
EOF_UNIT
  systemctl daemon-reload
  systemctl enable --now fnkc-ctl-trust-root.timer >/dev/null
else
  say "No systemd: refresh the trust root yourself now and then: $PREFIX/refresh-trust-root.sh"
fi
if [ ! -f "$ETC/agent.json" ]; then
  say "Creating $ETC/agent.json (edit: allowed images, limits, idle time)"
  install -m 0644 "$HERE/agent.example.json" "$ETC/agent.json"
else
  say "Keeping the existing $ETC/agent.json"
fi

if ! id "$ACCOUNT" >/dev/null 2>&1; then
  say "Creating the account '$ACCOUNT' (no password; only keys added with fnkc-ctl admin)"
  useradd --system --create-home --shell /bin/sh "$ACCOUNT"
fi
usermod -a -G docker "$ACCOUNT"
HOME_DIR="$(getent passwd "$ACCOUNT" | cut -d: -f6)"
install -d -m 0700 -o "$ACCOUNT" -g "$ACCOUNT" "$HOME_DIR/.ssh"

# One lock namespace shared by service requests and root administration; uploaded images are checked in images/.
install -d -m 0700 -o "$ACCOUNT" -g "$ACCOUNT" /var/lib/fnkc-ctl /var/lib/fnkc-ctl/locks /var/lib/fnkc-ctl/images /var/lib/fnkc-ctl/verified
# Every request reads agent.json, and a program rollback leaves it in place: the migrated settings are written
# beside it (same owner and mode), checked as the service account, and renamed into place, so an interrupted or
# wrong migration leaves the live file as it was. The version before the migration stays as agent.json.prev.
rm -f "$ETC/agent.json.new"
"$NODE" - "$ETC/agent.json" <<'JS' || die "could not migrate $ETC/agent.json (it is unchanged)"
const fs = require('node:fs');
const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');
const cfg = JSON.parse(text);
cfg.lockDir = '/var/lib/fnkc-ctl/locks';
cfg.imageStagingDir ??= '/var/lib/fnkc-ctl/images';
cfg.verifiedDir ??= '/var/lib/fnkc-ctl/verified';
cfg.allowedImages = (cfg.allowedImages ?? ['ghcr.io/fnkc-stats/r-env']).map(p => p === 'ghcr.io/fnkc-stats/' ? 'ghcr.io/fnkc-stats/r-env' : p);
const out = JSON.stringify(cfg, null, 2) + '\n';
if (out === text) process.exit(0); // nothing to migrate: no candidate
const st = fs.statSync(file);
const fd = fs.openSync(`${file}.new`, 'wx', 0o600);
fs.fchownSync(fd, st.uid, st.gid);
fs.fchmodSync(fd, st.mode & 0o7777);
fs.writeSync(fd, out);
fs.fsyncSync(fd);
fs.closeSync(fd);
JS
if [ -f "$ETC/agent.json.new" ]; then
  if ! sudo -u "$ACCOUNT" "$NODE" "$PREFIX/fnkc-ctl.cjs" admin check-config "$ETC/agent.json.new" >/dev/null; then
    rm -f "$ETC/agent.json.new"
    die "the migrated $ETC/agent.json does not pass the check (the file is unchanged): fix it (fnkc-ctl admin check-config), then run install.sh again"
  fi
  cp -p "$ETC/agent.json" "$ETC/agent.json.prev"
  mv -f "$ETC/agent.json.new" "$ETC/agent.json"
  say "Migrated $ETC/agent.json (the previous version is $ETC/agent.json.prev)"
fi

# Re-enroll managed keys to remove the old wildcard forwarding authorization.
for key in "$ETC/keys/"*.pub; do
  [ -f "$key" ] || continue
  user="$(basename "$key" .pub)"
  "$NODE" "$PREFIX/fnkc-ctl.cjs" admin add-user "$user" "$key" --account "$ACCOUNT"
done
command -v sshd >/dev/null || die 'OpenSSH server is required'
grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config.d/\*' /etc/ssh/sshd_config \
  || die 'sshd_config must include /etc/ssh/sshd_config.d/*.conf before Match blocks'
install -d -m 0755 /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/00-fnkc-ctl.conf <<EOF_SSH
Match User $ACCOUNT
    DisableForwarding yes
    AllowTcpForwarding no
    AllowStreamLocalForwarding no
    AllowAgentForwarding no
    PermitTunnel no
    PermitTTY no
    X11Forwarding no
Match all
EOF_SSH
sshd -t || die 'sshd configuration validation failed'
EFFECTIVE="$(sshd -T -C "user=$ACCOUNT,host=localhost,addr=127.0.0.1")"
printf '%s\n' "$EFFECTIVE" | grep -qx 'disableforwarding yes' || die 'effective sshd policy does not disable forwarding'
printf '%s\n' "$EFFECTIVE" | grep -qx 'permituserenvironment no' || die 'PermitUserEnvironment must be no for the gateway'
if printf '%s\n' "$EFFECTIVE" | awk '$1 == "acceptenv" {for (i=2;i<=NF;i++) if ($i != "LANG" && $i != "LC_*" && $i != "TZ") bad=1} END {exit !bad}'; then
  die 'AcceptEnv may only allow LANG, LC_* and TZ for the gateway; do not accept NODE_OPTIONS, PATH or agent configuration overrides'
fi
systemctl reload ssh.service 2>/dev/null || systemctl reload sshd.service \
  || die 'could not reload sshd; reload it manually before allowing users to connect'

say "Checking the agent"
sudo -u "$ACCOUNT" "$NODE" "$PREFIX/fnkc-ctl.cjs" --version >/dev/null \
  || die "the agent does not run as $ACCOUNT"
sudo -u "$ACCOUNT" docker info >/dev/null 2>&1 \
  || die "$ACCOUNT cannot use Docker (group membership applies to new logins; check the docker socket's group)"
# Read as the agent reads it: a mistake here would otherwise first show in every user's next request
say "Checking $ETC/agent.json"
sudo -u "$ACCOUNT" "$NODE" "$PREFIX/fnkc-ctl.cjs" admin check-config "$ETC/agent.json" >/dev/null \
  || die "fix $ETC/agent.json, then check it again with: fnkc-ctl admin check-config"

# The journal is the only record of who asked for what (docs/operations.md), and the agent writes it through
# logger(1) without failing a request when that is lost: send a marker as the service account and look for it.
say "Checking the request journal"
marker="install-probe-$(date +%s)-$$"
if ! command -v logger >/dev/null; then
  printf 'Warning: %s\n' "logger is missing (package bsdutils or util-linux): requests will leave no record in the journal" >&2
elif ! sudo -u "$ACCOUNT" logger -t fnkc-ctl -p user.info -- "command=install-probe marker=$marker"; then
  printf 'Warning: %s\n' "logger failed for $ACCOUNT: requests will leave no record in the journal" >&2
elif ! command -v journalctl >/dev/null; then
  printf 'Warning: %s\n' "no journalctl: requests go to syslog with tag fnkc-ctl; check that they arrive (grep $marker in the system log)" >&2
else
  found=''
  for _ in 1 2 3 4 5; do
    if journalctl -t fnkc-ctl --since=-10min -o cat 2>/dev/null | grep -F "marker=$marker" >/dev/null; then found=1; break; fi
    sleep 1
  done
  [ -n "$found" ] || printf 'Warning: %s\n' "a test line from $ACCOUNT did not reach the journal (journalctl -t fnkc-ctl): check that journald runs and receives syslog (/dev/log)" >&2
fi

cat <<EOF

Done. Next:
  1. Edit $ETC/agent.json if needed (allowedImages, limits, idleMinutes), then: fnkc-ctl admin check-config
  2. Add users:  fnkc-ctl admin add-user anna /path/to/anna.pub
     (names: lowercase letters and digits; the key is the one they use for Gitea)
  3. In their Positron settings (FNKC Projects -> Hosts): { "name": "server", "ssh": "$ACCOUNT@$(hostname -f 2>/dev/null || hostname)" }
EOF
