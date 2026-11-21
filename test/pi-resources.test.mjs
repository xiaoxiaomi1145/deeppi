import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { createPiResources } from '../server/pi/resources.mjs';

function fixture(t) {
  const agentDir = mkdtempSync(join(tmpdir(), 'deeppi-resources-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const registered = new Map();
  const pi = {
    getCommands: () => [{ source: 'extension', name: 'deeppi' }, { source: 'skill', name: 'skill:example', description: 'Example skill' }],
    registerMcpServer: (name, config) => registered.set(name, config),
    unregisterMcpServer: name => registered.delete(name),
    getMcpServers: () => [...registered].map(([name, config]) => ({ name, config })),
  };
  const cwd = join(agentDir, 'workspace');
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  return { agentDir, registered, ctx: { cwd, isProjectTrusted: () => false },
    resources: createPiResources({ pi, agentDir, configDirName: '.pi', parseFrontmatter }) };
}

test('MCP metadata hides connection data and ignores untrusted project files', t => {
  const { agentDir, ctx, resources } = fixture(t);
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { good: { url: 'https://fixture.test/mcp', headers: { Authorization: 'private' } } } }));
  writeFileSync(join(ctx.cwd, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'secret-command' } } }));
  const state = resources.snapshot(ctx, [{ name: 'mcp__good__search' }]);
  assert.deepEqual(state.mcp, [{ name: 'good', transport: 'http', enabled: true, exposure: 'codemode', source: 'pi', tools: 1 }]);
  assert.deepEqual(state.skills, [{ name: 'example', description: 'Example skill' }]);
  assert.doesNotMatch(JSON.stringify(state), /fixture\.test|private|secret-command/u);
});

test('confirmed HTTP registrations and removal go through Pi without ambient API keys', async t => {
  const { ctx, registered, resources } = fixture(t);
  const request = { action: 'register-mcp', name: 'test-mcp', transport: 'http', url: 'https://fixture.test/mcp' };
  await assert.rejects(resources.apply(ctx, request), { status: 403 });
  await assert.rejects(resources.apply(ctx, { ...request, tokenEnv: 'OPENAI_API_KEY', confirmed: true }), { status: 400 });
  await assert.rejects(resources.apply(ctx, { ...request, url: 'http://fixture.test/mcp', confirmed: true }), { status: 400 });
  assert.deepEqual(await resources.apply(ctx, { ...request, confirmed: true, exposure: 'direct' }), { reloadRequired: false, name: 'test-mcp' });
  assert.deepEqual(registered.get('test-mcp'), { url: request.url, exposure: 'direct' });
  await resources.apply(ctx, { action: 'remove-mcp', name: 'test-mcp' });
  assert.equal(registered.size, 0);
});

test('Skill install is native discovery only, refuses traversal and never replaces existing content', async t => {
  const { agentDir, ctx, resources } = fixture(t);
  const markdown = '---\nname: fixture-skill\ndescription: Test native discovery\n---\n\nFriendly instructions.\n';
  await assert.rejects(resources.apply(ctx, { action: 'import-skill', confirmed: true, markdown: markdown.replace('fixture-skill', '../../outside') }), { status: 400 });
  assert.deepEqual(await resources.apply(ctx, { action: 'import-skill', confirmed: true, markdown }), { reloadRequired: true, name: 'fixture-skill' });
  await assert.rejects(resources.apply(ctx, { action: 'import-skill', confirmed: true, markdown: `${markdown} changed` }), { status: 409 });
  assert.equal(readFileSync(join(agentDir, 'skills', 'fixture-skill', 'SKILL.md'), 'utf8'), markdown);
});
