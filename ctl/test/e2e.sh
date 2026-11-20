#!/usr/bin/env bash
# End-to-end test of fnkc-ctl with this computer's Docker: a throwaway git server stands in for Gitea, a throwaway
# Linux container for the team server (installed with install.sh from the server bundle), and a separate HOME with
# its own SSH key, ssh-agent, GPG key and client config, so nothing of the user's ~/.ssh, ~/.gnupg or
# ~/.config is used or changed. Checks, with an image in container.json:
#   Open refused for another Positron build, before anything is created
#   Open on this computer: clone inside the container, data reported as encrypted
#   Open --unlock: the project key decrypted with the GPG key on "this computer", data readable, checkout clean
#   renv: the first console restores renv.lock from the image, nothing installed
#   stop and reopen: data still decrypted; fnkc-projects lock, then unlock with a GPG key file (removed afterwards)
#   the server: install.sh, admin add-user, Open through the gateway (broker SSH, decryption), list, stop,
#   admin remove-user (container stopped, volumes kept, key refused)
# Positron itself is not started: a stand-in with the image's Positron build (from its labels) is used.
#
# Needs: Docker with the docker CLI (tested with Colima on macOS), node, git, git-crypt, gpg, ssh, ssh-keyscan.
# The server container uses the host network, so this Docker must forward ports of such containers to localhost
# (Colima does; Docker Desktop needs host networking enabled).
#
# Usage: test/e2e.sh [image]     default: the image of project-template/container.json; run from ctl/
#        E2E_KEEP=1 test/e2e.sh   keep the containers, volumes and files for a look afterwards
# The checks pass values to bash -c as arguments (single quotes on purpose), and commands for the containers are
# built here (expanded on this side on purpose)
# shellcheck disable=SC2016,SC2029
set -euo pipefail

CTL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$CTL_DIR/.." && pwd)"
IMAGE="${1:-$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).image)' "$ROOT/project-template/container.json")}"
ID="$(node -e 'console.log(require("crypto").randomBytes(3).toString("hex"))')"
# Under the project (in the home folder): Docker on macOS shares it with its VM; short, for gpg-agent's socket path
W="$CTL_DIR/.cache/e2e-$ID"
LOCAL_PROJECT="e2e-local-$ID" SERVER_PROJECT="e2e-server-$ID" GIT="fnkc-e2e-git-$ID" SERVER="fnkc-e2e-srv-$ID"
GIT_PORT="${E2E_GIT_PORT:-2299}" GW_PORT="${E2E_GATEWAY_PORT:-2223}"
SERVER_USER="e2e$ID"

say() { printf '\n==> %s\n' "$*"; }
ok() { printf '  ok   %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*" >&2; exit 1; }
check() { local what="$1"; shift; if "$@"; then ok "$what"; else fail "$what"; fi; }

cleanup() {
  local code=$?
  set +e
  if [ -n "${E2E_KEEP:-}" ]; then echo "kept: $W, containers $GIT $SERVER, projects $LOCAL_PROJECT $SERVER_PROJECT"; return; fi
  for p in "$LOCAL_PROJECT" "$SERVER_PROJECT"; do
    for c in $(docker ps -aq --filter "label=fnkc.project=$p"); do docker rm -f "$c" >/dev/null; done
    for v in $(docker volume ls -q | grep -- "-$p-"); do docker volume rm "$v" >/dev/null; done
    for n in $(docker network ls --format '{{.Name}}' | grep -- "-$p-net$"); do docker network rm "$n" >/dev/null; done
  done
  docker rm -f "$GIT" "$SERVER" >/dev/null 2>&1
  [ -n "${SSH_AGENT_PID:-}" ] && kill "$SSH_AGENT_PID" 2>/dev/null
  [ -d "${GNUPGHOME:-}" ] && gpgconf --kill gpg-agent 2>/dev/null && rm -rf "${GNUPGHOME:?}"
  rm -rf "${W:?}"
  [ "$code" = 0 ] && printf '\nAll end-to-end checks passed.\n' || printf '\nEnd-to-end test FAILED (E2E_KEEP=1 keeps everything for a look).\n' >&2
}
trap cleanup EXIT

for c in docker node git git-crypt gpg ssh ssh-keyscan; do command -v "$c" >/dev/null || fail "$c is needed"; done
REAL_DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}"
mkdir -p "$W/home/.ssh" "$W/home/.config/fnkc-ctl" "$W/bin" "$W/git" "$W/positron" "$W/positron-other"
chmod 700 "$W/home/.ssh"

