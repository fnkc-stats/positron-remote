#!/usr/bin/env bash
# Показывает параметры контейнера на Docker-хосте: образ, пользователя, порты, тома, сервер Positron.
# Нужен, чтобы перенести текущую рабочую среду stats2 в env/Dockerfile и env/renv.lock.
#
# Использование:
#   ./inspect-container.sh [--host <имя>]                       список контейнеров
#   ./inspect-container.sh [--host <имя>] <контейнер>           параметры контейнера
#   ./inspect-container.sh [--host <имя>] <контейнер> --r-packages   версия R и пакеты (сверить с env/renv.lock)
#   хост по умолчанию — первый из HOSTS
set -euo pipefail
. "$(dirname "$0")/lib.sh"
need docker "brew install docker"

H="$(host_names | head -n 1)" C="" RPKG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) H="${2:?после --host нужно имя}"; shift ;;
    --r-packages) RPKG=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    -*) die "неизвестный флаг $1" ;;
    *) C="$1" ;;
  esac
  shift
done
check_host "$H"
D() { hdocker "$H" "$@"; }

if [ -z "$C" ]; then
  D ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
  exit 0
fi

if [ "$RPKG" = 1 ]; then
  D exec "$C" Rscript -e 'cat(R.version.string, "\n\n");
    ip <- installed.packages(); ip <- ip[is.na(ip[, "Priority"]), , drop = FALSE];
    cat(sprintf("%s  # %s", rownames(ip), ip[, "Version"]), sep = "\n")'
  exit 0
fi

echo "== Образ"
D inspect -f '{{.Config.Image}}  ({{.Image}})' "$C"
echo "== Пользователь образа / restart policy"
D inspect -f 'User={{.Config.User}}  Restart={{.HostConfig.RestartPolicy.Name}}' "$C"
echo "== Порты"
D inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}-p {{if .HostIp}}{{.HostIp}}:{{end}}{{.HostPort}}:{{$p}} {{end}}{{end}}' "$C"
echo "== Тома"
D inspect -f '{{range .Mounts}}{{.Type}}: {{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}} -> {{.Destination}}{{if not .RW}} (ro){{end}}
{{end}}' "$C"
echo "== Сеть / прочее"
D inspect -f 'Network={{.HostConfig.NetworkMode}} Hostname={{.Config.Hostname}} Cmd={{json .Config.Cmd}} Entrypoint={{json .Config.Entrypoint}}' "$C"

if [ "$(D inspect -f '{{.State.Running}}' "$C")" = true ]; then
  echo "== Каталоги .positron-server внутри контейнера"
  D exec "$C" sh -c 'for d in /root/.positron-server /home/*/.positron-server; do
      [ -d "$d" ] || continue
      echo "$d  owner=$(stat -c %u:%g "$d")"
      ls -1 "$d/bin" 2>/dev/null | sed "s/^/    bin\//"
    done'
  echo "== Системное"
  D exec "$C" sh -c '. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME";
    for t in R quarto git git-crypt sshd; do printf "%-10s %s\n" "$t" "$(command -v $t || echo нет)"; done'
fi
