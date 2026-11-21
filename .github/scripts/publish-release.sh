#!/usr/bin/env bash
# Publishes the extension release of this commit (extension.yml, on main): fnkc-projects-v$VERSION with the files in
# $DIST. Tested locally by ctl/test/release.test.ts with a fake gh and throwaway git repositories.
#   VERSION=0.4.40 GITHUB_SHA=<commit> .github/scripts/publish-release.sh
# Environment: VERSION, GITHUB_SHA (the commit to release); DIST (default ctl/dist); GITHUB_STEP_SUMMARY (optional);
# RETRY_SECONDS (default 30, between attempts). Needs gh (logged in, or GH_TOKEN) and git with an origin.
set -euo pipefail
: "${VERSION:?}" "${GITHUB_SHA:?}"
DIST="${DIST:-ctl/dist}"
tag="fnkc-projects-v$VERSION"
# The paths whose change starts extension.yml on main (its on.push.paths; the test keeps the two lists equal)
RELEASE_PATHS=(ctl .github/workflows/extension.yml .github/workflows/ctl-checks.yml .github/workflows/windows-client.yml lint.sh)
FILES=(fnkc-projects.vsix fnkc-projects.vsix.sha256 fnkc-ctl-server.tar.gz fnkc-ctl-server.tar.gz.sha256 fnkc-projects-compat.json)
say() { echo "$*"; [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "$*" >> "$GITHUB_STEP_SUMMARY"; }

# A re-run of a published run has the same version: its release exists already
if gh release view "$tag" >/dev/null 2>&1; then say "Release $tag exists already (re-run): nothing to publish"; exit 0; fi

# Superseded: main moved on while this run built, and the newer commits change what a release contains, so their own
# run publishes a newer release with these changes too. Only the newest commit is released. (Runs of superseded
# commits were also the ones GitHub refused to create a release for, with HTTP 403.)
git fetch -q origin main
head="$(git rev-parse FETCH_HEAD)"
if [ "$head" != "$GITHUB_SHA" ] && [ -n "$(git diff --name-only "$GITHUB_SHA" "$head" -- "${RELEASE_PATHS[@]}")" ]; then
  say "Not released: main is at ${head:0:12}, whose run releases these changes with its own"
  exit 0
fi

previous="$(gh release view --json tagName --jq .tagName 2>/dev/null || true)"
notes="$(mktemp)"
trap 'rm -f "$notes"' EXIT
{
  echo "Install: Positron → Extensions → … → Install from VSIX, or update from the extension (FNKC Projects: Check for Updates)."
  echo
  if [ -n "$previous" ] && git rev-parse -q --verify "refs/tags/$previous" >/dev/null; then
    echo "Changes since $previous:"
    git log --no-merges --format='- %s (%h)' "$previous..$GITHUB_SHA" -- ctl
  else
    echo "First release."
  fi
} > "$notes"

# Only a version newer than the current latest release becomes "latest" (what installed extensions update to)
latest=true
if [ -n "$previous" ] && [ "$(printf '%s\n%s\n' "${previous#fnkc-projects-v}" "$VERSION" | sort -V | tail -n1)" != "$VERSION" ]; then
  latest=false
  say "$tag is older than $previous: published, not marked latest"
fi

cd "$DIST"
# Retries, and completes a release that was created but did not get all its files
for attempt in 1 2 3; do
  if gh release view "$tag" >/dev/null 2>&1; then
    gh release upload "$tag" --clobber "${FILES[@]}" && break
  elif gh release create "$tag" --target "$GITHUB_SHA" --title "FNKC Projects $VERSION" --notes-file "$notes" \
    --latest="$latest" "${FILES[@]}"; then
    break
  fi
  [ "$attempt" -lt 3 ] || { say "Release $tag could not be published (3 attempts)"; exit 1; }
  echo "attempt $attempt failed; retrying in ${RETRY_SECONDS:-30} seconds"
  sleep "${RETRY_SECONDS:-30}"
done
say "Released [FNKC Projects $VERSION](${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/releases/tag/$tag)"
