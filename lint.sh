#!/usr/bin/env bash
# Проверки перед коммитом (и в CI): shell-скрипты, GitHub Actions workflows, Dockerfile.
#
#   ./lint.sh                  проверить весь репозиторий
#   ./lint.sh --install-hook   включить запуск перед каждым коммитом (git config core.hooksPath .githooks)
#
# Инструменты: shellcheck, actionlint, hadolint (brew install shellcheck actionlint hadolint).
# Если инструмента нет, он запускается из Docker-образа с зафиксированной версией.
set -uo pipefail
cd "$(dirname "$0")" || exit 2

if [ "${1:-}" = --install-hook ]; then
  git config core.hooksPath .githooks && echo "pre-commit включён: .githooks/pre-commit -> ./lint.sh"
  exit $?
fi

SHELLCHECK_IMAGE=koalaman/shellcheck:v0.11.0
ACTIONLINT_IMAGE=rhysd/actionlint:1.7.12
HADOLINT_IMAGE=hadolint/hadolint:v2.14.0

# tool <имя> <образ> <аргументы>: локальный бинарник или тот же инструмент в Docker
tool() {
  local name="$1" image="$2"; shift 2
  if command -v "$name" >/dev/null 2>&1; then
    "$name" "$@"
  elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker run --rm -i -v "$PWD:/repo:ro" -w /repo --entrypoint "$name" "$image" "$@"
  else
    echo "  нет $name и Docker не запущен: brew install $name" >&2
    return 1
  fi
}

failed=""
check() {  # check <название> <команда...>
  local title="$1"; shift
  printf '\033[1;34m==>\033[0m %s\n' "$title"
  if ! "$@"; then failed="$failed $title;"; fi
}

# Файлы из git (отслеживаемые и новые, кроме игнорируемых): проверяется то, что попадёт в репозиторий
files() { git ls-files --cached --others --exclude-standard "$@" | while read -r f; do [ -f "$f" ] && echo "$f"; done; }

# Shell-скрипты: *.sh, файлы с shebang sh/bash и файлы с директивой shellcheck shell=
SHELL_FILES=()
while read -r f; do
  case "$f" in
    *.sh) SHELL_FILES+=("$f") ;;
    *) head -n 1 "$f" 2>/dev/null | grep -qE '^#!.*(/|env )(ba)?sh( |$)|^# shellcheck shell=' && SHELL_FILES+=("$f") ;;
  esac
done < <(files)
WORKFLOWS=(); while read -r f; do WORKFLOWS+=("$f"); done < <(files '.github/workflows/*.yml' '.github/workflows/*.yaml')
DOCKERFILES=(); while read -r f; do DOCKERFILES+=("$f"); done < <(files 'Dockerfile' '*/Dockerfile' '*.Dockerfile')

syntax() {
  local f rc=0
  for f in "${SHELL_FILES[@]}"; do
    if head -n 1 "$f" | grep -qE 'bash|shell=bash'; then bash -n "$f" || rc=1; else sh -n "$f" || rc=1; fi
  done
  return $rc
}

[ ${#SHELL_FILES[@]} -eq 0 ] || check "синтаксис shell (${#SHELL_FILES[@]})" syntax
[ ${#SHELL_FILES[@]} -eq 0 ] || check "shellcheck" tool shellcheck "$SHELLCHECK_IMAGE" -x -S warning "${SHELL_FILES[@]}"
[ ${#WORKFLOWS[@]} -eq 0 ]   || check "actionlint (${#WORKFLOWS[@]})" tool actionlint "$ACTIONLINT_IMAGE" "${WORKFLOWS[@]}"
[ ${#DOCKERFILES[@]} -eq 0 ] || check "hadolint (${#DOCKERFILES[@]})" tool hadolint "$HADOLINT_IMAGE" "${DOCKERFILES[@]}"

if [ -n "$failed" ]; then
  printf '\033[1;31mНе прошли проверки:\033[0m%s\n' "$failed" >&2
  echo "Исправьте замечания выше (пропустить разово: git commit --no-verify)" >&2
  exit 1
fi
printf '\033[1;32mВсе проверки пройдены\033[0m\n'
