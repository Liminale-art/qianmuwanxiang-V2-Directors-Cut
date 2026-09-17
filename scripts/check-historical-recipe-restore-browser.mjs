// Browser QMB -> guarded recipe stage -> actual plugin route -> immutable files.
// A test-only host consumer persists one proposal to prove ordinary cross-device
// reading. This is NOT the production host transaction or a restored v4 UI.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { historicalRecipeRestoreFixture } from '../tests/helpers/historical-recipe-restore-fixture.mjs';
import { init, exit } from '../server-plugin.js';
const { chromium } = createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const f = await historicalRecipeRestoreFixture(null, { extraArchives: 1, prepare: f => { f.rows[1].snapshotRef = 'legacy preserved'; f.rows[1].future = { exact: '  keep  ', zero: 0 }; } });
const before = await fs.readFile(f.file), original = structuredClone(f.current), source = structuredClone(f.source), retained = [];
for (const recipe of source.recipes.filter(row => row.origin === 'server-archive')) {
  const file = path.join(f.archive, recipe.reference.id + '.json'); assert.equal(path.dirname(file), f.archive);
  const bytes = await fs.readFile(file); await fs.rename(file, file + '.retained'); retained.push([file + '.retained', bytes]);
}
const modules = new Map(await Promise.all(JSON.parse(await fs.readFile(new URL('../release-files.json', import.meta.url))).files.filter(name => name.endsWith('.js'))
  .map(async name => ['/' + name, await fs.readFile(new URL('../' + name, import.meta.url))])));
