import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoopbackServer } from '../server/http.mjs';

test('Pi static root reuses the single parent third-party notice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deeppi-http-'));
  const dist = join(root, 'dist');
  const piDist = join(dist, 'pi');
  const notice = 'shared browser notices\n';
  await mkdir(join(piDist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'THIRD_PARTY_NOTICES'), notice);
  const server = createLoopbackServer({ distDir: piDist, accessToken: 'fixture', api: async () => {} });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/THIRD_PARTY_NOTICES`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), await readFile(join(dist, 'THIRD_PARTY_NOTICES'), 'utf8'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
