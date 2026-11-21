import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createPiAddons } from '../server/pi/addons.mjs';

const wrappedTools = ['deeppi_define_tool', 'deeppi_list_tools', 'deeppi_run_tool'];
const nativeTools = ['read', 'bash', 'another_extension'];

function host(sessionManager = SessionManager.inMemory()) {
  const commands = new Map();
  const handlers = new Map();
  const tools = new Map(nativeTools.map(name => [name, { name }]));
  const notices = [];
  const confirmations = [];
  const compacted = [];
  let active = [...nativeTools];
  let confirmed = false;
  let failWrite = false;
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) {
      assert(!tools.has(tool.name), `Repeated registration: ${tool.name}`);
      tools.set(tool.name, tool);
      if (tool.defaultActive !== false) active.push(tool.name);
    },
    on(name, handler) {
      assert(!handlers.has(name), `Repeated handler: ${name}`);
      handlers.set(name, handler);
    },
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...active],
    setActiveTools(names) {
      assert(names.every(name => tools.has(name)), 'Tools must be registered before activation');
      active = [...names];
    },
    appendEntry(type, data) {
      if (failWrite) throw new Error('Session write failed');
      sessionManager.appendCustomEntry(type, data);
    },
  };
  const ctx = {
    cwd: sessionManager.getCwd(), sessionManager, mode: 'tui', hasUI: true,
    isIdle: () => true,
    compact(options) {
      compacted.push(options.customInstructions);
      options.onComplete?.({ summary: 'Native summary', firstKeptEntryId: 'kept', tokensBefore: 100 });
    },
    ui: {
      notify(message, level) { notices.push({ message, level }); },
      async confirm(title, message) { confirmations.push({ title, message }); return confirmed; },
    },
  };
  return {
    addons: createPiAddons(pi), pi, ctx, tools, commands, notices, confirmations, compacted,
    emit: (name, context = ctx) => handlers.get(name)?.({ type: name }, context),
    command: (name, args, context = ctx) => commands.get(name).handler(args, context),
    agree: () => { confirmed = true; },
    blockWrite: () => { failWrite = true; },
    execute: (name, args, signal) => tools.get(name).execute('id', args, signal, undefined, ctx),
  };
}

const toggle = (session, id, enabled, extra) => session.addons.update(session.ctx, { id, enabled, ...extra });

function promptEntry(manager, text) {
  return manager.appendMessage({ role: 'user', content: [{ type: 'text', text }], timestamp: 0 });
}

test('add-ons are off before and after native session startup without changing Pi tools', async () => {
  const session = host();
  assert.deepEqual(session.addons.snapshot(), { compact: false, bash: false });
  await session.emit('session_start');
  const snapshot = session.addons.snapshot();
  snapshot.bash = true;
  await session.addons.attach(session.ctx);
  assert.deepEqual(session.addons.snapshot(), { compact: false, bash: false });
  assert.deepEqual(session.pi.getActiveTools(), nativeTools);
  assert.deepEqual(session.ctx.sessionManager.getBranch(), []);
  assert(!session.commands.has('compact'), 'Native Pi /compact remains untouched');
});

test('native custom entries restore the settings for the active branch across restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'deeppi-addon-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, dir);
  const original = host(manager);
  await original.emit('session_start');
  const before = promptEntry(manager, 'First user message');
  await toggle(original, 'compact', true);
  const count = manager.getBranch().length;
  await toggle(original, 'compact', true);
  await original.addons.attach(original.ctx);
  assert.equal(manager.getBranch().length, count, 'No duplicate entries on attach or no-op updates');
  const enabled = manager.getLeafId();
  await toggle(original, 'compact', false);
  assert.deepEqual(original.addons.snapshot(), { compact: false, bash: false });

  const opened = SessionManager.open(manager.getSessionFile(), dir);
  const resumed = host(opened);
  await resumed.emit('session_start');
  assert.equal(resumed.addons.snapshot().compact, false);
  opened.branch(enabled);
  await resumed.emit('session_tree');
  assert.equal(resumed.addons.snapshot().compact, true);
  assert.deepEqual(opened.buildSessionContext().messages.map(message => message.role), ['user']);
  opened.branch(before);
  await resumed.emit('session_tree');
  assert.deepEqual(resumed.addons.snapshot(), { compact: false, bash: false });
});

