#!/usr/bin/env bash
# Installs positron-ctl on a Linux server. Run as root from the unpacked bundle (npm run server-bundle):
#   tar -xzf positron-ctl-server.tar.gz && sudo ./positron-ctl-server/install.sh
# Safe to run again (e.g. to update positron-ctl): existing settings and users are kept.
#
# What it sets up:
#   /opt/positron-ctl/positron-ctl.cjs     the program (also as the positron-ctl command for admins)
#   /etc/positron-ctl/agent.json           rules: allowed images, limits, idle time (created once)
#   /etc/positron-ctl/keys/                users' public keys (positron-ctl admin add-user)
#   account "positron" in group docker     users log in as it; their key only runs the agent
# Requirements: Docker Engine and Node.js 20 or newer.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ACCOUNT="${POSITRON_ACCOUNT:-positron}"
PREFIX=/opt/positron-ctl
ETC=/etc/positron-ctl

say() { printf '==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (sudo $0)"
[ -f "$HERE/positron-ctl.cjs" ] || die "positron-ctl.cjs not found next to this script"

command -v docker >/dev/null || die "Docker is not installed (https://docs.docker.com/engine/install/)"
docker info >/dev/null 2>&1 || die "Docker is not running (systemctl enable --now docker)"
getent group docker >/dev/null || die "there is no docker group"

NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "Node.js is not installed (20 or newer; e.g. https://nodejs.org or the NodeSource packages)"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js $("$NODE" --version) is too old, 20 or newer is needed"

say "Installing $PREFIX/positron-ctl.cjs"
install -d -m 0755 "$PREFIX"
install -m 0755 "$HERE/positron-ctl.cjs" "$PREFIX/positron-ctl.cjs"
# For admins: positron-ctl admin ..., positron-ctl agent list --user <name>
printf '#!/bin/sh\nexec %s %s/positron-ctl.cjs "$@"\n' "$NODE" "$PREFIX" > /usr/local/bin/positron-ctl
chmod 0755 /usr/local/bin/positron-ctl

install -d -m 0755 "$ETC" "$ETC/keys"
if [ ! -f "$ETC/agent.json" ]; then
  say "Creating $ETC/agent.json (edit: allowed images, limits, idle time)"
  install -m 0644 "$HERE/agent.example.json" "$ETC/agent.json"
else
  say "Keeping the existing $ETC/agent.json"
fi

if ! id "$ACCOUNT" >/dev/null 2>&1; then
  say "Creating the account '$ACCOUNT' (no password; only keys added with positron-ctl admin)"
  useradd --system --create-home --shell /bin/sh "$ACCOUNT"
fi
usermod -a -G docker "$ACCOUNT"
HOME_DIR="$(getent passwd "$ACCOUNT" | cut -d: -f6)"
install -d -m 0700 -o "$ACCOUNT" -g "$ACCOUNT" "$HOME_DIR/.ssh"

# The forced command in authorized_keys names the node binary; refresh it if Node.js moved
if [ -f "$HOME_DIR/.ssh/authorized_keys" ]; then
  sed -i -E "s#command=\"[^ \"]+ $PREFIX/positron-ctl.cjs #command=\"$NODE $PREFIX/positron-ctl.cjs #" "$HOME_DIR/.ssh/authorized_keys"
fi

# Positron reaches containers through this account (ProxyJump), so sshd must allow it and TCP forwarding
if command -v sshd >/dev/null; then
  EFFECTIVE="$(sshd -T -C "user=$ACCOUNT,host=localhost,addr=127.0.0.1" 2>/dev/null || true)"
  if printf '%s\n' "$EFFECTIVE" | grep -qiE '^allowtcpforwarding (no|remote)$'; then
    say "WARNING: sshd has AllowTcpForwarding off for $ACCOUNT; Positron cannot reach containers through it"
  fi
  if printf '%s\n' "$EFFECTIVE" | grep -qiE '^allow(users|groups) ' \
     && ! printf '%s\n' "$EFFECTIVE" | grep -iE '^allow(users|groups) ' | grep -qw "$ACCOUNT"; then
    say "WARNING: sshd's AllowUsers/AllowGroups may not include $ACCOUNT; add it so users can log in"
  fi
fi

say "Checking the agent"
sudo -u "$ACCOUNT" "$NODE" "$PREFIX/positron-ctl.cjs" agent ping --user check >/dev/null \
  || die "the agent does not run as $ACCOUNT"
sudo -u "$ACCOUNT" docker info >/dev/null 2>&1 \
  || die "$ACCOUNT cannot use Docker (group membership applies to new logins; check the docker socket's group)"

cat <<EOF

Done. Next:
  1. Edit $ETC/agent.json if needed (allowedImages, limits, idleMinutes).
  2. Add users:  positron-ctl admin add-user anna /path/to/anna.pub
     (names: lowercase letters and digits; the key is the one they use for Gitea)
  3. In their Positron settings (Positron Projects -> Hosts): { "name": "server", "ssh": "$ACCOUNT@$(hostname -f 2>/dev/null || hostname)" }
EOF
