#!/usr/bin/env python3
"""Operator-only real-data renderer. Run on a dedicated runner, never from an unreviewed PR workflow.

Approval: /etc/positron-ctl/approvals/<id>.json, owned by root, not group/world-writable.
Fields: repository (local bare mirror), commit (40 hex), image (digest), data (read-only
snapshot directory), dataVersion (immutable snapshot identifier), document (relative .qmd).
Outputs and logs remain private in /var/lib/positron-reports/<unique-run-id>.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid


def run(args, **kwargs):
    return subprocess.run(args, check=True, timeout=kwargs.pop('timeout', 120), **kwargs)


def root_file(path):
    st = path.stat()
    if st.st_uid != 0 or st.st_mode & 0o022:
        raise ValueError(f'{path} must be root-owned and not group/world-writable')
    return path.read_bytes()


def local_image(image):
    """Docker's name for the pinned image on this host: the reference itself (pulled), or the tag positron-ctl
    gives an image a client uploaded (image-store.ts). Never pulls: the image must already be on the host."""
    name, digest = image.split('@')
    for ref in (image, re.sub(r':[^/:]+$', '', name) + ':' + digest.replace(':', '-')):
        if subprocess.run(['docker', 'image', 'inspect', ref], capture_output=True, timeout=30).returncode == 0:
            return ref
    raise ValueError('approved image is not on this host; open a project that pins it first')


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2 or not re.fullmatch(r'[a-zA-Z0-9_-]+', sys.argv[1]):
        raise ValueError('usage (root only): render-reviewed.py <approval-id>')
    os.umask(0o077)
    approval_path = Path('/etc/positron-ctl/approvals') / (sys.argv[1] + '.json')
    root_file(approval_path.parent / '..' / 'agent.json')
    if approval_path.parent.stat().st_uid != 0 or approval_path.parent.stat().st_mode & 0o022:
        raise ValueError('approval directory must be root-owned and not writable by other users')
    raw = root_file(approval_path)
    a = json.loads(raw)
    if not re.fullmatch(r'[0-9a-f]{40}', a['commit']):
        raise ValueError('approval requires an exact commit')
    if not re.fullmatch(r'[a-z0-9][a-z0-9./:_-]+@sha256:[0-9a-f]{64}', a['image']):
        raise ValueError('approval requires an immutable image digest')
    policy = json.loads(root_file(Path('/etc/positron-ctl/agent.json')))
    if a['image'].split('@')[0] not in policy['allowedImages']:
        raise ValueError('image repository is not approved')
    doc = a['document']
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_./-]*\.qmd', doc) or '..' in Path(doc).parts:
        raise ValueError('document must be a relative .qmd path')
    repo, data = Path(a['repository']).resolve(), Path(a['data']).resolve()
    if not repo.is_dir() or not data.is_dir() or not a['dataVersion']:
        raise ValueError('repository and immutable data snapshot are required')
    manifest = run(['git', '-C', str(repo), 'show', a['commit'] + ':container.json'], capture_output=True).stdout
    if json.loads(manifest)['image'] != a['image']:
        raise ValueError('approved image differs from the approved code manifest')
    image = local_image(a['image'])
    ident = 'positron-report-' + uuid.uuid4().hex
    output = Path('/var/lib/positron-reports') / ident
    output.mkdir(parents=True, mode=0o700)
    volume = ident + '-work'
    created = False
    try:
        run(['docker', 'volume', 'create', volume], stdout=subprocess.DEVNULL)
        with (output / 'job.log').open('wb') as log:
            # Git archive omits .git and its stored credentials. The archive is unpacked only in Docker.
            archive = subprocess.Popen(['git', '-C', str(repo), 'archive', a['commit']], stdout=subprocess.PIPE, stderr=log)
            try:
                run(['docker', 'run', '--rm', '-i', '--network', 'none', '--memory', '512m', '--cpus', '1',
                     '--pids-limit', '64', '--pull', 'never', '-v', volume + ':/work', '--entrypoint', 'sh', image,
                     '-c', 'tar -xf - -C /work && chown -R 1000:1000 /work'], stdin=archive.stdout, stdout=log, stderr=log)
            finally:
                archive.stdout.close()
                try:
                    code = archive.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    archive.kill()
                    archive.wait()
                    raise
            if code != 0:
                raise ValueError('could not archive approved commit')
            run(['docker', 'create', '--name', ident, '--pull', 'never', '--user', '1000:1000', '--network', 'none',
                 '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '4g',
                 '--memory-swap', '4g', '--cpus', '2', '--pids-limit', '256', '--log-driver', 'none',
                 '--tmpfs', '/tmp:rw,nosuid,size=512m', '-e', 'HOME=/tmp', '-e', 'TZ=UTC',
                 '-e', 'OMP_NUM_THREADS=2', '-e', 'OPENBLAS_NUM_THREADS=1',
                 '-v', volume + ':/work', '--mount', f'type=bind,source={data},target=/data,readonly',
                 '-w', '/work', '--entrypoint', 'quarto', image, 'render', doc, '--output-dir', '/work/output'],
                stdout=log, stderr=log)
            created = True
            run(['docker', 'start', '-a', ident], stdout=log, stderr=log, timeout=3600)
            exit_code = run(['docker', 'inspect', '--format', '{{.State.ExitCode}}', ident], capture_output=True).stdout.strip()
            if exit_code != b'0':
                raise ValueError('render failed; inspect the private job log')
            run(['docker', 'cp', ident + ':/work/output', str(output / 'artifacts')], stdout=log, stderr=log)
        (output / 'provenance.json').write_text(json.dumps({**a, 'approvalSha256': hashlib.sha256(raw).hexdigest()}, indent=2))
        print(f'Private report ready: {output}. Review before publication; no notification was sent.')
    finally:
        if created:
            subprocess.run(['docker', 'rm', '-f', ident], capture_output=True, timeout=30)
        subprocess.run(['docker', 'volume', 'rm', volume], capture_output=True, timeout=30)


if __name__ == '__main__':
    try:
        main()
    except (KeyError, ValueError, OSError, subprocess.SubprocessError) as exc:
        print(f'Render aborted: {exc}', file=sys.stderr)
        sys.exit(1)
