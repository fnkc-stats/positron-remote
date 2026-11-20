#!/usr/bin/env bash
# The actual startup and snapshot scripts, synthetic data, no network, disposable container filesystem.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
image="${1:-$(node -p 'JSON.parse(require("fs").readFileSync("project-template/container.json")).image')}"
docker run --rm --network none --user 1000:1000 --memory 1g --cpus 2 --pids-limit 128 \
  --mount "type=bind,source=$root/ctl/container,target=/usr/local/lib/fnkc,readonly" \
  --mount "type=bind,source=$root/ctl/test/environment-integration.R,target=/tmp/test.R,readonly" \
  -e RENV_CONFIG_CONNECT_TIMEOUT=2 -e RENV_CONFIG_DOWNLOAD_TIMEOUT=2 -e R_DEFAULT_INTERNET_TIMEOUT=2 \
  --entrypoint Rscript "$image" --vanilla /tmp/test.R
