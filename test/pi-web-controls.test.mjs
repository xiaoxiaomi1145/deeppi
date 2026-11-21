import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebModels } from '../server/pi/web-models.mjs';
import { slashCommand, webCommands, expandSkillMentions } from '../server/pi/web-input.mjs';
import { nativeCompaction, updateContextPolicy, autoCompactionThreshold } from '../server/pi/context-policy.mjs';
import { createPiHost } from '../server/pi/host.mjs';

function fakeHost() {
  const handlers = new Map(), entries = [], sent = [], compacted = [], choices = [];
  let name = '', pending = false;
  const unknown = { provider: 'unknown', id: 'unknown', api: 'unknown', contextWindow: 0 };
  const model = { provider: 'p', id: 'm', api: 'openai-completions', name: 'Model', contextWindow: 100_000 };
  const manager = { getSessionId: () => 'current', getBranch: () => entries, getLeafId: () => String(entries.length) };
  const ctx = { cwd: '/fixture', model: unknown, sessionManager: manager, modelRegistry: { getAvailable: () => choices },
    isIdle: () => true, hasPendingMessages: () => pending, getContextUsage: () => ({ tokens: 70_000, contextWindow: 100_000 }),
    compact: options => { compacted.push(options.customInstructions); options.onComplete?.(); } };
  const pi = { on: (name, fn) => handlers.set(name, fn), events: { on() {} }, getSessionName: () => name,
    getAllTools: () => [], getActiveTools: () => [], getThinkingLevel: () => 'off', getCommands: () => commands,
    getSettings: () => ({ compaction: { enabled: false, reserveTokens: 200 } }),
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    setSessionName: value => { name = value; }, setThinkingLevel: () => {},
    setModel: async value => { ctx.model = value; return true; },
    sendUserMessage: async (value, options) => { sent.push([value, options]); } };
  const host = createPiHost({ pi, addons: { snapshot: () => ({ compact: false }) }, resources: { snapshot: () => ({}), skills: () => [] },
    catalog: {}, hub: { bind() {}, isBound: () => true, publishState() {} },
    webModels: { snapshot: () => ({ models: [] }), apply: async () => { choices.push(model); return model; } } });
  handlers.get('session_start')({}, ctx);
  return { host, ctx, handlers, entries, sent, compacted, choices, pending: value => { pending = value; }, model };
}

const dispatch = (fixture, name, body) => fixture.host.action(name, body, new AbortController().signal);
const tick = () => new Promise(resolve => setImmediate(resolve));

test('host exposes model configuration, routes native slash without a model, never runs foreign commands', async () => {
  const fixture = fakeHost();
  assert.equal(fixture.host.snapshot().model, null);
  assert.deepEqual(await dispatch(fixture, 'prompt', { text: '/model' }), { ok: true, panel: 'model' });
  await dispatch(fixture, 'prompt', { text: '/name New title' });
  assert.equal(fixture.host.snapshot().title, 'New title');
  await assert.rejects(dispatch(fixture, 'prompt', { text: '/foreign' }), { status: 400 });
  assert.deepEqual(await dispatch(fixture, 'models', { action: 'save', use: true }), { ok: true });
  assert.equal(fixture.host.snapshot().model.id, 'm');
  assert.equal(fixture.sent.length, 0);
  await dispatch(fixture, 'prompt', { text: '/review concise' });
  assert.deepEqual(fixture.sent, [['/review concise', { deliverAs: 'followUp', expandPromptTemplates: true }]]);
});

test('additional compaction is native, uses stored focus, and will not run on abort, queued input, or the same leaf twice', async () => {
  const fixture = fakeHost();
  fixture.ctx.model = fixture.model;
  await dispatch(fixture, 'settings', { systemPrompt: 'keep me', context: { threshold: 65, focus: 'Keep decisions' } });
  assert.deepEqual(fixture.host.snapshot().context.policy, { threshold: 65, focus: 'Keep decisions' });
  assert.equal(fixture.host.snapshot().context.native.enabled, false);
  await dispatch(fixture, 'settings', { systemPrompt: 'new system prompt' });
  fixture.handlers.get('session_tree')();
  assert.equal(fixture.host.snapshot().context.policy.focus, 'Keep decisions');
  fixture.handlers.get('agent_settled')({ aborted: true });
  await tick();
  fixture.pending(true);
  fixture.handlers.get('agent_settled')({ aborted: false });
  await tick();
  assert.deepEqual(fixture.compacted, []);
  fixture.pending(false);
  for (let i = 0; i < 2; i += 1) { fixture.handlers.get('agent_settled')({ aborted: false }); await tick(); }
  assert.deepEqual(fixture.compacted, ['Keep decisions']);
});

async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), 'deeppi-controls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const replacement = { action: 'save', slug: 'gateway', protocol: 'openai-completions', baseUrl: 'https://one.example/v1/',
  apiKey: 'fixture-private', modelId: 'vendor/model', name: 'Gateway', contextWindow: 32000, maxOutputTokens: 4096, reasoning: true };

function registry(t, agentDir) {
  const entries = new Map();
  const pi = { registerProvider: (id, config) => entries.set(id, config), unregisterProvider: id => entries.delete(id) };
  return { entries, web: createWebModels({ pi, agentDir }) };
}

