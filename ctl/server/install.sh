#!/usr/bin/env bash
# Installs fnkc-ctl on a Linux server. Run as root from the unpacked bundle (npm run server-bundle):
#   tar -xzf fnkc-ctl-server.tar.gz && sudo ./fnkc-ctl-server/install.sh
# Safe to run again (e.g. to update fnkc-ctl): existing settings and users are kept, and the replaced release is kept
# for a rollback:
#   sudo /opt/fnkc-ctl/install.sh --rollback [--yes]    swaps the installed and the previous release (again: back)
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

# The program's files. Each version is installed whole as a release, $PREFIX/releases/<version>-<checksum>: these
# files and a MANIFEST of their checksums, staged and checked before it is used. $PREFIX/current points to the active
# release and $PREFIX/previous-release to the one it replaced; $PREFIX/<file> are fixed links through current, so one
# rename switches every file at once, and a rollback only ever selects a release whose files all match its MANIFEST.
# current and previous-release change together (switch_to): a switch stopped between them is finished by the next run.
# $PREFIX/install.sh is a copy of the newest installer (it manages releases, so a rollback does not replace it).
FILES=(fnkc-ctl.cjs volume-backup.sh render-reviewed.py refresh-trust-root.sh install.sh)
LINKED=(fnkc-ctl.cjs volume-backup.sh render-reviewed.py refresh-trust-root.sh)

