import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';

const shared = {
  bundle: true,
  jsx: 'automatic',
  target: ['es2022', 'chrome108', 'safari16.4', 'firefox115'],
  minify: true,
  legalComments: 'eof',
  loader: { '.svg': 'dataurl', '.woff2': 'file' },
};

// Include actual bundled packages, not unrelated development dependencies.
// Both browser surfaces share most dependencies; retain the license read
// promises across the two esbuild passes without changing their notices.
const packageNoticeCache = new Map();
async function packageNotice(dir) {
  if (!packageNoticeCache.has(dir)) {
    packageNoticeCache.set(dir, (async () => {
      const { name, version, license } = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      const files = (await readdir(dir, { withFileTypes: true })).filter(entry =>
        entry.isFile() && /^(?:license|licence|copying|notice)(?:[.-]|$)/iu.test(entry.name)).map(entry => entry.name).sort();
      const key = `${name}@${version}`;
      if (!files.length) throw new Error(`Missing license notice for the bundled dependency ${key}`);
      const texts = await Promise.all(files.map(async file => `${file}\n${(await readFile(join(dir, file), 'utf8')).trim()}`));
      return { key, notice: `${key}${typeof license === 'string' ? ` (${license})` : ''}\n${texts.join('\n\n')}` };
    })());
  }
  return packageNoticeCache.get(dir);
}

async function browserNotices(metafile) {
  const packageDirs = new Set();
  for (const { inputs } of Object.values(metafile.outputs)) {
    for (const [name, { bytesInOutput }] of Object.entries(inputs)) {
      if (!bytesInOutput) continue;
      const path = name.replaceAll('\\', '/');
      const index = path.lastIndexOf('node_modules/');
      if (index < 0) continue;
      const relative = /^(?:@[^/]+\/)?[^/]+(?=\/)/u.exec(path.slice(index + 'node_modules/'.length));
      if (relative) packageDirs.add(path.slice(0, index + 'node_modules/'.length) + relative[0]);
    }
  }
  const packages = new Map();
  for (const dir of [...packageDirs].sort()) {
    const { key, notice } = await packageNotice(dir);
    if (!packages.has(key)) packages.set(key, notice);
  }
  return [...packages.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, notice]) => notice).join('\n\n---\n\n');
}

const projectNotices = await readFile('THIRD_PARTY_NOTICES', 'utf8');
const surfaces = [['web', 'dist'], ['web/pi', 'dist/pi']];
let sharedNotice;
for (const [source, target] of surfaces) {
  await mkdir(`${target}/assets`, { recursive: true });
  const { metafile } = await build({ ...shared, metafile: true, entryPoints: [`${source}/main.tsx`], outfile: `${target}/assets/app.js` });
  const bundled = await browserNotices(metafile);
  await Promise.all([
    copyFile(`${source}/index.html`, `${target}/index.html`),
    copyFile('LICENSE', `${target}/LICENSE`),
    ...(target === 'dist/pi' ? [copyFile('web/pi-web/index.html', `${target}/pi-web.html`)] : []),
  ]);
  const notice = `${projectNotices.trimEnd()}\n\nBundled browser dependencies\n============================\n\n${bundled}\n`;
  if (target === 'dist') {
    sharedNotice = notice;
    await writeFile(`${target}/THIRD_PARTY_NOTICES`, notice);
  } else {
    // The Pi surface is nested below dist/. The HTTP static handler serves the
    // single root notice from there, so the generated package does not carry
    // an identical 85 KiB second copy.
    const targetNotice = `${target}/THIRD_PARTY_NOTICES`;
    if (notice === sharedNotice) {
      try { await unlink(targetNotice); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else {
      await writeFile(targetNotice, notice);
    }
  }
}
