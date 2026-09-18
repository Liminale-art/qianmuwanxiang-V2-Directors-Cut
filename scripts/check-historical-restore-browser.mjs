// Whole original-file + recipe + native-shaped save chain, actual plugin routes,
// real IDB, refresh and two browser devices. All files/accounts are temporary;
// the native ST writer is a test adapter, never a production save endpoint.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { historicalRestoreFixture } from '../tests/helpers/historical-restore-fixture.mjs';
import { png } from '../tests/helpers/historical-original-restore-fixture.mjs';
import { init, exit } from '../server-plugin.js';
const f = await historicalRestoreFixture(), routes = new Map(), checks = [], errors = [], unexpected = [], calls = [];
const original = await fs.readFile(f.file, 'utf8'), oldMetadata = structuredClone(f.context.chatMetadata);
const oldArchive = await fs.readFile(path.join(f.archive, f.rows[1].snapshotServerRef.id + '.json')); await f.hideArchive();
const modules = new Map(await Promise.all(JSON.parse(await fs.readFile(new URL('../release-files.json', import.meta.url))).files.filter(name => name.endsWith('.js'))
  .map(async name => ['/' + name, await fs.readFile(new URL('../' + name, import.meta.url))])));
await init({ get: (name, handler) => routes.set('GET ' + name, handler), post: (name, handler) => routes.set('POST ' + name, handler) }, { dataRoot: f.root });
let hostMode = 'ignore', hostCalls = 0;
const server = http.createServer(async (req, res) => {
  try {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Isolated historical restore</title>'); return; }
    if (route === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (modules.has(route)) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(modules.get(route)); return; }
    if (route === '/fixture.qmb') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(Buffer.from(await f.packed.file.arrayBuffer())); return; }
    if (route === '/fixture') {
      const [header, ...messages] = (await fs.readFile(f.file, 'utf8')).trimEnd().split('\n').map(JSON.parse);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ target: f.target, metadata: header.chat_metadata, messages })); return;
    }
    let body = ''; for await (const part of req) { body += part; if (body.length > 5 * 1048576) throw Error('Oversized test request'); }
    if (route === '/fixture-native-save') {
      hostCalls++;
      if (hostMode !== 'ignore') { const input = JSON.parse(body); f.context.chatMetadata = input.metadata; f.context.chat = input.messages; await f.persist(); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
    }
    if (!/^\/api\/plugins\/qianmu-tts\/(?:chat-gallery\/(?:state|evidence|recipe\/(?:restore|read))|image\/restore\/(?:capabilities|inspect|restore))$/.test(route)) { unexpected.push(route); res.writeHead(404); res.end(); return; }
    req.body = body ? JSON.parse(body) : undefined; req.user = f.req.user; calls.push({ route, headers: req.headers, body: req.body });
    res.set = (key, value) => { res.setHeader(key, value); return res; }; res.status = value => { res.statusCode = value; return res; };
    res.json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); return res; };
    await routes.get(req.method + ' ' + route.replace('/api/plugins/qianmu-tts', ''))(req, res);
  } catch (error) { errors.push(error.message); if (!res.writableEnded) { res.statusCode = 500; res.end('{}'); } }
});
await new Promise(done => server.listen(0, '127.0.0.1', done)); const origin = 'http://127.0.0.1:' + server.address().port;
const { chromium } = createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true }), contexts = [];
const check = (name, result) => { assert.ok(result, name); checks.push(name); };
const writes = () => calls.filter(row => /\/(recipe|image\/restore)\/restore$/.test(row.route)).length;
async function initialise(page) {
  await page.evaluate(async () => {
    const data = await (await fetch('/fixture')).json(); window.file = await (await fetch('/fixture.qmb')).blob(); window.target = data.target;
    window.packageOpens = 0; const slice = file.slice.bind(file);
    file.slice = (start, ...rest) => { if (start === 0) packageOpens++; return slice(start, ...rest); };
    window.account = 'st-user:alice'; window.active = true; window.epoch = 0;
    window.context = { chatId: target.chatId, characterId: 0, characters: [{ avatar: target.avatar, chat: target.chatId }],
      chat: data.messages, chatMetadata: data.metadata, getRequestHeaders: () => ({ 'X-CSRF-Token': 'fixture', Authorization: 'PRIVATE' }),
      async saveMetadata() { const result = await fetch('/fixture-native-save', { method: 'POST', body: JSON.stringify({ metadata: context.chatMetadata, messages: context.chat }) }); if (!result.ok) throw Error('test save failed'); } };
    const { createHistoricalRestore } = await import('/qianmu-historical-restore.js');
    const { createStoryboardPackageJournal } = await import('/qianmu-storyboard-package-journal.js');
    window.journal = createStoryboardPackageJournal({ dbName: 'unified-history-test' });
    window.make = () => createHistoricalRestore({ file, namespace: 'st-user:alice', getContext: () => context, epoch: () => epoch,
      account: async () => account, guard: async () => active, isCurrent: () => active, journal });
    window.session = make(); window.consent = view => ({ confirmed: true, expectedDigest: view.digest, dependenciesAccepted: true });
  });
}
async function device() {
  const context = await browser.newContext(); contexts.push(context);
  await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { unexpected.push(route.request().url()); return route.abort(); } return route.continue(); });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(origin); await initialise(page); return page;
}
try {
  const a = await device(); check('construction does not write files or call host', calls.length === 0 && hostCalls === 0);
  const view = await a.evaluate(async () => window.view = await session.preview());
  check('preview identifies missing images and fresh exact-chat scope without writes', view.ready && view.mode === 'fresh' && view.images.every(row => row.state === 'missing') && writes() === 0);
  check('all preview stages share exactly one successful immutable-package inspection', await a.evaluate(() => packageOpens === 1));
  check('mutating a detached inspection never poisons the next restore stage', await a.evaluate(async () => {
    const { inspectHistoricalStoryboardBundle: inspect } = await import('/qianmu-historical-storyboard-bundle.js');
    const first = await inspect(file); first.source.recipes.length = 0; first.media.images.length = 0;
    const second = await inspect(file); return second.source.recipes.length === 2 && second.media.images.length === 2 && packageOpens === 1;
  }));
  check('cached inspection still refuses invalid page guard without any file write', await a.evaluate(async () => {
    const { inspectHistoricalStoryboardBundle: inspect } = await import('/qianmu-historical-storyboard-bundle.js');
    try { await inspect(file, { guard: async () => false }); return false; } catch { return true; }
  }) && writes() === 0);
  check('preview explicitly excludes narrative, video, global resources and dependencies', view.dependenciesRestored === false && view.excluded.length === 5);
  check('dependency consent is required independently of confirmation', await a.evaluate(async () => { try { await session.restore({ confirmed: true, expectedDigest: view.digest }); return false; } catch { return true; } }) && writes() === 0);
  const failed = await a.evaluate(async () => { try { await session.restore(consent(view)); return null; } catch (error) { return { state: error.state, stage: error.stage }; } });
  check('host silently not persisting yields needs-review instead of completion', failed.state === 'needs_review' && hostCalls === 1);
  check('write stage reopens image sections but does not repeat every whole-package inspection', await a.evaluate(() => packageOpens === 2));
  check('actual IDB retains exact before and proposed new archive reference', await a.evaluate(async () => { const row = await journal.loadHistoricalChatMutation(account); return row.phase === 'submitted' && row.proposal.before.storyboardImages[1].snapshotServerRef.id !== row.proposal.after.storyboardImages[1].snapshotServerRef.id; }));
  for (const name of ['inline.png', 'server.png']) assert.deepEqual(await fs.readFile(path.join(f.images, name)), png); checks.push('both original files remain byte exact after host failure');
  check('failed native save leaves on-disk chat byte identical', await fs.readFile(f.file, 'utf8') === original);
  const failedWrites = writes();
  check('failed session cannot replay or automatically continue', await a.evaluate(async () => { try { await session.preview(); return false; } catch { return true; } }) && writes() === failedWrites && hostCalls === 1);
  await a.reload(); await initialise(a);
  const resumed = await a.evaluate(async () => window.view = await session.preview());
  check('real page reload finds durable operation with the same exact original package', resumed.mode === 'recovery' && resumed.fingerprint === view.fingerprint);
  check('recovery preview never retries host or archived files', hostCalls === 1 && writes() === failedWrites);
  check('recovery again requires explicit consent', await a.evaluate(async () => { try { await session.restore({ expectedDigest: view.digest }); return false; } catch { return true; } }) && hostCalls === 1);
  hostMode = 'normal'; const result = await a.evaluate(() => session.restore(consent(view)));
  check('explicit retry reads complete persisted metadata, originals and recipes', result.status === 'restored' && result.metadataVerified && result.originalsVerified === 2 && result.recipesVerified === 2 && hostCalls === 2);
  check('completion remains scoped and does not claim external dependencies or UI release', result.restoreSupported === false && result.dependenciesRestored === false && result.durableJournal === true);
  const savedRaw = await fs.readFile(f.file, 'utf8'), metadata = JSON.parse(savedRaw.split('\n')[0]).chat_metadata;
  const expected = structuredClone(oldMetadata); expected.story_director_liminale.storyboardImages[1].snapshotServerRef = metadata.story_director_liminale.storyboardImages[1].snapshotServerRef;
  assert.deepEqual(metadata, expected); checks.push('raw drafts, albums, inline recipe, unknown fields and unrelated settings all preserved');
  check('narrative lines remain byte exact', savedRaw.slice(savedRaw.indexOf('\n')) === original.slice(original.indexOf('\n')));
  assert.deepEqual(await fs.readFile(path.join(f.archive, f.rows[1].snapshotServerRef.id + '.retained')), oldArchive); checks.push('old archive retained without overwriting or deleting it');
  check('verified record retained for later explicit closure', await a.evaluate(async () => (await journal.loadHistoricalChatMutation(account)).phase === 'verified'));
  const b = await device();
  check('second device cannot read first device local journal', await b.evaluate(async () => await journal.loadHistoricalChatMutation(account) === null));
  check('second device reads complete recipes from actual saved references', await b.evaluate(async () => {
    const { createHistoricalRecipeArchiveClient } = await import('/qianmu-recipe-archive-client.js');
    const { inspectHistoricalStoryboardBundle } = await import('/qianmu-historical-storyboard-bundle.js');
    const bundle = await inspectHistoricalStoryboardBundle(file), records = context.chatMetadata.story_director_liminale.storyboardImages;
    const reader = createHistoricalRecipeArchiveClient({ namespace: account, target, records, guard: async () => {}, headers: context.getRequestHeaders });
    try { for (const recipe of bundle.source.recipes) { const result = await reader.read(records.find(row => row.id === recipe.recordId)); if (JSON.stringify(result.snapshot) !== JSON.stringify(recipe.snapshot)) return false; } return true; } finally { reader.close(); }
  }));
  const finalWrites = writes(); await a.reload(); await initialise(a);
  check('repeated same package with retained intent completes by readback only', await a.evaluate(async () => { const view = await session.preview(); return (await session.restore(consent(view))).status === 'restored'; }) && hostCalls === 2 && writes() === finalWrites);
  check('without local intent, another device does not guess equivalence of changed archive references', await b.evaluate(async () => { try { await session.preview(); return false; } catch { return true; } }) && hostCalls === 2);
  check('account change is blocked before any replay', await a.evaluate(async () => { account = 'st-user:bob'; try { await make().preview(); return false; } catch { return true; } finally { account = 'st-user:alice'; } }) && writes() === finalWrites);
  check('edited narrative refuses pending restore instead of reverting user text', await a.evaluate(async () => { context.chat[0].mes += ' user edit'; try { await make().preview(); return false; } catch { return context.chat[0].mes.endsWith(' user edit'); } }) && hostCalls === 2);
  check('all plugin calls retain CSRF-only headers without leaking model keys', calls.length > 0 && calls.every(row => row.headers['x-csrf-token'] === 'fixture' && !row.headers.authorization));
  check('no external/production/paid requests or browser exceptions', unexpected.length === 0 && errors.length === 0);
  console.log(JSON.stringify({ checks, errors, unexpected, isolatedDevices: contexts.length, hostCalls, host: 'test-shaped-saveMetadata', backend: 'actual-plugin-routes', durableJournal: 'real-IDB-local-only', productionWrites: false }));
} finally { for (const context of contexts) await context.close(); await browser.close(); await new Promise(done => server.close(done)); await exit(); await f.close(); }
