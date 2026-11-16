#!/bin/sh
# Entrypoint of a project container. positron-ctl copies it into the environment image's container as
# /usr/local/bin/positron-entrypoint before the first start (the r-env image itself is not changed).
#   no arguments:   set up SSH and run sshd (mode for Positron Remote SSH)
#   with arguments: run the command (e.g. quarto render), sshd is not started
set -e

if [ $# -gt 0 ]; then exec "$@"; fi

U=analyst
H="/home/$U"

# The login key is passed at creation: docker create -e SSH_PUBLIC_KEY="ssh-ed25519 ..."
if [ -n "${SSH_PUBLIC_KEY:-}" ]; then
  install -d -m 700 -o "$U" -g "$U" "$H/.ssh"
  printf '%s\n' "$SSH_PUBLIC_KEY" > "$H/.ssh/authorized_keys"
  chown "$U:$U" "$H/.ssh/authorized_keys"
  chmod 600 "$H/.ssh/authorized_keys"
fi
[ -s "$H/.ssh/authorized_keys" ] || echo "positron-entrypoint: no authorized_keys (set SSH_PUBLIC_KEY)" >&2

# Docker creates missing mount points owned by root. Positron writes its logs to ~/.positron-server and
# its state to data/ and extensions/; the project volume is ~/<project>. bin/ is the host's shared
# read-only volume with Positron servers and stays as it is.
for d in "$H/.positron-server" "$H/.positron-server/data" "$H/.positron-server/extensions" \
         ${POSITRON_PROJECT:+"$H/$POSITRON_PROJECT"}; do
  if [ -d "$d" ] && [ "$(stat -c %u "$d")" = 0 ]; then chown "$U:$U" "$d"; fi
done

# Every container gets its own host keys (the image has none)
ssh-keygen -A >/dev/null
mkdir -p /run/sshd

# Stops the container after POSITRON_IDLE_MINUTES without connections and CPU use (0: never)
/usr/local/bin/positron-idle-watch &

exec /usr/sbin/sshd -D -e
