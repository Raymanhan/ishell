"""Executed on the remote server by job.py, never on the desktop."""
import json, os, selectors, signal, subprocess, sys, time

root = sys.argv[1]
LIMIT = 16000


def save(result):
    temp = root + '/state.tmp'
    with open(temp, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)
    os.replace(temp, root + '/state.json')


def expand(path):
    path = os.path.expanduser(path)
    if not os.path.isabs(path):
        raise ValueError('文件路径和工作目录必须是绝对路径或 ~/ 路径')
    return path


result = dict(status='running', stdout='', stderr='', exitCode=None, truncated=False)
file_watch = None
save(result)
try:
    with open(root + '/input.json', encoding='utf-8') as f:
        data = json.load(f)
    name, args = data['name'], data['args']
    if os.path.exists(root + '/cancel'):
        raise RuntimeError('已停止执行')
    if name in ('read_file', 'write_file'):
        import stat, threading
        def interrupt_file(signum, frame):
            raise RuntimeError('执行超时' if signum == signal.SIGALRM else '已停止执行')
        signal.signal(signal.SIGALRM, interrupt_file)
        signal.signal(signal.SIGUSR1, interrupt_file)
        signal.alarm(min(1800, max(1, int(args.get('timeout', 120)))))
        file_watch = threading.Event()
        def watch_file_cancel():
            while not file_watch.wait(0.1):
                if os.path.exists(root + '/cancel'):
                    os.kill(os.getpid(), signal.SIGUSR1)
                    return
        threading.Thread(target=watch_file_cancel, daemon=True).start()
        path = expand(args['path'])
        if os.path.exists(path) and not stat.S_ISREG(os.stat(path).st_mode):
            raise ValueError('仅支持普通文本文件，不读取设备、管道或目录')
    if name == 'read_file':
        patterns = data.get('sensitivePatterns') or []
        if patterns:
            # Auto-approved reads were classified by the requested name only;
            # refuse when a link resolves to something that looks like a secret.
            real = os.path.realpath(expand(args['path'])).lower()
            if any(pattern in real for pattern in patterns):
                raise PermissionError('该路径实际指向可能含密钥的文件，自动模式下未读取，需要用户确认')
        with open(expand(args['path']), encoding='utf-8', errors='replace') as f:
            text = f.read(LIMIT + 1)
        result.update(stdout=text[:LIMIT], truncated=len(text) > LIMIT, exitCode=0)
    elif name == 'write_file':
        path = os.path.realpath(expand(args['path']))
        # Same-directory temporary file + rename: readers see a complete file.
        # Preserve an existing file's mode; new files use 0600 until chmod requested.
        import tempfile, stat
        previous = os.stat(path) if os.path.exists(path) else None
        old_mode = stat.S_IMODE(previous.st_mode) if previous else 0o600
        fd, temp = tempfile.mkstemp(prefix='.ishell-ai-', dir=os.path.dirname(path))
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                f.write(args['content'])
            os.chmod(temp, old_mode)
            if previous and os.geteuid() == 0:
                os.chown(temp, previous.st_uid, previous.st_gid)
            os.replace(temp, path)
        finally:
            if os.path.exists(temp): os.unlink(temp)
        result.update(stdout='已写入 ' + path, exitCode=0)
    else:
        cwd = expand(args.get('cwd') or '~')
        if name == 'shell':
            argv = ['sh', '-lc', args['command']]
        elif name == 'run_code':
            language = args['language']
            codepath = root + '/code.' + {'python': 'py', 'shell': 'sh', 'javascript': 'js'}[language]
            with open(codepath, 'w', encoding='utf-8') as f: f.write(args['code'])
            argv = [{'python': 'python3', 'shell': 'sh', 'javascript': 'node'}[language], codepath]
        else:
            raise ValueError('未知工具：' + name)
        process = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True)
        with open(root + '/pid', 'w') as f: f.write(str(process.pid))
        deadline = time.monotonic() + min(1800, max(1, int(args.get('timeout', 120))))
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
        selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
        stopped = False
        while selector.get_map() or process.poll() is None:
            if not stopped and (os.path.exists(root + '/cancel') or time.monotonic() >= deadline):
                stopped = True
                result['error'] = '已停止执行' if os.path.exists(root + '/cancel') else '执行超时'
                try: os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError: pass
            for key, _ in selector.select(0.15):
                chunk = os.read(key.fileobj.fileno(), 8192)
                if not chunk:
                    selector.unregister(key.fileobj)
                else:
                    # Keep a bounded byte buffer so UTF-8 characters split over reads survive.
                    field = key.data
                    buf = getattr(key.fileobj, '_ishell_tail', b'') + chunk
                    if len(buf) > LIMIT * 4:
                        result['truncated'] = True
                        buf = buf[-LIMIT * 4:]
                    key.fileobj._ishell_tail = buf
                    text = buf.decode('utf-8', errors='replace')
                    if len(text) > LIMIT: result['truncated'] = True
                    result[field] = text[-LIMIT:]
            save(result)
        result['exitCode'] = process.wait()
except Exception as error:
    result.update(error=str(error), exitCode=1)
finally:
    if file_watch is not None:
        file_watch.set()
        signal.alarm(0)
    result['status'] = 'done'
    save(result)
