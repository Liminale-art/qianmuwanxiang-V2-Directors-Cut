import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');

test('the manifest loads the bundle, whose entry keeps the host hooks and pulls the start-up graph as one chunk', async () => {
  const manifest = JSON.parse(await read('manifest.json'));
  assert.match(manifest.js, /^bundle\/index\.js\?v=/);
  const entry = await read('bundle/index.js');
  const imports = [...entry.matchAll(/from\s*["'](\.\/[^"']+)["']/g)].map(match => match[1]);
  assert.deepEqual([...new Set(imports)].length, 1, 'the entry statically imports exactly one chunk');
  assert.match(imports[0], /^\.\/chunks\/core-[\w-]+\.js$/);
  for (const hook of ['onActivate', 'onEnable', 'onDisable', 'onUpdate', 'onDelete']) assert.ok(entry.includes(` as ${hook}`) || entry.includes(`function ${hook}`), hook);
  const core = await read('bundle/' + imports[0].slice(2));
  assert.doesNotMatch(core, /^import[^;]*from\s*["']\.\//m, 'the start-up chunk has no further static imports of local chunks');
  assert.ok(core.includes(`VERSION="${manifest.version}"`) || core.includes(`VERSION='${manifest.version}'`), 'the bundle was built from this version of the sources');
  const release = JSON.parse(await read('release-files.json'));
  assert.ok(release.directories.includes('bundle'));
});

test('no chunk reaches back into the source tree, and assets resolve from the extension root', async () => {
  const chunks = (await readdir(new URL('bundle/chunks/', root))).filter(name => name.endsWith('.js'));
  assert.ok(chunks.length > 50);
  const rootExpression = 'import.meta.url.slice(0,import.meta.url.lastIndexOf("/bundle/")+1)';
  for (const name of ['index.js', ...chunks.map(chunk => 'chunks/' + chunk)]) {
    const text = await read('bundle/' + name);
    assert.ok(!text.replaceAll(rootExpression, '').includes('import.meta.url'), `${name}: unrewritten import.meta.url`);
    assert.doesNotMatch(text, /import\(sceneChunk|import\(["']\.\.\/\.\.\/\.\.\//, `${name}: source-only import form`);
    for (const match of text.matchAll(/(?:from\s*|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = new URL(match[1], new URL('bundle/' + name, root));
      assert.ok(existsSync(fileURLToPath(target)), `${name} imports a missing file: ${match[1]}`);
      assert.ok(target.pathname.includes('/bundle/'), `${name} imports outside the bundle: ${match[1]}`);
    }
  }
});

test('the chunk loader uses the build table when present and the importer otherwise', async () => {
  const runtime = await read('qianmu-feature-runtime.js');
  assert.match(runtime, /const direct=typeof __QIANMU_LOCAL_CHUNKS__==='object'\?__QIANMU_LOCAL_CHUNKS__\[name\]:null;/);
  assert.match(runtime, /await \(direct\?direct\(\):importer\(target\.href\)\)/);
  assert.doesNotMatch(runtime, /const __QIANMU_LOCAL_CHUNKS__=/, 'the table exists only in the bundle');
  const entry = await read('bundle/index.js'), core = await read('bundle/' + entry.match(/["']\.\/(chunks\/core-[\w-]+\.js)["']/)[1]);
  const allow = runtime.match(/const localChunkNames=new Set\(\[([\s\S]*?)\]\)/)[1];
  const names = [...allow.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
  const table = core.slice(core.indexOf('const __QIANMU_LOCAL_CHUNKS__='), core.indexOf('const __QIANMU_LOCAL_CHUNKS__=') + 6000);
  for (const name of names) assert.ok(table.includes(JSON.stringify(name) + ':'), `${name} is missing from the bundle's chunk table`);
});

test('the committed bundle matches the sources', { skip: !existsSync(fileURLToPath(new URL('node_modules/rollup/package.json', root))) || !existsSync(fileURLToPath(new URL('node_modules/esbuild/package.json', root))) ? 'build tools not installed (npm i --no-save rollup esbuild)' : false }, () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('scripts/build-bundle.mjs', root)), '--check'], { encoding: 'utf8' });
  assert.match(output, /"current":true/);
});

test('忆幕 loads its single-file bundle, which is self-contained and listed for installation', async () => {
  const manifest = JSON.parse(await read('yimu/manifest.json'));
  assert.equal(manifest.js, 'index.bundle.mjs?v=' + manifest.version);
  const bundle = await read('yimu/index.bundle.mjs');
  assert.ok(!/from\s*["']\.\.?\//.test(bundle), 'no local imports remain');
  assert.ok(!bundle.includes('import.meta.url'));
  assert.ok(bundle.includes('FRONTEND_VERSION="' + manifest.version + '"') || bundle.includes("FRONTEND_VERSION='" + manifest.version + "'"), 'built from this version of the sources');
  assert.ok(bundle.includes('yimuGenerationInterceptor'), 'the generation interceptor named in the manifest is in the bundle');
  const { FRONTEND } = await import('../scripts/build-yimu.mjs');
  assert.ok(FRONTEND.includes('index.bundle.mjs') && FRONTEND.includes('index.mjs'), 'the installer ships the bundle; sources stay alongside it');
});
