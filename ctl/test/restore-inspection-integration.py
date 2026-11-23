#!/usr/bin/env python3
"""Run the restore inspection command of docs/operations.md, as written there, against a hostile restore volume.

The volume belongs to the analyst: its .git/config runs programs (core.fsmonitor, gpg.program for a signed-looking
commit) and its file and author names carry terminal escapes (OSC 0 sets the window title). The documented command
must run none of them and print no raw ESC byte. A control run with plain ls/git shows the fixture does both.
"""
import os
from pathlib import Path
import re
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[2]
IMAGE = os.environ.get('FNKC_BACKUP_TEST_IMAGE', 'ghcr.io/fnkc-stats/r-env@sha256:13f9a16cc0fdae21e96a08d3fb7b1e937360de80991c0318ac7dda512514e24d')

# Built as root inside the image, then handed to the analyst (UID 1000) like a restored project volume
FIXTURE = r'''set -e
cd /data
git init -q
git config user.email a@example.invalid
esc="$(printf '\033]0;x\007')"
git config user.name "ev${esc}il"
echo a > a
git add a
git commit -qm first
# A commit with a gpgsig header: git log runs gpg.program on it when log.showSignature is on
tree="$(git rev-parse HEAD^{tree})"; parent="$(git rev-parse HEAD)"; who="ev${esc}il <a@example.invalid> 1700000000 +0000"
signed="$(printf 'tree %s\nparent %s\nauthor %s\ncommitter %s\ngpgsig -----BEGIN PGP SIGNATURE-----\n x\n -----END PGP SIGNATURE-----\n\nsigned\n' \
  "$tree" "$parent" "$who" "$who" | git hash-object -t commit -w --stdin)"
git update-ref HEAD "$signed"
printf '#!/bin/sh\necho GPG_RAN >&2\nexit 1\n' > .git/gpg.sh
chmod 755 .git/gpg.sh
git config gpg.program /restore/.git/gpg.sh  # where the inspection mounts the volume
git config log.showSignature true
git config core.fsmonitor 'echo FSMONITOR_RAN >&2; false'
touch "f${esc}" "g${esc}"
git add "g${esc}"
chown -R 1000:1000 /data
'''


def inspection_block():
    text = (ROOT / 'docs/operations.md').read_text()
    blocks = [b for b in re.findall(r'```bash\n(.*?)```', text, re.S) if 'target=/restore,readonly' in b]
    assert len(blocks) == 1, 'one inspection block in docs/operations.md'
    lines = blocks[0].splitlines()
    indent = min(len(line) - len(line.lstrip()) for line in lines if line.strip())
    return '\n'.join(line[indent:] for line in lines) + '\n'


def run_shell(script):
    r = subprocess.run(['bash', '-c', script], capture_output=True, timeout=120)
    return r.returncode, r.stdout + r.stderr


def main():
    volume = 'fnkc.restore.inspection-test-' + uuid.uuid4().hex[:8]
    block = inspection_block()
    resolve = '$(sudo fnkc-ctl admin resolve-image <approved-image@sha256:...>)'
    source = re.compile(r'source=fnkc\.restore\.[^,]*,target=/restore,')
    assert resolve in block and len(source.findall(block)) == 1, block
    # The helper image is resolved by fnkc-ctl on a host (backup-integration.py tests that); here it is the test image
    script = source.sub('source=' + volume + ',target=/restore,', block.replace(resolve, IMAGE)).replace('sudo docker ', 'docker ')
    assert '<' not in script.replace('2>&1', '') and 'sudo' not in script, script
    try:
        subprocess.run(['docker', 'volume', 'create', volume], check=True, capture_output=True, timeout=30)
        subprocess.run(['docker', 'run', '--rm', '--network', 'none', '-v', volume + ':/data', '--entrypoint', 'sh', IMAGE,
                        '-c', FIXTURE], check=True, capture_output=True, timeout=120)

        # Control: the same sandbox with plain ls and git runs the volume's programs and prints raw escapes
        control = ('docker run --rm --pull never --network none --read-only --tmpfs /tmp -e HOME=/tmp --cap-drop ALL '
                   '--security-opt no-new-privileges --user analyst '
                   f'--mount type=volume,source={volume},target=/restore,readonly --entrypoint sh {IMAGE} -c '
                   '\'ls -la /restore; git -c safe.directory=/restore -C /restore log -1 --format="%H %an %ad"; '
                   'git -c safe.directory=/restore -C /restore status --short | head -50\' 2>&1')
        _, out = run_shell(control)
        assert b'FSMONITOR_RAN' in out and b'GPG_RAN' in out and b'\x1b' in out, out

        code, out = run_shell(script)
        assert code == 0, out
        assert b'FSMONITOR_RAN' not in out and b'GPG_RAN' not in out, out
        assert b'\x1b' not in out and b'\x07' not in out, out
        # The names are still shown, escaped: the author through cat -v, the files by ls -b and git's quoting
        assert b'ev^[]0;x^Gil' in out and b'f\\033]0;x\\a' in out, out
        assert re.search(rb'^[0-9a-f]{40} ev', out, re.M) and b'A  "g\\033]0;x\\a"' in out, out
        print('PASS: the documented restore inspection runs no program from the volume (core.fsmonitor, gpg.program) '
              'and prints no raw terminal escape')
    finally:
        subprocess.run(['docker', 'volume', 'rm', volume], capture_output=True, timeout=30)


if __name__ == '__main__':
    main()
