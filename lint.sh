#!/usr/bin/env bash
# Checks before a commit (and in CI): shell scripts, GitHub Actions workflows, Dockerfiles,
# fnkc-ctl (TypeScript) and English-only text outside Markdown.
#
#   ./lint.sh                  check the whole repository
#   ./lint.sh --install-hook   run it before every commit (git config core.hooksPath .githooks)
#
# Tools: shellcheck, actionlint, hadolint (brew install shellcheck actionlint hadolint), node.
# If a tool is not installed, it runs from a Docker image with a pinned version.
set -uo pipefail
cd "$(dirname "$0")" || exit 2

if [ "${1:-}" = --install-hook ]; then
  git config core.hooksPath .githooks && echo "pre-commit enabled: .githooks/pre-commit -> ./lint.sh"
  exit $?
fi

SHELLCHECK_IMAGE=koalaman/shellcheck:v0.11.0
ACTIONLINT_IMAGE=rhysd/actionlint:1.7.12
HADOLINT_IMAGE=hadolint/hadolint:v2.14.0

# tool <name> <image> <args>: the local binary, or the same tool in Docker
tool() {
  local name="$1" image="$2"; shift 2
  if command -v "$name" >/dev/null 2>&1; then
    "$name" "$@"
  elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker run --rm -i -v "$PWD:/repo:ro" -w /repo --entrypoint "$name" "$image" "$@"
  else
    echo "  $name is not installed and Docker is not running: brew install $name" >&2
    return 1
  fi
}

failed=""
check() {  # check <title> <command...>
  local title="$1"; shift
  printf '\033[1;34m==>\033[0m %s\n' "$title"
  if ! "$@"; then failed="$failed $title;"; fi
}

# Files known to git (tracked and new, minus ignored): exactly what ends up in the repository
files() { git ls-files --cached --others --exclude-standard "$@" | while read -r f; do [ -f "$f" ] && echo "$f"; done; }

# Shell scripts: *.sh, files with an sh/bash shebang, and files with a shellcheck shell= directive
SHELL_FILES=()
while read -r f; do
  case "$f" in
    *.sh) SHELL_FILES+=("$f") ;;
    *) head -n 1 "$f" 2>/dev/null | grep -qE '^#!.*(/|env )(ba)?sh( |$)|^# shellcheck shell=' && SHELL_FILES+=("$f") ;;
  esac
done < <(files)
WORKFLOWS=(); while read -r f; do WORKFLOWS+=("$f"); done < <(files '.github/workflows/*.yml' '.github/workflows/*.yaml')
DOCKERFILES=(); while read -r f; do DOCKERFILES+=("$f"); done < <(files 'Dockerfile' '*/Dockerfile' '*.Dockerfile')
NON_MD=(); while read -r f; do case "$f" in *.md) ;; *) NON_MD+=("$f") ;; esac; done < <(files)

# fnkc-ctl (TypeScript): typecheck, unit tests, bundle
ctl_check() {
  command -v npm >/dev/null 2>&1 || { echo "  node is not installed: brew install node" >&2; return 1; }
  local out
  out="$(cd ctl && { [ -d node_modules ] || npm ci --silent --no-audit --no-fund; } && npm run -s check 2>&1)" \
    || { printf "%s\n" "$out"; return 1; }
}

syntax() {
  local f rc=0
  for f in "${SHELL_FILES[@]}"; do
    if head -n 1 "$f" | grep -qE 'bash|shell=bash'; then bash -n "$f" || rc=1; else sh -n "$f" || rc=1; fi
  done
  return $rc
}

# Code, configs and comments are English only; Markdown documents may be in any language
english_only() {
  perl -CSD -ne 'if (/\p{Cyrillic}/) { print "$ARGV:$.: $_"; $bad = 1 } close ARGV if eof; END { exit($bad ? 1 : 0) }' "$@"
}

[ ${#SHELL_FILES[@]} -eq 0 ] || check "shell syntax (${#SHELL_FILES[@]})" syntax
[ ${#SHELL_FILES[@]} -eq 0 ] || check "shellcheck" tool shellcheck "$SHELLCHECK_IMAGE" -x -S warning "${SHELL_FILES[@]}"
[ ${#WORKFLOWS[@]} -eq 0 ]   || check "actionlint (${#WORKFLOWS[@]})" tool actionlint "$ACTIONLINT_IMAGE" "${WORKFLOWS[@]}"
[ ${#DOCKERFILES[@]} -eq 0 ] || check "hadolint (${#DOCKERFILES[@]})" tool hadolint "$HADOLINT_IMAGE" "${DOCKERFILES[@]}"
[ ${#NON_MD[@]} -eq 0 ]      || check "English only outside *.md (${#NON_MD[@]})" english_only "${NON_MD[@]}"
check "fnkc-ctl (typecheck, tests, build)" ctl_check

if [ -n "$failed" ]; then
  printf '\033[1;31mFailed checks:\033[0m%s\n' "$failed" >&2
  echo "Fix the issues above (to skip once: git commit --no-verify)" >&2
  exit 1
fi
printf '\033[1;32mAll checks passed\033[0m\n'
