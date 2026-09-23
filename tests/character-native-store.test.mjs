import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {characterNativeFixture, namespace, document} from './helpers/character-native-fixture.mjs';
import {createCharacterNativeStore} from '../qianmu-character-native-store.js';
import {createCharacterNativeOriginals, validateCharacterNativeIndex, characterNativeBackup, CHARACTER_NATIVE_SLOT} from '../qianmu-character-native-contract.js';
import {characterLibraryBackupDigest, characterBackupBindingKey} from '../qianmu-character-library-backup.js';
import {validateCharacterStorageSummary} from '../qianmu-character-storage.js';
import {selectCharacterBinding} from '../qianmu-character-archive.js';
import {planUserAliases} from '../qianmu-user-alias.js';
import {inspectUserAliasTargets} from '../qianmu-user-identity.js';
import {aliasFixture, namespace as aliasNamespace, chatHash} from './fixtures/storyboard-user-aliases.mjs';

const save = (store, name = 'Alice', category = 'char') => store.save(namespace, {document: document(name, category)});
const target = (scope = 'default') => ({category: 'char', subjectKey: 'char:alice.png', scope, chatKey: scope === 'chat' ? 'chat-one' : ''});
const bound = (head, scope = 'default') => ({target: target(scope), archiveId: head.id});
const digest = value => characterLibraryBackupDigest(value);

test('native store is lazy and empty read does not upload or touch an IndexedDB library', async t => {
  let opened = 0; const store = createCharacterNativeStore({createStorage: () => { opened++; throw Error('unavailable'); }}); assert.equal(opened, 0);
  await assert.rejects(() => store.list(namespace), /unavailable/); assert.equal(opened, 1); store.close();
  const f = await characterNativeFixture(t), client = f.open();
  assert.deepEqual(await client.list(namespace), []); assert.equal((await client.usage(namespace)).count, 0); assert.equal(f.uploads, 0);
  assert.equal(await client.load(namespace, 'missing'), null);
});

test('two native instances share complete text and optional zero values, while list and accounting read only metadata', async t => {
  const f = await characterNativeFixture(t), a = f.open(), b = f.open(), head = await save(a);
  f.reset(); assert.deepEqual(await b.list(namespace), [head]); assert.equal(f.originalReads, 0);
  const summary = await b.storageSummary(namespace); validateCharacterStorageSummary(summary, namespace); assert.equal(summary.documents.count, 1); assert.equal(f.originalReads, 0);
  const loaded = await b.load(namespace, head.id); assert.equal(f.originalReads, 1); assert.deepEqual(loaded.head, head); assert.deepEqual(loaded.document, document());
  assert.equal(loaded.document.imagegen.novelReference.strength, 0); assert.equal(f.uploads, 0);
});

test('reference receipts and fixed Comfy implementations round-trip without fetching image bytes or invoking a workflow', async t => {
  const f = await characterNativeFixture(t), store = f.open(), value = document();
  const reference = {url: '/user/images/Qianmu-References/original.png', name: 'Original', mime: 'image/png', bytes: 100, sha256: 'a'.repeat(64)};
  value.imagegen.reference = reference; value.imagegen.preview = {...reference, url: '/user/images/Qianmu-References/preview.png', sourceSha256: reference.sha256};
  value.comfy = {version: 1, implementations: [{version: 1, name: 'Reference slot', workflow: {id: 'workflow', revision: 'wrev', version: 1, hash: 'b'.repeat(64)}, referenceSlot: 1, loras: [], conditioning: []}]};
  const head = await store.save(namespace, {document: value}); assert.deepEqual((await store.load(namespace, head.id)).document, value);
  const backup = await store.backup(namespace); assert.deepEqual(backup.archives[0].document, value);
  assert.equal(f.calls.some(row => row.path.includes('/images/') || row.path.includes('/prompt')), false);
});

