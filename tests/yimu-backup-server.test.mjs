import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createYimuStore, chatStorageName} from '../yimu/server-store.mjs';
import {createDocument, fingerprintMessages, SCHEMA} from '../yimu/contract.mjs';
import {encodeBackup, decodeBackup} from '../yimu/backup-codec.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const binding = {avatar: 'Fixture.png', file: 'Original', integrity: 'fixture-original'};
const clone = value => structuredClone(value);
async function bytes(iterable) {const out = []; for await (const chunk of iterable) out.push(chunk); return Buffer.concat(out);}
async function* chunks(value, size = 47) {for (let offset = 0; offset < value.length; offset += size) yield value.subarray(offset, offset + size);}
async function fixture(t, {io = null} = {}) {
    const base = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(base, 'yimu-backup-test-'));
    async function account(name) {
        const folder = path.join(root, name), chats = path.join(folder, 'chats'), characters = path.join(folder, 'characters');
        await fs.mkdir(path.join(chats, 'Fixture'), {recursive: true}); await fs.mkdir(characters);
        await fs.writeFile(path.join(characters, binding.avatar), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
        return {folder, chats, characters, request: {user: {profile: {handle: name}, directories: {root: folder, chats, characters}}}};
    }
    const a = await account('a'), b = await account('b');
    const store = createYimuStore({hostCwd: root, ...(io ? {io} : {})});
    const messages = Array.from({length: 10}, (_, index) => ({name: index % 2 ? 'User' : 'Character', is_user: Boolean(index % 2), is_system: false,
        mes: `第 ${index + 1} 层独立合成故事。`, send_date: `2026-10-25T12:${String(index).padStart(2, '0')}:00Z`, extra: {display: 'preserve-message-field'}}));
    const writeChat = async (owner = a, target = binding, body = messages) => {
        const filename = path.join(owner.chats, target.avatar.slice(0, -4), target.file + '.jsonl');
        await fs.mkdir(path.dirname(filename), {recursive: true});
        await fs.writeFile(filename, [{user_name: 'User', character_name: 'Character', chat_metadata: {integrity: target.integrity, unrelated_plugin: 'must-not-activate'}}, ...body].map(JSON.stringify).join('\n') + '\n');
        return filename;
    };
    const sourceFile = await writeChat();
    const hashes = await fingerprintMessages(messages), source = (start, end) => ({start, end, hashes: hashes.slice(start - 1, end)});
    await store.change(a.request, binding, {id: 'enable', type: 'enable', enabled: true, expectedRevision: 0, range: {start: 1, end: 10, total: 10}});
    await store.change(a.request, binding, {id: 'summary', type: 'append', expectedEpoch: 1, entry: {id: 'fine', kind: 'summary', text: '第一段细摘要', source: source(1, 3)}});
    await store.change(a.request, binding, {id: 'manual', type: 'append', entry: {id: 'note', kind: 'manual', text: '人工保留背景', placement:{binding,fromFloor:10,hash:hashes[9]}}});
    async function pack(sourceIds = [], target = binding) {
        const plan = await store.backupPlan(a.request, target);
        return bytes((await store.backupExport(a.request, target, {planId: plan.planId, sourceIds})).stream);
    }
    const upload = async (data, id = 'upload-one', owner = b) => store.backupUpload(owner.request, chunks(data), id);
    const restore = (id, options = {}) => store.backupRestore(b.request, id, {id: 'restore-one', targetAvatar: binding.avatar, sourceIds: ['source_0'], ...options});
    t.after(async () => {const real = await fs.realpath(root); assert.equal(path.dirname(real), base); assert.match(path.basename(real), /^yimu-backup-test-/); await fs.rm(real, {recursive: true, force: true});});
    return {root, a, b, store, messages, hashes, source, sourceFile, writeChat, pack, upload, restore};
}