test('web model has its own native provider, never returns its key, and reloads privately', async t => {
  const root = await temp(t);
  const { entries, web } = registry(t, root);
  const config = await web.apply(replacement, null);
  assert.equal(config.provider, 'deeppi-web-gateway');
  assert.equal(entries.get(config.provider).models[0].contextWindow, 32000);
  assert.equal(entries.get(config.provider).apiKey, 'fixture-private');
  assert.equal(web.snapshot().models[0].hasKey, true);
  assert.doesNotMatch(JSON.stringify(web.snapshot()), /fixture-private|"apiKey"/u);
  const file = join(root, 'deeppi', 'web-models.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 1);
  const reopened = registry(t, root);
  assert.equal(reopened.entries.get(config.provider).models[0].id, 'vendor/model');
  assert.equal(reopened.web.snapshot().models[0].baseUrl, 'https://one.example/v1');
});

test('editing a model will not implicitly forward its old key to a changed URL', async t => {
  const { entries, web } = registry(t, await temp(t));
  await web.apply(replacement, null);
  await assert.rejects(web.apply({ ...replacement, editing: true, baseUrl: 'https://two.example/v1', apiKey: '' }, null), { status: 400 });
  assert.equal(entries.get('deeppi-web-gateway').baseUrl, 'https://one.example/v1');
  await web.apply({ ...replacement, editing: true, baseUrl: 'https://two.example/v1', apiKey: 'fixture-new' }, null);
  assert.equal(entries.get('deeppi-web-gateway').apiKey, 'fixture-new');
});

test('model rejects command/env-shaped keys, insecure URLs, duplicate name and removal while selected', async t => {
  const { web } = registry(t, await temp(t));
  for (const patch of [{ apiKey: '!not-a-key' }, { apiKey: '${NOT_A_KEY}' }, { baseUrl: 'http://one.example/v1' },
    { maxOutputTokens: 32000 }, { baseUrl: 'https://u:pass@one.example/v1' }]) {
    await assert.rejects(web.apply({ ...replacement, ...patch }, null), { status: 400 });
  }
  const model = await web.apply(replacement, null);
  await assert.rejects(web.apply(replacement, null), { status: 409 });
  await assert.rejects(web.apply({ action: 'remove', slug: 'gateway' }, model), { status: 409 });
  await web.apply({ action: 'remove', slug: 'gateway' }, null);
  assert.deepEqual(web.snapshot().models, []);
});

const commands = [
  { name: 'review', source: 'prompt', description: 'Review requested changes' },
  { name: 'skill:format', source: 'skill', description: 'Apply format' },
  { name: 'foreign', source: 'prompt' }, { name: 'foreign', source: 'extension' },
];

test('slash knows native shortcuts, supports registered prompts and keeps unadapted extensions terminal-only', () => {
  const available = webCommands(commands);
  assert.equal(available.find(x => x.name === 'review').kind, 'prompt');
  assert.equal(available.find(x => x.name === 'foreign').kind, 'terminal');
  assert.equal(available.find(x => x.name === 'login').kind, 'terminal');
  assert.deepEqual(slashCommand('/model deeppi-web-gateway/vendor/model', commands), { name: 'model', args: 'deeppi-web-gateway/vendor/model', kind: 'native' });
  assert.deepEqual(slashCommand('/review --brief', commands), { name: 'review', args: '--brief', kind: 'prompt' });
  assert.deepEqual(slashCommand('/skill:format', commands), { name: 'skill:format', args: '', kind: 'skill' });
  assert.throws(() => slashCommand('/foreign', commands), { status: 400 });
  assert.throws(() => slashCommand('/not-loaded', commands), { status: 400 });
  assert.equal(slashCommand('Read /model from the docs', commands), null);
  assert.equal(slashCommand('/usr/bin/tool', commands), null);
});

test('@skills matches native registered skills only and expands unique referenced content in one request', async t => {
  const root = await temp(t);
  const format = join(root, 'format.md');
  const review = join(root, 'review.md');
  await writeFile(format, '---\nname: format\n---\nFORMAT_RULE');
  await writeFile(review, 'REVIEW_RULE');
  const sources = [{ name: 'skill:format', source: 'skill', sourceInfo: { path: format } },
    { name: 'skill:review', source: 'skill', sourceInfo: { path: review } }, { name: 'skill:foreign', source: 'extension', sourceInfo: { path: review } }];
  const result = await expandSkillMentions('Fix @skills:format then @skills:review and @skills:format.', sources, (value) => value.replace(/^---[\s\S]*?---\n/u, ''));
  assert.equal(result.match(/FORMAT_RULE/gu)?.length, 1);
  assert.match(result, /<skill name="review"[^>]*>[\s\S]*REVIEW_RULE/u);
  assert.match(result, /Fix @skills:format then @skills:review and @skills:format\.$/u);
  assert.equal(await expandSkillMentions('example `@skills:not-loaded` and \\@skills:not-loaded', sources), 'example `@skills:not-loaded` and \\@skills:not-loaded');
  await assert.rejects(expandSkillMentions('@skills:foreign', sources), { status: 400 });
});

test('session threshold is opt-in, never applies on an unknown window, and reports native policy separately', () => {
  const rule = updateContextPolicy({ threshold: null, focus: '' }, { threshold: 65, focus: 'remember tests' });
  assert.equal(autoCompactionThreshold(rule, 10000), 6500);
  assert.equal(autoCompactionThreshold(rule, 0), null);
  assert.equal(autoCompactionThreshold(updateContextPolicy(rule, { threshold: null }), 10000), null);
  assert.throws(() => updateContextPolicy(rule, { threshold: 110 }), { status: 400 });
  assert.deepEqual(nativeCompaction({ compaction: { enabled: false, reserveTokens: 500, keepRecentTokens: 2400,
    modelOverrides: { 'custom/test': { reserveTokens: 900 } } } }, { provider: 'custom', id: 'test', contextWindow: 10000 }),
  { enabled: false, reserveTokens: 900, keepRecentTokens: 2400 });
});
