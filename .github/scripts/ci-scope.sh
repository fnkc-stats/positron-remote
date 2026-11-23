#!/usr/bin/env bash
# Select jobs for the commit checked out by Actions. The publisher uses the same
# release paths when deciding whether a newer commit supersedes this release.
set -euo pipefail

changed() {
  if git diff --quiet --no-renames "$base" "$head" -- "$@"; then
    echo false
  else
    local status=$?
    [ "$status" = 1 ] || return "$status"
    echo true
  fi
}

release_paths=(ctl lint.sh .github/workflows/extension.yml .github/workflows/ctl-checks.yml
  .github/workflows/lint.yml .github/scripts/ci-scope.sh)
if [ "${1:-}" = release-changed ]; then
  base="${2:?}" head="${3:?}"
  changed "${release_paths[@]}"
  exit
fi

base="${BASE_SHA:-}" head=HEAD
if [ "${GITHUB_EVENT_NAME:?}" = workflow_dispatch ]; then
  extension=false pin=false environment=false
  [ "${MANUAL_TARGET:-extension}" != extension ] || extension=true
elif [ -z "$base" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  extension=true pin=true environment=true
else
  if [ "$GITHUB_EVENT_NAME" = pull_request ]; then
    release_paths+=(.github/scripts/publish-release.sh)
  fi
  extension=$(changed "${release_paths[@]}")
  pin=$(changed project-template/container.json .github/workflows/r-checks.yml)
  # Unknown ctl paths retain image coverage. Only extension UI and its tests are excluded.
  environment=$(changed env checks ctl .github/workflows/env-image.yml .github/workflows/image.yml \
    .github/workflows/positron.yml .github/scripts/ci-scope.sh \
    ':(exclude)ctl/media' ':(exclude)ctl/src/extension.ts' ':(exclude)ctl/src/sidebar.ts' \
    ':(exclude)ctl/src/images-view.ts' ':(exclude)ctl/test/extension.test.ts' \
    ':(exclude)ctl/test/fake-vscode.ts' ':(exclude)ctl/test/sidebar.test.ts')
fi
printf 'extension=%s\npin=%s\nenvironment=%s\n' "$extension" "$pin" "$environment"
