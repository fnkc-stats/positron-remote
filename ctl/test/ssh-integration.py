#!/usr/bin/env python3
"""Disposable SSH/broker regression test. Never mounts a host Docker socket or project volume."""
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
IMAGE = os.environ.get('POSITRON_TEST_IMAGE', 'r-env:verified')


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=60, **kwargs).stdout.strip()


def forward(port, key, user):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        local = sock.getsockname()[1]
    proc = subprocess.Popen(['ssh', '-N', '-F', '/dev/null', '-i', str(key), '-o', 'IdentitiesOnly=yes',
                             '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
                             '-p', str(port), '-L', f'127.0.0.1:{local}:127.0.0.1:23456', user + '@127.0.0.1'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for _ in range(50):
            if proc.poll() is not None:
                raise RuntimeError(proc.stderr.read().decode())
            try:
                with socket.create_connection(('127.0.0.1', local), timeout=2) as sock:
                    return sock.recv(64).decode().strip()
            except ConnectionRefusedError:
                time.sleep(.1)
        raise RuntimeError('forward never became ready')
    finally:
        proc.terminate()
        proc.communicate(timeout=10)


def main():
    name = 'positron-test-' + uuid.uuid4().hex[:10]
    with tempfile.TemporaryDirectory(prefix='positron-ssh-test-') as tmp:
        tmp = Path(tmp)
        key = tmp / 'key'
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)])
        (tmp / 'key.pub').chmod(0o644)
        setup = tmp / 'setup'
        setup.mkdir()
        (setup / 'projects.sh').write_text((ROOT / 'container/positron-projects.sh').read_text())
        (setup / 'public').write_text(key.with_suffix('.pub').read_text())
        (setup / 'mock.py').write_text("import socket\ns=socket.socket();s.bind(('127.0.0.1',23456));s.listen()\nwhile True:\n c,_=s.accept();c.sendall(b'MOCK_ONLY\\n');c.close()\n")
        (setup / 'start.sh').write_text(r'''#!/bin/sh
set -eu
useradd -m -s /bin/sh gateway
for user in analyst gateway; do
 install -d -m 700 -o "$user" -g "$user" /home/"$user"/.ssh
 cp /tmp/setup/public /home/"$user"/.ssh/authorized_keys
 chown "$user:$user" /home/"$user"/.ssh/authorized_keys
 chmod 600 /home/"$user"/.ssh/authorized_keys
done
sed -i 's/^/command="\/bin\/false",restrict /' /home/gateway/.ssh/authorized_keys
printf 'Match User gateway\n DisableForwarding yes\nMatch all\n' > /etc/ssh/sshd_config.d/00-test.conf
ssh-keygen -A >/dev/null
mkdir -p /run/sshd
python3 /tmp/setup/mock.py &
exec /usr/sbin/sshd -D -e -o 'AllowUsers=analyst gateway'
''')
        try:
            run(['docker', 'create', '--name', name, '--memory', '256m', '--pids-limit', '64',
                 '-p', '127.0.0.1::22', '--entrypoint', 'sh', IMAGE, '/tmp/setup/start.sh'])
            run(['docker', 'cp', str(setup), name + ':/tmp/setup'])
            run(['docker', 'start', name])
            info = json.loads(run(['docker', 'inspect', name]))[0]
            port = int(info['NetworkSettings']['Ports']['22/tcp'][0]['HostPort'])
            for _ in range(50):
                try:
                    host_key = run(['docker', 'exec', name, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'])
                    break
                except subprocess.CalledProcessError:
                    time.sleep(.1)
            else:
                raise RuntimeError('sshd did not initialize')
            time.sleep(.5)
            assert forward(port, key, 'analyst') == 'MOCK_ONLY'
            assert forward(port, key, 'gateway') == ''
            keys = tmp / 'keys'; keys.mkdir()
            (keys / 'alice.pub').write_text(key.with_suffix('.pub').read_text())
            fake = tmp / 'docker.py'
            fake.write_text('''import json, sys
name=sys.argv[-1]
project=name.removeprefix('positron-alice-')
print(json.dumps([{'Name': '/'+name, 'Config': {'Labels': {'positron.managed':'1', 'positron.user': 'bob' if project=='forbidden' else 'alice', 'positron.project':project}}, 'State':{'Running':True}, 'NetworkSettings':{'Ports':{'22/tcp':[{'HostIp':'127.0.0.1','HostPort':''' + repr(str(port)) + '''}]}}}]))
''')
            cfg = tmp / 'agent.json'
            cfg.write_text(json.dumps({'keysDir': str(keys), 'docker': [sys.executable, str(fake)], 'lockDir': str(tmp / 'locks')}))
            known = tmp / 'known_hosts'; known.write_text('test-container ' + host_key + '\n')

            def ssh(project, command):
                proxy = shlex.join(['env', 'SSH_ORIGINAL_COMMAND=positron-ctl agent connect ' + project,
                                    'node', str(ROOT / 'dist/positron-ctl.cjs'), 'serve', '--user', 'alice', '--agent-config', str(cfg)])
                return ['ssh', '-F', '/dev/null', '-i', str(key), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
                        '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlias=test-container',
                        '-o', 'UserKnownHostsFile=' + str(known), '-o', 'ProxyCommand=' + proxy,
                        'analyst@127.0.0.1', command]

            assert run(ssh('owned', 'printf BROKER_OK')) == 'BROKER_OK'
            status = run(ssh('owned', '''set -eu
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT; cd "$d"
git init -q; git config user.email test@example.invalid; git config user.name test
git-crypt init; echo a > a; git add a; git commit -qm initial
sh /tmp/setup/projects.sh status | grep 'Data: unlocked'
git-crypt lock
sh /tmp/setup/projects.sh status | grep 'Data: locked or unencrypted'
'''))
            assert 'Data: unlocked' in status and 'Data: locked or unencrypted' in status
            denied = subprocess.run(ssh('forbidden', 'true'), capture_output=True, text=True, timeout=15)
            assert denied.returncode != 0 and 'not owned' in denied.stderr
            session = subprocess.Popen(ssh('owned', 'echo CONNECTED; sleep 30'), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                assert session.stdout.readline().strip() == b'CONNECTED'
                (keys / 'alice.pub').unlink()
                assert session.wait(timeout=12) != 0
            finally:
                if session.poll() is None:
                    session.terminate()
                session.communicate(timeout=5)
            # install-server: the forced command passes a Positron server archive from raw stdin to the install
            # helper unchanged (no JSON request limit or timeout). The fake docker records what the helper receives.
            (keys / 'alice.pub').write_text(key.with_suffix('.pub').read_text())
            got = tmp / 'received.bin'
            fake_install = tmp / 'docker-install.py'
            fake_install.write_text('''import json, sys
args = sys.argv[1:]
if args[:2] == ['image', 'inspect']:
    print(json.dumps([{'Id': 'sha256:' + '1' * 64, 'Architecture': 'amd64'}])); sys.exit(0)
if any(a.startswith('test -x') for a in args): sys.exit(1)
if any('tar -xzf -' in a for a in args):
    open(''' + repr(str(got)) + ''', 'wb').write(sys.stdin.buffer.read()); sys.exit(0)
sys.exit(2)
''')
            cfg2 = tmp / 'agent-install.json'
            cfg2.write_text(json.dumps({'keysDir': str(keys), 'docker': [sys.executable, str(fake_install)], 'lockDir': str(tmp / 'locks')}))
            archive = tmp / 'archive.tar.gz'
            archive.write_bytes(os.urandom(5 * 1024 * 1024))
            image = 'ghcr.io/fnkc-stats/r-env@sha256:' + 'a' * 64
            def install(command):
                with open(archive, 'rb') as f:
                    return subprocess.run(['node', str(ROOT / 'dist/positron-ctl.cjs'), 'serve', '--user', 'alice', '--agent-config', str(cfg2)],
                                          stdin=f, capture_output=True, text=True, timeout=60,
                                          env={**os.environ, 'SSH_ORIGINAL_COMMAND': command})
            r = install('positron-ctl agent install-server ' + 'e' * 40 + ' ' + image)
            assert r.returncode == 0 and json.loads(r.stdout.strip().splitlines()[-1]) == {'ok': True, 'result': {'installed': True}}, r.stdout + r.stderr
            assert got.read_bytes() == archive.read_bytes(), 'archive changed in transit'
            r = install('positron-ctl agent install-server ' + 'e' * 40 + ' evil.example/r-env@sha256:' + 'a' * 64)
            assert r.returncode != 0 and 'not allowed' in r.stdout + r.stderr, r.stdout + r.stderr
            print('PASS: gateway forwarding denied; broker SSH succeeds; git-crypt state verified; foreign ownership denied; revocation closes active transport; install-server streams the archive unchanged and refuses unapproved images')
        finally:
            subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=30)


if __name__ == '__main__':
    import sys
    main()
