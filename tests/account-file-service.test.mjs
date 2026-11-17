import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createAccountFileService, installAccountFileRoutes, accountFileFamily, ACCOUNT_FILE_CLEANABLE } from '../server/qianmu-account-file-service.js';
import { inspectAccountFiles, cleanAccountFiles } from '../qianmu-account-file-cleanup.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const expectedAccount = 'st-user:' + sha('alice'), scope = sha('qianmu.st-account-document.v1\0st-user:alice');
const HOUR = 3600 * 1000;

async function fixture(t, options = {}) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'qianmu-account-files-'));
  const user = path.join(root, 'alice'), folder = path.join(user, 'files'); await fs.mkdir(folder, { recursive: true });
  const req = { user: { profile: { handle: 'alice', enabled: true }, directories: { root: user, files: folder } } };
  const service = createAccountFileService({ dataRoot: root, ...options });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  const input = (patch = {}) => ({ version: 1, expectedAccount, ...patch });
  // 写入一个带版本的槽位：versions 份正文，入口指向最后一份。age 为各份正文距今多久（毫秒）。
  async function slot(name, versions, { head = true, ageMs = 24 * HOUR, size = 100 } = {}) {
    const bodies = [];
    for (let i = 0; i < versions; i++) {
      const text = JSON.stringify({ schema: 'qianmu.st-account-document.v1', scope, slot: name, value: `${name}-${i}`.padEnd(size, 'x') });
      const file = `qianmu-v2-${scope}-${name}-${sha(text)}.json`; await fs.writeFile(path.join(folder, file), text);
      const when = new Date(Date.now() - ageMs - (versions - i) * 1000); await fs.utimes(path.join(folder, file), when, when);
      bodies.push({ file, fingerprint: sha(text), bytes: Buffer.byteLength(text) });
    }
    if (head) await fs.writeFile(path.join(folder, `qianmu-v2-${scope}-${name}.json`), JSON.stringify({ schema: 'qianmu.st-account-head.v1', scope, slot: name, fingerprint: bodies.at(-1).fingerprint }));
    return bodies;
  }
  const names = async () => (await fs.readdir(folder)).sort();
  return { root, folder, req, service, input, slot, names };
}

test('slots are grouped into families and the cleanable list is narrow', () => {
  assert.equal(accountFileFamily('assistant-' + 'a'.repeat(64)), 'assistant-*');
  assert.equal(accountFileFamily('assistant-conversations'), 'assistant-conversations');
  assert.equal(accountFileFamily('reader-chat-' + 'b'.repeat(32)), 'reader-chat-*');
  assert.deepEqual([...ACCOUNT_FILE_CLEANABLE], ['assistant-*', 'assistant-conversations', 'text-collection', 'notes', 'font-library']);
});

test('the inventory separates current versions, old versions, head-less originals and other accounts, without changing a file', async t => {
  const f = await fixture(t);
  const chat = await f.slot('assistant-' + 'a'.repeat(64), 4), index = await f.slot('assistant-conversations', 2), library = await f.slot('character-library', 3);
  const originals = await f.slot('character-record', 5, { head: false });
  await fs.writeFile(path.join(f.folder, `qianmu-v2-${scope}-font-library.snapshot.json`), 'snapshot');
  await fs.writeFile(path.join(f.folder, `qianmu-v2-${'c'.repeat(64)}-assistant-conversations.json`), 'another account');
  await fs.writeFile(path.join(f.folder, 'notes.json'), 'unrelated');
  const before = await f.names(), result = await f.service.inspect(f.req, f.input());
  const row = family => result.families.find(item => item.family === family);
  assert.deepEqual(row('assistant-*').retained, { count: 3, bytes: chat.slice(0, 3).reduce((sum, body) => sum + body.bytes, 0) });
  assert.equal(row('assistant-*').current.count, 2, 'the head and the body it points to');
  assert.equal(row('assistant-*').cleanable, true); assert.equal(row('assistant-conversations').retained.count, 1);
  assert.equal(row('character-library').cleanable, false, 'a versioned library outside the list is measured only');
  assert.equal(row('character-library').retained.count, 2);
  assert.deepEqual(row('character-record').originals.count, 5, 'bodies without a head are immutable originals, never old versions');
  assert.equal(row('character-record').retained.count, 0);
  assert.deepEqual(result.cleanable, { count: 4, bytes: chat.slice(0, 3).concat(index.slice(0, 1)).reduce((sum, body) => sum + body.bytes, 0) });
  assert.equal(result.other.count, 1); assert.equal(result.snapshots.count, 1);
  assert.doesNotMatch(JSON.stringify(result), /alice|qianmu-v2/, 'no file names or account handles leave the server');
  assert.deepEqual(await f.names(), before);
  assert.ok(library.length);
});

