#!/usr/bin/env bash
# Запускает контейнер проекта с Positron на любом Docker-хосте из HOSTS.
#
# Использование:
#   ./run-positron.sh <проект> [--host auto|<имя>] [--version local|latest|<версия>] [--unlock]
#   ./run-positron.sh <проект> --stop [--host <имя>]
#   ./run-positron.sh --list
#
#   <проект>   имя репозитория (ищется по адресам GIT_REMOTES по очереди) или полный git-URL
#   --host     auto (по умолчанию): первый доступный хост из HOSTS; или имя хоста, например local
#   --version  версия Positron; по умолчанию версия клиента на этой машине
#   --unlock   после клонирования выполнить git-crypt unlock ключом GIT_CRYPT_KEY_FILE
#
# Что происходит:
#   1. из репозитория проекта читается container.env: ENV_IMAGE — образ окружения проекта;
#   2. образ <ENV_IMAGE>-positron-<версия> скачивается из реестра, переносится с другого хоста
#      или собирается на месте (build-image.sh);
#   3. контейнер positron-<проект> запускается с томами для ~/work и данных Positron;
#      при смене версии он пересоздаётся, тома остаются;
#   4. в ~/.ssh/positron/<проект>.conf пишется хост positron-<проект> для Positron Remote SSH;
#   5. проект клонируется / обновляется в ~/work/<проект> (git по SSH с пробросом ssh-agent).
set -euo pipefail
. "$(dirname "$0")/lib.sh"

PROJECT="" HOST_ARG=auto VERSION_ARG=local UNLOCK=0 ACTION=run
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST_ARG="${2:?после --host нужно имя хоста}"; shift ;;
    --version) VERSION_ARG="${2:?после --version нужна версия}"; shift ;;
    --unlock) UNLOCK=1 ;;
    --stop) ACTION=stop ;;
    --list) ACTION=list ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    -*) die "неизвестный флаг $1" ;;
    *) [ -z "$PROJECT" ] || die "лишний аргумент '$1'"; PROJECT="$1" ;;
  esac
  shift
done
need docker "brew install docker"

# --- Список контейнеров
if [ "$ACTION" = list ]; then
  for h in $(host_names); do
    if host_up "$h"; then
      echo "== $h"
      hdocker "$h" ps -a --filter label=positron.project \
        --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}'
    else
      echo "== $h: недоступен"
    fi
  done
  exit 0
fi

[ -n "$PROJECT" ] || die "укажите проект: ./run-positron.sh <проект> (--help)"

# --- Проект: имя и адреса репозитория
case "$PROJECT" in
  *://*|*@*:*) NAME="$(basename "$PROJECT" .git)"; URLS="$PROJECT" ;;
  *) NAME="$PROJECT"; URLS=""
     [ -n "$GIT_REMOTES" ] || die "не задан GIT_REMOTES (positron.env) — или укажите полный git-URL"
     for b in $GIT_REMOTES; do URLS="$URLS ${b%/}/$NAME.git"; done ;;
