#!/bin/sh
# Entrypoint of a project container. fnkc-ctl copies it into the environment image's container as
# /usr/local/bin/fnkc-entrypoint before the first start (the r-env image itself is not changed).
#   no arguments:   set up SSH and run sshd (mode for Positron Remote SSH); stop preserves dependencies
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

# The project's volume for renv (~/.fnkc-library). Projects keep their packages in <project>/renv/library (project
# volume), as links into renv's cache. The default cache (~/.cache) is lost when the container is recreated, which
# would break every link: keep it on this volume. The image's site-library stays visible to renv, so a restore
# installs only packages the image lacks or has in another version.
if command -v R >/dev/null 2>&1 && [ -d "$H/.fnkc-library" ]; then
  if [ "$(stat -c %u "$H/.fnkc-library")" = 0 ]; then chown "$U:$U" "$H/.fnkc-library"; fi
  RENV_SITE="$(R RHOME)/etc/Renviron.site"
  # Only the lines written here (each start rewrites them), also R_LIBS and R_LIBS_USER written by earlier versions;
  # the image's own R_LIBS default stays
  sed -i '\#^[A-Z_]*=.*/\.fnkc-library/#d; /^RENV_CONFIG_EXTERNAL_LIBRARIES=/d; /^RENV_CONFIG_REPOS_OVERRIDE=/d' "$RENV_SITE" 2>/dev/null || true
  printf 'RENV_PATHS_CACHE=%s\nRENV_CONFIG_EXTERNAL_LIBRARIES=/usr/local/lib/R/site-library\n' "$H/.fnkc-library/renv-cache" >> "$RENV_SITE"
  # Packages the image lacks come from the host's CRAN mirror (agent config cranMirror), for renv::install() as well
  # as for restores of renv.lock, whatever repository a lockfile names: the image's own repository (a PPM snapshot,
  # used to build it) is not reachable from every host. Rprofile.R sets options(repos) to the same mirror.
  if [ -n "${FNKC_CRAN_MIRROR:-}" ]; then
    printf 'RENV_CONFIG_REPOS_OVERRIDE=%s\n' "$FNKC_CRAN_MIRROR" >> "$RENV_SITE"
  fi
fi
# The first R console after each start restores the project's renv.lock (see Rprofile.R)
rm -f /tmp/.fnkc-renv-restored

# Explicit analysis environment identity (sshd does not inherit Docker ENV).
sed -i '/^FNKC_IMAGE_DIGEST=/d; /^FNKC_PROJECT=/d' /etc/environment
printf 'FNKC_IMAGE_DIGEST=%s\n' "${FNKC_IMAGE_DIGEST:-unknown}" >> /etc/environment
[ -z "${FNKC_PROJECT:-}" ] || printf 'FNKC_PROJECT=%s\n' "$FNKC_PROJECT" >> /etc/environment

# Every container gets its own host keys (the image has none)
ssh-keygen -A >/dev/null
mkdir -p /run/sshd

# Positron saves edited files by itself (5 s after the last change), so a stop for idleness or a long absence loses
# no edits: in the remote's Machine settings, only where the user has not set them. Settings that are not plain JSON
# (comments) are left as they are.
SETTINGS="$H/.positron-server/data/Machine/settings.json"
NODE="$(ls "$H"/.positron-server/bin/*/node 2>/dev/null | head -n 1)"
if [ -n "$NODE" ] && [ -d "$H/.positron-server/data" ]; then
  su -s /bin/sh "$U" -c "mkdir -p '$H/.positron-server/data/Machine'" 2>/dev/null || true
  su -s /bin/sh "$U" -c "'$NODE' -e '
    const fs = require(\"fs\"); const f = process.argv[1];
    let s = {}; try { s = JSON.parse(fs.readFileSync(f, \"utf8\")); } catch (e) { if (e.code !== \"ENOENT\") process.exit(0); }
    const want = { \"files.autoSave\": \"afterDelay\", \"files.autoSaveDelay\": 5000 };
    let changed = false;
    for (const [k, v] of Object.entries(want)) if (!(k in s)) { s[k] = v; changed = true; }
    if (changed) fs.writeFileSync(f, JSON.stringify(s, null, 2) + \"\\n\");
  ' '$SETTINGS'" || echo "fnkc-entrypoint: could not set autosave in $SETTINGS" >&2
fi

# Stops the container after FNKC_IDLE_MINUTES without connections and CPU use, or 3 days after the last window closed
# while it computes (0: never)
/usr/local/bin/fnkc-idle-watch &

# Stopping never rewrites dependencies. Use fnkc-projects snapshot for intentional changes.
stopping() {
  trap '' TERM INT
  kill -TERM "$SSHD" 2>/dev/null
  wait "$SSHD"
  exit 0
}
/usr/sbin/sshd -D -e &
SSHD=$!
echo "$SSHD" > /run/fnkc-sshd.pid
trap stopping TERM INT
# Returns when sshd exits, or early for a trapped signal (stopping then exits)
wait "$SSHD"
