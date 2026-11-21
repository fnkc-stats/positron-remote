#!/usr/bin/env bash
# Runs CI's jobs on this computer, with the same scripts CI calls, so a failure shows up before a push:
#   ./ci-local.sh quick                 lint.yml / ctl-checks "checks" / windows-client: ./lint.sh (static checks,
#                                       typecheck, unit tests including the Windows ones, build) and npm audit
#   ./ci-local.sh integration [image]   ctl-checks "integration": ctl/test/integration.sh (Docker; ~15 minutes)
#   ./ci-local.sh image <series>        image.yml for one R series, this computer's architecture: env/build.sh, then
#                                       env/check-image.sh (Docker; an hour or more for a new environment)
#   ./ci-local.sh all [image]           quick, then integration
# What only CI can do: the other architecture, publishing to the registry, attestations, releases.
set -euo pipefail
cd "$(dirname "$0")"
quick() {
  ./lint.sh
  npm audit --prefix ctl --audit-level=critical || { echo "npm audit needs the network; CI runs it too" >&2; return 1; }
}
case "${1:-}" in
  quick) quick ;;
  integration) shift; ctl/test/integration.sh "$@" ;;
  image)
    series="${2:?usage: ./ci-local.sh image <series>}"
    env/build.sh "$series"
    env/check-image.sh "r-env:$series-env" --out "${TMPDIR:-/tmp}/r-checks-$series"
    ;;
  all) shift; quick; ctl/test/integration.sh "$@" ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
