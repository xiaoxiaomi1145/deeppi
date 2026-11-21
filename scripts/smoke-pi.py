#!/usr/bin/env python3
"""Exercise a real Pi CLI with an isolated home and loopback-only fixtures (POSIX)."""
import argparse
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'
BOT, USER = '100001', '200001'
MODEL_KEY, CALLBACK_SECRET = 'fixture-model-key', 'fixture-callback-secret'
WS_TOKEN, HTTP_TOKEN = 'fixture-ws-token', 'fixture-http-token'


def event(message_id, text):
    return dict(post_type='message', message_type='private', self_id=BOT, user_id=USER,
                message_id=message_id, message=[dict(type='text', data=dict(text=text))])


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'{}')
        if self.path == '/model/v1/chat/completions':
            if self.headers.get('Authorization') != 'Bearer ' + MODEL_KEY:
                self.send_error(401)
                return
            self.server.model_requests.append(payload)
            chunk = dict(id='fixture', object='chat.completion.chunk', created=1, model=payload['model'],
                         choices=[dict(index=0, delta=dict(role='assistant', content='本地测试模型回复'), finish_reason='stop')],
                         usage=dict(prompt_tokens=48, completion_tokens=6, total_tokens=54,
                                    prompt_cache_hit_tokens=24, prompt_cache_miss_tokens=24))
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            self.wfile.write(f'data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n'.encode())
            return
        if self.headers.get('Authorization') != 'Bearer ' + HTTP_TOKEN:
            self.send_error(401)
            return
        if self.path == '/onebot/get_login_info':
            data = dict(user_id=BOT, nickname='OneBot fixture')
        elif self.path == '/onebot/send_private_msg':
            self.server.onebot_messages.append(payload)
            data = dict(message_id=901)
        else:
            self.send_error(404)
            return
        body = json.dumps(dict(status='ok', retcode=0, data=data)).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def wait_for(check, label, timeout=12):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = check()
        if value:
            return value
        time.sleep(.04)
    raise AssertionError(label)


OPEN_ARCHIVE = '''
import { SessionManager } from '@earendil-works/pi-coding-agent';
const archive = SessionManager.create(process.argv[1]);
archive.appendSessionInfo('Native archive fixture');
archive.appendMessage({role:'user',content:'Archived user fixture',timestamp:Date.now()});
archive.appendMessage({role:'assistant',content:[{type:'text',text:'Archived reply fixture'}],api:'openai-completions',
  provider:'deeppi-env-deepseek',model:'deepseek-flash',timestamp:Date.now(),stopReason:'stop',
  usage:{input:2,output:3,cacheRead:0,cacheWrite:0,totalTokens:5,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
console.log(JSON.stringify({id:archive.getSessionId(),path:archive.getSessionFile()}));
'''

REVERSE_WS = '''
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
const { PI_ORIGIN, PI_BEARER, BOT, USER, WS_TOKEN } = process.env;
const call = async (path, body, method = 'POST') => {
  const response = await fetch(PI_ORIGIN + '/api/pi/' + path, {method,
    headers:{authorization:'Bearer ' + PI_BEARER,'content-type':'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(8000)});
  const result = await response.json();
  assert(response.ok, `${path} (${response.status}): ${result.error || ''}`);
  return result;
};
const state = await call('qq',{transport:'ws',port:0,botId:BOT,wsToken:WS_TOKEN,listen:true,cooldownMs:0},'PATCH');
const ws = new WebSocket(state.status.wsUrl, {headers:{'X-Self-ID':BOT,'X-Client-Role':'Universal',authorization:'Bearer ' + WS_TOKEN}});
try {
  await once(ws,'open',{signal:AbortSignal.timeout(3000)});
  const replies = [];
  ws.on('message', data => {
    const {action,params,echo} = JSON.parse(data);
    if (action !== 'get_login_info') replies.push({action,params});
    ws.send(JSON.stringify({status:'ok',retcode:0,data:action === 'get_login_info' ? {user_id:BOT} : {message_id:900},echo}));
  });
  assert.equal((await call('qqprobe',{})).botId, BOT);
  await call('qq',{enabled:true},'PATCH');
  ws.send(JSON.stringify({post_type:'message',message_type:'private',self_id:BOT,user_id:USER,message_id:'881',
    message:[{type:'text',data:{text:'OneBot WS fixture'}}]}));
  const end = Date.now() + 8000;
  while (replies.length === 0 && Date.now() < end) await new Promise(r => setTimeout(r,40));
  assert.deepEqual(replies,[{action:'send_private_msg',params:{user_id:USER,message:[{type:'text',data:{text:'本地测试模型回复'}}]}}]);
} finally { ws.terminate(); }
'''


