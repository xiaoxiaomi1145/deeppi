import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRounds,
  selectRoundWindow,
  summarizeTools,
  preserveScrollAnchor,
  isNearBottom,
} from './transcript-model.ts';
import {
  HISTORY_WGSL,
  buildHistoryPoints,
  clampHistoryIndex,
  createHistoryNavigator,
} from './transcript-gpu.ts';

const message = (id, role, text = '', extra = {}) => ({
  id,
  role,
  text,
  timestamp: Number(id.replace(/\D/g, '')) || 1,
  ...extra,
});

test('buildRounds groups consecutive tools and omits empty completed assistant stubs', () => {
  const rounds = buildRounds([
    message('u1', 'user', '先做事'),
    message('a1', 'assistant', '', { state: 'done' }),
    message('t1', 'tool', '第一步', { name: 'read', state: 'done', args: { path: 'a' } }),
    message('t2', 'tool', '', { name: 'write', state: 'error', args: { path: 'b' } }),
    message('a2', 'assistant', '结果'),
    message('u2', 'user', '第二轮'),
    message('a3', 'assistant', '', { state: 'running' }),
  ]);

  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].blocks.length, 2);
  assert.deepEqual(rounds[0].blocks[0], { kind: 'tools', tools: [
    rounds[0].blocks[0].tools[0], rounds[0].blocks[0].tools[1],
  ] });
  assert.equal(rounds[0].blocks[1].kind, 'assistant');
  assert.equal(rounds[0].blocks[1].message.text, '结果');
  assert.equal(rounds[1].blocks[0].kind, 'assistant');
  assert.equal(rounds[1].blocks[0].message.state, 'running');
});

test('summarizeTools reports total, progress, and error counts', () => {
  const tools = [
    message('t1', 'tool', 'ok', { state: 'done' }),
    message('t2', 'tool', '', { state: 'running' }),
    message('t3', 'tool', 'bad', { state: 'error' }),
  ];
  assert.deepEqual(summarizeTools(tools), { total: 3, running: 1, errors: 1 });
});

test('selectRoundWindow keeps twelve recent complete rounds and the active tail', () => {
  const rounds = Array.from({ length: 16 }, (_, index) => ({
    id: `r${index}`,
    user: message(`u${index}`, 'user', `round ${index}`),
    blocks: [],
    complete: true,
  }));
  rounds.push({
    id: 'active',
    user: message('u-active', 'user', 'still working'),
    blocks: [{ kind: 'assistant', message: message('a-active', 'assistant', '', { state: 'running' }) }],
    complete: false,
  });

  const initial = selectRoundWindow(rounds);
  assert.equal(initial.visible.map((round) => round.id).join(','), 'r4,r5,r6,r7,r8,r9,r10,r11,r12,r13,r14,r15,active');
  assert.equal(initial.hiddenCount, 4);
  assert.equal(initial.revealedEarlier, 0);

  const expanded = selectRoundWindow(rounds, { revealedEarlier: 3 });
  assert.equal(expanded.visible[0].id, 'r1');
  assert.equal(expanded.hiddenCount, 1);
  assert.equal(expanded.revealedEarlier, 3);
});

test('preserveScrollAnchor adds only the height inserted above the reader', () => {
  assert.equal(preserveScrollAnchor(800, 240, 1160), 600);
  assert.equal(preserveScrollAnchor(1000, 0, 1000), 0);
});

test('isNearBottom treats the threshold as inclusive', () => {
  assert.equal(isNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 520, threshold: 80 }), true);
  assert.equal(isNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 519, threshold: 80 }), false);
});

test('buildHistoryPoints normalizes density and preserves round identity', () => {
  const points = buildHistoryPoints([
    { id: 'r1', toolCount: 0, hasError: false, active: false },
    { id: 'r2', toolCount: 4, hasError: true, active: true },
  ]);
  assert.deepEqual(points.map(({ id, index, density }) => ({ id, index, density })), [
    { id: 'r1', index: 0, density: 0 },
    { id: 'r2', index: 1, density: 1 },
  ]);
  assert.equal(clampHistoryIndex(-2, points.length), 0);
  assert.equal(clampHistoryIndex(9, points.length), 1);
});

test('WebGPU shader declares an explicit vertex and fragment pipeline', () => {
  assert.match(HISTORY_WGSL, /@vertex/);
  assert.match(HISTORY_WGSL, /@fragment/);
  assert.match(createHistoryNavigator.toString(), /\.draw\(/);
});

test('history navigator draws once on changes and releases its fallback context', () => {
  let renderCount = 0;
  let selected = null;
  const listeners = new Map();
  const context = {
    clearRect() { renderCount += 1; },
    fillRect() {},
    setTransform() {},
    fillStyle: '',
  };
  const canvas = {
    width: 180,
    height: 24,
    getContext(kind) {
      assert.equal(kind, '2d');
      return context;
    },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const navigator = createHistoryNavigator(canvas, {
    points: [{ id: 'r1', toolCount: 1, hasError: false, active: false }],
    onSelect(id, index) { selected = [id, index]; },
  });
  listeners.get('pointerdown')({ offsetX: 179 });
  assert.deepEqual(selected, ['r1', 0]);
  assert.equal(renderCount, 1);
  navigator.update([{ id: 'r1', toolCount: 1, hasError: false, active: false }]);
  assert.equal(renderCount, 1);
  navigator.update([{ id: 'r1', toolCount: 2, hasError: false, active: false }]);
  assert.equal(renderCount, 2);
  navigator.destroy();
  assert.equal(listeners.size, 0);
});