test('memory-only package is complete inert account archive; no raw attachment and no empty restored chat', async t => {
    const f = await fixture(t), data = await f.pack(), decoded = await decodeBackup(chunks(data));
    assert.equal(decoded.header.sources[0].attached, false); assert.deepEqual(decoded.sourceReceipts, []);
    assert.equal(decoded.header.sources[0].fingerprint, sha(JSON.stringify(f.hashes)));
    const {archive} = await f.upload(data), result = await f.store.backupRead(f.b.request, archive.id);
    assert.equal(result.document.entries.length, 2); assert.equal(result.document.entries[0].text, '第一段细摘要');
    assert.equal(result.document.enabled, true, 'the inert archive preserves original settings without enabling a live chat');
    assert.equal((await f.store.backupList(f.b.request)).archives.length, 1);
    assert.deepEqual(await fs.readdir(path.join(f.b.chats, 'Fixture')), []);
    await assert.rejects(f.restore(archive.id, {sourceIds: []}), {code: 'yimu_backup_source'});
    assert.equal((await f.store.backupList(f.a.request)).archives.length, 0);
});

test('direct import uniquely matches real account text, merges once, and never changes ST bytes or receiver switches', async t => {
    const f=await fixture(t),target={...binding,file:'Renamed',integrity:'local-copy'};
    const filename=await f.writeChat(f.b,target),before=await fs.readFile(filename);
    const {archive}=await f.upload(await f.pack());
    const imported=await f.store.backupApply(f.b.request,archive.id,{id:'apply-one'});
    assert.equal(imported.status,'complete');assert.equal(imported.outcome,'merged');assert.deepEqual(imported.binding,target);
    const current=await f.store.read(f.b.request,target);assert.equal(current.document.enabled,false);assert.equal(current.document.autoSummary,false);
    assert.equal(current.document.entries.length,2);assert.deepEqual(current.document.entries.find(entry=>entry.kind==='manual').placement.binding,target);
    const memory=await fs.readFile(path.join(f.b.folder,'.yimu',chatStorageName(target)));
    const duplicate=await f.store.backupApply(f.b.request,archive.id,{id:'apply-again'});
    assert.equal(duplicate.outcome,'duplicate');assert.deepEqual(await fs.readFile(path.join(f.b.folder,'.yimu',chatStorageName(target))),memory);
    assert.deepEqual(await fs.readFile(filename),before);assert.deepEqual((await fs.readdir(path.join(f.b.chats,'Fixture'))),['Renamed.jsonl']);
});

test('multiple textual copies require a target choice; original identity wins only when it really matches', async t => {
    const f=await fixture(t),one={...binding,file:'Copy one',integrity:'one'},two={...binding,file:'Copy two',integrity:'two'};
    await f.writeChat(f.b,one);await f.writeChat(f.b,two);
    const {archive}=await f.upload(await f.pack());
    const choose=await f.store.backupApply(f.b.request,archive.id,{id:'choose-copy'});
    assert.equal(choose.status,'selection');assert.equal(choose.reason,'multiple');assert.equal(choose.candidates.length,2);
    assert.equal((await f.store.read(f.b.request,one)).document.entries.length,0);
    const applied=await f.store.backupApply(f.b.request,archive.id,{id:'choose-copy',targetBinding:two});assert.equal(applied.status,'complete');
    assert.equal((await f.store.read(f.b.request,one)).document.entries.length,0);assert.equal((await f.store.read(f.b.request,two)).document.entries.length,2);
    await f.writeChat(f.b,binding);
    const original=await f.store.backupApply(f.b.request,archive.id,{id:'prefer-original'});assert.deepEqual(original.binding,binding);
});

test('explicit mismatching target retains sourced memory as unresolved, never claims its old text as this source', async t => {
    const f=await fixture(t),target={...binding,file:'Different',integrity:'different'};
    await f.writeChat(f.b,target,f.messages.map(message=>({...message,mes:'另一故事'})));
    const {archive}=await f.upload(await f.pack());
    const choose=await f.store.backupApply(f.b.request,archive.id,{id:'different-target'});assert.equal(choose.status,'selection');assert.equal(choose.candidates[0].exact,false);
    const applied=await f.store.backupApply(f.b.request,archive.id,{id:'different-target',targetBinding:target});assert.equal(applied.exact,false);
    const doc=(await f.store.read(f.b.request,target)).document;
    for(const entry of doc.entries){assert.equal(entry.status,'invalid');assert.equal(entry.origin.unresolved,true);}
    assert.deepEqual(doc.entries.find(entry=>entry.kind==='manual').placement.binding,binding);
});

