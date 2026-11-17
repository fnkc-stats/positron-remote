#!/usr/bin/env bash
# Shows a container's settings on a Docker host: image, user, ports, volumes, Positron server.
# Used to carry an existing container setup over into env/Dockerfile and env/versions/<series>/renv.lock.
#
# Usage:
#   ./inspect-container.sh [--host <name>]                           list containers
#   ./inspect-container.sh [--host <name>] <container>               container settings
#   ./inspect-container.sh [--host <name>] <container> --r-packages  R version and packages (compare with env/versions/<series>/renv.lock)
#   <name>: local (default) or a Docker host address such as ssh://user@server.example.lan
set -euo pipefail
die() { printf "Error: %s\n" "$*" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || die "docker not found (brew install docker)"

H=local C="" RPKG=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) H="${2:?--host needs a name}"; shift ;;
    --r-packages) RPKG=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    -*) die "unknown flag $1" ;;
    *) C="$1" ;;
  esac
  shift
done
D() { if [ "$H" = local ]; then env -u DOCKER_HOST docker "$@"; else DOCKER_HOST="$H" docker "$@"; fi; }

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

echo "== Image"
D inspect -f '{{.Config.Image}}  ({{.Image}})' "$C"
echo "== Image user / restart policy"
D inspect -f 'User={{.Config.User}}  Restart={{.HostConfig.RestartPolicy.Name}}' "$C"
echo "== Ports"
D inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}-p {{if .HostIp}}{{.HostIp}}:{{end}}{{.HostPort}}:{{$p}} {{end}}{{end}}' "$C"
echo "== Volumes"
D inspect -f '{{range .Mounts}}{{.Type}}: {{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}} -> {{.Destination}}{{if not .RW}} (ro){{end}}
{{end}}' "$C"
echo "== Network / other"
D inspect -f 'Network={{.HostConfig.NetworkMode}} Hostname={{.Config.Hostname}} Cmd={{json .Config.Cmd}} Entrypoint={{json .Config.Entrypoint}}' "$C"

if [ "$(D inspect -f '{{.State.Running}}' "$C")" = true ]; then
  echo "== .positron-server directories inside the container"
  D exec "$C" sh -c 'for d in /root/.positron-server /home/*/.positron-server; do
      [ -d "$d" ] || continue
      echo "$d  owner=$(stat -c %u:%g "$d")"
      ls -1 "$d/bin" 2>/dev/null | sed "s/^/    bin\//"
    done'
  echo "== System"
  D exec "$C" sh -c '. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME";
    for t in R quarto git git-crypt sshd; do printf "%-10s %s\n" "$t" "$(command -v $t || echo missing)"; done'
fi