test('save captures user input immediately and returned objects cannot mutate stored data', async t => {
  const f = await characterNativeFixture(t), store = f.open(), input = document(), pending = store.save(namespace, {document: input}); input.name = 'changed after invocation';
  const head = await pending; head.name = 'mutated result'; const saved = await store.load(namespace, head.id); assert.equal(saved.document.name, 'Alice');
  saved.document.aliases.push('foreign'); assert.deepEqual((await store.load(namespace, head.id)).document.aliases, ['Alias']);
});

test('updates preserve identity, zero-created timestamp, and monotonic time without guessing a conflict from clocks', async t => {
  const f = await characterNativeFixture(t), store = f.open(); f.setTime(0); const first = await save(store);
  f.setTime(20); const next = await store.save(namespace, {id: first.id, expectedRevision: first.revision, document: document('second')});
  f.setTime(1); const last = await store.save(namespace, {id: next.id, expectedRevision: next.revision, document: document('third')});
  assert.equal(last.createdAt, 0); assert.equal(last.updatedAt, 20); assert.equal(last.version, 3); assert.notEqual(last.revision, next.revision);
  f.reset(); await assert.rejects(() => store.save(namespace, {id: first.id, expectedRevision: first.revision, document: document('stale')}), /变化/); assert.equal(f.uploads, 0);
});

test('missing, cross-category and caller-selected nonexistent identities cannot overwrite or allocate archives', async t => {
  const f = await characterNativeFixture(t), store = f.open(), head = await save(store); f.reset();
  await assert.rejects(() => store.save(namespace, {id: head.id, expectedRevision: head.revision, document: document('User', 'user')}), /分类/);
  await assert.rejects(() => store.save(namespace, {id: 'missing', document: document()}), /变化/);
  await assert.rejects(() => store.save(namespace, {expectedRevision: 'unrelated', document: document()}), /变化/); assert.equal(f.uploads, 0);
});

test('default and explicit chat unbind remain distinct; inherit restores default and records a deletion marker', async t => {
  const f = await characterNativeFixture(t), store = f.open(), head = await save(store); await store.bind(namespace, bound(head));
  const chat = await store.bind(namespace, {target: target('chat'), archiveId: ''});
  assert.equal(selectCharacterBinding(await store.bindings(namespace), target(), 'chat-one').archiveId, '');
  await store.bind(namespace, {target: target('chat'), expectedRevision: chat.revision, inherit: true});
  assert.equal(selectCharacterBinding(await store.bindings(namespace), target(), 'chat-one').archiveId, head.id);
  assert.deepEqual((await f.readIndex()).value.retired.bindings, [characterBackupBindingKey(target('chat'))]);
});

test('binding revisions and classification are enforced without reading archive bodies', async t => {
  const f = await characterNativeFixture(t), store = f.open(), head = await save(store), user = await save(store, 'User', 'user'); f.reset();
  await assert.rejects(() => store.bind(namespace, {...bound(head), archiveId: user.id}), /分类/); assert.equal(f.uploads, 0);
  const row = await store.bind(namespace, bound(head)); f.reset(); await assert.rejects(() => store.bind(namespace, bound(head)), /另一页/);
  assert.equal(f.originalReads, 0); assert.equal(f.uploads, 0); await store.bind(namespace, {...bound(head), expectedRevision: row.revision, archiveId: ''});
});

test('bound archives cannot be deleted; unbound removal retains all immutable originals and a tombstone', async t => {
  const f = await characterNativeFixture(t), store = f.open(), head = await save(store), binding = await store.bind(namespace, bound(head));
  const originalFiles = [...f.files.keys()].filter(name => name.includes('-character-record-')); f.reset();
  await assert.rejects(() => store.remove(namespace, head.id, head.revision), /仍有绑定/); assert.equal(f.uploads, 0);
  await store.bind(namespace, {...bound(head), expectedRevision: binding.revision, inherit: true}); await store.remove(namespace, head.id, head.revision);
  assert.equal(await store.load(namespace, head.id), null); assert.deepEqual((await f.readIndex()).value.retired.archives, [head.id]);
  for (const file of originalFiles) assert.ok(f.files.has(file)); assert.equal((await store.usage(namespace)).bytes, 0);
});