say "Image $IMAGE"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull -q "$IMAGE" >/dev/null
label() { docker image inspect "$IMAGE" --format "{{index .Config.Labels \"$1\"}}"; }
PV="$(label positron.version)" PC="$(label positron.commit)"
[ -n "$PV" ] && [ -n "$PC" ] || fail "the image has no positron.version / positron.commit labels"
ok "Positron $PV ($PC)"
# Stand-ins for Positron: product.json is all fnkc-ctl reads
printf '{"positronVersion": "%s", "positronBuildNumber": %s, "commit": "%s"}\n' "${PV%-*}" "${PV##*-}" "$PC" > "$W/positron/product.json"
printf '{"positronVersion": "2000.01.0", "positronBuildNumber": 1, "commit": "%s"}\n' "$(printf '0%.0s' $(seq 40))" > "$W/positron-other/product.json"

say "Stand-in Gitea: $GIT on port $GIT_PORT"
ssh-keygen -q -t ed25519 -N '' -C e2e -f "$W/home/.ssh/id_ed25519"
cp "$W/home/.ssh/id_ed25519.pub" "$W/git/authorized_keys"
cat > "$W/git/Dockerfile" <<'EOF'
FROM alpine:3.22
RUN apk add --no-cache openssh-server git && adduser -D -s /bin/sh git && passwd -u git && ssh-keygen -A \
 && mkdir -p /home/git/.ssh /home/git/stats
COPY authorized_keys /home/git/.ssh/authorized_keys
RUN chown -R git:git /home/git && chmod 700 /home/git/.ssh && chmod 600 /home/git/.ssh/authorized_keys
CMD ["/usr/sbin/sshd", "-D", "-e"]
EOF
docker build -q -t fnkc-e2e-git "$W/git" >/dev/null
docker run -d --name "$GIT" --memory 128m -p "$GIT_PORT:22" fnkc-e2e-git >/dev/null
BRIDGE="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"

# The separate HOME. OpenSSH reads ~/.ssh from the user database, not $HOME: a wrapper points it at this one.
# GnuPG only runs here, not in Docker: a short folder of its own, as its sockets allow 104 characters of path
GNUPGHOME="$(mktemp -d "${TMPDIR:-/tmp}/fnkc-e2e-gpg.XXXXXX")"
export HOME="$W/home" GNUPGHOME DOCKER_CONFIG="$REAL_DOCKER_CONFIG" PATH="$W/bin:$PATH"
touch "$HOME/.ssh/config"
cat > "$W/ssh_config" <<EOF
Include $HOME/.ssh/config
Host *
  UserKnownHostsFile $HOME/.ssh/known_hosts
  IdentityFile $HOME/.ssh/id_ed25519
EOF
printf '#!/bin/sh\nexec %s -F %s "$@"\n' "$(command -v ssh)" "$W/ssh_config" > "$W/bin/ssh"; chmod +x "$W/bin/ssh"
eval "$(ssh-agent -a "$W/agent.sock")" >/dev/null
ssh-add -q "$HOME/.ssh/id_ed25519"
trust() { # trust() <name> <port>: the host key of a test sshd on this computer, under the name clients use
  local k=""; for _ in $(seq 1 30); do k="$(ssh-keyscan -p "$2" -t ed25519 127.0.0.1 2>/dev/null | grep -v '^#')" && [ -n "$k" ] && break; sleep 1; done
  [ -n "$k" ] || fail "no sshd on port $2"
  echo "${k/#\[127.0.0.1\]:$2/[$1]:$2}" >> "$HOME/.ssh/known_hosts"
}
trust gitsrv.localhost "$GIT_PORT"
gpg --batch --quiet --passphrase '' --quick-gen-key 'E2E Tester <e2e@example.invalid>' default default never 2>/dev/null
FPR="$(gpg --list-keys --with-colons | awk -F: '/^fpr/ {print $10; exit}')"
ctl() { node "$CTL_DIR/dist/fnkc-ctl.cjs" "$@"; }
in_container() { ssh "fnkc-$1--$2" "$3"; }

