# Payload is prepended by the desktop. The random job ID is validated there.
import json, os, shutil, subprocess, sys, tempfile, time

# A runner stops itself after at most 1800 s and refreshes state.json while it
# runs, so anything untouched for an hour was abandoned (app crash, lost
# connection, unconfirmed stop) and may still hold code or file contents.
STALE_SECONDS = 3600

base = os.path.join(tempfile.gettempdir(), 'ishell-ai-' + str(os.getuid()))
if os.path.lexists(base):
    if os.path.islink(base) or os.stat(base).st_uid != os.getuid():
        raise ValueError('AI 临时目录所有者无效')
else:
    os.mkdir(base, 0o700)
os.chmod(base, 0o700)
root = os.path.join(base, payload['job'])
action = payload['action']
RUNNING = {'status': 'running', 'stdout': '', 'stderr': '', 'exitCode': None}


def remove_stale_jobs():
    now = time.time()
    for name in os.listdir(base):
        path = os.path.join(base, name)
        try:
            if os.path.islink(path) or not os.path.isdir(path):
                continue
            entries = [path] + [os.path.join(path, entry) for entry in os.listdir(path)]
            if now - max(os.lstat(entry).st_mtime for entry in entries) > STALE_SECONDS:
                shutil.rmtree(path, ignore_errors=True)
        except OSError:
            pass


if action == 'start':
    remove_stale_jobs()
    os.mkdir(root, 0o700)
    with open(root + '/input.json', 'w', encoding='utf-8') as f:
        json.dump(payload['input'], f, ensure_ascii=False)
    with open(root + '/runner.py', 'w', encoding='utf-8') as f:
        f.write(payload['runner'])
    with open(root + '/runner.log', 'wb') as log:
        subprocess.Popen([sys.executable, root + '/runner.py', root], stdin=subprocess.DEVNULL,
                         stdout=log, stderr=log, start_new_session=True, close_fds=True)
    print(json.dumps(RUNNING))
elif action == 'clean':
    shutil.rmtree(root, ignore_errors=True)
    print('{}')
elif not os.path.isdir(root):
    # Already cleaned (or removed as stale): nothing is running any more.
    print(json.dumps({'status': 'done', 'stdout': '', 'stderr': '', 'exitCode': None,
                      'error': '远端任务记录已不存在'}))
else:
    if action == 'cancel':
        with open(root + '/cancel', 'w') as f: f.write('stop')
    try:
        with open(root + '/state.json', encoding='utf-8') as f: print(f.read())
    except FileNotFoundError:
        print(json.dumps(RUNNING))