test('createOnce acknowledges identical first versions without a write but never resurrects deleted or edited archives', async t => {
  const f = await characterNativeFixture(t), store = f.open(), options = {isCurrent: () => true}, input = {id: 'stable', document: document()};
  const first = await store.createOnce(namespace, input, options); assert.equal(first.created, true); f.reset();
  assert.deepEqual(await store.createOnce(namespace, input, options), {...first, created: false}); assert.equal(f.uploads, 0);
  await assert.rejects(() => store.createOnce(namespace, {...input, document: document('other')}, options), /不会覆盖/);
  await store.remove(namespace, first.head.id, first.head.revision); f.reset();
  await assert.rejects(() => store.createOnce(namespace, input, options), /已删除/); assert.equal(f.uploads, 0);
});

test('createOnce edited then restored-to-same-text still conflicts by version rather than guessing ancestry', async t => {
  const f = await characterNativeFixture(t), store = f.open(), first = await store.createOnce(namespace, {id: 'stable', document: document()}, {isCurrent: () => true});
  await store.save(namespace, {id: 'stable', expectedRevision: first.head.revision, document: document()});
  await assert.rejects(() => store.createOnce(namespace, {id: 'stable', document: document()}, {isCurrent: () => true}), /不会覆盖/);
});

test('simultaneous identical createOnce calls acknowledge one verified winner without repeating directory writes', async t => {
  const f = await characterNativeFixture(t), a = f.open(), b = f.open(), input = {id: 'stable', document: document()}, options = {isCurrent: () => true};
  const results = await Promise.all([a.createOnce(namespace, input, options), b.createOnce(namespace, input, options)]);
  assert.equal(results.filter(row => row.created).length, 1); assert.deepEqual(results[0].head, results[1].head);
  assert.equal((await f.readIndex()).value.revision, 1);
});

