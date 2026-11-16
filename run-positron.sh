#!/usr/bin/env bash
# Starts a project's Positron container on any Docker host from HOSTS.
#
# Usage:
#   ./run-positron.sh <project> [--host auto|<name>] [--version local|latest|<version>] [--unlock]
#   ./run-positron.sh <project> --stop [--host <name>]
#   ./run-positron.sh --list
#
#   <project>  repository name (looked up under the GIT_REMOTES addresses in order) or a full git URL
#   --host     auto (default): the first reachable host in HOSTS; or a host name, e.g. local
#   --version  Positron version; defaults to the client version on this machine
#   --unlock   after cloning, run git-crypt unlock with the key in GIT_CRYPT_KEY_FILE
#
# What happens:
#   1. .devcontainer/devcontainer.json is read from the project repository: "image" is its environment;
#   2. the $REGISTRY/positron:<env name>-<env tag>-<version> image is pulled from the registry, copied from another host
#      or built on the spot (build-image.sh);
#   3. the positron-<project> container starts with volumes for ~/<project> and Positron's data;
#      when the version changes it is recreated, the volumes are kept;
#   4. ~/.ssh/positron/<project>.conf gets a positron-<project> host entry for Positron Remote SSH;
#   5. the project is cloned / updated in ~/<project> (git over SSH with ssh-agent forwarding).
set -euo pipefail
. "$(dirname "$0")/lib.sh"

PROJECT="" HOST_ARG=auto VERSION_ARG=local UNLOCK=0 ACTION=run
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST_ARG="${2:?--host needs a host name}"; shift ;;
    --version) VERSION_ARG="${2:?--version needs a version}"; shift ;;
    --unlock) UNLOCK=1 ;;
    --stop) ACTION=stop ;;
    --list) ACTION=list ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    -*) die "unknown flag $1" ;;
    *) [ -z "$PROJECT" ] || die "unexpected argument '$1'"; PROJECT="$1" ;;
  esac
  shift
done
need docker "brew install docker"

# --- List containers
if [ "$ACTION" = list ]; then
  for h in $(host_names); do
    if host_up "$h"; then
      echo "== $h"
      hdocker "$h" ps -a --filter label=positron.project \
        --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}'
    else
      echo "== $h: unreachable"
    fi
  done
  exit 0
fi

[ -n "$PROJECT" ] || die "specify a project: ./run-positron.sh <project> (--help)"

# --- Project: name and repository addresses
case "$PROJECT" in
  *://*|*@*:*) NAME="$(basename "$PROJECT" .git)"; URLS="$PROJECT" ;;
  *) NAME="$PROJECT"; URLS=""
     [ -n "$GIT_REMOTES" ] || die "GIT_REMOTES is not set (positron.env), or give a full git URL"
     for b in $GIT_REMOTES; do URLS="$URLS ${b%/}/$NAME.git"; done ;;