say() { printf '==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
# Replaces a file in one step (rename), so an SSH request never runs a half-written program
put() { cp -- "$1" "$2.new.$$" && chmod 0755 "$2.new.$$" && mv -f -- "$2.new.$$" "$2"; }
# Points the link $1 at $2 in one step: a new link renamed over the old link (or file)
relink() { ln -sfn -- "$2" "$1.new.$$" && mv -Tf -- "$1.new.$$" "$1"; }
version_of() { "${NODE:-node}" "$1" --version 2>/dev/null || echo unknown; }

# Whether the release directory $1 is complete: it lists every program file, and all files its MANIFEST lists are
# there with those checksums
complete() {
  [ -f "$1/MANIFEST" ] && (cd "$1" && sha256sum --quiet --strict -c MANIFEST >/dev/null 2>&1) || return 1
  local f
  for f in "${LINKED[@]}"; do awk -v f="$f" '$2 == f {found=1} END {exit !found}' "$1/MANIFEST" || return 1; done
}
# Whether $1 (a link target, releases/<id>) names a release directory
is_release() { [[ "$1" =~ ^releases/[A-Za-z0-9._-]+$ ]] && [ -d "$PREFIX/$1" ]; }
# The release directory the link $PREFIX/$1 points to (current or previous-release), or nothing
release_of() {
  local t
  t="$(readlink "$PREFIX/$1" 2>/dev/null)" || return 0
  is_release "$t" && echo "$PREFIX/$t"
  return 0
}
# switch_to <current> <previous>: points current and previous-release (unless <previous> is empty) at those
# releases (releases/<id>). That is two renames, so the intended pair and the one before it are written to $SWITCH
# first: a run stopped between them is completed (or undone) by the next run, under the lock, before anything reads
# or prunes the releases. Without it, both links could name one release: --rollback would refuse, and the other
# release, named by neither, would be pruned.
SWITCH="$PREFIX/.release-switch"
switch_to() {
  local old_cur old_prev
  old_cur="$(readlink "$PREFIX/current" 2>/dev/null || true)"
  old_prev="$(readlink "$PREFIX/previous-release" 2>/dev/null || true)"
  printf '%s\n' "$1" "$2" "$old_cur" "$old_prev" > "$SWITCH.new.$$" && mv -f -- "$SWITCH.new.$$" "$SWITCH"
  if [ -n "$2" ]; then
    relink "$PREFIX/previous-release" "$2"
  fi
  relink "$PREFIX/current" "$1"
  rm -f -- "$SWITCH"
}
# Completes a switch an earlier run left unfinished (or, if its new release is gone or incomplete, undoes it);
# sets RECOVERED. A record that matches neither the links before nor after that switch is stale and is dropped.
RECOVERED=0
recover_switch() {
  rm -f -- "$SWITCH".new.*
  [ -f "$SWITCH" ] || return 0
  local want_cur='' want_prev='' old_cur='' old_prev='' now_cur now_prev
  { IFS= read -r want_cur; IFS= read -r want_prev; IFS= read -r old_cur; IFS= read -r old_prev; } < "$SWITCH" || true
  now_cur="$(readlink "$PREFIX/current" 2>/dev/null || true)"
  now_prev="$(readlink "$PREFIX/previous-release" 2>/dev/null || true)"
  if { [ "$now_cur" != "$want_cur" ] && [ "$now_cur" != "$old_cur" ]; } ||
     { [ "$now_prev" != "$old_prev" ] && { [ -z "$want_prev" ] || [ "$now_prev" != "$want_prev" ]; }; }; then
    printf 'Warning: %s\n' "$SWITCH records a release switch that does not match current and previous-release (changed by hand since?): ignored" >&2
  elif [ "$now_cur" = "$want_cur" ] && { [ -z "$want_prev" ] || [ "$now_prev" = "$want_prev" ]; }; then
    : # the switch had finished
  elif is_release "$want_cur" && complete "$PREFIX/$want_cur" && { [ -z "$want_prev" ] || is_release "$want_prev"; }; then
    if [ -n "$want_prev" ]; then relink "$PREFIX/previous-release" "$want_prev"; fi
    relink "$PREFIX/current" "$want_cur"
    say "Completed an interrupted switch of releases: ${want_cur#releases/} is active${want_prev:+, ${want_prev#releases/} the previous release}"
    RECOVERED=1
  elif is_release "$old_cur" && { [ -z "$old_prev" ] || is_release "$old_prev"; }; then
    if [ -n "$old_prev" ]; then relink "$PREFIX/previous-release" "$old_prev"; fi
    relink "$PREFIX/current" "$old_cur"
    say "Undid an interrupted switch of releases (${want_cur#releases/} is missing or incomplete): ${old_cur#releases/} is active again"
    RECOVERED=1
  else
    printf 'Warning: %s\n' "an interrupted switch of releases ($SWITCH) can be neither completed nor undone: its releases are gone" >&2
  fi
  rm -f -- "$SWITCH"
}
# The active release: current, if the program links point through it (an installer from before releases, run since,
# leaves plain files there instead)
active_release() {
  local f
  for f in "${LINKED[@]}"; do [ "$(readlink "$PREFIX/$f" 2>/dev/null)" = "current/$f" ] || return 0; done
  release_of current
}
# stage <dir> <file...>: those files of <dir> as a complete release in $PREFIX/releases; prints its directory. Called
# as x="$(stage ...)" || die, where errexit is off: every step is checked here.
stage() {
  local src="$1" tmp id dir f copied=1
  shift
  tmp="$(mktemp -d "$PREFIX/releases/.staging.XXXXXX")" && [ -d "$tmp" ] || return 1
  for f in "$@"; do
    if ! cp -- "$src/$f" "$tmp/$f" || ! chmod 0755 "$tmp/$f"; then copied=0; break; fi
  done
  if [ "$copied" != 1 ] || ! { (cd "$tmp" && sha256sum -- "$@" > MANIFEST) && chmod 0644 "$tmp/MANIFEST" &&
       chmod 0755 "$tmp" && sync -- "$tmp"/* && complete "$tmp"; }; then
    rm -rf "$tmp"
    return 1
  fi
  id="$(version_of "$tmp/fnkc-ctl.cjs" | tr -c 'A-Za-z0-9.\n-' _ | head -n1)-$(sha256sum "$tmp/MANIFEST" | cut -c1-12)"
  dir="$PREFIX/releases/$id"
  if [ -d "$dir" ] && complete "$dir"; then
    rm -rf "$tmp"
  else
    # A damaged release of the same files is replaced whole
    if [ -e "$dir" ] && ! mv -T -- "$dir" "$tmp.damaged"; then rm -rf "$tmp"; return 1; fi
    mv -T -- "$tmp" "$dir" || { rm -rf "$tmp"; return 1; }
    rm -rf "$tmp.damaged"
  fi
  echo "$dir"
}

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
command -v flock >/dev/null || die "flock (util-linux) is required"

# One installer at a time: two of them would each switch the release under the other
install -d -m 0755 "$PREFIX" "$PREFIX/releases"
exec 9> "$PREFIX/.install.lock"
flock -n 9 || die "another install.sh is running (lock $PREFIX/.install.lock)"
recover_switch

if [ "$ROLLBACK" = 1 ]; then
  NODE="$(command -v node || true)"
  if [ "$RECOVERED" = 1 ]; then
    say "fnkc-ctl $(version_of "$PREFIX/fnkc-ctl.cjs") is installed; nothing else changed (run --rollback again to swap it with the previous release)"
    exit 0
  fi
  cur="$(active_release)"
  [ -n "$cur" ] || die "$PREFIX has no installed release to roll back from (installed before releases, or changed by hand): run install.sh from an unpacked fnkc-ctl-server.tar.gz"
  prev="$(release_of previous-release)"
  [ -n "$prev" ] && [ "$prev" != "$cur" ] || die "there is no previous release in $PREFIX to roll back to"
  complete "$prev" || die "the previous release ${prev##*/} is incomplete or its files changed (cd $prev && sha256sum -c MANIFEST); nothing changed"
  current="$(version_of "$PREFIX/fnkc-ctl.cjs")"
  previous="$(version_of "$prev/fnkc-ctl.cjs")"
  printf 'Installed: fnkc-ctl %s (release %s)\nPrevious:  fnkc-ctl %s (release %s)\n' "$current" "${cur##*/}" "$previous" "${prev##*/}"
  echo 'Running projects keep running; settings, users and images stay as they are. Running this again rolls forward.'
  if [ "$YES" != 1 ]; then
    [ -t 0 ] || die "confirmation needed: run this in a terminal, or add --yes"
    read -r -p "Roll back to $previous? [y/N] " answer
    case "$answer" in y|Y|yes|YES) ;; *) echo 'Nothing changed.'; exit 0 ;; esac
  fi
  # One rename switches every program file; the replaced release becomes the previous one, for rolling forward
  switch_to "releases/${prev##*/}" "releases/${cur##*/}"
  say "Rolled back: fnkc-ctl $(version_of "$PREFIX/fnkc-ctl.cjs") is installed (fnkc-ctl $current is kept as the previous release)"
  echo 'Users whose FNKC Projects needs the newer server see that in Check Setup: they install the matching older'
  echo 'extension from GitHub Releases and turn off fnkcProjects.checkForUpdates until the server is upgraded again.'
  exit 0
