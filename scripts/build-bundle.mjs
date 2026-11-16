// Builds the shipped bundles: `bundle/index.js` plus `bundle/chunks/*` (千幕) and `yimu/index.bundle.mjs` (忆幕).
//
// Why: ST loads an extension's entry module and the browser then fetches every statically imported file
// one by one (and re-validates each on every start). The source tree is ~400 small modules; a start-up
// that touches 200+ of them costs 200+ round trips. The bundle keeps the same module graph and
// semantics but ships everything the entry reaches by static import as one chunk, and each on-demand
// feature as its own chunk.
//
// The sources stay the single source of truth: tests run on them, and nothing in `bundle/` is edited by
// hand. Run `node scripts/build-bundle.mjs` before every push; `--check` verifies the committed bundle
// matches the sources without writing. Tools: `npm i --no-save rollup esbuild` (not shipped, not in
// package.json).
//
// Source constructs that only make sense per file are rewritten at load time, with exact match counts
// asserted so a silent miss fails the build:
//   • `import.meta.url`            → the original file's URL (assets, workers and styles stay where they are)
//   • on-demand local chunks       → a table of literal imports handed to the chunk loader
//   • two computed own-module imports (scene chunks, lock runtime) → literal imports
//   • ST host modules imported by relative path → their absolute paths (the entry moves one level down)
import { rollup } from 'rollup';
import { transform } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'bundle');
const check = process.argv.includes('--check');
const rel = file => path.relative(root, file).split(path.sep).join('/');
const fail = message => { throw new Error(`build-bundle: ${message}`); };
const EXTERNAL = id => id.startsWith('/scripts/') || id === '/lib.js' || id === '/script.js';
const strip = id => id.split('?')[0];
const ROOT_URL = 'import.meta.url.slice(0,import.meta.url.lastIndexOf("/bundle/")+1)';