say "Test projects (git-crypt data encrypted for the test GPG key)"
make_project() { # make_project <name>
  ssh -p "$GIT_PORT" git@gitsrv.localhost "git init -q --bare stats/$1.git && git -C stats/$1.git symbolic-ref HEAD refs/heads/main"
  local r="$W/repo-$1"
  git init -q -b main "$r"
  (cd "$r"
    git config user.name E2E; git config user.email e2e@example.invalid; git config commit.gpgsign false
    printf '{\n  "image": "%s"\n}\n' "$IMAGE" > container.json
    docker run --rm --entrypoint cat "$IMAGE" /usr/local/share/r-env/renv.lock > renv.lock
    git-crypt init >/dev/null; printf 'data/** filter=git-crypt diff=git-crypt\n' > .gitattributes
    mkdir data; printf 'id,value\n1,42\n' > data/secret.csv
    git add -A; git commit -qm "e2e project"; git-crypt add-gpg-user --trusted "$FPR" >/dev/null; git-crypt lock
    git remote add origin "ssh://git@gitsrv.localhost:$GIT_PORT/home/git/stats/$1.git"; git push -q origin main)
  ok "$1"
}
make_project "$LOCAL_PROJECT"
make_project "$SERVER_PROJECT"
cat > "$HOME/.config/fnkc-ctl/config.json" <<EOF
{
  "hosts": [{ "name": "local" }, { "name": "server", "ssh": "fnkc@localhost:$GW_PORT" }],
  "gitRemotes": ["ssh://git@gitsrv.localhost:$GIT_PORT/home/git/stats"],
  "decryptionHosts": ["server"],
  "local": { "extraHosts": { "gitsrv.localhost": "$BRIDGE" } }
}
EOF

say "This computer"
out="$(POSITRON_APP="$W/positron-other" ctl open "$LOCAL_PROJECT" --host local --no-window 2>&1 || true)"
check "Open is refused for another Positron build" grep -q "is built for Positron $PV" <<< "$out"
check "nothing was created for it" test -z "$(docker ps -aq --filter "label=fnkc.project=$LOCAL_PROJECT")"
export POSITRON_APP="$W/positron"
out="$(ctl open "$LOCAL_PROJECT" --host local --no-window 2>&1)" || { echo "$out"; fail "Open"; }
check "Open: the data is reported as encrypted" grep -q "Project data is encrypted" <<< "$out"
check "the checkout is in the container, locked" test "$(in_container local "$LOCAL_PROJECT" "cd ~/$LOCAL_PROJECT && git rev-parse --abbrev-ref HEAD && fnkc-projects data" | tr '\n' ' ')" = "main locked "
out="$(ctl open "$LOCAL_PROJECT" --host local --no-window --unlock 2>&1)" || { echo "$out"; fail "Open --unlock"; }
check "Open --unlock decrypts" grep -q "Project data is decrypted" <<< "$out"
check "the data is readable, the checkout clean" test "$(in_container local "$LOCAL_PROJECT" "cd ~/$LOCAL_PROJECT && tail -1 data/secret.csv && git status --short --untracked-files=no | wc -l" | tr -d ' ' | tr '\n' ' ')" = "1,42 0 "
check "the personal GPG key did not go to the container" test "$(in_container local "$LOCAL_PROJECT" 'test -e ~/.gnupg && echo yes || echo no')" = no
restore="$(in_container local "$LOCAL_PROJECT" "cd ~/$LOCAL_PROJECT && rm -f /tmp/.fnkc-renv-restored && echo 'cat(\"installed:\", length(dir(.libPaths()[1])), \"\\n\")' | R --interactive --no-save -q 2>&1")"
check "the first console restores renv.lock from the image" grep -q "synchronized" <<< "$restore"
check "nothing was installed into the project library" grep -q "installed: 0" <<< "$restore"
ctl stop "$LOCAL_PROJECT" --host local >/dev/null
ctl open "$LOCAL_PROJECT" --host local --no-window >/dev/null 2>&1
check "after stop and Open the data is still decrypted" test "$(in_container local "$LOCAL_PROJECT" "cd ~/$LOCAL_PROJECT && fnkc-projects data")" = unlocked
in_container local "$LOCAL_PROJECT" "cd ~/$LOCAL_PROJECT && fnkc-projects lock" >/dev/null
check "fnkc-projects lock" test "$(in_container local "$LOCAL_PROJECT" "cd ~/$LOCAL_PROJECT && fnkc-projects data")" = locked
gpg --armor --export-secret-keys e2e@example.invalid | in_container local "$LOCAL_PROJECT" "cat > ~/$LOCAL_PROJECT/key.asc"
in_container local "$LOCAL_PROJECT" "cd ~/$LOCAL_PROJECT && fnkc-projects unlock key.asc" >/dev/null 2>&1 || true
check "fnkc-projects unlock <GPG key file> decrypts" test "$(in_container local "$LOCAL_PROJECT" "cd ~/$LOCAL_PROJECT && fnkc-projects data")" = unlocked
check "the key file is removed from the project folder" test "$(in_container local "$LOCAL_PROJECT" "test -e ~/$LOCAL_PROJECT/key.asc && echo yes || echo no")" = no
ctl stop "$LOCAL_PROJECT" --host local >/dev/null