esac
[[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "invalid project name: '$NAME'"
CNAME="positron-$NAME"
SSH_ALIAS="positron-$NAME"

# --- Stop
if [ "$ACTION" = stop ]; then
  found=0
  for h in $( [ "$HOST_ARG" = auto ] && host_names || echo "$HOST_ARG" ); do
    host_up "$h" || continue
    if hdocker "$h" container inspect "$CNAME" >/dev/null 2>&1; then
      log "Stopping $CNAME on '$h'"; hdocker "$h" stop "$CNAME" >/dev/null; found=1
    fi
  done
  [ "$found" = 1 ] || warn "container $CNAME not found on any reachable host"
  exit 0
fi

# --- 1. The project's dev container config (cached: if git is unreachable, the last copy is used).
# The same .devcontainer/devcontainer.json is what Positron uses for "Reopen in Container",
# so a project pins its environment in exactly one place.
read_devcontainer() {
  local c="$CACHE_DIR/projects/$NAME.git" u fetched=""
  [ -d "$c" ] || git init -q --bare "$c"
  for u in $URLS; do
    if GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=$SSH_TIMEOUT" \
       git -C "$c" fetch -q --depth 1 "$u" HEAD 2>/dev/null; then
      git -C "$c" update-ref refs/positron/last FETCH_HEAD; fetched="$u"; break
    fi
    warn "$u is unreachable"
  done
  git -C "$c" rev-parse -q --verify refs/positron/last >/dev/null \
    || die "could not fetch repository $NAME from any address:$URLS"
  [ -n "$fetched" ] || warn "repository unreachable, using the cached copy of devcontainer.json"
  git -C "$c" show refs/positron/last:.devcontainer/devcontainer.json 2>/dev/null \
    || git -C "$c" show refs/positron/last:.devcontainer.json 2>/dev/null || true
}
DEVCONTAINER="$(read_devcontainer)"
# devcontainer.json may contain comments (JSONC), so the image is taken with a pattern rather than jq
ENV_IMAGE="$(printf '%s\n' "$DEVCONTAINER" | sed -n 's/.*"image"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
if [ -z "$ENV_IMAGE" ]; then
  if printf '%s\n' "$DEVCONTAINER" | grep -q '"build"'; then
    die "$NAME builds its own image (\"build\" in devcontainer.json); open it in Positron with Reopen in Container"
  fi
  ENV_IMAGE="$DEFAULT_ENV_IMAGE"
  warn "the project has no .devcontainer/devcontainer.json with \"image\", using DEFAULT_ENV_IMAGE=$ENV_IMAGE"
fi
check_env_image "$ENV_IMAGE"

VERSION="$(resolve_version "$VERSION_ARG")"
TAG="$(positron_tag "$ENV_IMAGE" "$VERSION")"
HOST="$(resolve_host "$HOST_ARG")"
log "Project $NAME: $ENV_IMAGE, Positron $VERSION, host '$HOST'"

# Is the same project already running on another host? Work there is not lost, but it has to be pushed to git.
for o in $(host_names); do
  [ "$o" != "$HOST" ] && host_up "$o" || continue
  if [ "$(hdocker "$o" inspect -f '{{.State.Running}}' "$CNAME" 2>/dev/null)" = true ]; then
    warn "$CNAME is also running on '$o'. Push your changes from there (positron-projects status) or stop it: --stop --host $o"
  fi
done

# --- 2. Image
if ! ensure_image "$HOST" "$TAG"; then
  log "$TAG is neither in the registry nor on other hosts, building it"
  build_args=("$VERSION" --env "$ENV_IMAGE" --host "$HOST")
  [ "$PUSH_BUILT" = 1 ] && build_args+=(--push)
  "$ROOT/build-image.sh" "${build_args[@]}"
fi

# --- 3. Container
if hdocker "$HOST" container inspect "$CNAME" >/dev/null 2>&1; then
  CUR="$(hdocker "$HOST" inspect -f '{{.Config.Image}}' "$CNAME")"
  if [ "$CUR" != "$TAG" ]; then
    log "Image changed ($CUR -> $TAG): recreating the container, volumes with your work are kept"
    hdocker "$HOST" rm -f "$CNAME" >/dev/null
  fi
fi
if hdocker "$HOST" container inspect "$CNAME" >/dev/null 2>&1; then
  log "Starting existing container $CNAME"
  hdocker "$HOST" start "$CNAME" >/dev/null
else
  [ -n "${SSH_PUBLIC_KEY_FILE:-}" ] && [ -f "$SSH_PUBLIC_KEY_FILE" ] \
    || die "public SSH key not found (SSH_PUBLIC_KEY_FILE)"
  rv="RUN_ARGS_$(echo "$HOST" | tr -c 'A-Za-z0-9_\n' '_')"
  log "Creating container $CNAME"
  # shellcheck disable=SC2086
  hdocker "$HOST" run -d --name "$CNAME" --hostname "$NAME" \
    --label positron.project="$NAME" \
    --platform "$DOCKER_PLATFORM" --restart unless-stopped \
    -p 127.0.0.1::22 \
    -e SSH_PUBLIC_KEY="$(cat "$SSH_PUBLIC_KEY_FILE")" \
    -e POSITRON_PROJECT="$NAME" \
    -v "positron-$NAME-project:$PROJECTS_DIR/$NAME" \
    -v "positron-$NAME-data:$SERVER_DATA_DIR/data" \
    -v "positron-$NAME-ext:$SERVER_DATA_DIR/extensions" \
    ${!rv:-} \
    "$TAG" >/dev/null
fi

# --- 4. SSH access: port on the host's 127.0.0.1; remote hosts are reached via ProxyJump
PORT="$(hdocker "$HOST" port "$CNAME" 22/tcp | head -n 1)"; PORT="${PORT##*:}"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "could not find the container's SSH port"
JUMP="$(host_jump "$HOST")"
IDENTITY="${SSH_PUBLIC_KEY_FILE%.pub}"

mkdir -p "$HOME/.ssh/positron"
{
  echo "# Written by run-positron.sh: $NAME on '$HOST'"
  echo "Host $SSH_ALIAS"
  echo "  HostName 127.0.0.1"
  echo "  Port $PORT"
  echo "  User $POSITRON_USER"
  [ -f "$IDENTITY" ] && echo "  IdentityFile $IDENTITY"
  echo "  ForwardAgent yes"
  [ -n "$JUMP" ] && echo "  ProxyJump $JUMP"
  echo "  # every new container has its own host key"
  echo "  StrictHostKeyChecking no"
  echo "  UserKnownHostsFile /dev/null"
  echo "  LogLevel ERROR"
} > "$HOME/.ssh/positron/$NAME.conf"
if ! grep -qiE '^[[:space:]]*Include[[:space:]]+.*positron/' "$HOME/.ssh/config" 2>/dev/null; then
  warn "add this line at the TOP of ~/.ssh/config:  Include positron/*.conf"
fi

SSHO=(-o BatchMode=yes -o ConnectTimeout="$SSH_TIMEOUT" -o StrictHostKeyChecking=no
      -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p "$PORT")
[ -f "$IDENTITY" ] && SSHO+=(-i "$IDENTITY")
[ -n "$JUMP" ] && SSHO+=(-J "$JUMP")
SSHO+=("$POSITRON_USER@127.0.0.1")

log "Waiting for sshd in the container"
for _ in $(seq 1 30); do ssh "${SSHO[@]}" true 2>/dev/null && break; sleep 1; done
ssh "${SSHO[@]}" true 2>/dev/null || die "could not log in to $CNAME over SSH (logs: docker logs $CNAME)"

COMMIT="$(hdocker "$HOST" image inspect -f '{{index .Config.Labels "positron.commit"}}' "$TAG")"
ssh "${SSHO[@]}" test -x "$SERVER_DATA_DIR/bin/$COMMIT/bin/positron-server" \
  || warn "$SERVER_DATA_DIR/bin/$COMMIT is missing in the container, Positron will try to download the server"

# --- 5. Project in ~/<project>
ssh-add -l >/dev/null 2>&1 || warn "no keys in ssh-agent (ssh-add): git in the container will not be able to reach Gitea"
log "Syncing the project into ~/$NAME"
# shellcheck disable=SC2086
ssh -A "${SSHO[@]}" positron-projects sync "$NAME" $URLS \
  || warn "sync finished with errors (the container is running; retry inside it: positron-projects sync)"

if [ "$UNLOCK" = 1 ]; then
  [ -n "$GIT_CRYPT_KEY_FILE" ] && [ -f "$GIT_CRYPT_KEY_FILE" ] || die "--unlock: GIT_CRYPT_KEY_FILE not found"
  log "git-crypt unlock in ~/$NAME"
  ssh "${SSHO[@]}" "cd $NAME && git-crypt unlock /dev/stdin" < "$GIT_CRYPT_KEY_FILE" \
    || warn "git-crypt unlock failed (the working tree must be clean)"
fi

log "Done: $CNAME on '$HOST'. In Positron: Remote SSH -> $SSH_ALIAS, folder $PROJECTS_DIR/$NAME"
