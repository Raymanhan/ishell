# Payload is prepended by the desktop. The random job ID is validated there.
import json, os, shutil, subprocess, sys, tempfile, time

base = os.path.join(tempfile.gettempdir(), 'ishell-ai-' + str(os.getuid()))
if os.path.lexists(base):
    if os.path.islink(base) or os.stat(base).st_uid != os.getuid():
        raise ValueError('AI 临时目录所有者无效')
else:
    os.mkdir(base, 0o700)
os.chmod(base, 0o700)
root = os.path.join(base, payload['job'])
action = payload['action']
if action == 'start':
    os.mkdir(root, 0o700)
    with open(root + '/input.json', 'w', encoding='utf-8') as f:
        json.dump(payload['input'], f, ensure_ascii=False)
    with open(root + '/runner.py', 'w', encoding='utf-8') as f:
        f.write(payload['runner'])
    with open(root + '/runner.log', 'wb') as log:
        subprocess.Popen([sys.executable, root + '/runner.py', root], stdin=subprocess.DEVNULL,
                         stdout=log, stderr=log, start_new_session=True, close_fds=True)
    print(json.dumps({'status': 'running', 'stdout': '', 'stderr': '', 'exitCode': None}))
elif action == 'clean':
    shutil.rmtree(root, ignore_errors=True)
    print('{}')
else:
    if action == 'cancel':
        with open(root + '/cancel', 'w') as f: f.write('stop')
    try:
        with open(root + '/state.json', encoding='utf-8') as f: print(f.read())
    except FileNotFoundError:
        print(json.dumps({'status': 'running', 'stdout': '', 'stderr': '', 'exitCode': None}))