fi

[ "$HERE" != "$PREFIX" ] || die "run the installer from an unpacked fnkc-ctl-server.tar.gz; here it only rolls back (--rollback)"
[ -f "$HERE/fnkc-ctl.cjs" ] || die "fnkc-ctl.cjs not found next to this script"

command -v python3 >/dev/null || die "Python 3 is required for kernel-owned locks"
command -v docker >/dev/null || die "Docker is not installed (https://docs.docker.com/engine/install/)"
docker info >/dev/null 2>&1 || die "Docker is not running (systemctl enable --now docker)"
command -v gh >/dev/null || die "GitHub CLI is required to verify offline image attestations (https://cli.github.com/)"
getent group docker >/dev/null || die "there is no docker group"

NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "Node.js is not installed (22.18 or newer; e.g. https://nodejs.org or the NodeSource packages)"
"$NODE" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 18)) process.exit(1)' \
  || die "Node.js 22.18 or newer is required"

# The whole new release is staged and checked before anything switches to it
new="$(stage "$HERE" "${FILES[@]}")" || die "could not stage the release in $PREFIX/releases (disk full?); nothing changed"
old="$(active_release)"
if [ -z "$old" ] && [ -f "$PREFIX/fnkc-ctl.cjs" ] && [ ! -L "$PREFIX/fnkc-ctl.cjs" ]; then
  # Files of an installer from before releases: kept as a release of their own for --rollback, if complete
  present=()
  for f in "${FILES[@]}"; do [ ! -f "$PREFIX/$f" ] || present+=("$f"); done
  if ! old="$(stage "$PREFIX" "${present[@]}")"; then
    old=''
    printf 'Warning: %s\n' "the installed files in $PREFIX are incomplete: there will be no previous release to roll back to" >&2
  fi
fi
if [ "$old" = "$new" ]; then
  say "fnkc-ctl $(version_of "$new/fnkc-ctl.cjs") is installed already (release ${new##*/}); checking the rest of the setup"
else
  # The previous release is recorded before the new one is activated, so --rollback always has a complete one
  if [ -n "$old" ]; then
    say "Keeping fnkc-ctl $(version_of "$old/fnkc-ctl.cjs") as the previous release (sudo $PREFIX/install.sh --rollback)"
  fi
  say "Installing fnkc-ctl $(version_of "$new/fnkc-ctl.cjs") (release ${new##*/})"
  switch_to "releases/${new##*/}" "${old:+releases/${old##*/}}"
fi
# Fixed links through current (the first time, they replace the plain files of an installer from before releases)
for f in "${LINKED[@]}"; do [ "$(readlink "$PREFIX/$f" 2>/dev/null)" = "current/$f" ] || relink "$PREFIX/$f" "current/$f"; done
put "$HERE/install.sh" "$PREFIX/install.sh"
# Only the active and the previous release are kept
keep_cur="$(release_of current)"; keep_prev="$(release_of previous-release)"
for d in "$PREFIX/releases/"* "$PREFIX/releases/".staging.*; do
  if [ -e "$d" ] && [ "$d" != "$keep_cur" ] && [ "$d" != "$keep_prev" ]; then rm -rf -- "$d"; fi
done
# The previous files of an installer from before releases (possibly a mixed set): replaced by previous-release
if [ -d "$PREFIX/previous" ]; then rm -rf -- "$PREFIX/previous"; fi
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
