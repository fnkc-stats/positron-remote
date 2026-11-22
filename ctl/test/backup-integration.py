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
IMAGE = os.environ.get('FNKC_BACKUP_TEST_IMAGE', 'ghcr.io/fnkc-stats/r-env@sha256:13f9a16cc0fdae21e96a08d3fb7b1e937360de80991c0318ac7dda512514e24d')
RESTIC = 'restic/restic@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510'


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=120, **kwargs).stdout.strip()


def main():
    ident = 'fnkc-backup-test-' + uuid.uuid4().hex[:8]
    volumes = [ident + '-source', ident + '-restic', ident + '-restore', ident + '-retry', ident + '-never']
    with tempfile.TemporaryDirectory(prefix='fnkc-backup-test-') as tmp:
        tmp = Path(tmp)
        wrapper = tmp / 'restic'
        wrapper.write_text('#!/bin/sh\nexec docker run --rm -i --network none -e RESTIC_PASSWORD -e RESTIC_REPOSITORY=/repo '
                           + '-v ' + shlex.quote(volumes[1] + ':/repo') + ' ' + shlex.quote(RESTIC) + ' "$@"\n')
        wrapper.chmod(0o700)
        # The helper image is resolved by the built fnkc-ctl under this host configuration (no provenance requirement)
        repo = IMAGE.split('@')[0]
        staging = tmp / 'staging'
        config = tmp / 'agent.json'
        config.write_text(json.dumps({'allowedImages': [repo], 'imageStagingDir': str(staging), 'verifiedDir': str(tmp / 'verified')}))
        env = {**os.environ, 'PATH': str(tmp) + os.pathsep + os.environ['PATH'], 'RESTIC_REPOSITORY': '/repo',
               'RESTIC_PASSWORD': 'disposable-fixture-password', 'FNKC_BACKUP_LOCK_DIR': str(tmp / 'locks'),
               'FNKC_CTL': str(ROOT / 'dist/fnkc-ctl.cjs'), 'FNKC_CTL_AGENT_CONFIG': str(config)}
        # Uploaded images are known by the tag <repository>:sha256-<hex>; the agent records the image ID it loaded
        uploaded = repo + '@sha256:' + 'e' * 64
        uploaded_tag = repo + ':sha256-' + 'e' * 64
        moved = repo + '@sha256:' + 'f' * 64
        moved_tag = repo + ':sha256-' + 'f' * 64
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
            # A failed restore (here: a wrong archive name) leaves no target behind; the corrected command then works
            failed = subprocess.run([str(ROOT / 'server/volume-backup.sh'), 'restore', snapshot, '/no-such.tar', volumes[3], IMAGE],
                                    env=env, capture_output=True, text=True, timeout=60)
            assert failed.returncode != 0 and 'Restore failed' in failed.stderr, failed.stderr
            assert subprocess.run(['docker', 'volume', 'inspect', volumes[3]], capture_output=True, timeout=30).returncode != 0
            run([str(ROOT / 'server/volume-backup.sh'), 'restore', snapshot, '/' + volumes[0] + '.tar', volumes[3], IMAGE], env=env)

            # The helper runs an uploaded image only while its tag still names the image ID recorded at upload
            image_id = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', IMAGE])
            restic_id = run(['docker', 'image', 'inspect', '--format', '{{.Id}}', RESTIC])
            run(['docker', 'tag', image_id, uploaded_tag])
            run(['docker', 'tag', restic_id, moved_tag])
            (staging / 'loaded').mkdir(parents=True)
            (staging / 'loaded' / ('e' * 64)).write_text(image_id + '\n')
            run([str(ROOT / 'server/volume-backup.sh'), 'backup', volumes[0], uploaded], env=env)
            refused = [
                (moved, 'not the image'),  # the tag was moved to another image after the upload
                (repo + '@sha256:' + 'd' * 64, 'not on this host'),
                ('ghcr.io/evil/r-env@sha256:' + 'e' * 64, 'not allowed'),
            ]
            (staging / 'loaded' / ('f' * 64)).write_text(image_id + '\n')
            for image, why in refused:
                r = subprocess.run([str(ROOT / 'server/volume-backup.sh'), 'backup', volumes[0], image],
                                   env=env, capture_output=True, text=True, timeout=60)
                assert r.returncode != 0 and why in r.stderr, (image, r.stderr)
            (staging / 'loaded' / ('f' * 64)).unlink()
            r = subprocess.run([str(ROOT / 'server/volume-backup.sh'), 'restore', snapshot, '/' + volumes[0] + '.tar',
                                volumes[4], moved], env=env, capture_output=True, text=True, timeout=60)
            assert r.returncode != 0 and 'no record' in r.stderr, r.stderr
            assert len(json.loads(run([str(wrapper), 'snapshots', '--json'], env=env))) == 2, 'only the verified backups ran'
            print('PASS: encrypted restic backup/check/restore, UID/mode preservation, existing target refused, failed restore retried, '
                  'helper image resolved to its recorded ID (moved, missing, unrecorded and disallowed images refused)')
        finally:
            for tag in (uploaded_tag, moved_tag):
                subprocess.run(['docker', 'image', 'rm', tag], capture_output=True, timeout=30)
            for volume in volumes:
                subprocess.run(['docker', 'volume', 'rm', volume], capture_output=True, timeout=30)


if __name__ == '__main__':
    main()
