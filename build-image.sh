#!/usr/bin/env bash
# Собирает слой Positron поверх образа окружения: <ENV_IMAGE>-positron-<версия>.
#
# Использование:
#   ./build-image.sh [local|latest|<версия>] [--env <образ>] [--host <имя>] [--push] [--force] [--prepare-only]
#     local           версия Positron, установленного на этой машине (по умолчанию)
#     latest          последний релиз posit-dev/positron
#     <версия>        например 2026.07.1-5 (Help → About)
#     --env <образ>   образ окружения с тегом, например ghcr.io/<owner>/r-env:2026.11.16-abc1234
#                     (по умолчанию DEFAULT_ENV_IMAGE из positron.env)
#     --host <имя>    на каком Docker-хосте собирать (по умолчанию local; см. HOSTS)
#     --push          отправить готовый образ в реестр
#     --force         пересобрать, даже если образ уже есть
#     --prepare-only  только скачать и подготовить контекст сборки, без Docker
#
# Архив сервера скачивается на этой машине; в Dockerfile только ADD, поэтому собирать можно
# и на демоне без интернета (нужен лишь образ окружения, его скрипт скачает или перенесёт).
# Обычно этот скрипт вызывает run-positron.sh или CI (.github/workflows/positron-image.yml).
set -euo pipefail
. "$(dirname "$0")/lib.sh"

VERSION_ARG=local PREPARE_ONLY=0 FORCE=0 PUSH=0 ENV_IMAGE="$DEFAULT_ENV_IMAGE" BUILD_HOST=local
while [ $# -gt 0 ]; do
  case "$1" in
    --prepare-only) PREPARE_ONLY=1 ;;
    --force) FORCE=1 ;;
    --push) PUSH=1 ;;
    --env) ENV_IMAGE="${2:?после --env нужен образ}"; shift ;;
    --host) BUILD_HOST="${2:?после --host нужно имя хоста}"; shift ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    -*) die "неизвестный флаг $1" ;;
    *) VERSION_ARG="$1" ;;
  esac
  shift
done

need curl; need jq; need tar
check_env_image "$ENV_IMAGE"
VERSION="$(resolve_version "$VERSION_ARG")"
TAG="$(positron_tag "$ENV_IMAGE" "$VERSION")"
log "Positron $VERSION поверх $ENV_IMAGE"

if [ "$PREPARE_ONLY" = 0 ]; then
  need docker "brew install docker"
  check_host "$BUILD_HOST"
  host_up "$BUILD_HOST" || die "хост '$BUILD_HOST' недоступен"
  if [ "$FORCE" = 0 ]; then
    if has_image "$BUILD_HOST" "$TAG"; then
      log "Образ $TAG уже есть на '$BUILD_HOST', сборка не нужна (--force для пересборки)"
      [ "$PUSH" = 0 ] || hdocker "$BUILD_HOST" push -q "$TAG"
      exit 0
    fi
    # Уже в реестре: достаточно доставить его на хост; собираем, только если это не удалось
    if [ "$PUSH" = 1 ] && hdocker "$BUILD_HOST" manifest inspect "$TAG" >/dev/null 2>&1; then
      if ensure_image "$BUILD_HOST" "$TAG"; then
        log "Образ $TAG уже есть в реестре, сборка не нужна (--force для пересборки)"
        exit 0
      fi
      warn "$TAG есть в реестре, но на '$BUILD_HOST' его не доставить — собираю на месте"
    fi
  fi
  ensure_image "$BUILD_HOST" "$ENV_IMAGE" \
    || die "образ окружения $ENV_IMAGE недоступен на '$BUILD_HOST' (нет в реестре? docker login ghcr.io?)"
fi

# --- 1. Скачивание архива (с докачкой)
subst() { local ph="\${$1}"; URL="${URL//"$ph"/$2}"; }
URL="$POSITRON_REH_URL_TEMPLATE"
subst quality "$POSITRON_QUALITY"
subst version "$VERSION"
subst os linux
subst arch-long "$ARCH_LONG"
subst arch "$ARCH"
[[ "$URL" != *'${'* ]] || die "в URL остался неподставленный плейсхолдер: $URL"

