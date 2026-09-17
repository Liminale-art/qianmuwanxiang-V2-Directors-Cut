// Real authenticated plugin handler + native fetch/crypto in isolated Edge contexts.
// Host authentication is fixture-injected; no live ST, production saves or model traffic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { init, exit } from '../server-plugin.js';
import { recipeRestoreFixture, restoreRequest, clientInput, sha } from '../tests/helpers/recipe-restore-fixture.mjs';
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const f = await recipeRestoreFixture(), checks = [], errors = [], unexpected = [], calls = [], routes = new Map();
const config = JSON.parse(await fs.readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
const modules = new Map(await Promise.all(config.files.filter(file => file.endsWith('.js')).map(async file => ['/' + file, await fs.readFile(new URL('../' + file, import.meta.url), 'utf8')])));
await init({ get: (name, handler) => routes.set('GET ' + name, handler), post: (name, handler) => routes.set('POST ' + name, handler) }, { dataRoot: f.root });
let mode = 'normal';
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><html><body>isolated recipe restore fixture</body></html>'); return; }
    if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (modules.has(pathname)) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(modules.get(pathname)); return; }
    if (pathname !== '/api/plugins/qianmu-tts/chat-gallery/recipe/restore') { unexpected.push(pathname); res.writeHead(404); res.end(); return; }
    let body = ''; for await (const part of req) { body += part; if (body.length > 2 * 1048576) throw Error('oversized fixture'); }
    req.body = JSON.parse(body); calls.push({ body: req.body, headers: req.headers }); req.user = f.req.user;
    if (mode === 'old') { res.writeHead(404); res.end('old'); return; }
    res.set = (key, value) => { res.setHeader(key, value); return res; }; res.status = code => { res.statusCode = code; return res; };
    res.json = value => { res.setHeader('Content-Type', 'application/json');
      if (mode === 'lost' && value.ok) { res.statusCode = 503; res.end(JSON.stringify({ ok: false })); } else res.end(JSON.stringify(value)); return res; };
    await routes.get('POST /chat-gallery/recipe/restore')(req, res);
  } catch (error) { errors.push(error.message); if (!res.writableEnded) { res.statusCode = 500; res.end('{}'); } }
});
await new Promise(done => server.listen(0, '127.0.0.1', done)); const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true }), contexts = [];
const check = (name, result) => { assert.ok(result, name); checks.push(name); };
async function device(input) {
  const context = await browser.newContext(); contexts.push(context);
  await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { unexpected.push(route.request().url()); return route.abort(); } return route.continue(); });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(origin);
  await page.evaluate(async input => {
    window.input = input; window.active = true; window.mod = await import('/qianmu-recipe-restore-client.js');
    window.make = (options = {}) => mod.createRecipeRestoreClient({ namespace: 'st-user:alice', guard: () => active,
      headers: () => ({ 'X-CSRF-Token': 'fixture', Authorization: 'PRIVATE', 'X-API-Key': 'PRIVATE' }), ...options });
    window.client = make();
  }, clientInput(input)); return page;
}
try {
  const input = restoreRequest(), a = await device(input), before = await fs.readFile(f.file);
  check('explicit confirmation required before native fetch', await a.evaluate(async () => { try { await client.restore(input); return false; } catch (e) { return e.recipeWriteState === 'not_started'; } }) && calls.length === 0);
  const result = await a.evaluate(() => client.restore(input, { confirmed: true }));
  check('native browser imports complete recipe through actual plugin route', result.proof === 'durable-restored-recipe');
  const file = path.join(f.archive, result.reference.id + '.json'), bytes = await fs.readFile(file), stat = await fs.stat(file), saved = JSON.parse(bytes);
  check('durable archive hash and bytes match original without adopting old missing path', sha(bytes) === input.originalReference.sha256 && result.reference.bytes === bytes.length && result.reference.id !== input.originalReference.id);
  assert.deepEqual(saved.snapshot, input.snapshot); checks.push('120 workflow nodes, prompt whitespace, zero and extensions preserved');
  check('only CSRF credential header forwarded', calls[0].headers['x-csrf-token'] === 'fixture' && !calls[0].headers.authorization && !calls[0].headers['x-api-key']);
  const b = await device(input), reused = await b.evaluate(() => client.restore(input, { confirmed: true }));
  check('fresh browser with no local cache reuses same immutable original', reused.reference.id === result.reference.id && (await fs.stat(file)).ino === stat.ino && (await fs.readdir(f.archive)).length === 1);
  const wrong = await b.evaluate(async () => { const c = make({ namespace: 'st-user:bob' }); try { await c.restore(input, { confirmed: true }); return false; } catch (e) { return e.recipeWriteState === 'not_started'; } });
  check('different-account import fails before upload', wrong && calls.length === 2);
  check('additional identity or disk path fields not silently ignored', await b.evaluate(async () => { try { await client.restore({ ...input, path: 'other' }, { confirmed: true }); return false; } catch (e) { return e.recipeWriteState === 'not_started'; } }));
  check('serialized workflow credentials rejected before upload', await b.evaluate(async () => {
    const value = structuredClone(input); value.snapshot.payload.parameters.workflow = '{"apiKey":"PRIVATE"}';
    try { await make().restore(value, { confirmed: true }); return false; } catch (e) { return e.recipeWriteState === 'not_started'; }
  }) && calls.length === 2);
  check('guard change after durable response prevents reference adoption', await b.evaluate(async () => {
    const c = make({ fetchImpl: async (...args) => { const response = await fetch(...args); active = false; return response; } });
    try { await c.restore(input, { confirmed: true }); return false; } catch (e) { return e.recipeWriteState === 'unconfirmed'; } finally { active = true; }
  }));
  check('close settles stalled browser guard without delayed request', await b.evaluate(async () => {
    let release; const gate = new Promise(done => release = done), c = make({ guard: () => gate }), pending = c.restore(input, { confirmed: true }); c.close();
    try { await pending; return false; } catch (e) { release(true); await new Promise(done => setTimeout(done, 20)); return e.recipeWriteState === 'not_started'; }
  }) && calls.length === 3);
  check('deadline covers stalled browser response body and cancels reader', await b.evaluate(async () => {
    let cancelled = false; const c = make({ timeoutMs: 120, fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } }) });
    try { await c.restore(input, { confirmed: true }); return false; } catch (e) { return e.recipeWriteState === 'unconfirmed' && cancelled; }
  }));
  const changed = restoreRequest(); changed.snapshot.prompt = 'second original'; const second = restoreRequest({ snapshot: changed.snapshot });
  await b.evaluate(value => { window.input = value; window.client = make(); }, clientInput(second)); mode = 'lost';
  check('post-write failure leaves state unconfirmed, never success', await b.evaluate(async () => { try { await client.restore(input, { confirmed: true }); return false; } catch (e) { return e.recipeWriteState === 'unconfirmed'; } }));
  const afterLost = calls.length; mode = 'normal';
  check('uncertain session refuses automatic or same-session retry', await b.evaluate(async () => { try { await client.restore(input, { confirmed: true }); return false; } catch { return true; } }) && calls.length === afterLost);
  check('file remains retained after lost application acknowledgement', (await fs.readdir(f.archive)).length === 2);
  const retry = await b.evaluate(() => make().restore(input, { confirmed: true }));
  check('new explicitly confirmed session reuses post-write file instead of multiplying originals', retry.reference.sha256 === second.originalReference.sha256 && (await fs.readdir(f.archive)).length === 2);
  mode = 'old';
  check('old backend gives update message and no metadata fallback', await a.evaluate(async () => { try { await make().restore(input, { confirmed: true }); return false; } catch (e) { return e.recipeWriteState === 'unconfirmed' && e.message.includes('新版配套后端'); } })); mode = 'normal';
  assert.deepEqual(await fs.readFile(f.file), before); checks.push('saved chat and its original metadata remain byte-identical throughout');
  assert.deepEqual(await fs.readFile(file), bytes); checks.push('original archive bytes unchanged throughout failures and retries');
  check('no additional generation, restoration UI, external traffic or production writes', unexpected.length === 0 && errors.length === 0);
  console.log(JSON.stringify({ checks, errors, unexpected, isolatedDevices: contexts.length, realTemporaryArchiveFiles: true, realPluginHandler: true, hostAuthentication: 'fixture-only' }));
} finally {
  for (const context of contexts) await context.close(); await browser.close(); await new Promise(done => server.close(done)); await exit(); await f.close();
}
