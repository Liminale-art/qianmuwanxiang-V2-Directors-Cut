// Native browser current-chat adapter -> TEST host saveMetadata -> temporary
// JSONL -> actual read-only plugin routes. No direct production save endpoint,
// production ST session, paid request, UI restore entry or persistent journal.
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
  }); return page;
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
  check('only existing scoped read-only plugin routes used with CSRF-only credentials', calls.length > 0 && calls.every(row => row.headers['x-csrf-token'] === 'fixture' && !row.headers.authorization));
  check('no production/paid/external requests or browser exceptions', unexpected.length === 0 && errors.length === 0);
  console.log(JSON.stringify({ checks, errors, unexpected, isolatedDevices: contexts.length, hostCalls, host: 'test-shaped-saveMetadata', backend: 'actual-plugin-read-only-routes', durableJournal: false, productionWrites: false }));
} finally { hostRelease?.(); for (const context of contexts) await context.close(); await browser.close(); await new Promise(done => server.close(done)); await exit(); await f.close(); }