test('lost merge completion receipt resumes the fixed target without duplicating memory', async t => {
    let failComplete=false;
    const io={...fs,async rename(from,to){if(failComplete&&path.basename(to).startsWith('backup-apply-')){const value=JSON.parse(await fs.readFile(from,'utf8'));if(value.value.status==='complete'){failComplete=false;throw Object.assign(new Error('lost completion'),{code:'ENOSPC'});}}return fs.rename(from,to);}};
    const f=await fixture(t,{io});await f.writeChat(f.b,binding);const {archive}=await f.upload(await f.pack());failComplete=true;
    await assert.rejects(f.store.backupApply(f.b.request,archive.id,{id:'resume-merge'}));
    assert.equal((await f.store.read(f.b.request,binding)).document.entries.length,2);
    const retried=await f.store.backupApply(f.b.request,archive.id,{id:'resume-merge'});assert.equal(retried.status,'complete');assert.equal(retried.repeated,true);
    assert.equal((await f.store.read(f.b.request,binding)).document.entries.length,2);
});

test('explicit primary attachment restores a disabled independent ST chat and preserves the original and management history', async t => {
    const f = await fixture(t);
    await f.store.change(f.a.request, binding, {id: 'edit', type: 'edit', entryId: 'fine', expectedRevision: 1, text: '用户精确修订'});
    await f.store.change(f.a.request, binding, {id: 'conflict', type: 'edit', entryId: 'fine', expectedRevision: 1, text: '另一设备保留版'});
    const before = await fs.readFile(f.sourceFile), priorMemory = await fs.readFile(path.join(f.a.folder, '.yimu', chatStorageName(binding)));
    const {archive} = await f.upload(await f.pack(['source_0']));
    const result = await f.restore(archive.id);
    assert.equal(result.status, 'complete'); assert.equal(result.document.enabled, false); assert.equal(result.document.schema, SCHEMA);
    assert.notDeepEqual(result.binding, binding); assert.equal(result.document.entries[0].text, '用户精确修订');
    assert.equal(result.document.entries[0].history.length, 1); assert.equal(result.document.entries[0].conflicts.length, 1);
    assert.deepEqual(result.document.operations, []); assert.deepEqual(result.receipt.hashes, f.hashes);
    const targetFile = path.join(f.b.chats, 'Fixture', result.binding.file + '.jsonl'), lines = (await fs.readFile(targetFile, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(lines[0].chat_metadata.integrity, result.binding.integrity); assert.equal(lines[0].chat_metadata.unrelated_plugin, undefined);
    assert.deepEqual(lines.slice(1), f.messages);
    assert.deepEqual(await fs.readFile(f.sourceFile), before); assert.deepEqual(await fs.readFile(path.join(f.a.folder, '.yimu', chatStorageName(binding))), priorMemory);
    assert.equal((await f.store.read(f.b.request, result.binding)).sourceAvailable, true);
    assert.equal((await f.store.backupResult(f.b.request, archive.id, {})).status, 'complete');
    assert.equal((await f.restore(archive.id, {id: 'second-click'})).binding.file, result.binding.file);
    assert.equal((await fs.readdir(path.join(f.b.chats, 'Fixture'))).length, 1);
});

test('same package deduplicates across upload ids and survives a lost completion response', async t => {
    const f = await fixture(t), data = await f.pack(['source_0']);
    const first = await f.upload(data), again = await f.upload(data, 'upload-again');
    assert.equal(first.archive.id, again.archive.id);
    const receipt = await f.store.backupUploadResult(f.b.request, 'upload-one');
    assert.equal(receipt.status, 'complete'); assert.equal(receipt.archive.id, first.archive.id);
    assert.equal((await f.store.backupList(f.b.request)).archives.length, 1);
    assert.ok(!(await fs.readdir(path.join(f.b.folder, '.yimu'))).some(name => name.endsWith('.tmp')));
});

test('explicit current-chat fingerprint match copies a new independent chat and never replaces its existing memories', async t => {
    const f = await fixture(t), current = {...binding, file: 'Different name', integrity: 'different-integrity'};
    const target = await f.writeChat(f.b, current);
    await f.store.change(f.b.request, current, {id: 'current-note', type: 'append', entry: {id: 'current', kind: 'manual', text: '不允许覆盖当前忆幕',placement:{binding:current,fromFloor:10,hash:f.hashes[9]}}});
    const currentBytes = await fs.readFile(target), currentMemory = await fs.readFile(path.join(f.b.folder, '.yimu', chatStorageName(current)));
    const {archive} = await f.upload(await f.pack());
    const restored = await f.restore(archive.id, {sourceIds: [], useCurrentBinding: current});
    assert.equal(restored.status, 'complete'); assert.notEqual(restored.binding.file, current.file);
    assert.deepEqual(await fs.readFile(target), currentBytes); assert.deepEqual(await fs.readFile(path.join(f.b.folder, '.yimu', chatStorageName(current))), currentMemory);
    assert.equal(restored.document.enabled, false);
});

test('same-name and partial textual matches never substitute for explicit complete source matching', async t => {
    const f = await fixture(t); await f.writeChat(f.b, binding, [...f.messages.slice(0, 3), {...f.messages[3], mes: '后文不同'}, ...f.messages.slice(4)]);
    const {archive} = await f.upload(await f.pack());
    await assert.rejects(f.restore(archive.id, {sourceIds: []}), {code: 'yimu_backup_source'});
    await assert.rejects(f.restore(archive.id, {sourceIds: [], useCurrentBinding: binding}), {code: 'yimu_backup_changed'});
    assert.deepEqual(await fs.readdir(path.join(f.b.chats, 'Fixture')), ['Original.jsonl']);
});

test('truncated or non-own packages fail terminally, leave no archive, and allow the next package upload', async t => {
    const f = await fixture(t), data = await f.pack(['source_0']);
    await assert.rejects(f.upload(data.subarray(0, -15)));
    assert.equal((await f.store.backupUploadResult(f.b.request, 'upload-one')).status, 'failed');
    assert.deepEqual((await f.store.backupList(f.b.request)).archives, []);
    assert.ok(!(await fs.readdir(path.join(f.b.folder, '.yimu'))).some(name => name.endsWith('.tmp')));
    assert.ok((await f.upload(data, 'new-upload')).archive.id);
});

test('invalid claimed raw fingerprints cannot be archived even with valid package framing', async t => {
    const f = await fixture(t), original = await f.pack(['source_0']), decoded = await decodeBackup(chunks(original));
    decoded.header.sources[0].fingerprint = '0'.repeat(64);
    const invalid = await bytes(encodeBackup({header: decoded.header, sources: [{id: 'source_0', stream: chunks(await fs.readFile(f.sourceFile))}]}));
    await assert.rejects(f.upload(invalid), {code: 'yimu_backup_raw'});
    assert.equal((await f.store.backupUploadResult(f.b.request, 'upload-one')).status, 'failed');
    assert.deepEqual((await f.store.backupList(f.b.request)).archives, []);
});

async function foreignFixture(f) {
    const foreign = {...binding, file: 'Ancestor', integrity: 'ancestor-integrity'}; await f.writeChat(f.a, foreign);
    const file = path.join(f.a.folder, '.yimu', chatStorageName(binding)), stored = JSON.parse(await fs.readFile(file, 'utf8')).value;
    stored.entries[0].origin = {binding: foreign, offset: 0};
    stored.entries[0].history = [{...clone(stored.entries[0]), revision: 1, text: '外源历史', history: undefined, conflicts: undefined, candidate: undefined}];
    stored.entries[0].revision = 2;
    await fs.writeFile(file, JSON.stringify({schema: 1, value: stored, checksum: sha(JSON.stringify(stored))}));
    return foreign;
}

test('ancestor originals require individual selection; omitted foreign sources and historical versions remain unresolved', async t => {
    const f = await fixture(t), foreign = await foreignFixture(f), plan = await f.store.backupPlan(f.a.request, binding);
    assert.equal(plan.sources.length, 2); assert.equal(plan.sources[1].binding.file, foreign.file);
    const {archive} = await f.upload(await f.pack(['source_0'])), result = await f.restore(archive.id);
    const entry = result.document.entries[0];
    assert.equal(entry.status, 'invalid'); assert.equal(entry.origin.unresolved, true); assert.equal(entry.history[0].origin.unresolved, true);
    await f.writeChat(f.b, foreign); // Deliberate identity/name collision still grants no imported-source authority.
    const read = await f.store.read(f.b.request, result.binding);
    assert.ok(read.invalidSourceIds.includes(entry.id)); assert.equal(read.document.entries[0].originVerified, false);
    await f.store.change(f.b.request, result.binding, {id: 'exclude-entry', type: 'entry', entryId: entry.id, expectedRevision: entry.revision, action: 'exclude'});
    await f.store.change(f.b.request, result.binding, {id: 'restore-entry', type: 'entry', entryId: entry.id, expectedRevision: entry.revision + 1, action: 'restore'});
    assert.equal((await f.store.read(f.b.request, result.binding)).document.entries[0].status, 'invalid');
});

test('explicit ancestor attachments restore to new verified files, with original source offsets and references intact', async t => {
    const f = await fixture(t); await foreignFixture(f);
    const {archive} = await f.upload(await f.pack(['source_0', 'source_1']));
    const result = await f.restore(archive.id, {sourceIds: ['source_0', 'source_1']});
    assert.equal(result.receipt.restoredSources.length, 2);
    const entry = result.document.entries[0]; assert.equal(entry.status, 'active'); assert.equal(entry.origin.unresolved, undefined);
    assert.notEqual(entry.origin.binding.file, 'Ancestor'); assert.equal(entry.origin.offset, 0);
    assert.deepEqual(entry.history[0].origin, entry.origin);
    assert.equal((await f.store.read(f.b.request, result.binding)).document.entries[0].originVerified, true);
});

test('missing originals still export all memory data with factual unavailable source metadata', async t => {
    const f = await fixture(t); await fs.unlink(f.sourceFile);
    const plan = await f.store.backupPlan(f.a.request, binding);
    assert.equal(plan.sources[0].available, false); assert.equal(plan.sources[0].bytes, 0);
    const {archive} = await f.upload(await f.pack());
    assert.equal((await f.store.backupRead(f.b.request, archive.id)).document.entries.length, 2);
});

test('changed export plan and nonexistent target character are rejected without mutating source or archive', async t => {
    const f = await fixture(t), plan = await f.store.backupPlan(f.a.request, binding);
    await f.writeChat(f.a, binding, [{...f.messages[0], mes: '新版本'}, ...f.messages.slice(1)]);
    await assert.rejects(f.store.backupExport(f.a.request, binding, {planId: plan.planId, sourceIds: []}), {code: 'yimu_backup_changed'});
    const {archive} = await f.upload(await f.pack(['source_0']));
    await assert.rejects(f.restore(archive.id, {targetAvatar: 'NoSuchRole.png'}), {code: 'yimu_backup_avatar'});
    assert.deepEqual(await fs.readdir(path.join(f.b.chats, 'Fixture')), []);
});

test('interrupted document commit retains pending receipt, recovers same targets, and never duplicates raw chats', async t => {
    let failCommit = false;
    const io = {...fs, async rename(from, to) {if (failCommit && path.basename(to).startsWith('chat-') && to.includes(`${path.sep}b${path.sep}`)) {failCommit = false; throw Object.assign(new Error('fixture interrupted commit'), {code: 'ENOSPC'});} return fs.rename(from, to);}};
    const f = await fixture(t, {io}), {archive} = await f.upload(await f.pack(['source_0'])); failCommit = true;
    await assert.rejects(f.restore(archive.id), {code: 'ENOSPC'});
    const pending = await f.store.backupResult(f.b.request, archive.id, {});
    assert.equal(pending.status, 'pending'); assert.equal(pending.request.id, 'restore-one');
    const result = await f.store.backupRestore(f.b.request, archive.id, {id: 'restore-one'});
    assert.equal(result.status, 'complete'); assert.equal((await fs.readdir(path.join(f.b.chats, 'Fixture'))).length, 1);
    assert.equal(result.document.enabled, false);
});

test('one upload id cannot replace or silently publish another package', async t => {
    const f = await fixture(t); await f.upload(await f.pack());
    await assert.rejects(f.upload(await f.pack(['source_0'])), {code: 'yimu_backup_collision'});
    assert.equal((await f.store.backupList(f.b.request)).archives.length, 1);
});

test('concurrent different packages using one upload id publish exactly one archive', async t => {
    const f = await fixture(t), one = await f.pack(), two = await f.pack(['source_0']);
    let started = 0, release; const barrier = new Promise(resolve => {release = resolve;});
    async function* simultaneous(value) {if (++started === 2) release(); await barrier; yield value;}
    const results = await Promise.allSettled([f.store.backupUpload(f.b.request, simultaneous(one), 'same-upload'), f.store.backupUpload(f.b.request, simultaneous(two), 'same-upload')]);
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(results.find(value => value.status === 'rejected').reason.code, 'yimu_backup_collision');
    assert.equal((await f.store.backupList(f.b.request)).archives.length, 1);
    assert.equal((await fs.readdir(path.join(f.b.folder, '.yimu'))).filter(name => name.endsWith('.yimu.gz')).length, 1);
});

test('schema 4 first write preserves the full original bytes in a read-only rollback copy', async t => {
    const f = await fixture(t), file = path.join(f.a.folder, '.yimu', chatStorageName(binding));
    const document = {...createDocument(binding), schema: 4}, bytes = Buffer.from(JSON.stringify({schema: 1, value: document, checksum: sha(JSON.stringify(document))}));
    await fs.writeFile(file, bytes);
    assert.equal((await f.store.read(f.a.request, binding)).document.schema, SCHEMA);
    assert.deepEqual(await fs.readFile(file), bytes);
    await f.store.change(f.a.request, binding, {id: 'upgrade', type: 'append', entry: {id: 'note', kind: 'manual', text: '保留旧版快照',placement:{binding,fromFloor:1,hash:f.hashes[0]}}});
    assert.deepEqual(await fs.readFile(file + '.schema4.bak'), bytes);
});

test('a concurrent ST edit on the same newly created inode is retained and receives a terminal failed receipt', async t => {
    let mutate = false, modifiedTarget = null;
    const io = {...fs, async open(target, flags, mode) {
        const file = await fs.open(target, flags, mode);
        if (mutate && flags === 'wx' && String(target).includes('-忆幕恢复-') && String(target).endsWith('.jsonl')) {
            mutate = false; modifiedTarget = target;
            return new Proxy(file, {get(object, key) {
                if (key === 'close') return async () => {await object.close(); await fs.appendFile(target, JSON.stringify({name: 'User', is_user: true, mes: 'ST 同时写入，必须保留'}) + '\n');};
                const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
            }});
        }
        return file;
    }};
    const f = await fixture(t, {io}), {archive} = await f.upload(await f.pack(['source_0'])); mutate = true;
    await assert.rejects(f.restore(archive.id), {code: 'yimu_backup_changed'});
    assert.match(await fs.readFile(modifiedTarget, 'utf8'), /ST 同时写入，必须保留/);
    const result = await f.store.backupResult(f.b.request, archive.id, {});
    assert.equal(result.status, 'failed'); assert.equal(result.receipt.status, 'failed');
    await assert.rejects(f.restore(archive.id), {code: 'yimu_backup_failed'});
    const second = await f.restore(archive.id, {id: 'explicit-new-attempt'});
    assert.equal(second.status, 'complete'); assert.notEqual(path.basename(modifiedTarget, '.jsonl'), second.binding.file);
    assert.match(await fs.readFile(modifiedTarget, 'utf8'), /ST 同时写入，必须保留/);
});

test('a user-created Yimu document in a pending target is never overwritten or mistaken for our completed restore', async t => {
    let failCommit = false;
    const io = {...fs, async rename(from, to) {if (failCommit && path.basename(to).startsWith('chat-') && to.includes(`${path.sep}b${path.sep}`)) {failCommit = false; throw Object.assign(new Error('interrupted'), {code: 'ENOSPC'});} return fs.rename(from, to);}};
    const f = await fixture(t, {io}), {archive} = await f.upload(await f.pack(['source_0'])); failCommit = true;
    await assert.rejects(f.restore(archive.id));
    const pending = await f.store.backupResult(f.b.request, archive.id, {}), target = pending.receipt.target;
    await f.store.change(f.b.request, target, {id: 'user-note', type: 'append', entry: {id: 'manual-user', kind: 'manual', text: '用户先行建立的新资料',placement:{binding:target,fromFloor:1,hash:f.hashes[0]}}});
    const file = path.join(f.b.folder, '.yimu', chatStorageName(target)), before = await fs.readFile(file);
    const failed = await f.store.backupResult(f.b.request, archive.id, {});
    assert.equal(failed.status, 'failed'); assert.deepEqual(await fs.readFile(file), before);
    assert.equal((await f.store.read(f.b.request, target)).document.entries[0].text, '用户先行建立的新资料');
});

test('archive corruption or linked archive files are never silently accepted as valid restore material', async t => {
    const f = await fixture(t), {archive} = await f.upload(await f.pack(['source_0']));
    const filename = path.join(f.b.folder, '.yimu', `backup-${archive.id}.yimu.gz`), original = await fs.readFile(filename);
    await fs.appendFile(filename, 'tampered');
    await assert.rejects(f.store.backupRead(f.b.request, archive.id), {code: 'yimu_backup_corrupt'});
    await assert.rejects(f.restore(archive.id), {code: 'yimu_backup_corrupt'});
    assert.deepEqual(await fs.readdir(path.join(f.b.chats, 'Fixture')), []);
    await fs.writeFile(filename, original);
    const linked = path.join(f.b.folder, 'linked-copy'); await fs.link(filename, linked);
    await assert.rejects(f.store.backupRead(f.b.request, archive.id), {code: 'yimu_backup_changed'});
    assert.deepEqual(await fs.readFile(linked), original);
});

test('unknown interrupted uploads stay retryable by the same id without publishing an unverified archive', async t => {
    const f = await fixture(t), data = await f.pack(['source_0']);
    async function* interrupted() {yield data.subarray(0, 32); throw Object.assign(new Error('fixture lost connection'), {code: 'ECONNRESET'});}
    await assert.rejects(f.store.backupUpload(f.b.request, interrupted(), 'network-upload'));
    assert.equal((await f.store.backupUploadResult(f.b.request, 'network-upload')).status, 'pending');
    assert.deepEqual((await f.store.backupList(f.b.request)).archives, []);
    assert.ok((await f.upload(data, 'network-upload')).archive.id);
});

test('matched current chat changing during restore produces a recoverable terminal failure without an active new document', async t => {
    let mutate = null;
    const io = {...fs, async open(target, flags, mode) {
        const file = await fs.open(target, flags, mode);
        if (mutate && flags === 'wx' && String(target).includes('-忆幕恢复-') && String(target).endsWith('.jsonl')) {
            const action = mutate; mutate = null;
            return new Proxy(file, {get(object, key) {
                if (key === 'close') return async () => {await object.close(); await action();};
                const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
            }});
        }
        return file;
    }};
    const f = await fixture(t, {io}), current = {...binding, file: 'Match', integrity: 'match-current'};
    await f.writeChat(f.b, current); const {archive} = await f.upload(await f.pack());
    mutate = () => f.writeChat(f.b, current, [{...f.messages[0], mes: '保存中发生的新剧情'}, ...f.messages.slice(1)]);
    await assert.rejects(f.restore(archive.id, {sourceIds: [], useCurrentBinding: current}), {code: 'yimu_backup_changed'});
    const failed = await f.store.backupResult(f.b.request, archive.id, {});
    assert.equal(failed.status, 'failed');
    const rawTarget = path.join(f.b.chats, 'Fixture', failed.receipt.target.file + '.jsonl');
    assert.ok((await fs.stat(rawTarget)).isFile());
    assert.equal((await f.store.read(f.b.request, failed.receipt.target)).document.enabled, false);
    assert.match(await fs.readFile(path.join(f.b.chats, 'Fixture', 'Match.jsonl'), 'utf8'), /保存中发生的新剧情/);
    await f.writeChat(f.b, current);
    assert.equal((await f.restore(archive.id, {id: 'explicit-retry', sourceIds: [], useCurrentBinding: current})).status, 'complete');
});

test('an occupied deterministic restore filename without our receipt is preserved, never adopted or replaced', async t => {
    const f = await fixture(t), {archive} = await f.upload(await f.pack(['source_0']));
    const suffix = sha(JSON.stringify([archive.id, 'restore-one', 'source_0'])).slice(0, 16);
    const target = path.join(f.b.chats, 'Fixture', `Original-忆幕恢复-${suffix}.jsonl`), original = 'user-owned arbitrary existing chat';
    await fs.writeFile(target, original);
    await assert.rejects(f.restore(archive.id), {code: 'yimu_backup_collision'});
    assert.equal(await fs.readFile(target, 'utf8'), original);
    assert.equal((await f.store.backupResult(f.b.request, archive.id, {})).status, 'missing');
});
