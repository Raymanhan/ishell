"""Exercise the exact remote runner/job scripts on disposable local paths."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

SOURCE = Path(__file__).resolve().parents[1] / 'src-tauri/src/ai'
JOB = (SOURCE / 'job.py').read_text()
RUNNER = (SOURCE / 'runner.py').read_text()


class RemoteTools(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='ishell-ai-tests-')
        self.root = Path(self.directory.name)
        self.jobs = []

    def job(self, action, job_id, **extra):
        payload = json.dumps(dict(action=action, job=job_id, **extra))
        script = 'import json\npayload=json.loads(' + repr(payload) + ')\n' + JOB
        return json.loads(subprocess.check_output([sys.executable, '-c', script], text=True))

    def start(self, name, args, runner=RUNNER):
        job_id = str(uuid.uuid4())
        self.jobs.append(job_id)
        self.job('start', job_id, input=dict(name=name, args=args), runner=runner)
        return job_id

    def wait(self, job_id, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = self.job('poll', job_id)
            if result['status'] == 'done': return result
            time.sleep(.08)
        self.fail('runner did not exit')

    def tearDown(self):
        for job_id in self.jobs:
            self.job('cancel', job_id)
            self.wait(job_id)
            self.job('clean', job_id)
        self.directory.cleanup()

    def test_stdout_stderr_exit_code_and_unicode(self):
        result = self.wait(self.start('shell', dict(command="printf '中文 output'; printf 'problem' >&2; exit 7", cwd=str(self.root))))
        self.assertEqual(result['stdout'], '中文 output')
        self.assertEqual(result['stderr'], 'problem')
        self.assertEqual(result['exitCode'], 7)

    def test_code_languages_and_working_directory(self):
        for language, code, text in [('python', 'import os; print(os.getcwd())', str(self.root)), ('shell', 'printf shell-ok', 'shell-ok')]:
            result = self.wait(self.start('run_code', dict(language=language, code=code, cwd=str(self.root))))
            self.assertEqual(result['stdout'].strip(), text)
            self.assertEqual(result['exitCode'], 0)
        if subprocess.run(['sh', '-c', 'command -v node'], capture_output=True).returncode == 0:
            result = self.wait(self.start('run_code', dict(language='javascript', code="console.log('node-ok')")))
            self.assertEqual(result['stdout'].strip(), 'node-ok')

    def test_atomic_file_write_preserves_permissions_and_symlink(self):
        path = self.root / '中文 ; $(false).txt'
        path.write_text('before')
        path.chmod(0o640)
        link = self.root / 'link'
        link.symlink_to(path)
        content = '配置\nline 2\n'
        result = self.wait(self.start('write_file', dict(path=str(link), content=content)))
        self.assertEqual(result['exitCode'], 0)
        self.assertTrue(link.is_symlink())
        self.assertEqual(path.stat().st_mode & 0o777, 0o640)
        result = self.wait(self.start('read_file', dict(path=str(path))))
        self.assertEqual(result['stdout'], content)

    def test_output_is_bounded_and_marked_truncated(self):
        result = self.wait(self.start('run_code', dict(language='python', code="print('a' * 1000000)")))
        self.assertEqual(len(result['stdout']), 16000)
        self.assertTrue(result['truncated'])
        self.assertEqual(result['exitCode'], 0)

    def test_timeout_kills_process_group(self):
        result = self.wait(self.start('shell', dict(command='sleep 20 & wait', timeout=1)))
        self.assertEqual(result['error'], '执行超时')
        self.assertNotEqual(result['exitCode'], 0)

    def test_cancellation_stops_child_before_it_can_write(self):
        sentinel = self.root / 'must-not-exist'
        job_id = self.start('run_code', dict(language='python', code=f"import time; time.sleep(3); open({str(sentinel)!r}, 'w').write('bad')"))
        self.job('cancel', job_id)
        result = self.wait(job_id)
        self.assertEqual(result['error'], '已停止执行')
        time.sleep(3.1)
        self.assertFalse(sentinel.exists())

    def test_missing_file_is_reported_as_failure(self):
        result = self.wait(self.start('read_file', dict(path=str(self.root / 'missing'))))
        self.assertEqual(result['exitCode'], 1)
        self.assertTrue(result['error'])

    def test_auto_approved_read_refuses_links_to_secrets(self):
        secret = self.root / '.ssh'
        secret.mkdir()
        (secret / 'id_rsa').write_text('PRIVATE KEY')
        link = self.root / 'notes.txt'
        link.symlink_to(secret / 'id_rsa')
        job_id = str(uuid.uuid4())
        self.jobs.append(job_id)
        self.job('start', job_id, runner=RUNNER,
                 input=dict(name='read_file', args=dict(path=str(link)), sensitivePatterns=['.ssh', 'id_rsa']))
        result = self.wait(job_id)
        self.assertEqual(result['exitCode'], 1)
        self.assertNotIn('PRIVATE', result['stdout'])
        self.assertIn('密钥', result['error'])
        # Without the guard (user approved or full access) the same read works.
        result = self.wait(self.start('read_file', dict(path=str(link))))
        self.assertEqual(result['stdout'], 'PRIVATE KEY')

    def test_missing_job_reports_done_and_stale_jobs_are_removed(self):
        result = self.job('cancel', str(uuid.uuid4()))
        self.assertEqual(result['status'], 'done')
        base = Path(tempfile.gettempdir()) / f'ishell-ai-{os.getuid()}'
        stale = base / str(uuid.uuid4())
        stale.mkdir(parents=True)
        (stale / 'input.json').write_text('{"secret": "left behind"}')
        old = time.time() - 7200
        for path in (stale / 'input.json', stale):
            os.utime(path, (old, old))
        fresh = self.start('shell', dict(command='true'))
        self.assertFalse(stale.exists())
        self.assertTrue((base / fresh).exists())

    def test_slow_file_io_can_timeout_or_be_canceled(self):
        path = self.root / 'file.slow'
        path.write_text('data')
        # Simulate a slow filesystem at the open boundary; exercise the actual
        # runner's timeout and cancel handlers rather than waiting on real NFS.
        runner = """import builtins, time
_original_open = builtins.open
def _slow_open(path, *args, **kwargs):
    if str(path).endswith('.slow'): time.sleep(10)
    return _original_open(path, *args, **kwargs)
builtins.open = _slow_open
""" + RUNNER
        result = self.wait(self.start('read_file', dict(path=str(path), timeout=1), runner))
        self.assertEqual(result['error'], '执行超时')
        job_id = self.start('read_file', dict(path=str(path)), runner)
        time.sleep(.2)
        self.job('cancel', job_id)
        result = self.wait(job_id)
        self.assertEqual(result['error'], '已停止执行')


if __name__ == '__main__':
    unittest.main()
