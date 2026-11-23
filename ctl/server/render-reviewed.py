#!/usr/bin/env python3
"""Operator-only real-data renderer. Run on a dedicated runner, never from an unreviewed PR workflow.

Approval: /etc/fnkc-ctl/approvals/<id>.json, owned by root, not group/world-writable.
Fields: repository (local bare mirror), commit (40 hex), image (digest), data (read-only
snapshot directory), dataVersion (immutable snapshot identifier), document (relative .qmd).
Outputs and logs remain private in /var/lib/fnkc-reports/<unique-run-id>.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid


def run(args, **kwargs):
    return subprocess.run(args, check=True, timeout=kwargs.pop('timeout', 120), **kwargs)


def check_root_owned(path):
    st = path.stat()
    if st.st_uid != 0 or st.st_mode & 0o022:
        raise ValueError(f'{path} must be root-owned and not group/world-writable')


def root_file(path):
    check_root_owned(path)
    return path.read_bytes()


AGENT_CONFIG = Path('/etc/fnkc-ctl/agent.json')
REPORTS = Path('/var/lib/fnkc-reports')
RESOLVER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'


def fnkc_ctl():
    """fnkc-ctl from this script's own release (not through the current link, which an install may switch meanwhile),
    run by the Node that install.sh checked and wrote into /usr/local/bin/fnkc-ctl. Unprivileged tests can override the bundle."""
    ctl = Path(__file__).resolve().with_name('fnkc-ctl.cjs')
    if os.geteuid() != 0:
        ctl = os.environ.get('FNKC_CTL', ctl)
    node = None
    try:
        m = re.search(r'^exec (/\S+) ', Path('/usr/local/bin/fnkc-ctl').read_text(), re.M)
        node = m and m.group(1)
    except OSError:
        pass
    if not node or not os.access(node, os.X_OK):
        node = shutil.which('node', path=RESOLVER_PATH if os.geteuid() == 0 else None)
    if not node:
        raise ValueError('node is required (the one fnkc-ctl runs with)')
    return [node, ctl]


def local_image(image):
    """Docker's immutable ID of the pinned image, resolved by fnkc-ctl (host-image.ts): an allowed repository,
    provenance verified on this host if required, and the local name still pointing at the image the digest names
    (for an upload, the image ID recorded when the agent loaded it). A tag alone is never trusted: the tag of an
    uploaded image can be moved to any image. Never pulls: the image must already be on the host."""
    args = [*fnkc_ctl(), 'admin', 'resolve-image', image]
    env = None
    if os.geteuid() == 0:
        args.extend(['--agent-config', str(AGENT_CONFIG)])
        env = {'PATH': RESOLVER_PATH}
    r = subprocess.run(args, env=env, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        why = r.stderr.strip().splitlines()
        why = re.sub(r'^Error: ', '', why[-1]) if why else f'fnkc-ctl exited with {r.returncode}'
        raise ValueError('approved image cannot be used: ' + why)
    ident = r.stdout.strip()
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', ident):
        raise ValueError(f'unexpected image ID for {image}: {ident!r}')
    return ident


def validate_artifacts(directory):
    if not stat.S_ISDIR(directory.lstat().st_mode):
        raise ValueError('render artifacts must be a directory')
    pending = [directory]
    while pending:
        for entry in pending.pop().iterdir():
            info = entry.lstat()
            if stat.S_ISDIR(info.st_mode):
                pending.append(entry)
            elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError(f'unsafe render artifact: {entry!r}')


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2 or not re.fullmatch(r'[a-zA-Z0-9_-]+', sys.argv[1]):
        raise ValueError('usage (root only): render-reviewed.py <approval-id>')
    os.umask(0o077)
    approval_path = AGENT_CONFIG.parent / 'approvals' / (sys.argv[1] + '.json')
    check_root_owned(approval_path.parent)
    raw = root_file(approval_path)
    a = json.loads(raw)
    if not re.fullmatch(r'[0-9a-f]{40}', a['commit']):
        raise ValueError('approval requires an exact commit')
    if not re.fullmatch(r'[a-z0-9][a-z0-9./:_-]+@sha256:[0-9a-f]{64}', a['image']):
        raise ValueError('approval requires an immutable image digest')
    policy = json.loads(root_file(AGENT_CONFIG))
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
    ident = 'fnkc-report-' + uuid.uuid4().hex
    output = REPORTS / ident
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
                     '--pids-limit', '64', '--read-only', '--log-driver', 'none', '--cap-drop', 'ALL',
                     '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
                     '--security-opt', 'no-new-privileges', '--pull', 'never', '-v', volume + ':/work', '--entrypoint', 'sh', image,
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
            with tempfile.TemporaryDirectory(dir=output) as staging:
                artifacts = Path(staging) / 'artifacts'
                run(['docker', 'cp', ident + ':/work/output', str(artifacts)], stdout=log, stderr=log)
                validate_artifacts(artifacts)
                artifacts.rename(output / 'artifacts')
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
