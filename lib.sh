# shellcheck shell=bash disable=SC2034
# Shared functions for the scripts in this repository (sourced, not executed).
# Compatible with bash 3.2 (macOS): no associative arrays.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE_DIR="${CACHE_DIR:-$ROOT/.cache}"

# Config: environment variables take precedence over positron.env
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
# Same template as the default of remoteSSH.serverDownloadUrlTemplate
_DEFAULT_URL_TEMPLATE='https://cdn.posit.co/positron/${quality}/reh/${arch-long}/positron-reh-${os}-${arch}-${version}.tar.gz'
POSITRON_REH_URL_TEMPLATE="${POSITRON_REH_URL_TEMPLATE:-$_DEFAULT_URL_TEMPLATE}"

# User inside the container; created in env/Dockerfile, change both together
POSITRON_USER=analyst
POSITRON_UID=1000
POSITRON_GID=1000
POSITRON_HOME="/home/$POSITRON_USER"
SERVER_DATA_DIR="$POSITRON_HOME/.positron-server"
WORK_DIR="$POSITRON_HOME/work"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "command not found: '$1'${2:+ ($2)}"; }

case "$ARCH" in
  x64)   ARCH_LONG=x86_64; DOCKER_PLATFORM=linux/amd64 ;;
  arm64) ARCH_LONG=arm64;  DOCKER_PLATFORM=linux/arm64 ;;
  *) die "ARCH must be x64 or arm64, not '$ARCH'" ;;
esac

# --- Positron versions

# Version of the Positron client installed on this machine: <positronVersion>-<buildNumber>
local_positron_version() {
  local pj="$POSITRON_APP/Contents/Resources/app/product.json"
  [ -f "$pj" ] || die "$pj not found (give the version explicitly or set POSITRON_APP)"
  jq -r '"\(.positronVersion)-\(.positronBuildNumber)"' "$pj"
}

latest_positron_version() {
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh release view --repo posit-dev/positron --json tagName -q .tagName
  else
    curl -fsSL https://api.github.com/repos/posit-dev/positron/releases/latest | jq -r .tag_name
  fi
}

# Argument: local (default) | latest | a specific version such as 2026.07.1-5
resolve_version() {
  local v="${1:-local}"
  case "$v" in
    local)  v="$(local_positron_version)" ;;
    latest) v="$(latest_positron_version)" ;;
  esac
  [[ "$v" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]+-[0-9]+$ ]] || die "not a Positron version: '$v' (expected something like 2026.07.1-5)"
  printf '%s\n' "$v"
}

# --- Images

# The environment image needs an explicit tag: the Positron image tag is derived from it, and it pins the dependencies
check_env_image() {
  local img="$1" last="${1##*/}"
  [ -n "$img" ] || die "no environment image set (ENV_IMAGE in the project's container.env, or DEFAULT_ENV_IMAGE)"
  [[ "$img" != *@* ]] || die "ENV_IMAGE is given by digest, a tag is required: $img"
  [[ "$last" == *:* ]] || die "ENV_IMAGE has no tag: $img"
  [[ "${last##*:}" != latest ]] || die "ENV_IMAGE tagged latest does not pin dependencies, use a specific tag: $img"
}

# Positron images live in their own private package, separate from the public environment images:
#   ghcr.io/fnkc-stats/r-env:2026.11.16-aaf87d7 + 2026.11.1-4
#   -> $REGISTRY/positron:r-env-2026.11.16-aaf87d7-2026.11.1-4[-arm64]
positron_tag() {
  local env_name="${1%:*}" env_tag="${1##*:}"
  printf '%s/positron:%s-%s-%s%s\n' "$REGISTRY" "${env_name##*/}" "$env_tag" "$2" \
    "$([ "$ARCH" = x64 ] || echo "-$ARCH")"
}

# --- Docker hosts. HOSTS="stats2=ssh://user@stats2 local": names in the order --host auto tries them.
#     local is Docker on this machine (Docker Desktop / OrbStack / Colima).

host_url() {
  local e
  [ "$1" = local ] && { echo local; return 0; }
  for e in $HOSTS; do
    [ "${e%%=*}" = "$1" ] && [ "$e" != "${e#*=}" ] && { echo "${e#*=}"; return 0; }
  done
  return 1
}
host_names() { local e; for e in $HOSTS; do echo "${e%%=*}"; done; }
check_host() { host_url "$1" >/dev/null || die "unknown host '$1' (known: $(host_names | tr '\n' ' ')- see HOSTS in positron.env)"; }

hdocker() {
  local h="$1" url; shift
  url="$(host_url "$h")" || die "unknown host '$h'"
  if [ "$url" = local ]; then env -u DOCKER_HOST docker "$@"
  else DOCKER_HOST="$url" docker "$@"; fi
}

# ssh://user@host:port -> user@host:port (for ProxyJump); empty for local
host_jump() {
  local url; url="$(host_url "$1")"
  [ "$url" = local ] && return 0
  echo "${url#ssh://}"
}

_var() { printf '_UP_%s' "$(echo "$1" | tr -c 'A-Za-z0-9_\n' '_')"; }
# Is the host's Docker daemon reachable? A remote host is first probed with a short ssh to avoid a long timeout.
host_up() {
  local var; var="$(_var "$1")"
  if [ -z "${!var:-}" ]; then
    local ok=0 url j h port=""
    url="$(host_url "$1")" || die "unknown host '$1'"
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

# auto | <name> -> name of a reachable host
resolve_host() {
  local h="${1:-auto}"
  if [ "$h" != auto ]; then
    check_host "$h"
    host_up "$h" || die "host '$h' is unreachable"
    echo "$h"; return 0
  fi
  local first=1
  for h in $(host_names); do
    if host_up "$h"; then
      [ "$first" = 1 ] || warn "the first hosts in HOSTS are unreachable, using '$h'"
      echo "$h"; return 0
    fi
    first=0
  done
  die "none of the hosts in HOSTS is reachable ($HOSTS)"
}

has_image() { hdocker "$1" image inspect "$2" >/dev/null 2>&1; }

# copy_image <from> <to> <image>: docker save | docker load through this machine
copy_image() {
  log "Copying $3: $1 -> $2"
  hdocker "$1" save "$3" | gzip -1 | hdocker "$2" load >/dev/null
}

can_pull() { case " $NO_REGISTRY_HOSTS " in *" $1 "*) return 1 ;; esac; return 0; }

# ensure_image <host> <image>: make the image available to the host's daemon. In order:
#   already there; docker pull on the host; copy from another reachable host; pull on this machine and copy.
ensure_image() {
  local h="$1" tag="$2" o
  has_image "$h" "$tag" && return 0
  if can_pull "$h"; then
    log "Pulling $tag on '$h'"
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
