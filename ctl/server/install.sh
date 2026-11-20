#!/usr/bin/env bash
# Installs fnkc-ctl on a Linux server. Run as root from the unpacked bundle (npm run server-bundle):
#   tar -xzf fnkc-ctl-server.tar.gz && sudo ./fnkc-ctl-server/install.sh
# Safe to run again (e.g. to update fnkc-ctl): existing settings and users are kept.
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

say() { printf '==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (sudo $0)"
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

say "Installing $PREFIX/fnkc-ctl.cjs"
install -d -m 0755 "$PREFIX"
install -m 0755 "$HERE/fnkc-ctl.cjs" "$PREFIX/fnkc-ctl.cjs"
install -m 0755 "$HERE/volume-backup.sh" "$HERE/render-reviewed.py" "$HERE/refresh-trust-root.sh" "$PREFIX/"
# For admins: fnkc-ctl admin ..., fnkc-ctl agent list --user <name>
printf '#!/bin/sh\nexec %s %s/fnkc-ctl.cjs "$@"\n' "$NODE" "$PREFIX" > /usr/local/bin/fnkc-ctl
chmod 0755 /usr/local/bin/fnkc-ctl

install -d -m 0755 "$ETC" "$ETC/keys"
say "Installing GitHub's Sigstore trust root for offline provenance checks"
"$PREFIX/refresh-trust-root.sh" "$ETC/trusted-root.jsonl" >/dev/null || die "could not download GitHub's attestation trust root"
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
"$NODE" - "$ETC/agent.json" <<'JS'
const fs = require('node:fs');
const file = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
cfg.lockDir = '/var/lib/fnkc-ctl/locks';
cfg.imageStagingDir ??= '/var/lib/fnkc-ctl/images';
cfg.verifiedDir ??= '/var/lib/fnkc-ctl/verified';
cfg.allowedImages = (cfg.allowedImages ?? ['ghcr.io/fnkc-stats/r-env']).map(p => p === 'ghcr.io/fnkc-stats/' ? 'ghcr.io/fnkc-stats/r-env' : p);
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
JS

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

cat <<EOF

Done. Next:
  1. Edit $ETC/agent.json if needed (allowedImages, limits, idleMinutes).
  2. Add users:  fnkc-ctl admin add-user anna /path/to/anna.pub
     (names: lowercase letters and digits; the key is the one they use for Gitea)
  3. In their Positron settings (FNKC Projects -> Hosts): { "name": "server", "ssh": "$ACCOUNT@$(hostname -f 2>/dev/null || hostname)" }
EOF
