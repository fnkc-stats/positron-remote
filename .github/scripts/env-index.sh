#!/usr/bin/env bash
# Joins the environment images image.yml's architecture jobs built, checked and pushed into one multi-architecture
# index, by the digests those jobs recorded (never by looking up architecture tags: re-running only a failed leg or
# only this step gives the legs different run attempts, so their tags differ). Tested locally by
# ctl/test/env-index.test.ts with a fake docker.
#   .github/scripts/env-index.sh <image> <tag> <digest-dir> <description>
#     <digest-dir>/amd64 and <digest-dir>/arm64 each hold <image>@sha256:<digest>. Publishes the index as <image>:<tag>,
#     checks it holds exactly those two images and prints <image>@<index digest>. Needs docker buildx and jq.
set -euo pipefail
image="${1:?image}" tag="${2:?tag}" dir="${3:?digest directory}" description="${4:?description}"

refs=()
for arch in amd64 arm64; do
  [ -s "$dir/$arch" ] || { echo "no tested $arch image recorded in $dir (did its build job pass?)" >&2; exit 1; }
  ref="$(tr -d '[:space:]' < "$dir/$arch")"
  [[ "$ref" =~ ^${image//./\\.}@sha256:[0-9a-f]{64}$ ]] || { echo "unexpected $arch image '$ref' (want $image@sha256:<digest>)" >&2; exit 1; }
  refs+=("$ref")
done

# The registry shows a multi-architecture image's description from the index annotation
docker buildx imagetools create -t "$image:$tag" --annotation "index:org.opencontainers.image.description=$description" "${refs[@]}"
digest="$(docker buildx imagetools inspect "$image:$tag" --format '{{json .Manifest}}' | jq -er .digest)"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "no index digest for $image:$tag" >&2; exit 1; }
# The index holds exactly the images the build jobs tested
docker buildx imagetools inspect "$image@$digest" --raw \
  | jq -e --arg a "${refs[0]#*@}" --arg b "${refs[1]#*@}" \
    '[.manifests[] | select(.platform.os == "linux") | .digest] | sort == ([$a, $b] | sort)' >/dev/null \
  || { echo "$image@$digest does not hold exactly the tested images ${refs[*]}" >&2; exit 1; }
echo "$image@$digest"
