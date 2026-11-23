#!/usr/bin/env python3
"""Test the actual encrypted backup/restore path using disposable volumes and a local restic repository."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
IMAGE = os.environ.get('FNKC_BACKUP_TEST_IMAGE', 'ghcr.io/fnkc-stats/r-env@sha256:13f9a16cc0fdae21e96a08d3fb7b1e937360de80991c0318ac7dda512514e24d')
RESTIC = 'restic/restic@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510'


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=120, **kwargs).stdout.strip()


def main():
    suffix = 'backup-test-' + uuid.uuid4().hex[:8]
    ident = 'fnkc-' + suffix
    # Restore targets live in the staging namespace fnkc.restore.<name> (volume-backup.sh refuses any other name)
    staged = 'fnkc.restore.' + suffix
    volumes = [ident + '-source', staged + '-restore', staged + '-retry', staged + '-never']
    with tempfile.TemporaryDirectory(prefix='fnkc-backup-test-') as tmp:
        tmp = Path(tmp)
        # Restic invokes the Docker CLI on the host and observes the tar helper's exit status.
        run(['docker', 'pull', '-q', RESTIC])
        if sys.platform.startswith('linux'):
            container = run(['docker', 'create', RESTIC])
            try:
                run(['docker', 'cp', container + ':/usr/bin/restic', str(tmp / 'restic')])
            finally:
                run(['docker', 'rm', container])
        elif not shutil.which('restic'):
            raise RuntimeError('Install restic 0.17 or newer to run the backup fixture on this host.')
        # The helper image is resolved by the built fnkc-ctl under this host configuration (no provenance requirement)
        repo = IMAGE.split('@')[0]
        staging = tmp / 'staging'
        config = tmp / 'agent.json'
        config.write_text(json.dumps({'allowedImages': [repo], 'imageStagingDir': str(staging), 'verifiedDir': str(tmp / 'verified')}))
        env = {**os.environ, 'PATH': str(tmp) + os.pathsep + os.environ['PATH'], 'RESTIC_REPOSITORY': str(tmp / 'repo'), 'RESTIC_CACHE_DIR': str(tmp / 'cache'),
               'RESTIC_PASSWORD': 'disposable-fixture-password', 'FNKC_BACKUP_LOCK_DIR': str(tmp / 'locks'),
               'FNKC_CTL': str(ROOT / 'dist/fnkc-ctl.cjs'), 'FNKC_CTL_AGENT_CONFIG': str(config)}
        # Uploaded images are known by the tag <repository>:sha256-<hex>; the agent records the image ID it loaded
        uploaded = repo + '@sha256:' + 'e' * 64
        uploaded_tag = repo + ':sha256-' + 'e' * 64
        moved = repo + '@sha256:' + 'f' * 64
        moved_tag = repo + ':sha256-' + 'f' * 64
        try:
            run(['docker', 'volume', 'create', volumes[0]])
            run(['docker', 'run', '--rm', '--network', 'none', '-v', volumes[0] + ':/data', '--entrypoint', 'sh', IMAGE,
                 '-c', 'printf PRIVATE_FIXTURE > /data/result.txt; chown 1000:1000 /data/result.txt; chmod 600 /data/result.txt; '
                 + 'mkdir /data/sub; printf x > /data/sub/f; ln /data/sub/f /data/sub/g; chown -R 1000:1000 /data/sub; '
                 + 'chmod 400 /data/sub/f; chmod 500 /data/sub; '
                 + 'printf x > /data/suid; mkdir /data/sgid; chown 1000:1000 /data/suid /data/sgid; chmod 4755 /data/suid; chmod 2755 /data/sgid'])
            run(['restic', 'init'], env=env)
            # Docker writes part of the tar stream before it reports a producer failure.
            docker = tmp / 'docker'
            real_docker = shutil.which('docker')
            assert real_docker
            docker.write_text('#!/bin/sh\ncase " $* " in *" --entrypoint tar "*) '
                              'printf partial-archive; echo producer-failed >&2; exit 1;; esac\n'
                              'exec ' + shlex.quote(real_docker) + ' "$@"\n')
            docker.chmod(0o700)
            failed = subprocess.run([str(ROOT / 'server/volume-backup.sh'), 'backup', volumes[0], IMAGE],
                                    env=env, capture_output=True, text=True, timeout=120)
            assert failed.returncode != 0 and 'producer-failed' in failed.stderr, failed.stderr
            assert not json.loads(run(['restic', 'snapshots', '--json'], env=env)), 'partial snapshot survived'
            docker.unlink()
            run([str(ROOT / 'server/volume-backup.sh'), 'backup', volumes[0], IMAGE], env=env)
            snapshots = json.loads(run(['restic', 'snapshots', '--json'], env=env))
            assert len(snapshots) == 1
            assert set(snapshots[0]['tags']) == {'fnkc', volumes[0]}, snapshots
            snapshot = snapshots[0]['id']
            run(['restic', 'check'], env=env)
            run([str(ROOT / 'server/volume-backup.sh'), 'restore', snapshot, '/' + volumes[0] + '.tar', volumes[1], IMAGE], env=env)
            result = run(['docker', 'run', '--rm', '--network', 'none', '--user', '1000:1000',
                          '-v', volumes[1] + ':/data:ro', '--entrypoint', 'cat', IMAGE, '/data/result.txt'])
            assert result == 'PRIVATE_FIXTURE'
            label = run(['docker', 'volume', 'inspect', '--format', '{{index .Labels "fnkc.restore"}}', volumes[1]])
            assert label == snapshot + ':/' + volumes[0] + '.tar', label
            # Owners and modes survive a restore by a helper with only CHOWN, FOWNER and DAC_OVERRIDE
            modes = run(['docker', 'run', '--rm', '--network', 'none', '-v', volumes[1] + ':/data:ro', '--entrypoint', 'stat',
                         IMAGE, '-c', '%n %u:%g %a', '/data/result.txt', '/data/sub', '/data/sub/f'])
            assert modes.splitlines() == ['/data/result.txt 1000:1000 600', '/data/sub 1000:1000 500', '/data/sub/f 1000:1000 400'], modes
            # A hardlink inside the 0500 directory is restored (tar needs DAC_OVERRIDE there) and still shares the inode
            links = run(['docker', 'run', '--rm', '--network', 'none', '-v', volumes[1] + ':/data:ro', '--entrypoint', 'stat',
                         IMAGE, '-c', '%n %i %h', '/data/sub/f', '/data/sub/g'])
            (f_name, f_ino, f_links), (g_name, g_ino, g_links) = (line.split() for line in links.splitlines())
            assert f_ino == g_ino and f_links == g_links == '2', links
            # Set-ID bits never survive a restore, although FOWNER would let tar put them back after chown
            setid = run(['docker', 'run', '--rm', '--network', 'none', '-v', volumes[1] + ':/data:ro', '--entrypoint', 'stat',
                         IMAGE, '-c', '%n %u:%g %a', '/data/suid', '/data/sgid'])
            assert setid.splitlines() == ['/data/suid 1000:1000 755', '/data/sgid 1000:1000 755'], setid
            again = subprocess.run([str(ROOT / 'server/volume-backup.sh'), 'restore', snapshot,
                                    '/' + volumes[0] + '.tar', volumes[1], IMAGE], env=env, capture_output=True, text=True, timeout=30)
            assert again.returncode != 0 and 'already exists' in again.stderr
            # A failed restore (here: a wrong archive name) leaves no target behind; the corrected command then works
            failed = subprocess.run([str(ROOT / 'server/volume-backup.sh'), 'restore', snapshot, '/no-such.tar', volumes[2], IMAGE],
                                    env=env, capture_output=True, text=True, timeout=60)
            assert failed.returncode != 0 and 'Restore failed' in failed.stderr, failed.stderr
            assert subprocess.run(['docker', 'volume', 'inspect', volumes[2]], capture_output=True, timeout=30).returncode != 0
            run([str(ROOT / 'server/volume-backup.sh'), 'restore', snapshot, '/' + volumes[0] + '.tar', volumes[2], IMAGE], env=env)

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
                                volumes[3], moved], env=env, capture_output=True, text=True, timeout=60)
            assert r.returncode != 0 and 'no record' in r.stderr, r.stderr
            assert len(json.loads(run(['restic', 'snapshots', '--json'], env=env))) == 2, 'only the verified backups ran'
            print('PASS: encrypted restic backup/check/restore, UID/mode/hardlink preservation under a capability-limited helper, set-ID bits stripped, existing target refused, failed restore retried, '
                  'helper image resolved to its recorded ID (moved, missing, unrecorded and disallowed images refused)')
        finally:
            for tag in (uploaded_tag, moved_tag):
                subprocess.run(['docker', 'image', 'rm', tag], capture_output=True, timeout=30)
            for volume in volumes:
                subprocess.run(['docker', 'volume', 'rm', volume], capture_output=True, timeout=30)


if __name__ == '__main__':
    main()