test('simultaneous different createOnce calls do not acknowledge each other as successful', async t => {
  const f = await characterNativeFixture(t), a = f.open(), b = f.open(), options = {isCurrent: () => true};
  const results = await Promise.allSettled([a.createOnce(namespace, {id: 'stable', document: document('one')}, options), b.createOnce(namespace, {id: 'stable', document: document('two')}, options)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal((await f.readIndex()).value.revision, 1);
});

test('independent simultaneous saves merge in the native directory; same-target writes do not silently overwrite', async t => {
  const f = await characterNativeFixture(t), a = f.open(), b = f.open();
  const [first, second] = await Promise.all([save(a, 'first'), save(b, 'second')]); assert.equal((await a.list(namespace)).length, 2);
  const results = await Promise.allSettled([a.save(namespace, {id: first.id, expectedRevision: first.revision, document: document('a')}), b.save(namespace, {id: first.id, expectedRevision: first.revision, document: document('b')})]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal((await b.load(namespace, second.id)).document.name, 'second');
});

test('lost index acknowledgement is reported as uncertain, not retried; a fresh reader can recover accepted data', async t => {
  const f = await characterNativeFixture(t), a = f.open(); f.loseAck();
  await assert.rejects(() => save(a), error => error.writeState === 'unconfirmed');
  const published = f.calls.filter(row => row.request.method === 'POST' && JSON.parse(Buffer.from(JSON.parse(row.request.body).data, 'base64')).schema === 'qianmu.st-account-head.v1');
  assert.equal(published.length, 1); const rows = await f.open().list(namespace); assert.equal(rows.length, 1); assert.equal((await a.load(namespace, rows[0].id)).document.name, 'Alice');
});

test('backup reads every original and reproduces the existing portable library contract without writes', async t => {
  const f = await characterNativeFixture(t), store = f.open(), head = await save(store); await save(store, 'Other', 'other'); await store.bind(namespace, bound(head));
  f.reset(); const backup = await store.backup(namespace); assert.equal(backup.archives.length, 2); assert.equal(backup.bindings.length, 1); assert.equal(f.originalReads, 2); assert.equal(f.uploads, 0);
  assert.equal(backup.credentialsIncluded, false); assert.equal(backup.archives.find(row => row.head.id === head.id).document.imagegen.sensitiveAppearance, 'private annotation');
});

test('missing or damaged originals fail detail and full backup, never synthesize an empty document', async t => {
  const f = await characterNativeFixture(t), store = f.open(), head = await save(store), key = [...f.files.keys()].find(name => name.includes('-character-record-'));
  const body = f.files.get(key); f.files.delete(key); f.reset();
  await assert.rejects(() => store.load(namespace, head.id), /原件/); await assert.rejects(() => store.backup(namespace), /原件/); assert.equal(f.uploads, 0);
  f.files.set(key, body.replace('black hair', 'white hair')); await assert.rejects(() => store.load(namespace, head.id), /校验/);
});

test('original read validates the whole descriptor even when the immutable body hash itself is correct', async t => {
  const f = await characterNativeFixture(t), store = f.open(); await save(store); const {value} = await f.readIndex(), row = structuredClone(value.archives[0]);
  row.head.name = 'different metadata'; const originals = createCharacterNativeOriginals(f.storage);
  await assert.rejects(() => originals.read(row), /当前目录/); row.head.name = 'Alice'; row.original.scope = 'a'.repeat(64);
  await assert.rejects(() => originals.read(row), /账户/);
});

test('corrupted or unknown directory fields block mutations with zero uploads and no local fallback', async t => {
  const f = await characterNativeFixture(t), store = f.open(); await save(store); const {value} = await f.readIndex(); value.unrecognized = true; await f.writeIndex(value); f.reset();
  await assert.rejects(() => store.list(namespace), /目录/); await assert.rejects(() => save(store, 'new'), /目录/); assert.equal(f.uploads, 0);
});

test('directory contract rejects mismatched ownership, metadata, usage, references, bindings and retirement markers', async t => {
  const f = await characterNativeFixture(t), store = f.open(), head = await save(store); await store.bind(namespace, bound(head)); const {value} = await f.readIndex();
  const changes = [v => v.namespace = 'st-user:other', v => v.revision = -1, v => v.archives.push(v.archives[0]), v => v.archives[0].head.extra = true,
    v => v.archives[0].head.version = 0, v => v.archives[0].head.bytes = 70000, v => v.archives[0].original.slot = 'collections', v => v.archives[0].original.scope = 'f'.repeat(64),
    v => v.usage.bytes++, v => v.usage.count++, v => v.bindings.push(v.bindings[0]), v => v.bindings[0].archiveId = 'missing', v => v.bindings[0].category = 'user',
    v => v.bindings[0].chatKey = 'ignored', v => v.retired.archives.push(head.id), v => v.retired.archives.push('same', 'same'), v => v.retired.bindings.push('not JSON'),
    v => v.retired.bindings.push(characterBackupBindingKey(target())), v => v.retired.bindings.push(JSON.stringify(['char', 'char:a', 'default', 'ignored']))];
  for (const change of changes) { const next = structuredClone(value); change(next); assert.throws(() => validateCharacterNativeIndex(next, {namespace, scope: f.storage.scope})); }
});

test('restore requires confirmation, the exact local backup digest, same account and explicit conflict choices', async t => {
  const f = await characterNativeFixture(t), store = f.open(), first = await save(store), old = await store.backup(namespace);
  await store.save(namespace, {id: first.id, expectedRevision: first.revision, document: document('new')}); const current = await store.backup(namespace); f.reset();
  assert.throws(() => store.restoreBackup(namespace, old, {expectedDigest: 'a'.repeat(64)}), /确认/);
  assert.throws(() => store.restoreBackup('st-user:elsewhere', old, {expectedDigest: 'a'.repeat(64), confirmed: true}), /另一 ST/);
  await assert.rejects(async () => store.restoreBackup(namespace, old, {expectedDigest: await digest(old), confirmed: true}), /已变化/);
  await assert.rejects(async () => store.restoreBackup(namespace, old, {expectedDigest: await digest(current), confirmed: true}), /冲突/); assert.equal(f.uploads, 0);
  const result = await store.restoreBackup(namespace, old, {expectedDigest: await digest(current), confirmed: true, decisions: {[`archive:${first.id}`]: 'incoming'}});
  assert.equal(result.replaced, 1); assert.deepEqual(await store.backup(namespace), old);
});

test('explicit restoration can revive a removed archive and binding while removing matching tombstones', async t => {
  const f = await characterNativeFixture(t), store = f.open(), head = await save(store), binding = await store.bind(namespace, bound(head)), original = await store.backup(namespace);
  await store.bind(namespace, {...bound(head), expectedRevision: binding.revision, inherit: true}); await store.remove(namespace, head.id, head.revision);
  const empty = await store.backup(namespace); await store.restoreBackup(namespace, original, {expectedDigest: await digest(empty), confirmed: true});
  assert.deepEqual(await store.backup(namespace), original); assert.deepEqual((await f.readIndex()).value.retired, {archives: [], bindings: []});
});

test('new native library can restore an entire library without resetting record revisions or USER links', async t => {
  const f = await characterNativeFixture(t), store = f.open(), backup = aliasFixture(); backup.namespace = namespace;
  const initial = await store.backup(namespace); await store.restoreBackup(namespace, backup, {expectedDigest: await digest(initial), confirmed: true});
  assert.deepEqual(await store.backup(namespace), characterNativeBackup(namespace, backup.archives, backup.bindings));
});

test('restore rejects stale whole-library confirmation after original preparation and retains the newer binding', async t => {
  const f = await characterNativeFixture(t), store = f.open(), peer = f.open(), original = await store.backup(namespace), incoming = aliasFixture(); incoming.namespace = namespace;
  let triggered = false;
  // A head fetch within original preparation does not acquire the index queue.
  f.hook(async call => { if (!triggered && call.request.method === 'GET' && call.path.includes('-character-record-')) { triggered = true; await peer.bind(namespace, {target: target(), archiveId: ''}); } });
  await assert.rejects(async () => store.restoreBackup(namespace, incoming, {expectedDigest: await digest(original), confirmed: true}), /已变化/);
  f.hook(null); assert.equal((await store.list(namespace)).length, 0); assert.equal((await store.bindings(namespace)).length, 1);
});

test('account changes, failed login and closed sessions never fall back to browser originals', async t => {
  const f = await characterNativeFixture(t), store = f.open(); await save(store); f.reset(); f.account('st-user:other');
  await assert.rejects(() => store.list(namespace), /账户/); assert.equal(f.uploads, 0); f.account(namespace);
  f.hook(() => new Response('{}', {status: 401, headers: {'content-type': 'application/json'}})); await assert.rejects(() => store.list(namespace), /登录/); f.hook(null);
  store.close(); await assert.rejects(() => store.list(namespace), /已变化/);
});

test('per-call identity and abort guards stop backup without publishing anything', async t => {
  const f = await characterNativeFixture(t), store = f.open(); await save(store); let current = true;
  f.hook(call => { if (call.path.includes('-character-record-')) current = false; }); f.reset();
  await assert.rejects(() => store.backup(namespace, {isCurrent: () => current})); assert.equal(f.uploads, 0); f.hook(null);
  const controller = new AbortController(); controller.abort(); f.reset(); await assert.rejects(() => store.backup(namespace, {signal: controller.signal})); assert.equal(f.calls.length, 0);
});

test('a full directory refuses a new original before upload; it does not need to read all 512 originals', async t => {
  const f = await characterNativeFixture(t), store = f.open(); await save(store); const {value} = await f.readIndex(), template = value.archives[0];
  value.archives = Array.from({length: 512}, (_, i) => ({...structuredClone(template), head: {...structuredClone(template.head), id: 'id-' + i}}));
  value.usage = {count: 512, bytes: template.head.bytes * 512, bindings: 0}; await f.writeIndex(value); f.reset();
  await assert.rejects(() => save(store, 'overflow'), /上限/); assert.equal(f.uploads, 0); assert.equal(f.originalReads, 0);
});

test('logical text byte budget is enforced before preserving another original', async t => {
  const f = await characterNativeFixture(t), store = f.open(); await save(store); const {value} = await f.readIndex(), template = value.archives[0];
  value.archives = Array.from({length: 256}, (_, i) => ({head: {...structuredClone(template.head), id: 'id-' + i, bytes: 65536}, original: {...template.original, bytes: 70000}}));
  value.usage = {count: 256, bytes: 16 * 1024 * 1024, bindings: 0}; await f.writeIndex(value); f.reset();
  await assert.rejects(() => save(store, 'overflow'), /上限/); assert.equal(f.uploads, 0);
});

test('binding and deletion-marker budgets stop before publishing an index and never truncate old entries', async t => {
  const f = await characterNativeFixture(t), store = f.open(); await save(store); const {value} = await f.readIndex();
  value.bindings = Array.from({length: 2048}, (_, i) => ({category: 'char', subjectKey: 'char:' + i, scope: 'default', chatKey: '', archiveId: '', revision: 'r' + i, updatedAt: 1}));
  value.usage.bindings = 2048; await f.writeIndex(value); f.reset();
  await assert.rejects(() => store.bind(namespace, {target: target(), archiveId: ''}), /目录/); assert.equal(f.uploads, 0);
  value.bindings = []; value.usage.bindings = 0; value.retired.archives = Array.from({length: 8192}, (_, i) => 'removed-' + i); await f.writeIndex(value); f.reset();
  const head = value.archives[0].head; await assert.rejects(() => store.remove(namespace, head.id, head.revision), /删除标记/); assert.equal(f.uploads, 0);
});

test('invalid clocks or an exhausted archive revision cannot upload an unrepresentable original', async t => {
  const f = await characterNativeFixture(t), store = f.open(); f.setTime(-1); await assert.rejects(() => save(store), /时间/); assert.equal(f.uploads, 0);
  f.setTime(1); await save(store); const {value} = await f.readIndex(), head = value.archives[0].head; head.version = Number.MAX_SAFE_INTEGER; await f.writeIndex(value); f.reset();
  await assert.rejects(() => store.save(namespace, {id: head.id, expectedRevision: head.revision, document: document('next')}), /索引/); assert.equal(f.uploads, 0);
});

test('whole original validation rejects normalized-away fields instead of silently stripping a backup payload', async t => {
  const f = await characterNativeFixture(t), store = f.open(); await save(store); const backup = await store.backup(namespace), row = structuredClone(backup.archives[0]);
  row.document.unrecognized = 'keep private original'; f.reset();
  await assert.rejects(() => createCharacterNativeOriginals(f.storage).preserve(row), /字段/); assert.equal(f.uploads, 0);
});

test('USER alias review uses the existing receipt and changes only the confirmed bindings', async t => {
  const f = await characterNativeFixture(t, {account: aliasNamespace}), store = f.open(), initial = await store.backup(aliasNamespace), library = aliasFixture();
  await store.restoreBackup(aliasNamespace, library, {expectedDigest: await digest(initial), confirmed: true});
  const bindings = await store.bindings(aliasNamespace), heads = await store.list(aliasNamespace), resolveTargets = async targets => inspectUserAliasTargets(targets, {'A B.png': 'User'});
  const pending = await planUserAliases({namespace: aliasNamespace, chatHash, bindings, resolveTargets}), chosen = pending.display.find(row => row.conflict && row.archiveId === 'bob');
  const plan = await planUserAliases({namespace: aliasNamespace, chatHash, bindings, choices: {[chosen.groupId]: chosen.candidateId}, resolveTargets});
  f.reset(); const result = await store.applyUserAliasReview(aliasNamespace, plan.review, {expectedBindings: bindings, expectedHeads: heads, confirmed: true});
  assert.deepEqual(result, {before: 3, after: 2}); assert.equal(f.originalReads, 0); assert.deepEqual((await store.backup(aliasNamespace)).archives, library.archives);
  const rows = await store.bindings(aliasNamespace); assert.equal(rows.length, 3); assert.equal(rows.find(row => row.chatKey === 'other-chat').revision, 'unchanged');
  await assert.rejects(() => store.applyUserAliasReview(aliasNamespace, plan.review, {expectedBindings: bindings, expectedHeads: heads, confirmed: true}), /已变化/);
});

test('alias-aware binding rejects an alternate spelling instead of silently creating a duplicate USER binding', async t => {
  const f = await characterNativeFixture(t), store = f.open(), user = await save(store, 'User', 'user');
  await store.bind(namespace, {target: {category: 'user', subjectKey: 'user:/User Avatars/A B.png', scope: 'default', chatKey: ''}, archiveId: user.id}); f.reset();
  await assert.rejects(() => store.bind(namespace, {target: {category: 'user', subjectKey: 'user:/User%20Avatars/A%20B.png', scope: 'default', chatKey: ''}, archiveId: user.id}), /其他地址/); assert.equal(f.uploads, 0);
});

test('a failed original upload never publishes the directory or switches to an empty local store', async t => {
  const f = await characterNativeFixture(t), store = f.open();
  f.hook(call => { if (call.request.method === 'POST') throw Error('synthetic upload unavailable'); });
  await assert.rejects(() => save(store)); f.hook(null); assert.equal((await f.readIndex()).exists, false);
  assert.equal(f.uploads, 1); assert.deepEqual(await store.list(namespace), []);
});

test('account loss after original preservation stops directory publication while retaining the body', async t => {
  const f = await characterNativeFixture(t), store = f.open(); let originalGets = 0;
  f.hook(call => { if (call.request.method === 'GET' && call.path.includes('-character-record-') && ++originalGets === 2) f.account('st-user:changed'); });
  await assert.rejects(() => save(store)); f.hook(null); f.account(namespace);
  assert.equal((await f.readIndex()).exists, false); assert.equal([...f.files.keys()].filter(name => name.includes('-character-record-')).length, 1);
});

test('closing a store cancels an in-flight original read and does not retain a hanging native operation', async t => {
  const f = await characterNativeFixture(t), store = f.open(), head = await save(store); let entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  f.hook(async call => { if (call.path.includes('-character-record-')) { entered(); await new Promise(resolve => { release = resolve; }); } });
  const pending = store.load(namespace, head.id); const rejected = assert.rejects(pending); await reached; store.close(); await rejected; release(); f.hook(null);
});

test('explicit no-op restore keeps the native directory revision and performs no uploads', async t => {
  const f = await characterNativeFixture(t), store = f.open(); await save(store); const original = await store.backup(namespace), before = await f.readIndex(); f.reset();
  const result = await store.restoreBackup(namespace, original, {expectedDigest: await digest(original), confirmed: true});
  assert.equal(result.added, 0); assert.equal(f.uploads, 0); assert.equal((await f.readIndex()).fingerprint, before.fingerprint);
});

test('native selection is centralized at the shared archive factory rather than only the panel', async () => {
  const store = await readFile(new URL('../qianmu-character-archive-store.js', import.meta.url), 'utf8');
  assert.match(store, /createCharacterArchiveSession/); assert.match(store, /createLocalCharacterArchiveStore/);
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  for (const file of ['qianmu-character-native-store.js', 'qianmu-character-native-contract.js']) assert.ok(release.files.includes(file));
});
