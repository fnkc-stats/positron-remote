# Общие функции для скриптов этого репозитория (подключается через source).
# Совместимо с bash 3.2 (macOS): без ассоциативных массивов.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE_DIR="${CACHE_DIR:-$ROOT/.cache}"

# Конфиг: переменные окружения имеют приоритет над positron.env
_CONFIG_VARS="REGISTRY DEFAULT_ENV_IMAGE HOSTS NO_REGISTRY_HOSTS ARCH POSITRON_QUALITY POSITRON_APP
  POSITRON_REH_URL_TEMPLATE GIT_REMOTES SSH_PUBLIC_KEY_FILE SSH_TIMEOUT GIT_CRYPT_KEY_FILE PUSH_BUILT"
if [ -f "$ROOT/positron.env" ]; then
  _saved=""
  for _v in $_CONFIG_VARS; do
    if [ -n "${!_v+x}" ]; then _saved="$_saved$_v=$(printf '%q' "${!_v}")"$'\n'; fi
  done
  # shellcheck disable=SC1091
  . "$ROOT/positron.env"
  eval "$_saved"
  unset _saved _v
fi

REGISTRY="${REGISTRY:-ghcr.io/fnkc-stats}"
DEFAULT_ENV_IMAGE="${DEFAULT_ENV_IMAGE:-}"
HOSTS="${HOSTS:-local}"
NO_REGISTRY_HOSTS="${NO_REGISTRY_HOSTS:-}"
ARCH="${ARCH:-x64}"
POSITRON_QUALITY="${POSITRON_QUALITY:-releases}"
POSITRON_APP="${POSITRON_APP:-/Applications/Positron.app}"
GIT_REMOTES="${GIT_REMOTES:-}"
SSH_TIMEOUT="${SSH_TIMEOUT:-5}"
GIT_CRYPT_KEY_FILE="${GIT_CRYPT_KEY_FILE:-}"
PUSH_BUILT="${PUSH_BUILT:-0}"
if [ -z "${SSH_PUBLIC_KEY_FILE:-}" ]; then
  for _k in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_ecdsa.pub" "$HOME/.ssh/id_rsa.pub"; do
    [ -f "$_k" ] && { SSH_PUBLIC_KEY_FILE="$_k"; break; }
  done
  unset _k
fi
# Тот же шаблон, что по умолчанию в remoteSSH.serverDownloadUrlTemplate
_DEFAULT_URL_TEMPLATE='https://cdn.posit.co/positron/${quality}/reh/${arch-long}/positron-reh-${os}-${arch}-${version}.tar.gz'
POSITRON_REH_URL_TEMPLATE="${POSITRON_REH_URL_TEMPLATE:-$_DEFAULT_URL_TEMPLATE}"

# Пользователь внутри контейнера; создаётся в env/Dockerfile, менять согласованно
POSITRON_USER=analyst
POSITRON_UID=1000
POSITRON_GID=1000
POSITRON_HOME="/home/$POSITRON_USER"
SERVER_DATA_DIR="$POSITRON_HOME/.positron-server"
WORK_DIR="$POSITRON_HOME/work"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33mВнимание:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mОшибка:\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "не найдена команда '$1'${2:+ ($2)}"; }

case "$ARCH" in
  x64)   ARCH_LONG=x86_64; DOCKER_PLATFORM=linux/amd64 ;;
  arm64) ARCH_LONG=arm64;  DOCKER_PLATFORM=linux/arm64 ;;
  *) die "ARCH должен быть x64 или arm64, а не '$ARCH'" ;;
esac

# --- Версии Positron

# Версия клиента Positron, установленного на этой машине: <positronVersion>-<buildNumber>
local_positron_version() {
  local pj="$POSITRON_APP/Contents/Resources/app/product.json"
  [ -f "$pj" ] || die "не найден $pj (укажите версию явно или POSITRON_APP)"
  jq -r '"\(.positronVersion)-\(.positronBuildNumber)"' "$pj"
}

latest_positron_version() {
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh release view --repo posit-dev/positron --json tagName -q .tagName
  else
    curl -fsSL https://api.github.com/repos/posit-dev/positron/releases/latest | jq -r .tag_name
  fi
}

# Аргумент: local (по умолчанию) | latest | конкретная версия вида 2026.07.1-5
resolve_version() {
  local v="${1:-local}"
  case "$v" in
    local)  v="$(local_positron_version)" ;;
    latest) v="$(latest_positron_version)" ;;
  esac
  [[ "$v" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]+-[0-9]+$ ]] || die "непохоже на версию Positron: '$v' (ожидается вида 2026.07.1-5)"
  printf '%s\n' "$v"
}

# --- Образы

