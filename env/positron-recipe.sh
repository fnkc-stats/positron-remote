#!/usr/bin/env bash
# The recipe of a runnable image: a hash of what it is made from besides its environment (which is in its tag), that
# is env/positron.Dockerfile and the server's build arguments (env/positron.args format, read from stdin; blank lines
# and order do not count). positron.yml records it as the positron.recipe label and reuses a published image only if
# it matches; image.yml uses the same rule to run its SSH tests on the published image instead of building the layer.
#   env/positron-recipe.sh < env/positron.args
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
{ sha256sum < "$here/positron.Dockerfile"; grep -v '^[[:space:]]*$' | LC_ALL=C sort; } | sha256sum | cut -c1-64