say "The server: $SERVER (install.sh from the server bundle, gateway on port $GW_PORT)"
(cd "$CTL_DIR" && npm run --silent server-bundle >/dev/null)
mkdir -p "$W/server"; cp "$CTL_DIR/dist/fnkc-ctl-server.tar.gz" "$W/server/"
cat > "$W/server/Dockerfile" <<EOF
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server sudo docker.io procps \
 && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd && sed -i 's/^#\?Port .*/Port $GW_PORT/' /etc/ssh/sshd_config
# No systemd here: "systemctl reload" makes sshd read its configuration again
RUN printf '#!/bin/sh\npkill -HUP -x sshd\n' > /usr/local/bin/systemctl && chmod 755 /usr/local/bin/systemctl
COPY fnkc-ctl-server.tar.gz /root/
CMD ["/usr/sbin/sshd", "-D", "-e"]
EOF
docker build -q -t fnkc-e2e-server "$W/server" >/dev/null
docker run -d --name "$SERVER" --network host --memory 1g -v /var/run/docker.sock:/var/run/docker.sock fnkc-e2e-server >/dev/null
cp "$HOME/.ssh/id_ed25519.pub" "$W/server/user.pub"; docker cp "$W/server/user.pub" "$SERVER:/root/user.pub"
docker exec "$SERVER" sh -c 'groupmod -g "$(stat -c %g /var/run/docker.sock)" docker && cd /root && tar -xzf fnkc-ctl-server.tar.gz && ./fnkc-ctl-server/install.sh' > "$W/install.log" 2>&1 \
  || { cat "$W/install.log"; fail "install.sh"; }
ok "install.sh"
# Room for a test project on a laptop's Docker; the test git server's name, as on this computer
docker exec "$SERVER" node -e '
  const f = "/etc/fnkc-ctl/agent.json", fs = require("fs"), c = JSON.parse(fs.readFileSync(f));
  c.limits = { ...c.limits, memory: "2g" }; c.reserveMemory = "1g"; c.extraHosts = { "gitsrv.localhost": process.argv[1] };
  fs.writeFileSync(f, JSON.stringify(c, null, 2));' "$BRIDGE"
docker exec "$SERVER" fnkc-ctl admin add-user "$SERVER_USER" /root/user.pub >/dev/null
ok "admin add-user $SERVER_USER"
policy="$(docker exec "$SERVER" sshd -T -C user=fnkc,host=localhost,addr=127.0.0.1)"
check "the gateway allows no forwarding and no TTY" bash -c 'grep -qx "disableforwarding yes" <<< "$1" && grep -qx "permittty no" <<< "$1"' _ "$policy"
trust localhost "$GW_PORT"
out="$(ctl open "$SERVER_PROJECT" --host server --no-window --unlock 2>&1)" || { echo "$out"; fail "Open on the server"; }
check "Open through the gateway, decrypted on the server" grep -q "Project data is decrypted" <<< "$out"
check "the project is used over the broker" test "$(in_container server "$SERVER_PROJECT" "cd ~/$SERVER_PROJECT && tail -1 data/secret.csv")" = "1,42"
check "the gateway refuses other commands" bash -c '! ssh -p "$1" fnkc@localhost "ls /" >/dev/null 2>&1' _ "$GW_PORT"
check "list shows it running" bash -c 'node "$1/dist/fnkc-ctl.cjs" list 2>&1 | grep -E "^ +$2 +running" >/dev/null' _ "$CTL_DIR" "$SERVER_PROJECT"
ctl stop "$SERVER_PROJECT" --host server >/dev/null
check "stop" test -n "$(docker ps -aq --filter "label=fnkc.project=$SERVER_PROJECT" --filter status=exited)"
ctl open "$SERVER_PROJECT" --host server --no-window >/dev/null 2>&1
docker exec "$SERVER" fnkc-ctl admin remove-user "$SERVER_USER" >/dev/null
check "admin remove-user stops the container" test -n "$(docker ps -aq --filter "label=fnkc.project=$SERVER_PROJECT" --filter status=exited)"
check "and keeps its volumes" test "$(docker volume ls -q | grep -c -- "-$SERVER_PROJECT-")" -ge 3
check "and the gateway refuses the key" bash -c '! ssh -p "$1" -o BatchMode=yes fnkc@localhost "agent ping" >/dev/null 2>&1' _ "$GW_PORT"
