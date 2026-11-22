#!/usr/bin/env python3
"""Run pnpm pi-web against real Pi RPC and isolated loopback fixtures (POSIX)."""
import argparse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import re
import signal
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
KEY = 'local-model-fixture-only'
MODEL = 'pi-web-fixture'
LAUNCH = re.compile(r'^http://127\.0\.0\.1:\d+/#access=([A-Za-z0-9_-]{43})$')


class ModelFixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        if self.path != '/v1/chat/completions' or self.headers.get('Authorization') != 'Bearer ' + KEY:
            self.send_error(401)
            return
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.requests.put(request)
        final_user = next((str(item['content']) for item in reversed(request.get('messages', [])) if item['role'] == 'user'), '')
        chunks = [('收到 ', None), ('Pi 本地回复。', 'stop')]
        if 'Hold for stop' in final_user:
            chunks = [('正在生成…', None)]
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        try:
            for text, finish_reason in chunks:
                data = dict(id='pi-web-fixture', object='chat.completion.chunk', created=1, model=request['model'],
                            choices=[dict(index=0, delta=dict(role='assistant', content=text), finish_reason=finish_reason)],
                            usage=dict(prompt_tokens=24, completion_tokens=8, total_tokens=32))
                self.wfile.write(f'data: {json.dumps(data)}\n\n'.encode())
                self.wfile.flush()
            if len(chunks) == 1:
                self.server.release.wait(30)
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def wait_until(check, label, timeout=35):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(.07)
    raise AssertionError(label)


class Web:
    def __init__(self, launch):
        self.link = launch
        self.origin = launch.partition('#')[0].rstrip('/')
        self.auth = {'Authorization': 'Bearer ' + LAUNCH.fullmatch(launch)[1]}

    def call(self, path, data=None, *, auth=True, expected=200):
        payload = None if data is None else json.dumps(data).encode()
        req = urllib.request.Request(self.origin + '/api/pi-web/' + path, data=payload,
                                     headers=({'Content-Type': 'application/json'} if data is not None else {}) |
                                             (self.auth if auth else {}))
        try:
            res = urllib.request.urlopen(req, timeout=50)
        except urllib.error.HTTPError as error:
            res = error
        with res:
            result = json.load(res)
            assert res.status == expected, f'{path.split("?")[0]} returned {res.status}: {result.get("error", "unexpected status")}'
            assert KEY not in json.dumps(result), 'Web exposed model credentials'
            return result

    def state(self):
        return self.call('state')

    def state_until(self, check, label):
        def poll():
            state = self.state()
            return state if check(state) else None
        return wait_until(poll, label)

    @contextmanager
    def listen(self):
        request = urllib.request.Request(self.origin + '/api/pi-web/events', headers=self.auth)
        response = urllib.request.urlopen(request, timeout=30)
        events = queue.Queue()

        def reader():
            event = None
            try:
                for raw in response:
                    line = raw.decode().rstrip('\r\n')
                    if line.startswith('event: '):
                        event = line[7:]
                    elif event and line.startswith('data: '):
                        events.put((event, json.loads(line[6:])))
                        event = None
            except (OSError, ValueError):
                pass

        thread = threading.Thread(target=reader, daemon=True)
        thread.start()
        yield events
        # Server shutdown closes the stream; closing this response concurrently
        # while the reader is blocked can wait for the next heartbeat on CPython.


@contextmanager
def service(env, command):
    proc = subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, start_new_session=True)
    lines = queue.Queue()

    def reader():
        for line in proc.stdout:
            if LAUNCH.fullmatch(line.strip()):
                lines.put(line.strip())
        lines.put(None)

    threading.Thread(target=reader, daemon=True).start()
    try:
        try:
            launch = lines.get(timeout=20)
        except queue.Empty:
            raise AssertionError('pnpm pi-web did not print a launch link') from None
        assert launch, f'Pi Web exited before listening (code {proc.poll()}); check prerequisites'
        yield Web(launch)
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)
        proc.stdout.close()


def next_event(events, predicate, label):
    deadline = time.monotonic() + 25
    while (remaining := deadline - time.monotonic()) > 0:
        try:
            kind, data = events.get(timeout=remaining)
        except queue.Empty:
            break
        if predicate(kind, data):
            return data
    raise AssertionError(label)


def deliver(web, events, text):
    state = web.state()
    web.call('prompt', dict(generation=state['generation'], text=text))
    next_event(events, lambda kind, data: kind == 'delta' and data.get('text') and data.get('generation') == state['generation'],
               'no native message delta')
    return web.state_until(lambda view: view['status'] == 'idle' and len(view['messages']) >= 2, 'Pi did not settle')


