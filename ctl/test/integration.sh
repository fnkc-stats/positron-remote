#!/usr/bin/env bash
# The integration tests of CI's ctl-checks.yml, in the same order, against one image (default: the environment the
# project template pins). CI runs this script; run it before pushing a change to fnkc-ctl, the container scripts or
# the server bundle. Needs Docker, Node 22.18+, Python 3, git-crypt and GnuPG. On non-Linux hosts install restic 0.17+ for the backup fixture. Every test uses throwaway containers,
# volumes, keys and homes, and cleans up after itself.
#   ctl/test/integration.sh [<image>]
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
image="${1:-$(jq -r .image project-template/container.json)}"
for tool in docker node python3 git-crypt gpg jq; do command -v "$tool" >/dev/null || { echo "integration: $tool is required" >&2; exit 2; }; done
docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null
export FNKC_TEST_IMAGE="$image" FNKC_BACKUP_TEST_IMAGE="$image"
[ -d ctl/node_modules ] || npm ci --prefix ctl --silent --no-audit --no-fund
npm --prefix ctl run -s build:cli >/dev/null

step() { printf '\n==> %s\n' "$*"; "$@"; }
step python3 ctl/test/ssh-integration.py
step python3 ctl/test/backup-integration.py
step python3 ctl/test/restore-inspection-integration.py
step npm --prefix ctl run -s test:removal -- "$image"
step ctl/test/clone-integration.sh "$image"
step ctl/test/environment-integration.sh "$image"
step ctl/test/e2e.sh "$image"
printf '\nAll integration tests passed on %s\n' "$image"