// ── On-demand chunk table ────────────────────────────────────────────────────────────────────────────
// The loader validates names against an allowlist; every allowlisted name has exactly one canonical URL
// across its call sites (tests/local-chunks.test.mjs enforces that), which is what gets imported here.
async function localChunkTable() {
  const runtime = await readFile(path.join(root, 'qianmu-feature-runtime.js'), 'utf8');
  const allow = runtime.match(/const localChunkNames=new Set\(\[([\s\S]*?)\]\)/);
  if (!allow) fail('local chunk allowlist not found');
  const names = [...allow[1].matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
  const files = (await readdir(root)).filter(name => /^(index|qianmu-[\w-]+)\.js$/.test(name));
  const canonical = new Map();
  for (const file of files) {
    const source = await readFile(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/['"](\.\/(qianmu-[\w-]+\.js)(?:\?v=[\w.-]+)?)['"]/g)) {
      const [, url, name] = match;
      if (!names.includes(name)) continue;
      const before = source.slice(Math.max(0, match.index - 40), match.index);
      const literalCall = /(?:loadLocalChunk|\bload)\(\s*$/.test(before), idleEntry = file === 'qianmu-idle-preload.js';
      if (!literalCall && !idleEntry) continue;
      if (canonical.has(name) && canonical.get(name) !== url) fail(`${name} has two on-demand URLs: ${canonical.get(name)} and ${url}`);
      canonical.set(name, url);
    }
  }
  for (const name of names) if (!canonical.has(name)) fail(`no on-demand call site found for ${name}`);
  return `const __QIANMU_LOCAL_CHUNKS__={${names.map(name => `${JSON.stringify(name)}:()=>import(${JSON.stringify(canonical.get(name))})`).join(',')}};\n`;
}

// ── Per-file rewrites ────────────────────────────────────────────────────────────────────────────────
const HOST_IMPORTS = { '../../../extensions.js': '/scripts/extensions.js', '../../../secrets.js': '/scripts/secrets.js', '../../../utils.js': '/scripts/utils.js', '../../../script.js': '/scripts/script.js' };
function exact(file, source, pattern, replacement, expected) {
  let count = 0;
  const next = source.replace(pattern, (...args) => { count++; return typeof replacement === 'function' ? replacement(...args) : replacement; });
  if (count !== expected) fail(`${file}: expected ${expected} match(es) of ${pattern}, found ${count}`);
  return next;
}
function rewrite(file, source, table) {
  if (file === 'qianmu-feature-runtime.js') source = table + source;
  if (file === 'qianmu-comfy-lock-runtime.js') source = exact(file, source, /import\(sceneChunk\('([\w-]+)'\)\)/g, (_, name) => `import('./${name}.js')`, 2);
  if (file === 'index.js') {
    source = exact(file, source, /import\(`\.\/qianmu-comfy-lock-runtime\.js\?v=\$\{VERSION\}`\)/g, "import('./qianmu-comfy-lock-runtime.js')", 1);
    for (const [from, to] of Object.entries(HOST_IMPORTS)) source = source.replaceAll(`import('${from}')`, `import('${to}')`);
    if (/import\('\.\.\/\.\.\/\.\.\//.test(source)) fail('index.js still imports a host module by relative path');
  }
  return source;
}

// Module ids keep their `?v=` suffix: in the browser `x.js?v=1` and `x.js` are two module instances, and
// the bundle keeps exactly that (no instance is merged or split by the build).
function sourcePlugin(table) {
  return {
    name: 'qianmu-source',
    resolveId(source, importer) {
      if (EXTERNAL(source)) return { id: source, external: true };
      if (!importer) return path.resolve(root, source);
      if (!source.startsWith('.')) fail(`${rel(strip(importer))} imports a bare or absolute module: ${source}`);
      const at = source.indexOf('?'), file = at < 0 ? source : source.slice(0, at), query = at < 0 ? '' : source.slice(at);
      const target = path.resolve(path.dirname(strip(importer)), file);
      if (!existsSync(target)) fail(`${rel(strip(importer))} imports a missing file: ${source}`);
      return target + query;
    },
    async load(id) { return rewrite(rel(strip(id)), await readFile(strip(id), 'utf8'), table); },
    // Everything under bundle/ can find the extension root from its own URL, at any depth, so assets,
    // workers and stylesheets resolve exactly where the source file expected them.
    resolveImportMeta(property, { moduleId }) {
      return property === 'url' ? `(${ROOT_URL}+${JSON.stringify(rel(strip(moduleId)))})` : null;
    },
    async renderChunk(code) { return (await transform(code, { minifyWhitespace: true, legalComments: 'none', charset: 'utf8', target: 'es2022' })).code; },
  };
}

async function compile() {
  const entry = path.join(root, 'index.js');
  let startup = null;
  const warnings = [];
  const bundle = await rollup({
    input: { index: entry }, plugins: [sourcePlugin(await localChunkTable())],
    // Semantics first: nothing is dropped or reordered beyond what module linking itself requires.
    treeshake: false, preserveEntrySignatures: 'strict',
    onwarn: warning => { if (!['CIRCULAR_DEPENDENCY', 'EVAL'].includes(warning.code)) warnings.push(warning); },
  });
  const output = await bundle.generate({
    dir: outDir, format: 'es', entryFileNames: 'index.js', chunkFileNames: 'chunks/[name]-[hash].js', generatedCode: 'es2015', hoistTransitiveImports: false,
    // Everything the entry reaches by static import ships as one chunk; on-demand features import from it.
    manualChunks(id, { getModuleInfo }) {
      if (!startup) {
        startup = new Set(); const queue = [entry];
        while (queue.length) {
          const next = queue.pop(); if (startup.has(next)) continue; startup.add(next);
          const info = getModuleInfo(next); if (info && !info.isExternal) queue.push(...info.importedIds.filter(item => !EXTERNAL(item)));
        }
      }
      return startup.has(id) ? 'core' : undefined;
    },
  });
  await bundle.close();
  if (warnings.length) fail(`unexpected warnings:\n${warnings.map(w => `  [${w.code}] ${w.message}`).slice(0, 12).join('\n')}`);
  const chunks = output.output.filter(item => item.type === 'chunk');
  const files = chunks.map(chunk => ({ name: chunk.fileName, text: chunk.code })).sort((x, y) => x.name.localeCompare(y.name));
  // Post-conditions: nothing in the bundle may reach back into the source tree by a computed module URL.
  for (const file of files) {
    if (/import\(sceneChunk|\$\{VERSION\}`\)|import\(['"]\.\.\/\.\.\/\.\.\//.test(file.text)) fail(`${file.name} kept a source-only import form`);
    if (file.text.replaceAll(ROOT_URL, '').includes('import.meta.url')) fail(`${file.name} uses an unrewritten import.meta.url`);
  }
  const index = chunks.find(chunk => chunk.fileName === 'index.js');
  if (!index) fail('no entry chunk');
  for (const hook of ['onActivate', 'onEnable', 'onDisable', 'onUpdate', 'onDelete']) if (!index.exports.includes(hook)) fail(`entry lost its ${hook} export`);
  const reach = new Set();
  const walk = name => { if (reach.has(name)) return; reach.add(name); for (const next of chunks.find(chunk => chunk.fileName === name)?.imports || []) if (!EXTERNAL(next)) walk(next); };
  walk('index.js');
  return { files, startup: reach.size, modules: startup.size };
}

// ── 忆幕 ─────────────────────────────────────────────────────────────────────────────────────────────
// A separate extension living in yimu/. Its front end is ~40 flat modules with no on-demand chunks and no
// file-relative URLs, so it ships as one file next to its sources: yimu/index.bundle.mjs.
const yimuOut = path.join(root, 'yimu', 'index.bundle.mjs');
async function compileYimu() {
  const warnings = [];
  const bundle = await rollup({
    input: path.join(root, 'yimu', 'index.mjs'), treeshake: false, preserveEntrySignatures: 'strict',
    external: id => id.startsWith('node:') || EXTERNAL(id),
    plugins: [{
      name: 'yimu-source',
      resolveId(source, importer) {
        if (source.startsWith('node:') || EXTERNAL(source)) return { id: source, external: true };
        if (!importer) return path.resolve(root, source);
        if (!source.startsWith('./')) fail(`yimu/${path.basename(strip(importer))} imports outside its own folder: ${source}`);
        const at = source.indexOf('?'), target = path.resolve(path.dirname(strip(importer)), at < 0 ? source : source.slice(0, at));
        if (!existsSync(target)) fail(`yimu/${path.basename(strip(importer))} imports a missing file: ${source}`);
        return target + (at < 0 ? '' : source.slice(at));
      },
      async load(id) { return readFile(strip(id), 'utf8'); },
      resolveImportMeta(property, { moduleId }) { fail(`${rel(strip(moduleId))} uses import.meta.${property}; register how the bundle should resolve it`); },
      async renderChunk(code) { return (await transform(code, { minifyWhitespace: true, legalComments: 'none', charset: 'utf8', target: 'es2022' })).code; },
    }],
    onwarn: warning => { if (!['CIRCULAR_DEPENDENCY', 'EVAL'].includes(warning.code)) warnings.push(warning); },
  });
  const output = await bundle.generate({ format: 'es', generatedCode: 'es2015', inlineDynamicImports: true });
  await bundle.close();
  if (warnings.length) fail(`yimu warnings: ${warnings.map(w => `[${w.code}] ${w.message}`).slice(0, 12).join('; ')}`);
  const chunks = output.output.filter(item => item.type === 'chunk');
  if (chunks.length !== 1) fail(`yimu produced ${chunks.length} chunks; expected one file`);
  if (/from\s*["']\.\.?\//.test(chunks[0].code)) fail('yimu bundle still imports a local file');
  return { name: 'yimu/index.bundle.mjs', text: chunks[0].code, modules: Object.keys(chunks[0].modules).length };
}

const digest = files => createHash('sha256').update(files.map(file => `${file.name}\0${file.text}`).join('\0')).digest('hex');
async function committed() {
  if (!existsSync(outDir)) return [];
  const walk = async dir => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))).flat();
  const found = (await walk(outDir)).filter(file => file.endsWith('.js'));
  const files = await Promise.all(found.map(async file => ({ name: path.relative(outDir, file).split(path.sep).join('/'), text: await readFile(file, 'utf8') })));
  return files.sort((x, y) => x.name.localeCompare(y.name));
}

const { files, startup, modules } = await compile();
const yimu = await compileYimu();
const summary = { files: files.length, startupRequests: startup, startupModules: modules, bytes: files.reduce((total, file) => total + Buffer.byteLength(file.text), 0), digest: digest(files),
  yimu: { modules: yimu.modules, bytes: Buffer.byteLength(yimu.text), digest: digest([yimu]) } };
if (check) {
  const yimuNow = existsSync(yimuOut) ? await readFile(yimuOut, 'utf8') : '';
  const stale = [digest(await committed()) !== summary.digest && 'bundle/', digest([{ name: yimu.name, text: yimuNow }]) !== summary.yimu.digest && 'yimu/index.bundle.mjs'].filter(Boolean);
  if (stale.length) { console.error(`${stale.join(' and ')} stale; run node scripts/build-bundle.mjs`); process.exit(1); }
  console.log(JSON.stringify({ ...summary, current: true }));
} else {
  await rm(outDir, { recursive: true, force: true });
  for (const file of files) { const target = path.join(outDir, file.name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.text); }
  await writeFile(yimuOut, yimu.text);
  console.log(JSON.stringify(summary));
}