test('the programmatic toggle rejects malformed values and requires explicit Bash confirmation', async () => {
  const session = host();
  await session.emit('session_start');
  await assert.rejects(toggle(session, 'unknown', true), /add-on/i);
  await assert.rejects(toggle(session, 'compact', 'true'), /boolean/i);
  await assert.rejects(toggle(session, 'bash', true), /confirm/i);
  await assert.rejects(toggle(session, 'bash', true, { confirmed: 'true' }), /confirm/i);
  assert.equal(session.addons.snapshot().bash, false);
  assert.deepEqual(session.pi.getActiveTools(), nativeTools);
  assert.deepEqual(session.ctx.sessionManager.getBranch(), []);
});

test('TUI Bash activation requires a human dialog that explains host permissions', async () => {
  const session = host();
  await session.emit('session_start');
  await session.command('deeppi-addons', 'enable bash', { ...session.ctx, hasUI: false, mode: 'print' });
  assert.equal(session.confirmations.length, 0);
  assert.equal(session.addons.snapshot().bash, false);
  await session.command('deeppi-addons', 'enable bash');
  assert.match(session.confirmations[0].message, /host|sandbox/i);
  assert.equal(session.addons.snapshot().bash, false);
  session.agree();
  await session.command('deeppi-addons', 'enable bash');
  assert.equal(session.addons.snapshot().bash, true);
  await session.command('deeppi-addons', '');
  assert(session.notices.some(({ message }) => /compact.*off.*bash.*on/is.test(message)));
  await session.command('deeppi-addons', 'disable bash');
  assert.deepEqual(session.pi.getActiveTools(), nativeTools);
});

test('the enhanced compaction command delegates native compaction with continuity guidance and focus', async () => {
  const session = host();
  await session.emit('session_start');
  await session.command('deeppi-compact', 'Portability');
  assert.equal(session.compacted.length, 0);
  await session.command('deeppi-addons', 'enable compact');
  await session.command('deeppi-compact', 'Portability', { ...session.ctx, isIdle: () => false });
  assert.equal(session.compacted.length, 0);
  await session.command('deeppi-compact', '  Portability  ');
  assert.equal(session.compacted.length, 1);
  assert.match(session.compacted[0], /Portability/);
  assert.match(session.compacted[0], /paths/i);
  assert.match(session.compacted[0], /pending/i);
  assert.doesNotMatch(session.addons.compactInstructions(), /undefined/);
  assert(session.notices.some(({ message }) => /compaction completed/i.test(message)));
});

test('only prefixed wrappers are active and a cached wrapper refuses calls after disable or shutdown', async () => {
  const session = host();
  await session.emit('session_start');
  await toggle(session, 'bash', true, { confirmed: true });
  assert.deepEqual(session.pi.getActiveTools(), [...nativeTools, ...wrappedTools]);
  const before = session.ctx.sessionManager.getBranch().length;
  await session.addons.attach(session.ctx);
  assert.equal(session.ctx.sessionManager.getBranch().length, before);
  await toggle(session, 'bash', false);
  assert.deepEqual(session.pi.getActiveTools(), nativeTools);
  await assert.rejects(session.execute('deeppi_list_tools', {}), /disabled|off/i);
  await toggle(session, 'bash', true, { confirmed: true });
  await session.emit('session_shutdown');
  await assert.rejects(session.execute('deeppi_run_tool', { name: 'irrelevant' }), /disabled|off/i);
});

test('the Bash registry is branch-local and runs literal arguments without ambient secrets', async t => {
  const session = host();
  const manager = session.ctx.sessionManager;
  await session.emit('session_start');
  await toggle(session, 'bash', true, { confirmed: true });
  const before = manager.getLeafId();
  const envName = 'DEEPPI_TEST_ADDON_PRIVATE_TOKEN';
  const previous = process.env[envName];
  process.env[envName] = 'must-not-leak';
  t.after(() => {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  });
  await session.execute('deeppi_define_tool', {
    name: 'echo_local', description: 'Echo a literal local value',
    parameters: [{ name: 'value', required: true }],
    script: 'printf "%s\\n%s\\n" "$1" "${DEEPPI_TEST_ADDON_PRIVATE_TOKEN:-unset}"',
  });
  const defined = manager.getLeafId();
  const listed = (await session.execute('deeppi_list_tools', {})).details.tools;
  assert.deepEqual(listed.map(tool => tool.name), ['echo_local']);
  assert(!Object.hasOwn(listed[0], 'script'));
  const value = 'hello; $(printf replaced)';
  const result = await session.execute('deeppi_run_tool', { name: 'echo_local', args: { value } });
  assert.equal(result.details.text, `${value}\nunset\n`);
  assert.equal(result.isError, false);

  manager.branch(before);
  await session.emit('session_tree');
  assert.equal(session.addons.snapshot().bash, true);
  await assert.rejects(session.execute('deeppi_run_tool', { name: 'echo_local', args: { value } }), /unknown/i);
  manager.branch(defined);
  const resumed = host(manager);
  await resumed.emit('session_start');
  assert.deepEqual((await resumed.execute('deeppi_list_tools', {})).details.tools, listed);
  assert.deepEqual(manager.buildSessionContext().messages, []);
});