def run_smoke(extension, browser):
    with tempfile.TemporaryDirectory(prefix='deeppi-pi-smoke-') as directory, ThreadingHTTPServer(('127.0.0.1', 0), Fixture) as upstream:
        upstream.model_requests, upstream.onebot_messages = [], []
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        try:
            _run_session(extension, browser, Path(directory), upstream)
        finally:
            upstream.shutdown()
            thread.join()


def _run_session(extension, browser, home, upstream):
    cwd, archive_cwd = home / 'project', home / 'archive'
    cwd.mkdir()
    archive_cwd.mkdir()
    upstream_url = f'http://127.0.0.1:{upstream.server_port}'
    env = {key: os.environ[key] for key in ('PATH', 'PREFIX', 'TMPDIR', 'LD_LIBRARY_PATH') if key in os.environ}
    env.update(HOME=str(home), PI_CODING_AGENT_DIR=str(home / 'agent'), TERM='xterm-256color',
               PI_OFFLINE='1', PI_NO_TELEMETRY='1', DEEPSEEK_BASE_URL=upstream_url + '/model/v1', DEEPSEEK_API_KEY=MODEL_KEY)
    # Loading the complete SDK on a cold mobile filesystem can take longer than the actual fixture requests.
    archive = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', OPEN_ARCHIVE, str(archive_cwd)], cwd=ROOT, env=env, timeout=45))
    archived = Path(archive['path']).read_bytes()
    ready = home / 'ready.ts'
    ready.write_text("export default pi => pi.on('session_start', (_event, ctx) => ctx.ui.notify('DEEPPI FIXTURE READY', 'info'));\n")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 34, 200, 0, 0))
    proc = subprocess.Popen(['node', str(CLI), '--offline', '-e', str(extension), '-e', str(ready),
                             '--model', 'deeppi-env-deepseek/deepseek-flash:off'],
                            cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()

    def terminal(pattern, timeout=20):
        def check():
            if select.select([master], [], [], .08)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    pass
            return re.search(pattern, output)
        return wait_for(check, 'Pi TUI did not print the expected marker', timeout)

    try:
        terminal(rb'DEEPPI FIXTURE READY')
        os.write(master, b'/deeppi\r')
        link = terminal(rb'(http://127\.0\.0\.1:\d+)/#access=([0-9A-Za-z_-]{43})')
        origin, access = link[1].decode(), link[2].decode()

        def api(path, body=None, method='GET', status=200, auth=True):
            headers = {'Authorization': 'Bearer ' + access} if auth else {}
            if body is not None:
                headers['Content-Type'] = 'application/json'
                body = json.dumps(body).encode()
            try:
                with urllib.request.urlopen(urllib.request.Request(origin + '/api/pi/' + path, body, headers, method=method), timeout=12) as response:
                    actual, data = response.status, json.load(response)
            except urllib.error.HTTPError as error:
                actual, data = error.code, json.load(error)
            assert actual == status, f'{path}: expected {status}, got {actual} ({data.get("error", "")})'
            return data

        if browser:
            print(f'{origin}/#access={access}', flush=True)
            while proc.poll() is None:
                if select.select([master], [], [], .25)[0]:
                    try:
                        os.read(master, 65536)
                    except OSError:
                        break
            return

        api('state', status=401, auth=False)
        state = api('state')
        assert state['cwd'] == str(cwd) and state['model']['provider'] == 'deeppi-env-deepseek', state.get('model')
        assert state['addons'] == dict(compact=False, bash=False)
        native_id = state['id']
        catalog = api('catalog')
        assert catalog['currentId'] == native_id
        history = api('history?' + urllib.parse.urlencode({'id': archive['id']}))
        assert any(m['text'] == 'Archived reply fixture' for m in history['messages'])
        assert api('state')['id'] == native_id and Path(archive['path']).read_bytes() == archived
        assert api('probe', {}, 'POST')['model'] == 'deepseek-flash'
        api('prompt', {'text': 'Native Web prompt fixture'}, 'POST', status=202)

        def completed():
            live = api('state')
            return live['status'] == 'idle' and any(m['text'] == '本地测试模型回复' for m in live['messages'])
        wait_for(completed, 'Native Web prompt did not reach the transcript')
        os.write(master, b'/deeppi-addons enable compact\r')
        wait_for(lambda: api('state')['addons']['compact'], 'TUI add-on did not reach Web')
        api('switch', {'id': archive['id']}, 'POST')
        wait_for(lambda: api('state')['id'] == archive['id'], 'Pi did not switch to the archive')
        assert api('state')['cwd'] == str(archive_cwd)
        api('switch', {'id': native_id}, 'POST')
        assert api('state')['id'] == native_id
        print('Pi: authenticated Web, native gateway probe/chat, read-only preview, two native switches, TUI add-on sync.', flush=True)

        ws_env = dict(env, PI_ORIGIN=origin, PI_BEARER=access, BOT=BOT, USER=USER, WS_TOKEN=WS_TOKEN)
        subprocess.run(['node', '--input-type=module', '-e', REVERSE_WS], cwd=ROOT, env=ws_env, check=True, timeout=25)
        view = api('qq', {'listen': True, 'transport': 'http', 'port': 0, 'httpApiUrl': upstream_url + '/onebot',
                          'httpSecret': CALLBACK_SECRET, 'httpToken': HTTP_TOKEN}, 'PATCH')
        assert view['settings']['enabled'] is False and view['settings']['hasHttpSecret'] is True
        assert CALLBACK_SECRET not in json.dumps(view) and HTTP_TOKEN not in json.dumps(view)
        assert api('qqprobe', {}, 'POST')['botId'] == BOT
        api('qq', {'enabled': True}, 'PATCH')
        payload = json.dumps(event('882', 'OneBot HTTP fixture')).encode()
        signature = 'sha1=' + hmac.new(CALLBACK_SECRET.encode(), payload, hashlib.sha1).hexdigest()
        headers = {'Content-Type': 'application/json', 'X-Signature': signature}
        with urllib.request.urlopen(urllib.request.Request(view['status']['httpUrl'], payload, headers), timeout=6) as response:
            assert response.status == 204
        wait_for(lambda: upstream.onebot_messages, 'Signed OneBot HTTP event did not receive a reply')
        assert upstream.onebot_messages == [{'user_id': USER, 'message': [{'type': 'text', 'data': {'text': '本地测试模型回复'}}]}]
        assert not any('OneBot' in m['text'] for m in api('state')['messages'])
        assert len(upstream.model_requests) >= 4
        api('qq', {'listen': False}, 'PATCH')
        print('OneBot: reverse WebSocket and signed reverse HTTP each reached the real Pi model route and replied to the fixture; native history remained isolated.', flush=True)
    except Exception:
        redacted = re.sub(rb'(#access=)[A-Za-z0-9_-]+', rb'\1[redacted]', output)
        redacted = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', redacted)
        print(redacted.decode(errors='replace')[-3000:], flush=True)
        raise
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        os.close(master)


def stop(_signal, _frame):
    raise SystemExit(0)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, stop)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--extension', type=Path, default=ROOT / 'extensions/deeppi.ts')
    parser.add_argument('--browser', action='store_true', help='Serve an isolated local fixture for interactive browser checks')
    arguments = parser.parse_args()
    run_smoke(arguments.extension.resolve(), arguments.browser)
