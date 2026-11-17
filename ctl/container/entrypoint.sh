#!/bin/sh
# Entrypoint of a project container. fnkc-ctl copies it into the environment image's container as
# /usr/local/bin/fnkc-entrypoint before the first start (the r-env image itself is not changed).
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
[ -s "$H/.ssh/authorized_keys" ] || echo "fnkc-entrypoint: no authorized_keys (set SSH_PUBLIC_KEY)" >&2

# Docker creates missing mount points owned by root. Positron writes its logs to ~/.positron-server and
# its state to data/ and extensions/; the project volume is ~/<project>. bin/ is the host's shared
# read-only volume with Positron servers and stays as it is.
for d in "$H/.positron-server" "$H/.positron-server/data" "$H/.positron-server/extensions" \
         ${FNKC_PROJECT:+"$H/$FNKC_PROJECT"}; do
  if [ -d "$d" ] && [ "$(stat -c %u "$d")" = 0 ]; then chown "$U:$U" "$d"; fi
done

# R sessions load fnkc-ctl's additions (memory limit handling) after the image's own Rprofile.site
if command -v R >/dev/null 2>&1 && [ -f /usr/local/lib/fnkc/Rprofile.R ]; then
  SITE="$(R RHOME)/etc/Rprofile.site"
  LINE='if (file.exists("/usr/local/lib/fnkc/Rprofile.R")) source("/usr/local/lib/fnkc/Rprofile.R")'
  grep -qxF "$LINE" "$SITE" 2>/dev/null || printf '%s\n' "$LINE" >> "$SITE"
fi

# Explicit analysis environment identity (sshd does not inherit Docker ENV).
sed -i '/^FNKC_IMAGE_DIGEST=/d; /^FNKC_PROJECT=/d' /etc/environment
printf 'FNKC_IMAGE_DIGEST=%s\n' "${FNKC_IMAGE_DIGEST:-unknown}" >> /etc/environment
[ -z "${FNKC_PROJECT:-}" ] || printf 'FNKC_PROJECT=%s\n' "$FNKC_PROJECT" >> /etc/environment

# Every container gets its own host keys (the image has none)
ssh-keygen -A >/dev/null
mkdir -p /run/sshd

# Stops the container after FNKC_IDLE_MINUTES without connections and CPU use (0: never)
/usr/local/bin/fnkc-idle-watch &

exec /usr/sbin/sshd -D -e
