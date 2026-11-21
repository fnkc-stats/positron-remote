#!/usr/bin/env bash
# Real image provenance, before a release: the published Positron image of the template pin and the team's Positron
# (positron-<version>-<pin digest>, the image Open starts) is verified as hosts verify it (npm run test:provenance:
# the client's proof from GitHub and the registry, then gh offline). Fails when that image is not published or not
# attested, so a pin without its Positron layer does not merge. CI: ctl-checks.yml. Needs Docker (buildx), gh, jq,
# Node 22.18+ and network access; GH_TOKEN avoids the anonymous API rate limit. Linux only: the host's gh binary
# runs inside a Linux container for the offline part.
#   ctl/test/provenance-pin.sh [<owner>/<repo>]
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
repository="${1:-${GITHUB_REPOSITORY:-fnkc-stats/positron-remote}}"
[ "$(uname -s)" = Linux ] || { echo "provenance-pin: Linux only (gh runs inside a Linux container); CI runs it" >&2; exit 2; }
for tool in docker gh jq node; do command -v "$tool" >/dev/null || { echo "provenance-pin: $tool is required" >&2; exit 2; }; done
pin="$(jq -r .image project-template/container.json)"
version="$(sed -n 's/^POSITRON_VERSION=//p' env/positron.args)"
[[ "$pin" == *@sha256:* && -n "$version" ]] || { echo "provenance-pin: no pin ($pin) or Positron version ($version)" >&2; exit 2; }
image="${pin%@*}"
tag="positron-$version-${pin##*sha256:}"
digest="$(docker buildx imagetools inspect "$image:$tag" --format '{{json .Manifest}}' | jq -er .digest)" \
  || { echo "provenance-pin: $image:$tag is not published: build it (positron.yml) before pinning $pin" >&2; exit 1; }
echo "provenance-pin: $image:$tag = $image@$digest"
[ -d ctl/node_modules ] || npm ci --prefix ctl --silent --no-audit --no-fund
npm --prefix ctl run -s test:provenance -- "$image@$digest" "$repository"
