// Native browser current-chat adapter -> TEST host saveMetadata -> temporary
// JSONL -> actual read-only plugin routes. No direct production save endpoint,
// production ST session, paid request or UI restore entry. The optional write-ahead
// path below uses actual IndexedDB and survives real page reloads.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { historicalChatSaveFixture } from '../tests/helpers/historical-chat-save-fixture.mjs';
import { init, exit } from '../server-plugin.js';
const f = await historicalChatSaveFixture(), routes = new Map(), checks = [], errors = [], unexpected = [], calls = [];
const original = await fs.readFile(f.file, 'utf8'), originalMetadata = structuredClone(f.context.chatMetadata);
const modules = new Map(await Promise.all(JSON.parse(await fs.readFile(new URL('../release-files.json', import.meta.url))).files.filter(name => name.endsWith('.js'))
  .map(async name => ['/' + name, await fs.readFile(new URL('../' + name, import.meta.url))])));
await init({ get: (name, handler) => routes.set('GET ' + name, handler), post: (name, handler) => routes.set('POST ' + name, handler) }, { dataRoot: f.root });
let hostMode = 'normal', hostCalls = 0, hostRelease;
const server = http.createServer(async (req, res) => {
  try {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Isolated current-chat save</title>'); return; }
    if (route === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (modules.has(route)) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(modules.get(route)); return; }
    if (route === '/fixture') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ target: f.target, metadata: f.context.chatMetadata, messages: f.context.chat, proposal: f.proposal })); return; }
    let body = ''; for await (const part of req) { body += part; if (body.length > 5 * 1048576) throw Error('Oversized fixture'); }
    if (route === '/fixture-native-save') {
      hostCalls++; const mode = hostMode;
      if (mode === 'hold') await new Promise(done => hostRelease = done);
      if (mode !== 'ignore') { const input = JSON.parse(body); f.context.chatMetadata = input.metadata; f.context.chat = input.messages; await f.persist(); }
      res.writeHead(mode === 'lost' ? 503 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: mode !== 'lost' })); return;
    }
    if (!/^\/api\/plugins\/qianmu-tts\/chat-gallery\/(state|evidence)$/.test(route)) { unexpected.push(route); res.writeHead(404); res.end(); return; }
    req.body = JSON.parse(body); req.user = f.req.user; calls.push({ route, headers: req.headers, body: req.body });
    res.set = (key, value) => { res.setHeader(key, value); return res; }; res.status = value => { res.statusCode = value; return res; };
    res.json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); return res; };
    await routes.get('POST ' + route.replace('/api/plugins/qianmu-tts', ''))(req, res);
  } catch (error) { errors.push(error.message); if (!res.writableEnded) { res.statusCode = 500; res.end('{}'); } }
});
await new Promise(done => server.listen(0, '127.0.0.1', done)); const origin = 'http://127.0.0.1:' + server.address().port;
const { chromium } = createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true }), contexts = [];
const check = (name, result) => { assert.ok(result, name); checks.push(name); };
async function device() {
  const context = await browser.newContext(); contexts.push(context);
  await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { unexpected.push(route.request().url()); return route.abort(); } return route.continue(); });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(origin);
  await initialise(page); return page;
}
async function initialise(page) {
  await page.evaluate(async () => {
    const data = await (await fetch('/fixture')).json(); window.target = data.target; window.proposal = data.proposal;
    window.account = 'st-user:alice'; window.active = true; window.epoch = 0; window.hostPromises = 0;
    window.context = { chatId: target.chatId, characterId: 0, characters: [{ avatar: target.avatar, chat: target.chatId }],
      chat: data.messages, chatMetadata: data.metadata, getRequestHeaders: () => ({ 'X-CSRF-Token': 'fixture', Authorization: 'PRIVATE' }),
      async saveMetadata() { hostPromises++; try { const response = await fetch('/fixture-native-save', { method: 'POST', body: JSON.stringify({ metadata: context.chatMetadata, messages: context.chat }) }); if (!response.ok) throw Error('test host acknowledgement lost'); } finally { hostPromises--; } } };
    window.select = () => Object.fromEntries(['storyboardImages', 'storyboardCollections', 'characterDrafts'].filter(key => Object.hasOwn(context.chatMetadata.story_director_liminale, key)).map(key => [key, structuredClone(context.chatMetadata.story_director_liminale[key])]));
    window.next = () => { const before = select(), after = structuredClone(before); after.storyboardImages.push({ id: 'browser-' + before.storyboardImages.length, createdAt: before.storyboardImages.length + 50, extension: { zero: 0 } }); return { ...proposal, before, after }; };
    const { createHistoricalChatSaveSession } = await import('/qianmu-historical-chat-save.js');
    window.make = (options = {}) => createHistoricalChatSaveSession({ getContext: () => context, epoch: () => epoch, namespace: 'st-user:alice', account: async () => account,
      guard: async () => active, isCurrent: () => active, hostTimeoutMs: 100, ...options });
    window.session = make(); window.consent = { confirmed: true, scope: 'historical-chat-metadata-only' };
    const { createStoryboardPackageJournal } = await import('/qianmu-storyboard-package-journal.js');
    const { createHistoricalChatMutation } = await import('/qianmu-historical-chat-journal.js');
    window.newJournal = (dbName = 'qianmu-history-browser') => createStoryboardPackageJournal({ dbName });
    window.makeRecord = createHistoricalChatMutation;
  });
}
try {
  const a = await device(); check('construction does not read/save chat', hostCalls === 0 && calls.length === 0);
  check('explicit metadata-only confirmation required', await a.evaluate(async () => { try { await session.save(proposal); return false; } catch { return true; } }) && hostCalls === 0);
  const result = await a.evaluate(() => session.save(proposal, consent));
  check('three-field native-shaped save confirmed by actual server state and body readback', result.status === 'saved' && result.metadataVerified && result.durableJournal === false && hostCalls === 1);
  const savedRaw = await fs.readFile(f.file, 'utf8'), saved = JSON.parse(savedRaw.split('\n')[0]).chat_metadata;
  for (const key of Object.keys(f.proposal.after)) assert.deepEqual(saved.story_director_liminale[key], f.proposal.after[key]); checks.push('raw picture/album/draft fields and unknown extensions persist intact');
  check('body and unrelated plugin metadata preserved', savedRaw.slice(savedRaw.indexOf('\n')) === original.slice(original.indexOf('\n')) && saved.story_director_liminale.history === originalMetadata.story_director_liminale.history && JSON.stringify(saved.unrelated) === JSON.stringify(originalMetadata.unrelated));
  const b = await device();
  check('fresh browser verifies exactly persisted fields without another save', await b.evaluate(async () => { const value = next(); value.after = structuredClone(value.before); return (await session.save(value, consent)).status === 'unchanged'; }) && hostCalls === 1);
  hostMode = 'ignore'; const ignored = await a.evaluate(() => session.save(next(), consent));
  check('swallowed host failure is unconfirmed, not success or rollback', ignored.status === 'unconfirmed' && ignored.pending.after.storyboardImages.length === 3 && hostCalls === 2);
  check('retry is never automatic or implicit', await a.evaluate(async () => (await session.retry()).status === 'unconfirmed') && hostCalls === 2);
  hostMode = 'normal'; check('explicit retry rechecks original server baseline then commits', (await a.evaluate(() => session.retry({ confirmed: true }))).status === 'saved' && hostCalls === 3);
  hostMode = 'lost'; check('post-commit thrown acknowledgement is accepted only through matching server readback', (await a.evaluate(() => session.save(next(), consent))).status === 'saved' && hostCalls === 4);
  hostMode = 'hold'; const pending = await a.evaluate(async () => { window.waitingProposal = next(); window.heldSession = make({ hostTimeoutMs: 20 }); return heldSession.save(waitingProposal, consent); });
  check('host timeout keeps staged intent and does not claim native cancellation', pending.status === 'unconfirmed' && pending.reason === 'host_pending' && hostCalls === 5);
  check('other same-page coordinator cannot queue while native promise still pending', await a.evaluate(async () => { const other = make(); try { await other.save(waitingProposal, consent); return false; } catch { return true; } finally { other.close(); } }) && hostCalls === 5);
  hostMode = 'normal'; hostRelease(); await a.waitForFunction(() => hostPromises === 0);
  check('late native completion is checked read-only without repeating host write', (await a.evaluate(() => heldSession.verify())).status === 'saved' && hostCalls === 5);
  check('caller input and pending intent cannot mutate each other', await a.evaluate(async () => { const snapshot = select(); return snapshot.storyboardImages.length === 5 && proposal.after.storyboardImages.length === 2; }));
  check('account switch stops save before local mutation or native request', await a.evaluate(async () => { account = 'st-user:bob'; try { await session.save(next(), consent); return false; } catch { return true; } finally { account = 'st-user:alice'; } }) && hostCalls === 5);
  check('newly edited local baseline is not overwritten by stale proposal', await a.evaluate(async () => { const value = next(); context.chatMetadata.story_director_liminale.storyboardCollections[0].name = 'user edit'; try { await session.save(value, consent); return false; } catch { return context.chatMetadata.story_director_liminale.storyboardCollections[0].name === 'user edit'; } }) && hostCalls === 5);

  await a.reload(); await initialise(a);
  hostMode = 'ignore';
  const durable = await a.evaluate(async () => { window.journal = newJournal(); window.persistedSession = make({ journal }); return persistedSession.save(next(), consent); });
  check('actual IDB record is committed before host call and survives unacknowledged persistence', durable.status === 'unconfirmed' && durable.durableJournal === true && hostCalls === 6);
  check('existing package journal reports pending historical save without altering legacy mutation shape', await a.evaluate(async () => await journal.hasMutation(account) && await journal.loadMutation(account) === null && (await journal.loadHistoricalChatMutation(account)).phase === 'submitted'));
  await a.reload(); await initialise(a);
  const recovered = await a.evaluate(async () => { window.journal = newJournal(); window.persistedSession = make({ journal }); return persistedSession.recover(); });
  check('real page reload retains exact before/after draft extensions and does not replay native write', recovered.reason === 'confirmation_required' && recovered.durableJournal === true && recovered.pending.after.storyboardImages.length === 6 && hostCalls === 6);
  check('fresh recovery still requires explicit retry confirmation', await a.evaluate(async () => (await persistedSession.retry()).status === 'unconfirmed') && hostCalls === 6);
  hostMode = 'normal';
  check('explicit retry after reload verifies original server baseline then saves exactly once', (await a.evaluate(() => persistedSession.retry({ confirmed: true }))).status === 'saved' && hostCalls === 7);
  check('verified journal retains raw payload and does not erase itself automatically', await a.evaluate(async () => { const row = await journal.loadHistoricalChatMutation(account); return row.phase === 'verified' && row.proposal.after.storyboardImages.length === 6 && await journal.hasMutation(account); }));
  await a.reload(); await initialise(a);
  check('second reload re-verifies saved result read-only instead of replaying previous operation', await a.evaluate(async () => { window.journal = newJournal(); window.persistedSession = make({ journal }); return (await persistedSession.recover()).status === 'saved'; }) && hostCalls === 7);
  check('other account cannot read another account pending content', await a.evaluate(async () => await journal.loadHistoricalChatMutation('st-user:bob') === null));
  check('record dismissal requires confirmation and only removes local recovery record', await a.evaluate(async () => { const row = await journal.loadHistoricalChatMutation(account); try { await journal.dismissHistoricalChatMutation(row); return false; } catch { await journal.dismissHistoricalChatMutation(row, { confirmed: true }); return !await journal.hasMutation(account); } }) && hostCalls === 7);
  check('persisted chat remains intact after recovery record dismissal', JSON.parse((await fs.readFile(f.file, 'utf8')).split('\n')[0]).chat_metadata.story_director_liminale.storyboardImages.length === 6);

  check('v6 to v7 migration adds only new store and retains old mutation and checkpoint bytes', await a.evaluate(async () => {
    window.legacy = { namespace: account, chatHash: 'b'.repeat(64), fileHash: 'c'.repeat(64), version: 1, revision: 1, createdAt: 1, phase: 'prepared', patch: [] };
    await new Promise((resolve, reject) => { const request = indexedDB.open('migration', 6); request.onupgradeneeded = () => { const db = request.result; db.createObjectStore('mutations', { keyPath: 'namespace' }).add(legacy); const checkpoints = db.createObjectStore('checkpoints', { keyPath: 'key' }); checkpoints.createIndex('namespace', 'namespace'); checkpoints.add({ key: 'old-opaque', untouched: '  old  ' }); }; request.onsuccess = () => { request.result.close(); resolve(); }; request.onerror = () => reject(request.error); });
    window.migration = newJournal('migration'); const original = await migration.loadMutation(account); if (JSON.stringify(original) !== JSON.stringify(legacy)) return false;
    return await new Promise((resolve, reject) => { const request = indexedDB.open('migration', 7); request.onsuccess = () => { const db = request.result, tx = db.transaction('checkpoints'), get = tx.objectStore('checkpoints').get('old-opaque'); get.onsuccess = () => resolve(db.version === 7 && db.objectStoreNames.contains('historicalChatMutations') && get.result.untouched === '  old  '); tx.oncomplete = () => db.close(); }; request.onerror = () => reject(request.error); });
  }));
  check('pending legacy mutation atomically blocks historical prepare without overwriting original record', await a.evaluate(async () => { const row = await makeRecord(next()); try { await migration.prepareHistoricalChatMutation(row, { confirmed: true }); return false; } catch { return await migration.loadHistoricalChatMutation(account) === null && JSON.stringify(await migration.loadMutation(account)) === JSON.stringify(legacy); } }));
  check('historical pending record blocks legacy prepare through the same transaction stores', await a.evaluate(async () => { await migration.dismissMutation(legacy, { confirmed: true }); window.record = await migration.prepareHistoricalChatMutation(await makeRecord(next()), { confirmed: true }); try { await migration.prepareMutation(legacy); return false; } catch { return await migration.loadMutation(account) === null && await migration.hasMutation(account); } }));
  check('parallel journal clients cannot prepare two different pending records for one account', await a.evaluate(async () => { window.racer = newJournal('migration'); const row = await makeRecord(next()); try { await racer.prepareHistoricalChatMutation(row, { confirmed: true }); return false; } catch { return (await racer.loadHistoricalChatMutation(account)).proposalDigest === record.proposalDigest; } }));
  check('simultaneous first preparations have one atomic winner without replacing the winning payload', await a.evaluate(async () => {
    const first = newJournal('simultaneous'), second = newJournal('simultaneous'), left = await makeRecord(next()), proposal = next(); proposal.fileHash = 'e'.repeat(64); const right = await makeRecord(proposal);
    try { const results = await Promise.allSettled([first.prepareHistoricalChatMutation(left, { confirmed: true }), second.prepareHistoricalChatMutation(right, { confirmed: true })]); const winners = results.filter(row => row.status === 'fulfilled'); return winners.length === 1 && (await first.loadHistoricalChatMutation(account)).proposalDigest === winners[0].value.proposalDigest; } finally { first.close(); second.close(); }
  }));
  check('simultaneous legacy and historical preparations share atomic account-level exclusion', await a.evaluate(async () => {
    const first = newJournal('legacy-race'), second = newJournal('legacy-race'), row = await makeRecord(next());
    try { const results = await Promise.allSettled([first.prepareMutation(legacy), second.prepareHistoricalChatMutation(row, { confirmed: true })]); return results.filter(row => row.status === 'fulfilled').length === 1 && Number(Boolean(await first.loadMutation(account))) + Number(Boolean(await second.loadHistoricalChatMutation(account))) === 1; } finally { first.close(); second.close(); }
  }));
  check('stale CAS update and stale dismissal preserve newer journal revision', await a.evaluate(async () => { window.updated = await migration.updateHistoricalChatMutation(record, 'submitted'); let denied = 0; try { await racer.updateHistoricalChatMutation(record, 'submitted'); } catch { denied++; } try { await racer.dismissHistoricalChatMutation(record, { confirmed: true }); } catch { denied++; } return denied === 2 && (await migration.loadHistoricalChatMutation(account)).revision === updated.revision; }));
  check('false page guard refuses durable mutation and preserves original record', await a.evaluate(async () => { try { await migration.updateHistoricalChatMutation(updated, 'uncertain', { isCurrent: () => false }); return false; } catch { return (await migration.loadHistoricalChatMutation(account)).phase === 'submitted'; } }));
  check('independent browser device does not mistake local journal for cross-device durable backup', await b.evaluate(async () => { const journal = newJournal('migration'); try { return await journal.loadHistoricalChatMutation(account) === null; } finally { journal.close(); } }));
  check('closing journal refuses future operations but leaves previously committed record readable', await a.evaluate(async () => { racer.close(); try { await racer.loadHistoricalChatMutation(account); return false; } catch { return (await migration.loadHistoricalChatMutation(account)).phase === 'submitted'; } }));
  check('modified stored payload is rejected without erasing corrupted evidence', await a.evaluate(async () => {
    migration.close(); await new Promise((resolve, reject) => { const request = indexedDB.open('migration', 7); request.onsuccess = () => { const db = request.result, tx = db.transaction('historicalChatMutations', 'readwrite'), store = tx.objectStore('historicalChatMutations'), get = store.get(account); get.onsuccess = () => { const row = get.result; row.proposal.after.storyboardImages.pop(); store.put(row); }; tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; request.onerror = () => reject(request.error); });
    const checkJournal = newJournal('migration'); try { await checkJournal.loadHistoricalChatMutation(account); return false; } catch { return await checkJournal.hasMutation(account); } finally { checkJournal.close(); }
  }));
  check('blocked upgrade fails closed and can retry after old connection closes without deleting its record', await a.evaluate(async () => {
    const old = await new Promise((resolve, reject) => { const request = indexedDB.open('blocked-migration', 6); request.onupgradeneeded = () => request.result.createObjectStore('mutations', { keyPath: 'namespace' }).add(legacy); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const journal = newJournal('blocked-migration'); let refused = false;
    try { await journal.loadMutation(account); } catch { refused = true; }
    old.close(); journal.close(); const retry = newJournal('blocked-migration'); try { return refused && JSON.stringify(await retry.loadMutation(account)) === JSON.stringify(legacy); } finally { retry.close(); }
  }));
  check('only existing scoped read-only plugin routes used with CSRF-only credentials', calls.length > 0 && calls.every(row => row.headers['x-csrf-token'] === 'fixture' && !row.headers.authorization));
  check('no production/paid/external requests or browser exceptions', unexpected.length === 0 && errors.length === 0);
  console.log(JSON.stringify({ checks, errors, unexpected, isolatedDevices: contexts.length, hostCalls, host: 'test-shaped-saveMetadata', backend: 'actual-plugin-read-only-routes', durableJournal: 'real-IDB-local-only', productionWrites: false }));
} finally { hostRelease?.(); for (const context of contexts) await context.close(); await browser.close(); await new Promise(done => server.close(done)); await exit(); await f.close(); }