def run(root, model, command, browser):
    agent, a, b = [root / name for name in ('pi-agent', 'workspace A', 'workspace B')]
    for directory in (agent, a, b):
        directory.mkdir()
    (agent / 'models.json').write_text(json.dumps({'providers': {'local-fixture': {
        'baseUrl': f'http://127.0.0.1:{model.server_port}/v1', 'api': 'openai-completions', 'apiKey': KEY,
        'models': [{'id': MODEL, 'name': 'Pi Web fixture', 'contextWindow': 16384, 'maxTokens': 512}]
    }}}), encoding='utf8')
    native_settings = {'defaultProvider': 'local-fixture', 'defaultModel': MODEL}
    qq_port = None
    if not browser:
        # The fixture loads the real extension but must never acquire its QQ port.
        import socket
        native_settings['extensions'] = [str(ROOT / 'extensions' / 'deeppi.ts')]
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            qq_port = reservation.getsockname()[1]
        qq = agent / 'deeppi' / 'qq' / 'settings.json'
        qq.parent.mkdir(parents=True, mode=0o700)
        qq.write_text(json.dumps({'version': 1, 'settings': {'listen': True, 'transport': 'ws', 'port': qq_port,
                                                            'botId': '123456789', 'wsToken': 'local-fixture-token'}}), encoding='utf8')
        qq.chmod(0o600)
    (agent / 'settings.json').write_text(json.dumps(native_settings), encoding='utf8')
    env = {key: os.environ[key] for key in ['PATH', 'PREFIX', 'TMPDIR', 'LD_LIBRARY_PATH', 'SystemRoot'] if key in os.environ}
    if os.environ.get('DEEPPI_PI_CLI'):
        env['DEEPPI_PI_CLI'] = os.environ['DEEPPI_PI_CLI']
    env.update(HOME=str(root), PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE='1', PI_NO_TELEMETRY='1')
    with service(env, command) as web:
        if browser:
            print(web.link, flush=True)
            signal.pause()
            return
        web.call('state', auth=False, expected=401)
        assert 'data-pi-web' in urllib.request.urlopen(web.origin, timeout=5).read().decode()
        assert not web.state()['connected'] and not web.state()['id']
        for cwd, name in [(str(a), '工作区 A'), (str(b), '工作区 B')]:
            web.call('workspaces', dict(action='save', path=cwd, name=name, activate=True))
        assert dict((row['cwd'], row['name']) for row in web.call('workspaces')['workspaces'])[str(b)] == '工作区 B'
        with web.listen() as events:
            start = next_event(events, lambda kind, _: kind == 'state', 'missing initial state')
            assert not start['id']
            web.call('sessions', dict(cwd=str(a), title='会话 A'))
            first = web.state()
            assert first['connected'] and first['cwd'] == str(a) and first['model']['id'] == MODEL
            assert any(command['name'] == 'deeppi' for command in first['commands']), 'real Deeppi extension was not loaded'
            with socket.socket() as probe:
                probe.settimeout(1)
                assert probe.connect_ex(('127.0.0.1', qq_port)) != 0, 'independent Pi RPC started the TUI OneBot listener'
            first = deliver(web, events, 'Message for A only')
            assert [row['text'] for row in first['messages'] if row['role'] in ('user', 'assistant')] == ['Message for A only', '收到 Pi 本地回复。']
            sent = model.requests.get(timeout=5)
            assert sent['model'] == MODEL and not any('Message for B only' in str(item['content']) for item in sent['messages'])
            web.call('sessions', dict(cwd=str(b), title='会话 B'))
            second = web.state()
            assert second['connected'] and second['cwd'] == str(b) and second['generation'] > first['generation'] and not second['messages']
            web.call('prompt', dict(generation=first['generation'], text='stale'), expected=409)
            history = 'history?' + urllib.parse.urlencode(dict(cwd=str(a), id=first['id']))
            assert web.call(history)['messages'][0]['text'] == 'Message for A only'
            assert web.state()['id'] == second['id'], 'preview switched active session'
            second = deliver(web, events, 'Message for B only')
            assert not any('Message for A only' in str(item['content']) for item in model.requests.get(timeout=5)['messages'])
            web.call('prompt', dict(generation=second['generation'], text='Hold for stop'))
            next_event(events, lambda kind, data: kind == 'delta' and data.get('text') == '正在生成…', 'no delta before stop')
            web.call('stop', dict(generation=second['generation']))
            web.state_until(lambda view: view['status'] == 'idle', 'Pi did not stop')
            model.release.set()
            web.call('switch', dict(cwd=str(a), id=first['id']))
            assert web.state()['messages'][0]['text'] == 'Message for A only'
    with service(env, command) as web:
        assert not web.state()['id']
        destinations = {row['cwd'] for row in web.call('workspaces')['workspaces']}
        assert {str(a), str(b)} <= destinations
        web.call('switch', dict(cwd=str(b), id=second['id']))
        assert web.state()['messages'][0]['text'] == 'Message for B only'
    print('Pi Web: auth, native streaming and stop, independent workspaces, read-only preview, native switching, restart, and TUI QQ isolation passed.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--browser', action='store_true', help='start an isolated Web fixture instead of exercising the API')
    parser.add_argument('--bin', help='installed deeppi-web executable, instead of pnpm pi-web')
    args = parser.parse_args()

    def interrupted(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    with tempfile.TemporaryDirectory(prefix='deeppi-pi-web-smoke-') as temporary:
        with ThreadingHTTPServer(('127.0.0.1', 0), ModelFixture) as server:
            server.requests = queue.Queue()
            server.release = threading.Event()
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                run(Path(temporary).resolve(), server, [args.bin] if args.bin else ['pnpm', 'pi-web'], args.browser)
            except KeyboardInterrupt:
                pass
            finally:
                server.release.set()
                server.shutdown()
