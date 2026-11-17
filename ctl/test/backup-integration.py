#!/usr/bin/env python3
"""Test the actual encrypted backup/restore path using disposable volumes and a restic container."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
IMAGE = os.environ.get('POSITRON_BACKUP_TEST_IMAGE', 'ghcr.io/fnkc-stats/r-env@sha256:ef119546a3771b34a454015c1946a063ba617164abea26b9be3bb7a2952ea289')
RESTIC = 'restic/restic@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510'


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=120, **kwargs).stdout.strip()


def main():
    ident = 'positron-backup-test-' + uuid.uuid4().hex[:8]
    volumes = [ident + '-source', ident + '-restic', ident + '-restore']
    with tempfile.TemporaryDirectory(prefix='positron-backup-test-') as tmp:
        tmp = Path(tmp)
        wrapper = tmp / 'restic'
        wrapper.write_text('#!/bin/sh\nexec docker run --rm -i --network none -e RESTIC_PASSWORD -e RESTIC_REPOSITORY=/repo '
                           + '-v ' + shlex.quote(volumes[1] + ':/repo') + ' ' + shlex.quote(RESTIC) + ' "$@"\n')
        wrapper.chmod(0o700)
        env = {**os.environ, 'PATH': str(tmp) + os.pathsep + os.environ['PATH'], 'RESTIC_REPOSITORY': '/repo',
               'RESTIC_PASSWORD': 'disposable-fixture-password', 'POSITRON_BACKUP_LOCK_DIR': str(tmp / 'locks')}
        try:
            for volume in volumes[:2]:
                run(['docker', 'volume', 'create', volume])
            run(['docker', 'run', '--rm', '--network', 'none', '-v', volumes[0] + ':/data', '--entrypoint', 'sh', IMAGE,
                 '-c', 'printf PRIVATE_FIXTURE > /data/result.txt; chown 1000:1000 /data/result.txt; chmod 600 /data/result.txt'])
            run([str(wrapper), 'init'], env=env)
            run([str(ROOT / 'server/volume-backup.sh'), 'backup', volumes[0], IMAGE], env=env)
            snapshots = json.loads(run([str(wrapper), 'snapshots', '--json'], env=env))
            assert len(snapshots) == 1
            snapshot = snapshots[0]['id']
            run([str(wrapper), 'check'], env=env)
            run([str(ROOT / 'server/volume-backup.sh'), 'restore', snapshot, '/' + volumes[0] + '.tar', volumes[2], IMAGE], env=env)
            result = run(['docker', 'run', '--rm', '--network', 'none', '--user', '1000:1000',
                          '-v', volumes[2] + ':/data:ro', '--entrypoint', 'cat', IMAGE, '/data/result.txt'])
            assert result == 'PRIVATE_FIXTURE'
            again = subprocess.run([str(ROOT / 'server/volume-backup.sh'), 'restore', snapshot,
                                    '/' + volumes[0] + '.tar', volumes[2], IMAGE], env=env, capture_output=True, text=True, timeout=30)
            assert again.returncode != 0 and 'already exists' in again.stderr
            print('PASS: encrypted restic backup/check/restore, UID/mode preservation, existing target refused')
        finally:
            for volume in volumes:
                subprocess.run(['docker', 'volume', 'rm', volume], capture_output=True, timeout=30)


if __name__ == '__main__':
    main()