# Образ окружения должен быть с явным тегом: по нему строится тег Positron-образа и он фиксирует зависимости
check_env_image() {
  local img="$1" last="${1##*/}"
  [ -n "$img" ] || die "не задан образ окружения (ENV_IMAGE в container.env проекта или DEFAULT_ENV_IMAGE)"
  [[ "$img" != *@* ]] || die "ENV_IMAGE задан по digest, нужен тег: $img"
  [[ "$last" == *:* ]] || die "у ENV_IMAGE нет тега: $img"
  [[ "${last##*:}" != latest ]] || die "ENV_IMAGE с тегом latest не фиксирует зависимости, укажите конкретный тег: $img"
}

# <ENV_IMAGE>-positron-<версия>[-arm64]
positron_tag() {
  printf '%s-positron-%s%s\n' "$1" "$2" "$([ "$ARCH" = x64 ] || echo "-$ARCH")"
}

# --- Docker-хосты. HOSTS="stats2=ssh://user@stats2 local": имена в порядке выбора для --host auto.
#     local — Docker на этой машине (Docker Desktop / OrbStack / Colima).

host_url() {
  local e
  [ "$1" = local ] && { echo local; return 0; }
  for e in $HOSTS; do
    [ "${e%%=*}" = "$1" ] && [ "$e" != "${e#*=}" ] && { echo "${e#*=}"; return 0; }
  done
  return 1
}
host_names() { local e; for e in $HOSTS; do echo "${e%%=*}"; done; }
check_host() { host_url "$1" >/dev/null || die "неизвестный хост '$1' (есть: $(host_names | tr '\n' ' ')— см. HOSTS в positron.env)"; }

hdocker() {
  local h="$1" url; shift
  url="$(host_url "$h")" || die "неизвестный хост '$h'"
  if [ "$url" = local ]; then env -u DOCKER_HOST docker "$@"
  else DOCKER_HOST="$url" docker "$@"; fi
}

# ssh://user@host:port -> user@host:port (для ProxyJump); у local пусто
host_jump() {
  local url; url="$(host_url "$1")"
  [ "$url" = local ] && return 0
  echo "${url#ssh://}"
}

_var() { printf '_UP_%s' "$(echo "$1" | tr -c 'A-Za-z0-9_\n' '_')"; }
# Доступен ли демон хоста. Удалённый хост сначала проверяется коротким ssh, чтобы не ждать долгий таймаут.
host_up() {
  local var; var="$(_var "$1")"
  if [ -z "${!var:-}" ]; then
    local ok=0 url j h port=""
    url="$(host_url "$1")" || die "неизвестный хост '$1'"
    if [ "$url" = local ]; then
      hdocker local info >/dev/null 2>&1 && ok=1
    else
      j="${url#ssh://}"; h="$j"
      if [[ "$h" == *:* ]]; then port="${h##*:}"; h="${h%:*}"; fi
      if ssh -o BatchMode=yes -o ConnectTimeout="$SSH_TIMEOUT" ${port:+-p "$port"} "$h" true >/dev/null 2>&1 \
         && hdocker "$1" info >/dev/null 2>&1; then ok=1; fi
    fi
    printf -v "$var" '%s' "$ok"
  fi
  [ "${!var}" = 1 ]
}

# auto | <имя> -> имя доступного хоста
resolve_host() {
  local h="${1:-auto}"
  if [ "$h" != auto ]; then
    check_host "$h"
    host_up "$h" || die "хост '$h' недоступен"
    echo "$h"; return 0
  fi
  local first=1
  for h in $(host_names); do
    if host_up "$h"; then
      [ "$first" = 1 ] || warn "первые хосты из HOSTS недоступны, использую '$h'"
      echo "$h"; return 0
    fi
    first=0
  done
  die "недоступен ни один хост из HOSTS ($HOSTS)"
}

has_image() { hdocker "$1" image inspect "$2" >/dev/null 2>&1; }

# copy_image <откуда> <куда> <образ>: docker save | docker load через эту машину
copy_image() {
  log "Копирую $3: $1 -> $2"
  hdocker "$1" save "$3" | gzip -1 | hdocker "$2" load >/dev/null
}

can_pull() { case " $NO_REGISTRY_HOSTS " in *" $1 "*) return 1 ;; esac; return 0; }

# ensure_image <хост> <образ>: сделать образ доступным демону хоста. По очереди:
#   уже есть; docker pull на хосте; копия с другого доступного хоста; pull на этой машине и копия.
ensure_image() {
  local h="$1" tag="$2" o
  has_image "$h" "$tag" && return 0
  if can_pull "$h"; then
    log "Скачиваю $tag на '$h'"
    hdocker "$h" pull -q --platform "$DOCKER_PLATFORM" "$tag" >/dev/null 2>&1 && return 0
  fi
  for o in $(host_names); do
    [ "$o" != "$h" ] && host_up "$o" && has_image "$o" "$tag" && { copy_image "$o" "$h" "$tag"; return 0; }
  done
  if [ "$h" != local ] && host_url local >/dev/null && host_up local \
     && hdocker local pull -q --platform "$DOCKER_PLATFORM" "$tag" >/dev/null 2>&1; then
    copy_image local "$h" "$tag"; return 0
  fi
  return 1
}
