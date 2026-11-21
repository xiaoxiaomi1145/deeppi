import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStickerStore } from '../server/qq/stickers.mjs';

const scope = '100100:p:100200';
const group = '100100:g:100200';
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const image = { file: `base64://${gif.toString('base64')}` };
const cdn = 'https://multimedia.nt.qq.com.cn/download?secret=fixture-only';
const fixture = async (t, fetch) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'deeppi-stickers-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, store: createStickerStore({ dataDir, fetch }) };
};
const status = expected => error => error.status === expected;

test('saved image, stable number and AI note survive a cold start within one conversation', async t => {
  const { dataDir, store } = await fixture(t);
  assert.deepEqual(await store.list(scope), []);
  assert.deepEqual(await store.save(scope, image, '  开心  '), { id: 1, note: '开心', bytes: 42 });
  assert.deepEqual(await store.save(scope, image, '鼓掌'), { id: 2, note: '鼓掌', bytes: 42 });
  const reloaded = createStickerStore({ dataDir });
  assert.deepEqual(await reloaded.list(scope), [
    { id: 1, note: '开心', bytes: 42 }, { id: 2, note: '鼓掌', bytes: 42 },
  ]);
  assert.deepEqual(await reloaded.read(scope, 2), {
    id: 2, note: '鼓掌', bytes: 42, segment: { type: 'image', data: image },
  });
  assert.deepEqual(await reloaded.list(group), []);
  assert.deepEqual(await reloaded.list('100101:p:100200'), []);
  await assert.rejects(reloaded.read(group, 2), status(404));
  assert.equal((await reloaded.save(group, image, '群里收藏')).id, 1);
  const member = `${group}:u:100201`;
  assert.deepEqual(await reloaded.list(member), []);
  assert.equal((await reloaded.save(member, image, '群成员收藏')).id, 1);
  assert.equal((await reloaded.read(group, 1)).note, '群里收藏');
  await assert.rejects(reloaded.read(`${group}:u:100202`, 1), status(404));
});

 test('overlapping saves retain each entry and do not duplicate an id across instances', async t => {
  const { dataDir, store } = await fixture(t);
  const second = createStickerStore({ dataDir });
  const expected = Array.from({ length: 12 }, (_, i) => `note ${i}`);
  const rows = await Promise.all(expected.map((note, i) => (i % 2 ? second : store).save(scope, image, note)));
  assert.deepEqual(rows.map(row => row.id).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.deepEqual((await second.list(scope)).map(row => row.note).sort(), [...expected].sort());
});

 test('exact QQ HTTPS sources are fetched once with redirects disabled and no credentials', async t => {
  let seen;
  const { dataDir, store } = await fixture(t, async (url, options) => {
    seen = { url: String(url), options };
    return new Response(gif, { headers: { 'Content-Type': 'application/octet-stream' } });
  });
  assert.deepEqual(await store.save(scope, { url: cdn, file: 'inbound.gif' }, '下载的表情'), {
    id: 1, note: '下载的表情', bytes: 42,
  });
  assert.equal(seen.url, cdn);
  assert.equal(seen.options.redirect, 'error');
  assert.equal(seen.options.credentials, 'omit');
  assert.ok(seen.options.signal instanceof AbortSignal);
  const root = join(dataDir, 'stickers');
  const files = await readdir(root);
  assert.equal(files.length, 1);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, files[0]))).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(join(root, files[0]), 'utf8'), /fixture-only|multimedia|inbound\.gif/);
});

 test('untrusted sources, invalid identifiers and noncanonical base64 cannot enter the store', async t => {
  const { store } = await fixture(t, () => assert.fail('untrusted inputs must not reach fetch'));
  for (const media of [
    { file: '/tmp/local.gif' }, { url: 'file:///tmp/local.gif' }, { url: 'http://gchat.qpic.cn/face' },
    { url: 'https://gchat.qpic.cn.example.test/face' }, { url: 'https://gchat.qpic.cn:8443/face' },
    { url: 'https://secret@gchat.qpic.cn/face' }, { url: 'https://gchat.qpic.cn@127.0.0.1/face' },
    { url: 'https://127.0.0.1/face' }, { file: 'base64://not!valid' },
  ]) await assert.rejects(store.save(scope, media, 'rejected'), status(400));
  await assert.rejects(store.save('../../private', image, 'rejected'), status(400));
  await assert.rejects(store.save(scope, image, 'bad\nline'), status(400));
  await assert.rejects(store.read(scope, '../other'), status(400));
  assert.deepEqual(await store.list(scope), []);
});

 test('an image content type cannot make SVG look like an allowed raster', async t => {
  const { store } = await fixture(t, async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
    headers: { 'Content-Type': 'image/png' },
  }));
  await assert.rejects(store.save(scope, { url: cdn }, '不是位图'), status(415));
  assert.deepEqual(await store.list(scope), []);
});

 test('rejects both declared oversize and streaming oversize without reserving a number', async t => {
  let canceled = false;
  const { store } = await fixture(t, async url => {
    if (String(url).endsWith('declared')) return new Response(gif, { headers: { 'Content-Length': '2097153' } });
    let sent = 0;
    return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(Buffer.alloc(sent++ ? 1 : 2 * 1024 * 1024)); },
      cancel() { canceled = true; },
    }));
  });
  await assert.rejects(store.save(scope, { url: 'https://gchat.qpic.cn/declared' }, 'declared'), status(413));
  await assert.rejects(store.save(scope, { url: 'https://gchat.qpic.cn/chunked' }, 'chunked'), status(413));
  assert.equal(canceled, true);
  assert.equal((await store.save(scope, image, 'valid')).id, 1);
});

 test('caller cancellation prevents a delayed image from being persisted', async t => {
  const controller = new AbortController();
  const { store } = await fixture(t, async (_url, options) => {
    assert.equal(options.signal.aborted, false);
    controller.abort(new Error('turn cancelled'));
    return new Response(gif);
  });
  await assert.rejects(store.save(scope, { url: cdn }, 'cancelled', controller.signal), /turn cancelled/);
  assert.deepEqual(await store.list(scope), []);
});

 test('at capacity saving more fails without evicting or changing earlier ids', async t => {
  const { store } = await fixture(t);
  for (let id = 1; id <= 32; id++) {
    assert.equal((await store.save(scope, image, `note ${id}`)).id, id);
  }
  await assert.rejects(store.save(scope, image, 'overflow'), status(409));
  assert.equal((await store.read(scope, 1)).note, 'note 1');
  assert.equal((await store.read(scope, 32)).note, 'note 32');
});

 test('embedded media is still limited by total bytes per conversation', async t => {
  const big = Buffer.alloc(2 * 1024 * 1024);
  gif.copy(big);
  const { store } = await fixture(t);
  const media = { file: `base64://${big.toString('base64')}` };
  for (let id = 1; id <= 4; id++) await store.save(scope, media, `large ${id}`);
  await assert.rejects(store.save(scope, image, 'overflow'), status(409));
  assert.equal((await store.list(scope)).length, 4);
});

 test('the private storage directory cannot be replaced with a symlink', async t => {
  const { dataDir, store } = await fixture(t);
  await symlink(dataDir, join(dataDir, 'stickers'), 'dir');
  await assert.rejects(store.save(scope, image, 'blocked'), status(500));
  assert.deepEqual(await readdir(dataDir), ['stickers']);
});