esac
[[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "недопустимое имя проекта: '$NAME'"
CNAME="positron-$NAME"
SSH_ALIAS="positron-$NAME"

# --- Остановка
if [ "$ACTION" = stop ]; then
  found=0
  for h in $( [ "$HOST_ARG" = auto ] && host_names || echo "$HOST_ARG" ); do
    host_up "$h" || continue
    if hdocker "$h" container inspect "$CNAME" >/dev/null 2>&1; then
      log "Останавливаю $CNAME на '$h'"; hdocker "$h" stop "$CNAME" >/dev/null; found=1
    fi
  done
  [ "$found" = 1 ] || warn "контейнер $CNAME не найден на доступных хостах"
  exit 0
fi

# --- 1. container.env из репозитория проекта (кешируется: если git недоступен, берётся последняя копия)
read_container_env() {
  local c="$CACHE_DIR/projects/$NAME.git" u fetched=""
  [ -d "$c" ] || git init -q --bare "$c"
  for u in $URLS; do
    if GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=$SSH_TIMEOUT" \
       git -C "$c" fetch -q --depth 1 "$u" HEAD 2>/dev/null; then
      git -C "$c" update-ref refs/positron/last FETCH_HEAD; fetched="$u"; break
    fi
    warn "$u недоступен"
  done
  git -C "$c" rev-parse -q --verify refs/positron/last >/dev/null \
    || die "не удалось получить репозиторий $NAME ни по одному адресу:$URLS"
  [ -n "$fetched" ] || warn "репозиторий недоступен, использую сохранённую копию container.env"
  git -C "$c" show refs/positron/last:container.env 2>/dev/null || true
}
ENV_IMAGE="$(read_container_env | sed -n "s/^ENV_IMAGE=[\"']\{0,1\}\([^\"' #]*\).*/\1/p" | tail -n 1)"
if [ -z "$ENV_IMAGE" ]; then
  ENV_IMAGE="$DEFAULT_ENV_IMAGE"
  warn "в проекте нет container.env с ENV_IMAGE, использую DEFAULT_ENV_IMAGE=$ENV_IMAGE"
fi
check_env_image "$ENV_IMAGE"

VERSION="$(resolve_version "$VERSION_ARG")"
TAG="$(positron_tag "$ENV_IMAGE" "$VERSION")"
HOST="$(resolve_host "$HOST_ARG")"
log "Проект $NAME: $ENV_IMAGE, Positron $VERSION, хост '$HOST'"

# Тот же проект уже запущен на другом хосте? Работа там не потеряется, но её нужно отправить в git.
for o in $(host_names); do
  [ "$o" != "$HOST" ] && host_up "$o" || continue
  if [ "$(hdocker "$o" inspect -f '{{.State.Running}}' "$CNAME" 2>/dev/null)" = true ]; then
    warn "$CNAME запущен и на '$o'. Отправьте оттуда изменения (positron-projects status) или остановите: --stop --host $o"
  fi
done

# --- 2. Образ
if ! ensure_image "$HOST" "$TAG"; then
  log "Образа $TAG нет ни в реестре, ни на других хостах — собираю"
  "$ROOT/build-image.sh" "$VERSION" --env "$ENV_IMAGE" --host "$HOST" $([ "$PUSH_BUILT" = 1 ] && echo --push)
fi

# --- 3. Контейнер
if hdocker "$HOST" container inspect "$CNAME" >/dev/null 2>&1; then
  CUR="$(hdocker "$HOST" inspect -f '{{.Config.Image}}' "$CNAME")"
  if [ "$CUR" != "$TAG" ]; then
    log "Образ изменился ($CUR -> $TAG): пересоздаю контейнер, тома с работой сохраняются"
    hdocker "$HOST" rm -f "$CNAME" >/dev/null
  fi
fi
if hdocker "$HOST" container inspect "$CNAME" >/dev/null 2>&1; then
  log "Запускаю существующий контейнер $CNAME"
  hdocker "$HOST" start "$CNAME" >/dev/null
else
  [ -n "${SSH_PUBLIC_KEY_FILE:-}" ] && [ -f "$SSH_PUBLIC_KEY_FILE" ] \
    || die "не найден публичный SSH-ключ (SSH_PUBLIC_KEY_FILE)"
  rv="RUN_ARGS_$(echo "$HOST" | tr -c 'A-Za-z0-9_\n' '_')"
  log "Создаю контейнер $CNAME"
  # shellcheck disable=SC2086
  hdocker "$HOST" run -d --name "$CNAME" --hostname "$NAME" \
    --label positron.project="$NAME" \
    --platform "$DOCKER_PLATFORM" --restart unless-stopped \
    -p 127.0.0.1::22 \
    -e SSH_PUBLIC_KEY="$(cat "$SSH_PUBLIC_KEY_FILE")" \
    -v "positron-$NAME-work:$WORK_DIR" \
    -v "positron-$NAME-data:$SERVER_DATA_DIR/data" \
    -v "positron-$NAME-ext:$SERVER_DATA_DIR/extensions" \
    ${!rv:-} \
    "$TAG" >/dev/null
fi

# --- 4. SSH-доступ: порт на 127.0.0.1 хоста; к удалённому хосту — через ProxyJump
PORT="$(hdocker "$HOST" port "$CNAME" 22/tcp | head -n 1)"; PORT="${PORT##*:}"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "не удалось узнать порт SSH контейнера"
JUMP="$(host_jump "$HOST")"
IDENTITY="${SSH_PUBLIC_KEY_FILE%.pub}"

mkdir -p "$HOME/.ssh/positron"
{
  echo "# Создано run-positron.sh: $NAME на '$HOST'"
  echo "Host $SSH_ALIAS"
  echo "  HostName 127.0.0.1"
  echo "  Port $PORT"
  echo "  User $POSITRON_USER"
  [ -f "$IDENTITY" ] && echo "  IdentityFile $IDENTITY"
  echo "  ForwardAgent yes"
  [ -n "$JUMP" ] && echo "  ProxyJump $JUMP"
  echo "  # ключ хоста свой у каждого нового контейнера"
  echo "  StrictHostKeyChecking no"
  echo "  UserKnownHostsFile /dev/null"
  echo "  LogLevel ERROR"
} > "$HOME/.ssh/positron/$NAME.conf"
if ! grep -qiE '^[[:space:]]*Include[[:space:]]+.*positron/' "$HOME/.ssh/config" 2>/dev/null; then
  warn "добавьте в НАЧАЛО ~/.ssh/config строку:  Include positron/*.conf"
fi

SSHO=(-o BatchMode=yes -o ConnectTimeout="$SSH_TIMEOUT" -o StrictHostKeyChecking=no
      -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p "$PORT")
[ -f "$IDENTITY" ] && SSHO+=(-i "$IDENTITY")
[ -n "$JUMP" ] && SSHO+=(-J "$JUMP")
SSHO+=("$POSITRON_USER@127.0.0.1")

log "Жду sshd в контейнере"
for _ in $(seq 1 30); do ssh "${SSHO[@]}" true 2>/dev/null && break; sleep 1; done
ssh "${SSHO[@]}" true 2>/dev/null || die "не удалось войти в $CNAME по SSH (логи: docker logs $CNAME)"

COMMIT="$(hdocker "$HOST" image inspect -f '{{index .Config.Labels "positron.commit"}}' "$TAG")"
ssh "${SSHO[@]}" test -x "$SERVER_DATA_DIR/bin/$COMMIT/bin/positron-server" \
  || warn "в контейнере нет $SERVER_DATA_DIR/bin/$COMMIT — Positron будет пытаться скачать сервер"

# --- 5. Проект в ~/work
ssh-add -l >/dev/null 2>&1 || warn "в ssh-agent нет ключей (ssh-add): git в контейнере не сможет зайти в Gitea/GitHub"
log "Синхронизирую проект в ~/work/$NAME"
# shellcheck disable=SC2086
ssh -A "${SSHO[@]}" positron-projects sync "$NAME" $URLS \
  || warn "синхронизация с ошибками (контейнер работает; повторить внутри: positron-projects sync)"

if [ "$UNLOCK" = 1 ]; then
  [ -n "$GIT_CRYPT_KEY_FILE" ] && [ -f "$GIT_CRYPT_KEY_FILE" ] || die "--unlock: не найден GIT_CRYPT_KEY_FILE"
  log "git-crypt unlock в ~/work/$NAME"
  ssh "${SSHO[@]}" "cd work/$NAME && git-crypt unlock /dev/stdin" < "$GIT_CRYPT_KEY_FILE" \
    || warn "git-crypt unlock не удался (рабочее дерево должно быть чистым)"
fi

log "Готово: $CNAME на '$HOST'. В Positron: Remote SSH -> $SSH_ALIAS, папка $WORK_DIR/$NAME"