const routes = new Map(), checks = [], errors = [], unexpected = [], calls = [];
await init({ get: (name, handler) => routes.set('GET ' + name, handler), post: (name, handler) => routes.set('POST ' + name, handler) }, { dataRoot: f.root });
let mode = 'normal', nth = 0;
const server = http.createServer(async (req, res) => {
  try {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Isolated historical recipe stage</title>'); return; }
    if (route === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (modules.has(route)) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(modules.get(route)); return; }
    if (route === '/fixture.qmb') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(Buffer.from(await f.packed.file.arrayBuffer())); return; }
    if (route === '/fixture') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(f.current)); return; }
    if (!/^\/api\/plugins\/qianmu-tts\/chat-gallery\/recipe\/(restore|read)$/.test(route)) { unexpected.push(route); res.writeHead(404); res.end(); return; }
    let body = ''; for await (const part of req) { body += part; if (body.length > 2 * 1048576) throw Error('oversized fixture request'); }
    req.body = JSON.parse(body); req.user = f.req.user; calls.push({ route, headers: req.headers, body: req.body });
    const writing = route.endsWith('/restore'); if (writing) nth++;
    if (writing && mode === 'old') { res.writeHead(404); res.end(); return; }
    if (writing && mode === 'fail-second' && nth === 2) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"ok":false}'); return; }
    res.set = (key, value) => { res.setHeader(key, value); return res; }; res.status = status => { res.statusCode = status; return res; };
    res.json = value => { res.setHeader('Content-Type', 'application/json');
      if (writing && mode === 'lost' && value.ok) { mode = 'normal'; res.statusCode = 503; res.end('{"ok":false}'); } else res.end(JSON.stringify(value)); return res; };
    await routes.get('POST ' + route.replace('/api/plugins/qianmu-tts', ''))(req, res);
  } catch (error) { errors.push(error.message); if (!res.writableEnded) { res.statusCode = 500; res.end('{}'); } }
});
await new Promise(done => server.listen(0, '127.0.0.1', done)); const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true }), contexts = [];
const check = (name, result) => { assert.ok(result, name); checks.push(name); };
async function device() {
  const context = await browser.newContext(); contexts.push(context);
  await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { unexpected.push(route.request().url()); return route.abort(); } return route.continue(); });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(origin);
  await page.evaluate(async () => {
    window.file = await (await fetch('/fixture.qmb')).blob(); window.current = await (await fetch('/fixture')).json();
    window.bundle = await (await import('/qianmu-historical-storyboard-bundle.js')).inspectHistoricalStoryboardBundle(file);
    window.mod = await import('/qianmu-historical-recipe-restore.js'); window.active = true; window.account = current.namespace;
    window.make = (options = {}) => mod.createHistoricalRecipeRestore({ file, namespace: bundle.source.namespace, target: bundle.source.target,
      readCurrent: async () => current, guard: async () => account === bundle.source.namespace, isCurrent: () => active,
      headers: () => ({ 'X-CSRF-Token': 'fixture', Authorization: 'PRIVATE' }), ...options });
    window.session = make(); window.consent = view => ({ confirmed: true, scope: view.scope, expectedDigest: view.digest });
  }); return page;
}
try {
  const a = await device();
  check('creating stage and inspecting actual QMB do not access recipe backend', calls.length === 0);
  check('explicit preview confirmation required', await a.evaluate(async () => { try { await session.restore({ confirmed: true }); return false; } catch { return true; } }));
  const view = await a.evaluate(async () => window.view = await session.preview());
  check('offline preview identifies inline vs archived scope without any file writes', view.inlineRecipes === 1 && view.archiveRecipes === 2 && calls.length === 0);
  mode = 'fail-second'; nth = 0;
  const failure = await a.evaluate(async () => { try { await session.restore(consent(view)); return null; } catch (e) { return { state: e.recipesState, completed: e.completed, proposed: e.proposedSaved }; } });
  check('second archive failure yields receipts only, never a partially adoptable metadata proposal', failure.state === 'needs_review' && failure.completed.length === 1 && failure.proposed === null);
  const firstRef = failure.completed[0].reference, firstFile = path.join(f.archive, firstRef.id + '.json'), firstBytes = await fs.readFile(firstFile), firstStat = await fs.stat(firstFile);
  check('verified first file retained without deleting original archive copy', (await fs.readdir(f.archive)).length === 3);
  check('failed session cannot silently retry', await a.evaluate(async () => { try { await session.preview(); return false; } catch { return true; } }) && calls.length === 2);
  mode = 'normal'; nth = 0;
  const result = await a.evaluate(async () => { session = make(); view = await session.preview(); return window.result = await session.restore(consent(view)); });
  check('new explicit batch reuses verified first archive and imports remaining original', result.archiveRecipesVerified === 2 && result.archiveReceipts[0].reference.id === firstRef.id && (await fs.stat(firstFile)).ino === firstStat.ino && (await fs.readdir(f.archive)).length === 4);
  check('only corresponding server refs changed, retaining inline contents and legacy/unknown fields', result.proposedSaved.storyboardImages[1].snapshotRef === 'legacy preserved' && result.proposedSaved.storyboardImages[1].future.exact === '  keep  ' && result.proposedSaved.storyboardImages[1].future.zero === 0 && result.proposedSaved.storyboardImages[1].snapshotServerRef.id !== source.saved.storyboardImages[1].snapshotServerRef.id);
  assert.deepEqual(result.proposedSaved.storyboardImages[0], source.saved.storyboardImages[0]); checks.push('inline original preserved exactly, not inflated into or copied from another archive');
  assert.deepEqual(result.proposedSaved.characterDrafts, source.saved.characterDrafts); assert.deepEqual(result.proposedSaved.storyboardCollections, source.saved.storyboardCollections); checks.push('raw character draft and album extensions preserved');
  check('result explicitly disclaims image verification, host persistence, dependency availability and full restore', ['metadataRestored', 'originalsVerified', 'dependenciesRestored', 'restoreSupported'].every(key => result[key] === false));
  check('only image-reference field set marked changed when all other original fields already exist', JSON.stringify(result.changedFields) === '["storyboardImages"]');
  assert.deepEqual(await fs.readFile(f.file), before); assert.deepEqual(await a.evaluate(() => current), original); checks.push('stage left real JSONL and live browser metadata byte/value identical');
  for (const [file, bytes] of retained) assert.deepEqual(await fs.readFile(file), bytes); assert.deepEqual(await fs.readFile(firstFile), firstBytes); checks.push('old and newly acknowledged archive files remain intact');
  check('account change and live raw draft edit fail before any subsequent upload', await a.evaluate(async () => {
    const count = []; account = 'st-user:bob'; try { await make().preview(); count.push(false); } catch { count.push(true); } account = bundle.source.namespace;
    current.saved.characterDrafts.items[0].future.note = 'local edit'; try { await make().preview(); count.push(false); } catch { count.push(true); }
    current.saved = structuredClone(bundle.source.saved); return count.every(Boolean);
  }) && calls.length === 4);
  mode = 'lost';
  check('lost batch receipt exposes no resolved proposal and no automatic retry', await a.evaluate(async () => {
    session = make(); view = await session.preview(); try { await session.restore(consent(view)); return false; } catch (e) { return e.recipesState === 'needs_review' && e.proposedSaved === null; }
  }) && calls.length === 5);
  check('close settles waiting source resolver without backend call', await a.evaluate(async () => {
    let release; const gate = new Promise(done => release = done), c = make({ readCurrent: () => gate }), pending = c.preview(); c.close();
    try { await pending; return false; } catch (e) { release(current); await new Promise(done => setTimeout(done, 10)); return e.recipesState === 'not_started'; }
  }) && calls.length === 5);
  mode = 'old';
  check('old backend refuses adoption with no inline fallback', await a.evaluate(async () => { session = make(); view = await session.preview(); try { await session.restore(consent(view)); return false; } catch (e) { return e.recipesState === 'needs_review' && e.proposedSaved === null && e.cause.message.includes('新版配套后端'); } })); mode = 'normal';
  // Explicit test-only consumer applies the returned proposal to a TEMPORARY
  // chat. Production stage above does not call this or save metadata itself.
  f.rows.splice(0, f.rows.length, ...structuredClone(result.proposedSaved.storyboardImages)); f.saved = { ...structuredClone(result.proposedSaved), storyboardImages: f.rows }; await f.write();
  f.current = { ...f.current, saved: structuredClone(f.saved) };
  const b = await device(), gallerySha256 = f.request().gallerySha256;
  const reread = await b.evaluate(async gallerySha256 => {
    const { createHistoricalRecipeArchiveClient } = await import('/qianmu-recipe-archive-client.js');
    const client = createHistoricalRecipeArchiveClient({ namespace: current.namespace, target: current.target, gallerySha256,
      records: current.saved.storyboardImages, account: async () => account, guard: async () => {}, headers: () => ({ 'X-CSRF-Token': 'fixture' }) });
    try { return await client.read(current.saved.storyboardImages[1]); } finally { client.close(); }
  }, gallerySha256);
  assert.deepEqual(reread.snapshot, source.recipes[1].snapshot); check('fresh device ordinary reader resolves test-consumer-saved new ref with all 120 nodes', reread.snapshot.payload.parameters.workflow.nodes.length === 120 && reread.origin === 'server-archive');
  check('native requests send only scoped route/CSRF, no arbitrary provider auth', calls.every(row => row.headers['x-csrf-token'] === 'fixture' && !row.headers.authorization));
  check('zero external calls, generation requests or browser errors', unexpected.length === 0 && errors.length === 0);
  console.log(JSON.stringify({ checks, errors, unexpected, isolatedDevices: contexts.length, realPluginHandler: true, hostSave: 'test-only-consumer', productionWrites: false }));
} finally { for (const context of contexts) await context.close(); await browser.close(); await new Promise(done => server.close(done)); await exit(); await f.close(); }
