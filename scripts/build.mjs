import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
    const { name, version, license } = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const key = `${name}@${version}`;
    if (packages.has(key)) continue;
    const files = (await readdir(dir, { withFileTypes: true })).filter(entry =>
      entry.isFile() && /^(?:license|licence|copying|notice)(?:[.-]|$)/iu.test(entry.name)).map(entry => entry.name).sort();
    if (!files.length) throw new Error(`Missing license notice for the bundled dependency ${key}`);
    const texts = await Promise.all(files.map(async file => `${file}\n${(await readFile(join(dir, file), 'utf8')).trim()}`));
    packages.set(key, `${key}${typeof license === 'string' ? ` (${license})` : ''}\n${texts.join('\n\n')}`);
  }
  return [...packages.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, notice]) => notice).join('\n\n---\n\n');
}

const projectNotices = await readFile('THIRD_PARTY_NOTICES', 'utf8');
await Promise.all([['web', 'dist'], ['web/pi', 'dist/pi']].map(async ([source, target]) => {
  await mkdir(`${target}/assets`, { recursive: true });
  const { metafile } = await build({ ...shared, metafile: true, entryPoints: [`${source}/main.tsx`], outfile: `${target}/assets/app.js` });
  const bundled = await browserNotices(metafile);
  await Promise.all([
    copyFile(`${source}/index.html`, `${target}/index.html`),
    copyFile('LICENSE', `${target}/LICENSE`),
    writeFile(`${target}/THIRD_PARTY_NOTICES`, `${projectNotices.trimEnd()}\n\nBundled browser dependencies\n============================\n\n${bundled}\n`),
  ]);
}));