test('cleaning removes only old versions of listed slots, keeps the newest old one, the current one, originals and anything just written', async t => {
  const f = await fixture(t);
  const chat = await f.slot('assistant-' + 'a'.repeat(64), 5), library = await f.slot('character-library', 3), originals = await f.slot('character-record', 2, { head: false });
  const busy = await f.slot('text-collection', 3, { ageMs: 60 * 1000 });   // 一分钟前刚写的：可能是保存到一半
  const done = await f.service.clean(f.req, f.input({ families: ['assistant-*', 'text-collection'] }));
  assert.deepEqual(done.removed, { count: 3, bytes: chat.slice(0, 3).reduce((sum, body) => sum + body.bytes, 0) });
  const left = await f.names(), has = body => left.includes(body.file);
  assert.deepEqual(chat.map(has), [false, false, false, true, true], 'the three oldest go; the newest old version and the current one stay');
  assert.ok(library.every(has), 'an unlisted slot is untouched'); assert.ok(originals.every(has), 'originals are untouched');
  assert.ok(busy.every(has), 'recently written versions are left alone');
  assert.equal(done.kept.count, 1 + 2, 'one kept for the chat, two fresh ones for the collection');
  const again = await f.service.clean(f.req, f.input({ families: ['assistant-*', 'text-collection'] }));
  assert.equal(again.removed.count, 0, 'a second run finds nothing more');
});

test('a slot whose current version is missing is left entirely alone, and the request is checked', async t => {
  const f = await fixture(t), chat = await f.slot('assistant-' + 'a'.repeat(64), 4);
  await fs.unlink(path.join(f.folder, chat.at(-1).file));
  const done = await f.service.clean(f.req, f.input({ families: ['assistant-*'] }));
  assert.equal(done.removed.count, 0); assert.equal(done.kept.count, 3);
  for (const families of [undefined, [], ['character-library'], ['assistant-*', 'assistant-*'], ['*'], 'assistant-*']) {
    await assert.rejects(f.service.clean(f.req, f.input({ families })), { code: 'account_files_contract' });
  }
  await assert.rejects(f.service.clean(f.req, { version: 1, expectedAccount: 'st-user:' + sha('bob'), families: ['assistant-*'] }), { code: 'account_files_account' });
  await assert.rejects(f.service.inspect({ user: null }, f.input()), { code: 'account_files_account' });
  const outside = { user: { profile: { handle: 'alice', enabled: true }, directories: { root: path.dirname(f.root), files: f.folder } } };
  await assert.rejects(f.service.inspect(outside, f.input()), { code: 'account_files_path' });
});

test('routes answer in JSON, and the browser side turns a missing backend into "no such item" rather than an error', async t => {
  const f = await fixture(t), chat = await f.slot('assistant-' + 'a'.repeat(64), 4), routes = new Map();
  installAccountFileRoutes({ post: (route, handler) => routes.set(route, handler) }, { dataRoot: () => f.root, register() {} });
  assert.deepEqual([...routes.keys()], ['/storage/account-files', '/storage/account-files/clean']);
  const fetchImpl = async (url, options) => {
    const handler = routes.get(url.replace('/api/plugins/qianmu-tts', '')); let status = 200, body;
    const res = { set() {}, status(code) { status = code; return res; }, json(value) { body = value; } };
    await handler({ ...f.req, body: JSON.parse(options.body) }, res);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  const transport = { resolveNamespace: async () => 'st-user:alice', headers: () => ({ 'X-CSRF-Token': 't' }), fetchImpl };
  const inventory = await inspectAccountFiles(transport);
  assert.equal(inventory.cleanable.count, 3); assert.equal(inventory.expectedAccount, expectedAccount);
  const done = await cleanAccountFiles(inventory, transport);
  assert.equal(done.removed.count, 2); assert.equal((await f.names()).includes(chat[0].file), false);
  assert.equal(await inspectAccountFiles({ ...transport, fetchImpl: async () => new Response('<html>', { status: 404, headers: { 'content-type': 'text/html' } }) }), null);
  assert.equal(await inspectAccountFiles({ ...transport, fetchImpl: async () => { throw new Error('offline'); } }), null);
  assert.deepEqual((await cleanAccountFiles({ expectedAccount, families: [] }, transport)).removed, { count: 0, bytes: 0 });
});
