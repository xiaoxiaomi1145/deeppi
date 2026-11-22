import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('../server/pi-web/rpc-worker.mjs', import.meta.url);
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'deeppi-rpc-worker-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'fixture.mjs');
  await writeFile(path, `import { createInterface } from 'node:readline';
const input = createInterface({input: process.stdin});
let buffered;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const respond = request => send({type:'response',id:request.id,command:request.type,success:true,data:{value:request.value}});
input.on('line', line => {
 const request = JSON.parse(line);
 if (request.type === 'first') buffered = request;
 else if (request.type === 'second') {
   const data = Buffer.from(JSON.stringify({type:'agent_start',text:'你好'})+'\\n');
   process.stdout.write(data.subarray(0, data.indexOf(Buffer.from('你好')) + 1));
   process.stdout.write(data.subarray(data.indexOf(Buffer.from('你好')) + 1));
   respond(request); respond(buffered);
 } else if (request.type === 'break') {
   process.stderr.write('fixture-private-secret\\n'); process.stdout.write('broken wire\\n');
 } else if (request.type === 'exit') process.exit(3);
 else if (request.type === 'ignore-close') {
   process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); respond(request);
 }
});
`);
  await chmod(path, 0o700);
  return { cwd, path };
}

test('correlates out-of-order Pi replies while forwarding separate UTF-8 events', async t => {
  const { cwd, path } = await fixture(t);
  const { createPiRpcWorker, resolvePiCli } = await import(root);
  const cli = resolvePiCli({ cwd, env: { DEEPPI_PI_CLI: path }, peerEntry: () => assert.fail('explicit path should win') });
  const worker = createPiRpcWorker({ cli, cwd });
  t.after(() => worker.close());
  const events = [];
  worker.onEvent(event => events.push(event));
  const first = worker.request('first', { value: 'one' });
  const second = worker.request('second', { value: 'two' });
  assert.deepEqual(await Promise.all([first, second]), [{ value: 'one' }, { value: 'two' }]);
  assert.deepEqual(events, [{ type: 'agent_start', text: '你好' }]);
});

test('invalid stdout and child exit reject pending requests without exposing diagnostics', async t => {
  const { cwd, path } = await fixture(t);
  const { createPiRpcWorker } = await import(root);
  for (const command of ['break', 'exit']) {
    const worker = createPiRpcWorker({ cli: { command: process.execPath, args: [path, '--mode', 'rpc'] }, cwd });
    try {
      await assert.rejects(Promise.all([worker.request('first'), worker.request(command)]), error =>
        error.status === 502 && !error.message.includes('fixture-private-secret'));
    } finally { await worker.close(); }
  }
});

test('CLI resolution prefers peer before searching PATH and rejects an invalid explicit override', async t => {
  const { cwd, path } = await fixture(t);
  const { resolvePiCli } = await import(root);
  const env = { PATH: cwd };
  const cli = join(cwd, 'pi');
  await writeFile(cli, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal(resolvePiCli({ cwd, env, peerEntry: () => path }).command, process.execPath);
  assert.equal(resolvePiCli({ cwd, env, peerEntry: () => undefined }).command, cli);
  assert.throws(() => resolvePiCli({ cwd, env: { ...env, DEEPPI_PI_CLI: 'unavailable' }, peerEntry: () => path }), { status: 503 });
});

test('close finishes even when a worker keeps running after EOF and SIGTERM', async t => {
  const { cwd, path } = await fixture(t);
  const { createPiRpcWorker } = await import(root);
  const worker = createPiRpcWorker({ cli: { command: process.execPath, args: [path, '--mode', 'rpc'] }, cwd, closeGraceMs: 100 });
  t.after(() => worker.close());
  await worker.request('ignore-close');
  await worker.close();
  await assert.rejects(worker.request('first'), { status: 502 });
});
