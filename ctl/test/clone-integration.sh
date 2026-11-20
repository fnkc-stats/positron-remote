#!/usr/bin/env bash
# Crash during promotion, retry without clobbering already-promoted work.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
image="${1:?image required}"
docker run --rm -i --network none --user 1000:1000 --memory 512m --pids-limit 128 \
  --mount "type=bind,source=$root/ctl/container/fnkc-projects.sh,target=/tmp/projects,readonly" \
  --entrypoint bash "$image" -s <<'TEST'
set -eu
cd /home/analyst
mkdir source fixture bin
git -C source init -q -b main
git -C source config user.email fixture@example.invalid
git -C source config user.name Fixture
printf 'original\n' > source/analysis.R
printf '{}\n' > source/container.json
git -C source add .
git -C source commit -qm fixture
revision="$(git -C source rev-parse HEAD)"
cat > bin/mv <<'WRAPPER'
#!/bin/sh
/bin/mv "$@"
kill -KILL "$PPID"
WRAPPER
chmod +x bin/mv
if PATH="/home/analyst/bin:$PATH" /tmp/projects init fixture "$revision" /home/analyst/source; then
  echo 'expected interrupted initialization' >&2; exit 1
fi
test -d fixture/.fnkc-init
test -d fixture/.git
# This new user file must survive retry unchanged.
printf 'keep me\n' > fixture/notes.txt
/tmp/projects init fixture "$revision" /home/analyst/source
test "$(cat fixture/notes.txt)" = 'keep me'
test "$(cat fixture/analysis.R)" = original
test ! -e fixture/.fnkc-init
/tmp/projects init fixture "$revision" /home/analyst/source
printf 'PASS: killed clone promotion resumes, user files survive, repeated initialization is idempotent\n'
TEST
