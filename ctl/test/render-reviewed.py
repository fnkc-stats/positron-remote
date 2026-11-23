"""Exercise the report runner with temporary approval files and recorded Docker calls."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'server/render-reviewed.py'
spec = importlib.util.spec_from_file_location('renderer', SCRIPT)
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
IMAGE = 'ghcr.io/fnkc-stats/r-env@sha256:' + 'a' * 64
IMAGE_ID = 'sha256:' + 'b' * 64


class RenderTest(unittest.TestCase):
    def test_root_resolver(self):
        with patch.dict(os.environ, {'FNKC_CTL': '/unused', 'FNKC_CTL_AGENT_CONFIG': '/unused',
                                     'NODE_OPTIONS': '--help'}), patch.object(os, 'geteuid', return_value=0), \
                patch.object(renderer.shutil, 'which', return_value='/usr/bin/node'), \
                patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, IMAGE_ID)) as call:
            self.assertEqual(renderer.local_image(IMAGE), IMAGE_ID)
        args = call.call_args.args[0]
        self.assertEqual(args[1:], [SCRIPT.with_name('fnkc-ctl.cjs'), 'admin', 'resolve-image', IMAGE,
                                    '--agent-config', '/etc/fnkc-ctl/agent.json'])
        self.assertEqual(call.call_args.kwargs['env'], {'PATH': renderer.RESOLVER_PATH})

    def run_job(self, root, kind):
        config = root / 'agent.json'
        config.write_text(json.dumps({'allowedImages': [IMAGE.split('@')[0]]}))
        approvals = root / 'approvals'
        approvals.mkdir()
        (approvals / 'job.json').write_text(json.dumps(dict(commit='a' * 40, image=IMAGE, dataVersion='1',
                                                            document='doc.qmd', repository=str(root), data=str(root))))
        containers = []

        def run(args, **kwargs):
            out = b''
            if args[0] == 'git':
                out = json.dumps({'image': IMAGE}).encode()
            elif args[1] in ('run', 'create'):
                containers.append(args)
            elif args[1] == 'inspect':
                out = b'0'
            elif args[1] == 'cp':
                artifacts = Path(args[-1])
                subdir = artifacts / 'nested'
                subdir.mkdir(parents=True)
                report = subdir / 'report.html'
                report.touch()
                if kind == 'symlink':
                    (subdir / 'link').symlink_to(config)
                elif kind == 'hardlink':
                    os.link(report, subdir / 'link')
                elif kind == 'fifo':
                    os.mkfifo(subdir / 'fifo')
            return subprocess.CompletedProcess(args, 0, out)

        output = io.StringIO()
        with contextlib.ExitStack() as stack:
            for obj, name, value in [(renderer, 'AGENT_CONFIG', config), (renderer, 'REPORTS', root / 'reports'),
                                     (sys, 'argv', ['render-reviewed.py', 'job'])]:
                stack.enter_context(patch.object(obj, name, value))
            stack.enter_context(patch.object(os, 'geteuid', return_value=0))
            stack.enter_context(patch.object(renderer, 'check_root_owned'))
            stack.enter_context(patch.object(renderer, 'local_image', return_value=IMAGE_ID))
            stack.enter_context(patch.object(subprocess, 'run', side_effect=run))
            archive = stack.enter_context(patch.object(subprocess, 'Popen')).return_value
            archive.wait.return_value = 0
            stack.enter_context(contextlib.redirect_stdout(output))
            if kind == 'regular':
                renderer.main()
                self.assertIn('Private report ready', output.getvalue())
            else:
                with self.assertRaisesRegex(ValueError, 'unsafe render artifact'):
                    renderer.main()
                self.assertEqual(output.getvalue(), '')
                self.assertFalse(list((root / 'reports').glob('*/artifacts')))
        self.assertEqual([a[1] for a in containers], ['run', 'create'])
        for c in containers:
            for flag, value in [('--cap-drop', 'ALL'), ('--security-opt', 'no-new-privileges'),
                                ('--network', 'none'), ('--pull', 'never'), ('--log-driver', 'none')]:
                self.assertEqual(c[c.index(flag) + 1], value)
            self.assertIn('--read-only', c)
            self.assertEqual(c[c.index('--entrypoint') + 2], IMAGE_ID)
        self.assertEqual([containers[0][i + 1] for i, v in enumerate(containers[0]) if v == '--cap-add'],
                         ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'])
        self.assertNotIn('--cap-add', containers[1])

    def test_artifacts(self):
        for kind in ('regular', 'symlink', 'hardlink', 'fifo'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as d:
                self.run_job(Path(d), kind)


if __name__ == '__main__':
    unittest.main()