DL_DIR="$CACHE_DIR/downloads"; mkdir -p "$DL_DIR"
ARCHIVE="$DL_DIR/positron-reh-linux-$ARCH-$VERSION.tar.gz"
if [ ! -f "$ARCHIVE" ]; then
  log "Скачиваю $URL"
  curl -fL --progress-bar --retry 3 --connect-timeout 15 -C - -o "$ARCHIVE.part" "$URL" \
    || die "не удалось скачать архив (проверьте версию: $VERSION)"
  mv "$ARCHIVE.part" "$ARCHIVE"
else
  log "Архив уже скачан: $ARCHIVE"
fi

# --- 2. Распаковка и проверка
CTX="$CACHE_DIR/build/$VERSION-$ARCH"
STAGE="$CTX/stage"
rm -rf "$CTX"; mkdir -p "$STAGE"
log "Распаковываю"
tar -xzf "$ARCHIVE" -C "$STAGE" --strip-components=1 || { rm -f "$ARCHIVE"; die "архив повреждён, удалён; запустите ещё раз"; }

PJ="$STAGE/product.json"
[ -f "$PJ" ] || die "в архиве нет product.json"
COMMIT="$(jq -r .commit "$PJ")"
APP_NAME="$(jq -r '.serverApplicationName // "positron-server"' "$PJ")"
ARCHIVE_VERSION="$(jq -r '"\(.positronVersion)-\(.positronBuildNumber)"' "$PJ")"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "некорректный commit в product.json: $COMMIT"
[ "$ARCHIVE_VERSION" = "$VERSION" ] || die "версия в архиве ($ARCHIVE_VERSION) не совпадает с запрошенной ($VERSION)"
[ -x "$STAGE/bin/$APP_NAME" ] || die "в архиве нет исполняемого bin/$APP_NAME"

# Для версии локального клиента дополнительно сверяем commit
if [ "$VERSION" = "$(local_positron_version 2>/dev/null || true)" ]; then
  LOCAL_COMMIT="$(jq -r .commit "$POSITRON_APP/Contents/Resources/app/product.json")"
  [ "$LOCAL_COMMIT" = "$COMMIT" ] || die "commit сервера ($COMMIT) != commit клиента ($LOCAL_COMMIT)"
  log "Commit совпадает с локальным клиентом"
fi

# Раскладка, которую ждёт Remote SSH: ~/.positron-server/bin/<commit>/bin/<serverApplicationName>.
# data/ и extensions/ создаются заранее: на них монтируются тома, и с владельцем analyst
# новый том получает правильные права. Перепаковка в tar.gz с владельцем в заголовках:
# контекст сборки ~3x меньше распакованного (важно при сборке на удалённом хосте),
# а ADD распакует его с этими uid:gid.
mkdir -p "$CTX/data/bin" "$CTX/data/data" "$CTX/data/extensions"
mv "$STAGE" "$CTX/data/bin/$COMMIT"
log "Упаковываю контекст сборки"
if tar --version 2>/dev/null | grep -q bsdtar; then
  COPYFILE_DISABLE=1 tar -czf "$CTX/server.tar.gz" -C "$CTX/data" \
    --uid "$POSITRON_UID" --gid "$POSITRON_GID" --no-xattrs --no-mac-metadata --no-acls .
else
  tar -czf "$CTX/server.tar.gz" -C "$CTX/data" \
    --numeric-owner --owner "$POSITRON_UID" --group "$POSITRON_GID" .
fi
rm -rf "$CTX/data"
install -m 0755 "$ROOT/positron/positron-entrypoint" "$ROOT/positron/positron-projects" "$CTX/"
log "Контекст сборки: $CTX ($(du -h "$CTX/server.tar.gz" | cut -f1), commit $COMMIT)"

if [ "$PREPARE_ONLY" = 1 ]; then
  echo "$CTX"
  exit 0
fi

# --- 3. Сборка
log "Собираю $TAG на '$BUILD_HOST'"
hdocker "$BUILD_HOST" build \
  --platform "$DOCKER_PLATFORM" \
  -f "$ROOT/positron/Dockerfile" \
  --build-arg ENV_IMAGE="$ENV_IMAGE" \
  --build-arg POSITRON_VERSION="$VERSION" \
  --build-arg POSITRON_COMMIT="$COMMIT" \
  -t "$TAG" \
  "$CTX"
rm -rf "$CTX"

if [ "$PUSH" = 1 ]; then
  log "Отправляю $TAG в реестр"
  hdocker "$BUILD_HOST" push -q "$TAG"
fi
log "Готово: $TAG"