test('failed native writes do not enable Bash or leave a partially registered definition', async () => {
  const session = host();
  await session.emit('session_start');
  session.blockWrite();
  await assert.rejects(toggle(session, 'bash', true, { confirmed: true }), /session write failed/i);
  assert.equal(session.addons.snapshot().bash, false);
  assert.deepEqual(session.pi.getActiveTools(), nativeTools);

  const enabled = host();
  await enabled.emit('session_start');
  await toggle(enabled, 'bash', true, { confirmed: true });
  enabled.blockWrite();
  await assert.rejects(enabled.execute('deeppi_define_tool', { name: 'unwritten', description: 'No side effects', script: 'printf ok' }), /session write failed/i);
  assert.deepEqual((await enabled.execute('deeppi_list_tools', {})).details.tools, []);
});

// A similarly named user extension must not be replaced or deactivated.
test('prefixed name collisions leave existing native extension tools untouched', async () => {
  const session = host();
  const existing = { name: 'deeppi_run_tool' };
  session.pi.registerTool(existing);
  await session.emit('session_start');
  await assert.rejects(toggle(session, 'bash', true, { confirmed: true }), /deeppi_run_tool/i);
  assert.equal(session.tools.get(existing.name), existing);
  assert(session.pi.getActiveTools().includes(existing.name));
  assert.equal(session.addons.snapshot().bash, false);
});

// Invalid records may come from an older or manually edited local session.
test('programmatic updates from a replaced session context cannot affect the active add-ons', async () => {
  const session = host();
  await session.emit('session_start');
  await toggle(session, 'compact', true);
  const replacement = { ...session.ctx, sessionManager: SessionManager.inMemory() };
  await session.emit('session_start', replacement);
  assert.deepEqual(session.addons.snapshot(), { compact: false, bash: false });
  await assert.rejects(toggle(session, 'compact', true), /session changed/i);
  assert.deepEqual(session.addons.snapshot(), { compact: false, bash: false });
});

test('malformed persisted add-on entries cannot accidentally enable Bash', async () => {
  const original = host();
  await original.emit('session_start');
  await toggle(original, 'bash', true, { confirmed: true });
  const manager = original.ctx.sessionManager;
  const toggleType = manager.getBranch().at(-1).customType;
  manager.appendCustomEntry(toggleType, { id: 'bash', enabled: 'true' });
  const restored = host(manager);
  await restored.emit('session_start');
  assert.equal(restored.addons.snapshot().bash, false);
  assert.deepEqual(restored.pi.getActiveTools(), nativeTools);
});

test('installed Pi dispatches TUI commands, preserves native tools, and publishes add-on state', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'deeppi-addon-sdk-'));
  const settingsManager = SettingsManager.inMemory();
  const sessionManager = SessionManager.inMemory(cwd);
  const changes = [];
  const errors = [];
  let session, addons, confirmed = false;
  t.after(async () => {
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true,
    extensionFactories: [pi => {
      addons = createPiAddons(pi);
      pi.events.on('deeppi:addons-changed', state => changes.push(state));
    }],
  });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, sessionManager, resourceLoader }));
  await session.bindExtensions({ mode: 'tui', uiContext: {
    notify() {}, async confirm() { confirmed = true; return true; },
  }, onError: error => errors.push(error) });
  const original = session.getActiveToolNames();
  assert(original.includes('bash'));
  assert.deepEqual(addons.snapshot(), { compact: false, bash: false });

  await session.prompt('/deeppi-addons enable bash');
  assert.equal(confirmed, true);
  assert.deepEqual(addons.snapshot(), { compact: false, bash: true });
  assert.deepEqual(session.getActiveToolNames(), [...original, ...wrappedTools]);
  const list = session.agent.state.tools.find(tool => tool.name === 'deeppi_list_tools');
  assert.deepEqual((await list.execute('list-1', {})).details.tools, []);

  await session.prompt('/deeppi-addons enable bash');
  await session.prompt('/deeppi-addons disable bash');
  assert.deepEqual(changes, [{ compact: false, bash: true }, { compact: false, bash: false }]);
  assert.deepEqual(session.getActiveToolNames(), original);
  await assert.rejects(list.execute('list-2', {}), /disabled/i);
  assert.deepEqual(errors, []);
  assert.deepEqual(sessionManager.buildSessionContext().messages.filter(message => message.role === 'user'), []);
});
