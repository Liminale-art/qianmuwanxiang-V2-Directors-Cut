// Native browser Blob -> existing authenticated restore client -> real isolated
// image service/files. No production account, host metadata save or paid API.
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { historicalOriginalRestoreFixture } from '../tests/helpers/historical-original-restore-fixture.mjs';
const { chromium } = createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage(), checks = [], errors = [], unexpected = [];
const bytes = Buffer.from(await page.evaluate(async () => {
  const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 48;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#2868cc'; ctx.fillRect(0, 0, 32, 48);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); return [...new Uint8Array(await blob.arrayBuffer())];
}));
const f = await historicalOriginalRestoreFixture(null, { readImage: async () => new Blob([bytes], { type: 'image/png' }) });
const modules = new Map(await Promise.all(JSON.parse(await readFile(new URL('../release-files.json', import.meta.url))).files.filter(name => name.endsWith('.js'))
  .map(async name => ['/' + name, await readFile(new URL('../' + name, import.meta.url))])));
let held = false, started = false, release, loseReply = false;
const server = http.createServer(async (req, res) => {
  const controller = new AbortController(); res.once('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Isolated original restore</title>'); return; }
    if (route === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (modules.has(route)) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(modules.get(route)); return; }
    if (route === '/fixture.qmb') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(Buffer.from(await f.packed.file.arrayBuffer())); return; }
    if (['/user/images/inline.png', '/user/images/server.png'].includes(route)) {
      res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(await readFile(path.join(f.images, route.split('/').at(-1)))); return;
    }
    if (/^\/api\/plugins\/qianmu-tts\/image\/restore\/(capabilities|inspect|restore)$/.test(route)) {
      let body = ''; for await (const part of req) { body += part; if (body.length > 1048576) throw Error('Oversized test upload'); }
      if (route.endsWith('/restore') && held) { started = true; await new Promise(done => release = done); }
      const result = await f.restoreFetch(route, { body: body || undefined, headers: req.headers, signal: controller.signal });
      // A raw socket close can be retried by Chromium's transport and receive a
      // valid reused receipt. A controlled 503 models a genuinely unconfirmed
      // application response AFTER publication without relying on that behavior.
      if (route.endsWith('/restore') && loseReply) {
        loseReply = false; res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, version: 1, code: 'image_restore_storage', message: '测试回执未确认' })); return;
      }
      if (!res.destroyed) { res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(await result.text()); } return;
    }
    unexpected.push(route); res.writeHead(404); res.end();
  } catch (error) { if (!controller.signal.aborted) errors.push(error.message); if (!res.destroyed) { res.writeHead(500); res.end(); } }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port;
