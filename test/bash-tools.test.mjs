import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createBashTools, runBash } from '../server/bash-tools.mjs';

const options = { cwd: process.cwd(), allowBash: true, bashTimeoutMs: 5_000, maxToolOutput: 4_096 };
const definition = { name: 'greet', description: 'Print a greeting', script: 'printf hello' };

function fixture(registry = {}, onRegistryChange = () => {}, cwd = options.cwd) {
  const tools = createBashTools({ ...options, cwd, registry, onRegistryChange });
  return {
    tools,
    call(name, input, signal) {
      return tools.find((tool) => tool.name === name).execute(`call-${name}`, input, signal);
    },
  };
}

async function tempDir(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'deeppi-bash-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('disabling Bash removes every execution and registry tool', () => {
  assert.deepEqual(createBashTools({ ...options, allowBash: false, registry: {} }), []);
});

test('reusable tool arguments remain literal and follow declaration order', async (t) => {
  const cwd = await tempDir(t);
  const registry = {};
  const { tools, call } = fixture(registry, () => {}, cwd);
  assert.deepEqual(tools.map((tool) => tool.name), ['bash', 'define_tool', 'list_tools', 'run_tool']);
  const schemasBefore = JSON.stringify(tools.map((tool) => tool.parameters));
  const parameters = [{ name: 'first', required: true }, { name: 'optional' }, { name: 'last' }];
  const script = `printf '%s\n' "$#" "$1" "$2" "$3"`;
  await call('define_tool', { ...definition, parameters, script });
  assert.deepEqual(registry.greet, { ...definition, parameters, script });
  assert.equal(JSON.stringify(tools.map((tool) => tool.parameters)), schemasBefore);

  const result = await call('run_tool', {
    name: 'greet',
    args: { last: '-n with spaces', first: '$(printf x > expanded) ; * "quoted"' },
  });
  assert.equal(result.details.text, '3\n$(printf x > expanded) ; * "quoted"\n\n-n with spaces\n');
  assert.equal(result.details.exitCode, 0);
  assert.equal(result.content[0].type, 'text');
  await assert.rejects(readFile(join(cwd, 'expanded')), { code: 'ENOENT' });

  const listed = await call('list_tools', {});
  assert.deepEqual(listed.details.tools, [{ name: 'greet', description: 'Print a greeting', parameters }]);
  assert.deepEqual((await fixture().call('list_tools', {})).details.tools, []);
});

test('registry and argument validation reject reserved, duplicate, extra and missing names', async () => {
  const registry = {};
  let changes = 0;
  const { call } = fixture(registry, () => { changes++; });
  for (const name of ['bash', 'define_tool', 'list_tools', 'run_tool', '__proto__', 'constructor', 'toString', 'bad name']) {
    await assert.rejects(call('define_tool', { ...definition, name }));
  }
  await assert.rejects(call('define_tool', { ...definition, parameters: [{ name: 'x' }, { name: 'x' }] }), /duplicate/i);
  await assert.rejects(call('define_tool', { ...definition, parameters: [{ name: '__proto__' }] }));
  assert.equal(changes, 0);
  assert.deepEqual(registry, {});

  await call('define_tool', { ...definition, parameters: [{ name: 'first', required: true }] });
  await assert.rejects(call('run_tool', { name: 'greet' }), /missing.*first/i);
  await assert.rejects(call('run_tool', { name: 'greet', args: { first: 'ok', extra: 'bad' } }), /extra/i);
  await assert.rejects(call('run_tool', { name: 'greet', args: { first: 42 } }));
  await assert.rejects(call('run_tool', { name: 'greet', args: { first: '\u0000' } }));
  await assert.rejects(call('run_tool', { name: 'constructor' }));
  assert.equal(changes, 1);
});

test('a full registry still supports updates and rolls back on persistence failure', async () => {
  const registry = {};
  let fail = false;
  const { call } = fixture(registry, () => { if (fail) throw new Error('Persistence failed'); });
  for (let i = 0; i < 32; i++) {
    await call('define_tool', { ...definition, name: `tool_${i}` });
  }
  assert.equal(Object.keys(registry).length, 32);
  await assert.rejects(call('define_tool', definition), /limit|full/i);
  await call('define_tool', { ...definition, name: 'tool_0', script: 'printf changed' });
  assert.equal(registry.tool_0.script, 'printf changed');

  fail = true;
  await assert.rejects(call('define_tool', { ...definition, name: 'tool_0' }), /persistence failed/i);
  assert.equal(registry.tool_0.script, 'printf changed');
  assert.equal(Object.keys(registry).length, 32);
});

test('Bash does not inherit startup hooks or application secrets and sees EOF on stdin', async (t) => {
  const cwd = await tempDir(t);
  const startup = join(cwd, 'startup.sh');
  await writeFile(startup, 'printf sourced\\n > startup-ran\n');
  const previousBashEnv = process.env.BASH_ENV;
  const previousSecret = process.env.DSH_BASH_TEST_API_KEY;
  process.env.BASH_ENV = startup;
  process.env.DSH_BASH_TEST_API_KEY = 'test-only-secret';
  t.after(() => {
    if (previousBashEnv === undefined) delete process.env.BASH_ENV;
    else process.env.BASH_ENV = previousBashEnv;
    if (previousSecret === undefined) delete process.env.DSH_BASH_TEST_API_KEY;
    else process.env.DSH_BASH_TEST_API_KEY = previousSecret;
  });

  const { call } = fixture({}, () => {}, cwd);
  const result = await call('bash', { command: 'if read -r line; then exit 2; fi; printf "%s" "${DSH_BASH_TEST_API_KEY-unset}"' });
  assert.deepEqual(result.details, { text: 'unset', exitCode: 0, timedOut: false, truncated: false });
  await assert.rejects(readFile(join(cwd, 'startup-ran')), { code: 'ENOENT' });
});

test('output capture caps and continues draining both pipes', async () => {
  const script = 'for ((i=0; i<400; i++)); do printf "%1024s" x; printf "%1024s" y >&2; done; exit 7';
  const { call } = fixture();
  const result = await call('bash', { command: script });
  assert.equal(result.details.exitCode, 7);
  assert.equal(result.details.truncated, true);
  assert.equal(result.details.timedOut, false);
  assert.equal(result.details.text.length, 4_096);
  assert.equal(result.isError, true);
});

test('timeout kills descendants that keep the output pipes open', { skip: process.platform === 'win32' }, async (t) => {
  const cwd = await tempDir(t);
  const result = await runBash({
    script: `(sleep 0.85; printf late > survived) & printf 'ready\n'`,
    cwd,
    timeoutMs: 250,
    outputLimit: 64,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.text, 'ready\n');
  await delay(850);
  await assert.rejects(readFile(join(cwd, 'survived')), { code: 'ENOENT' });
});

test('abort rejects pre-aborted and in-flight Bash calls', async (t) => {
  const cwd = await tempDir(t);
  const controller = new AbortController();
  const options = { cwd, timeoutMs: 5_000, outputLimit: 64 };
  await assert.rejects(runBash({
    ...options,
    script: 'printf unexpected > started',
    signal: AbortSignal.abort(),
  }), { name: 'AbortError' });
  await assert.rejects(readFile(join(cwd, 'started')), { code: 'ENOENT' });

  const running = runBash({ ...options, script: 'sleep 2', signal: controller.signal });
  const aborted = assert.rejects(running, { name: 'AbortError' });
  await delay(50);
  controller.abort();
  await aborted;
});