const timer = setTimeout(() => void browser.close(), 120000);
await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { unexpected.push(route.request().url()); return route.abort(); } return route.continue(); });
page.on('pageerror', error => errors.push(error.message));
const check = (label, condition) => { assert.ok(condition, label); checks.push(label); };
const posts = () => f.imageCalls.filter(row => row.action === 'restore');
const archive = path.join(f.user, '.qianmu-recipes-v1'), archives = async () => Promise.all((await readdir(archive)).sort().map(async name => [name, await readFile(path.join(archive, name), 'utf8')]));
try {
  await page.goto(origin);
  const before = await readFile(f.file), recipes = await archives();
  await page.evaluate(async () => {
    window.file = await (await fetch('/fixture.qmb')).blob();
    window.bundle = await (await import('/qianmu-historical-storyboard-bundle.js')).inspectHistoricalStoryboardBundle(file);
    window.api = await import('/qianmu-historical-original-restore.js'); window.active = true; window.account = bundle.source.namespace;
    window.current = { namespace: account, target: bundle.source.target, saved: structuredClone(bundle.source.saved), evidence: bundle.source.chatEvidence };
    window.create = () => api.createHistoricalOriginalRestore({ file, namespace: bundle.source.namespace, target: bundle.source.target,
      readCurrent: async () => current, guard: async () => { if (account !== bundle.source.namespace) throw Error('account changed'); }, isCurrent: () => active,
      headers: () => ({ 'X-CSRF-Token': 'fixture', Authorization: 'NEVER_FORWARD' }) });
    window.session = create(); window.confirm = view => ({ confirmed: true, scope: view.scope, expectedDigest: view.digest });
  });
  check('creating a session does not call restore service or write files', f.imageCalls.length === 0 && (await readdir(f.images)).length === 0);
  check('restore requires explicit originals-only preview confirmation', await page.evaluate(async () => { try { await session.restore({ confirmed: true }); return false; } catch { return true; } }) && posts().length === 0);
  const preview = await page.evaluate(async () => window.view = await session.preview());
  check('browser previews both original paths as missing without writing', preview.ready && preview.originals.every(row => row.state === 'missing') && posts().length === 0);
  const result = await page.evaluate(() => session.restore(confirm(view)));
  check('browser uploads and verifies both missing files through existing service', result.originalsVerified === 2 && result.completed.length === 2 && posts().length === 2);
  assert.deepEqual(await readFile(path.join(f.images, 'inline.png')), bytes); assert.deepEqual(await readFile(path.join(f.images, 'server.png')), bytes); checks.push('both restored files are exactly the original browser PNG bytes');
  check('restored image actually decodes in browser at original size', await page.evaluate(async () => { const image = await createImageBitmap(await (await fetch('/user/images/inline.png')).blob()); const ok = image.width === 32 && image.height === 48; image.close(); return ok; }));
  check('image stage does not claim metadata, recipes, dependencies or full recovery', ['metadataRestored', 'recipesRestored', 'dependenciesRestored', 'restoreSupported'].every(key => result[key] === false));
  check('native requests carry CSRF only and no arbitrary credential headers', f.imageCalls.every(row => row.headers['x-csrf-token'] === 'fixture' && !row.headers.authorization));
  const imageBefore = await stat(path.join(f.images, 'inline.png'));
  const existing = await page.evaluate(async () => { session.close(); session = create(); view = await session.preview(); return session.restore(confirm(view)); });
  check('fresh explicit restore reuses identical files without another upload', existing.completed.length === 0 && posts().length === 2 && (await stat(path.join(f.images, 'inline.png'))).ino === imageBefore.ino);
  await writeFile(path.join(f.images, 'server.png'), 'local different original');
  check('conflicting destination disables restore and is not overwritten', await page.evaluate(async () => { view = await session.preview(); try { await session.restore(confirm(view)); return false; } catch { return !view.ready && view.originals[1].state === 'conflict'; } }) && await readFile(path.join(f.images, 'server.png'), 'utf8') === 'local different original');
  // Restore the TEST fixture's known bytes. Production code never performs this overwrite.
  await writeFile(path.join(f.images, 'server.png'), bytes);
  check('account change prevents a browser preview without using another account context', await page.evaluate(async () => { account = 'st-user:bob'; try { await session.preview(); return false; } catch { return true; } finally { account = bundle.source.namespace; } }));
  check('edited raw draft is a full preflight failure, not silent normalization', await page.evaluate(async () => { current.saved.characterDrafts.items[0].future.note = 'local edit'; try { await session.preview(); return false; } catch { return true; } finally { current.saved = structuredClone(bundle.source.saved); } }));
  check('original JSONL and immutable recipe bytes were never changed', (await readFile(f.file)).equals(before) && JSON.stringify(await archives()) === JSON.stringify(recipes));
  check('existing live context fields remain unchanged', await page.evaluate(() => JSON.stringify(current.saved) === JSON.stringify(bundle.source.saved)));
  // A second isolated fixture supplies missing files for cancellation/lost reply.
  // Only scoped image destinations change; no source chat or archive is touched.
  const missing = await historicalOriginalRestoreFixture(null, { prepare: f => { f.rows[0].url = '/user/images/cancel-one.png'; f.rows[1].url = '/user/images/cancel-two.png'; }, readImage: async () => new Blob([bytes], { type: 'image/png' }) });
  try {
    const transfer = [...new Uint8Array(await missing.packed.file.arrayBuffer())];
    await page.evaluate(async transfer => { session.close(); file = new Blob([Uint8Array.from(transfer)]); bundle = await (await import('/qianmu-historical-storyboard-bundle.js')).inspectHistoricalStoryboardBundle(file); current = { namespace: account, target: bundle.source.target, saved: structuredClone(bundle.source.saved), evidence: bundle.source.chatEvidence }; session = create(); view = await session.preview(); }, transfer);
    held = true; started = false;
    await page.evaluate(() => { window.outcome = null; window.running = session.restore(confirm(view)).then(value => outcome = value, error => outcome = { state: error.originalsState }); });
    for (let i = 0; i < 200 && !started; i++) await page.waitForTimeout(10); assert.ok(started);
    await page.evaluate(() => session.close()); await page.waitForFunction(() => outcome !== null);
    check('close settles pending upload as needing review rather than a rollback claim', (await page.evaluate(() => outcome.state)) === 'needs_review');
    held = false; release(); await page.waitForTimeout(60);
    check('cancelled late request cannot start the next image', !posts().some(row => row.body.receipt.url.endsWith('cancel-two.png')));
    loseReply = true;
    await page.evaluate(async () => { session = create(); view = await session.preview(); });
    const lost = await page.evaluate(async () => { try { return { result: await session.restore(confirm(view)) }; } catch (error) { return { state: error.originalsState, message: error.message }; } });
    check('lost reply after real file publication remains unconfirmed', lost.state === 'needs_review');
    assert.deepEqual(await readFile(path.join(f.images, 'cancel-one.png')), bytes); checks.push('file published before a lost reply is preserved');
    const count = posts().length;
    const completed = await page.evaluate(async () => { session = create(); view = await session.preview(); return { view, result: await session.restore(confirm(view)) }; });
    check('new explicit session detects committed file and uploads only remaining missing one', completed.view.originals[0].state === 'present' && completed.result.originalsVerified === 2 && posts().length === count + 1);
  } finally { await missing.close(); }
  check('no external/production calls or browser exceptions', unexpected.length === 0 && errors.length === 0);
  console.log(JSON.stringify({ checks, errors, unexpected, actualIsolatedFileWrites: true, productionWrites: false, metadataWrites: false }));
} finally {
  clearTimeout(timer); held = false; release?.(); await context.close(); await browser.close();
  await new Promise(resolve => server.close(resolve)); await f.close();
}
