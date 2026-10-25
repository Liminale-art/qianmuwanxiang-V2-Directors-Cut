import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createYimuStore, chatStorageName} from '../yimu/server-store.mjs';
import {registerYimuRoutes} from '../yimu/server-plugin.mjs';
import {fingerprintMessages, DEFAULTS, VERSION, SCHEMA, createDocument} from '../yimu/contract.mjs';

const binding = {avatar: '角色.png', file: '聊天 - 2026-10-25', integrity: 'fixture_integrity'};
const messages = [
    {name: '我', is_user: true, mes: '第一层测试原文，不应复制进忆幕存储', send_date: '2026-10-25T10:00:00.000Z'},
    {name: '角色', is_user: false, mes: '第二层测试原文，不应复制进忆幕存储', send_date: '2026-10-25T10:01:00.000Z'},
];

async function fixture(t) {
    const parent = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(parent, 'yimu-server-test-'));
    t.after(async () => {
        const real = await fs.realpath(root);
        assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^yimu-server-test-/);
        await fs.rm(real, {recursive: true, force: true});
    });
    const account = path.join(root, 'data', 'alpha');
    const chats = path.join(account, 'chats');
    await fs.mkdir(path.join(chats, '角色'), {recursive: true});
    const request = {user: {profile: {handle: 'alpha'}, directories: {root: account, chats}}};
    const store = createYimuStore({hostCwd: root});
    const chatFile = path.join(chats, '角色', `${binding.file}.jsonl`);
    const writeChat = (items = messages, target = chatFile, identity = binding.integrity) => fs.writeFile(target,
        [{chat_metadata: {integrity: identity}}, ...items].map(value => JSON.stringify(value)).join('\n'), 'utf8');
    await writeChat();
    const source = {start: 1, end: 2, hashes: await fingerprintMessages(messages)};
    const enable = () => store.change(request, binding, {id: 'enable', type: 'enable', expectedRevision: 0,
        enabled: true, range: {start: 1, end: 2, total: 2}});
    const append = (id, text = '用户确认的手动补充') => store.change(request, binding,
        {id: `append_${id}`, type: 'append', entry: {id, kind: 'manual', text, source: null}});
    const summary = (epoch = 1) => store.change(request, binding, {id: 'summary_1', type: 'append', expectedEpoch: epoch,
        entry: {id: 'slice_1', kind: 'summary', text: '两人确实进行了这次对话。角色只知已告知部分。', source}});
    return {root, account, chats, request, store, chatFile, writeChat, source, enable, append, summary};
}

test('independent store reads ST account identity, saves only memories, and survives a new client instance', async t => {
    const f = await fixture(t);
    const empty = await f.store.read(f.request, binding);
    assert.equal(empty.document.enabled, false);
    assert.equal(empty.sourceAvailable, true);
    assert.deepEqual(empty.defaults.values, DEFAULTS);
    await f.enable();
    const saved = await f.summary();
    assert.equal(saved.document.entries[0].status, 'active');
    const otherDevice = createYimuStore({hostCwd: f.root});
    assert.deepEqual((await otherDevice.read(f.request, binding)).document, saved.document);
    const bytes = await fs.readFile(path.join(f.account, '.yimu', chatStorageName(binding)), 'utf8');
    assert.ok(!bytes.includes(messages[0].mes));
    assert.ok(!bytes.includes(messages[1].mes));
    assert.ok(bytes.includes(saved.document.entries[0].text));
    assert.deepEqual((await fs.readdir(path.join(f.account, '.yimu'))).sort(), [chatStorageName(binding)]);
});

test('same chat names cannot share memories across accounts or clones; relative data paths use captured ST cwd', async t => {
    const f = await fixture(t);
    await f.append('one');
    const otherAccount = path.join(f.root, 'data', 'beta');
    await fs.mkdir(path.join(otherAccount, 'chats'), {recursive: true});
    const other = {user: {profile: {handle: 'beta'}, directories: {root: otherAccount, chats: path.join(otherAccount, 'chats')}}};
    assert.deepEqual((await f.store.read(other, binding)).document.entries, []);
    const cloneBinding = {...binding, file: '另一个独立聊天'};
    await f.writeChat(messages, path.join(f.chats, '角色', `${cloneBinding.file}.jsonl`));
    assert.deepEqual((await f.store.read(f.request, cloneBinding)).document.entries, []);
    await assert.rejects(f.store.read(f.request, {...binding, integrity: 'different_identity'}), {code: 'yimu_binding_changed'});
    const relative = {user: {profile: {handle: 'alpha'}, directories: {root: 'data/alpha', chats: 'data/alpha/chats'}}};
    assert.equal((await f.store.read(relative, binding)).document.entries.length, 1);
});

test('unsafe names, drive-relative roots, and redirected directories fail closed', async t => {
    const f = await fixture(t);
    for (const file of ['../escape', 'bad/name', 'bad\\name', 'NUL', 'ending.', 'x:y']) {
        await assert.rejects(f.store.read(f.request, {...binding, file}));
    }
    for (const root of ['D:data', 'bad\0path', path.parse(f.root).root]) {
        const request = {user: {profile: {handle: 'alpha'}, directories: {root, chats: f.chats}}};
        await assert.rejects(f.store.read(request, binding), {code: 'yimu_account'});
    }
    await f.store.read(f.request, binding);
    const linked = path.join(f.root, 'linked-account');
    await fs.symlink(f.account, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const redirected = {user: {profile: {handle: 'alpha'}, directories: {root: linked, chats: path.join(linked, 'chats')}}};
    await assert.rejects(f.store.read(redirected, binding), {code: 'yimu_path'});
});

test('old raw text, changed header, and disabled epoch cannot be accepted as a new summary', async t => {
    const f = await fixture(t);
    await f.enable();
    const before = (await f.store.read(f.request, binding)).document;
    await f.writeChat([{...messages[0], mes: '原文被编辑'}, messages[1]]);
    await assert.rejects(f.summary(), {code: 'yimu_source_changed'});
    assert.deepEqual((await f.store.read(f.request, binding)).document, before);
    await f.writeChat(messages, f.chatFile, 'other_chat');
    await assert.rejects(f.summary(), {code: 'yimu_source_identity'});
    assert.equal((await f.store.read(f.request, binding)).sourceAvailable, false);
    await f.writeChat();
    await f.store.change(f.request, binding, {id: 'disable', type: 'enable', expectedRevision: 1, enabled: false});
    await assert.rejects(f.summary(), /状态|设置/);
    assert.equal((await f.store.read(f.request, binding)).document.entries.length, 0);
});

test('first persistence verifies the ST header while existing manual notes remain editable without raw chat', async t => {
    const f = await fixture(t);
    await f.writeChat(messages, f.chatFile, 'wrong_identity');
    await assert.rejects(f.append('one'), {code: 'yimu_source_identity'});
    assert.deepEqual(await fs.readdir(path.join(f.account, '.yimu')), []);
    await f.writeChat();
    await f.append('one');
    await fs.unlink(f.chatFile);
    const missing = await f.store.read(f.request, binding);
    assert.equal(missing.sourceAvailable, false);
    const edit = await f.store.change(f.request, binding, {id: 'edit_without_source', type: 'edit', entryId: 'one', expectedRevision: 1, text: '保留人工资料'});
    assert.equal(edit.document.entries[0].text, '保留人工资料');
});

test('same-entry concurrent edits preserve both versions and different entries save without false conflicts', async t => {
    const f = await fixture(t);
    await f.append('one');
    await f.append('two');
    const independent = await Promise.all(['one', 'two'].map(entryId => f.store.change(f.request, binding,
        {id: `edit_${entryId}`, type: 'edit', entryId, expectedRevision: 1, text: `分别修改 ${entryId}`})));
    assert.ok(independent.every(result => result.outcome === 'applied'));
    const competing = await Promise.all(['PC 修改', '手机修改'].map((text, i) => f.store.change(f.request, binding,
        {id: `competing_${i}`, type: 'edit', entryId: 'one', expectedRevision: 2, text})));
    assert.deepEqual(competing.map(result => result.outcome).sort(), ['applied', 'conflict']);
    const document = (await f.store.read(f.request, binding)).document;
    const one = document.entries.find(entry => entry.id === 'one');
    assert.equal(one.conflicts.length, 1);
    assert.equal(new Set([one.text, one.conflicts[0].text]).size, 2);
    assert.equal(document.entries.find(entry => entry.id === 'two').conflicts.length, 0);
});

test('operation retries are idempotent and account defaults survive another instance', async t => {
    const f = await fixture(t);
    await f.append('one');
    const repeated = await f.append('one');
    assert.equal(repeated.outcome, 'duplicate');
    assert.equal(repeated.document.entries.length, 1);
    assert.equal(repeated.document.revision, 1);
    await assert.rejects(f.store.change(f.request, binding, {id: 'append_one', type: 'append', receipt: 'forged',
        entry: {id: 'other', kind: 'manual', text: '不能冒充同一次请求', source: null}}), /同一操作标识/);
    const result = await f.store.defaults(f.request, {id: 'defaults_1', expectedRevision: 0, values: {...DEFAULTS, recent: 7}});
    assert.equal(result.defaults.values.recent, 7);
    assert.equal((await createYimuStore({hostCwd: f.root}).read(f.request, binding)).defaults.values.recent, 7);
    await assert.rejects(f.store.defaults(f.request, {id: 'defaults_stale', expectedRevision: 0, values: DEFAULTS}), /另一设备/);
});

test('same-account documents are never read through a symbolic or hard-linked file', async t => {
    const f = await fixture(t);
    await f.append('one');
    const stored = path.join(f.account, '.yimu', chatStorageName(binding));
    const unrelated = path.join(f.root, 'unrelated-copy.json');
    await fs.link(stored, unrelated);
    await assert.rejects(f.store.read(f.request, binding), {code: 'yimu_corrupt'});
    await fs.unlink(unrelated);
    const savedBytes = await fs.readFile(stored);
    await fs.rename(stored, unrelated);
    await fs.symlink(unrelated, stored, process.platform === 'win32' ? 'file' : undefined).catch(async caught => {
        if (caught.code === 'EPERM') { await fs.rename(unrelated, stored); return; }
        throw caught;
    });
    if ((await fs.lstat(stored)).isSymbolicLink()) await assert.rejects(f.store.read(f.request, binding), {code: 'yimu_corrupt'});
    assert.deepEqual(await fs.readFile(stored), savedBytes);
});

test('corrupt documents and occupied locks are preserved, never auto-repaired or removed', async t => {
    const f = await fixture(t);
    await f.append('one');
    const folder = path.join(f.account, '.yimu');
    const file = path.join(folder, chatStorageName(binding));
    const original = await fs.readFile(file);
    const lock = `${file}.lock`;
    await fs.writeFile(lock, JSON.stringify({owner: 'unknown', pid: 2147483647}));
    const impatient = createYimuStore({hostCwd: f.root, lockTimeoutMs: 0});
    await assert.rejects(impatient.change(f.request, binding, {id: 'edit', type: 'edit', entryId: 'one', expectedRevision: 1, text: '不应覆盖'}), {code: 'yimu_busy'});
    assert.deepEqual(await fs.readFile(file), original);
    assert.ok(await fs.stat(lock));
    await fs.unlink(lock);
    await fs.writeFile(file, '{damaged');
    await assert.rejects(f.append('two'), {code: 'yimu_corrupt'});
    assert.equal(await fs.readFile(file, 'utf8'), '{damaged');
});

test('failure before atomic replacement preserves the complete original and cleans only own temporary file', async t => {
    const f = await fixture(t);
    await f.append('one');
    const target = path.join(f.account, '.yimu', chatStorageName(binding));
    const original = await fs.readFile(target);
    const failing = createYimuStore({hostCwd: f.root, io: {...fs, async rename() { throw Object.assign(new Error('synthetic failure'), {code: 'EIO'}); }}});
    await assert.rejects(failing.change(f.request, binding, {id: 'edit', type: 'edit', entryId: 'one', expectedRevision: 1, text: '不能覆盖'}), {code: 'EIO'});
    assert.deepEqual(await fs.readFile(target), original);
    assert.deepEqual(await fs.readdir(path.dirname(target)), [chatStorageName(binding)]);
});

test('narrow rename follows a moved chat, preserves rollback data, and remains idempotent', async t => {
    const f = await fixture(t);
    await f.append('one');
    const newBinding = {...binding, file: '已改名'};
    await assert.rejects(f.store.rename(f.request, binding, newBinding), {code: 'yimu_rename'});
    await fs.rename(f.chatFile, path.join(f.chats, '角色', `${newBinding.file}.jsonl`));
    const moved = await f.store.rename(f.request, binding, newBinding);
    assert.deepEqual(moved.document.binding, newBinding);
    assert.equal(moved.document.entries.length, 1);
    const old = await f.store.read(f.request, binding);
    assert.deepEqual(old.document.movedTo, newBinding);
    assert.equal(old.sourceAvailable, false);
    assert.deepEqual((await f.store.rename(f.request, binding, newBinding)).document, moved.document);
    assert.equal((await f.store.read(f.request, newBinding)).sourceAvailable, true);
});

test('interrupted rename resumes only an identical target and does not lose the old document', async t => {
    const f = await fixture(t);
    await f.append('one');
    const newBinding = {...binding, file: '改名中断后重试'};
    await fs.rename(f.chatFile, path.join(f.chats, '角色', `${newBinding.file}.jsonl`));
    let writes = 0;
    const interrupted = createYimuStore({hostCwd: f.root, io: {...fs, async rename(from, to) {
        if (++writes === 2) throw Object.assign(new Error('synthetic interruption'), {code: 'EIO'});
        return fs.rename(from, to);
    }}});
    await assert.rejects(interrupted.rename(f.request, binding, newBinding), {code: 'EIO'});
    const old = await f.store.read(f.request, binding);
    assert.equal(old.document.movedTo, undefined);
    assert.equal(old.document.entries.length, 1);
    assert.equal((await f.store.read(f.request, newBinding)).document.entries.length, 1);
    const resumed = await f.store.rename(f.request, binding, newBinding);
    assert.equal(resumed.document.entries.length, 1);
    assert.deepEqual((await f.store.read(f.request, binding)).document.movedTo, newBinding);
});

test('accepting a model candidate rechecks original floors and cannot reactivate stale evidence', async t => {
    const f = await fixture(t);
    await f.enable();
    await f.summary();
    await f.store.change(f.request, binding, {id: 'manual_edit', type: 'edit', entryId: 'slice_1', expectedRevision: 1, text: '人工确认的含义'});
    const proposed = await f.store.change(f.request, binding, {id: 'redo', type: 'redo', entryId: 'slice_1', expectedRevision: 2,
        expectedEpoch: 1, entry: {id: 'slice_1', kind: 'summary', source: f.source, text: '待人工决定的新总结'}});
    assert.ok(proposed.document.entries[0].candidate);
    await f.writeChat([{...messages[0], mes: '候选生成后原文变化'}, messages[1]]);
    await assert.rejects(f.store.change(f.request, binding, {id: 'accept', type: 'entry', action: 'acceptCandidate', entryId: 'slice_1', expectedRevision: 3}), {code: 'yimu_source_changed'});
    assert.equal((await f.store.read(f.request, binding)).document.entries[0].text, '人工确认的含义');
});

test('undo after deletion and changed original preserves the old text as invalid and allows explicit redo', async t => {
    const f = await fixture(t);
    await f.enable();
    const original = await f.summary();
    const text = original.document.entries[0].text;
    await f.store.change(f.request, binding, {id: 'delete_slice', type: 'entry', action: 'delete', entryId: 'slice_1', expectedRevision: 1});
    const changed = [{...messages[0], mes: '修改后的真实原文'}, messages[1]];
    await f.writeChat(changed);
    const restored = await f.store.change(f.request, binding, {id: 'undo_delete', type: 'entry', action: 'undo', entryId: 'slice_1', expectedRevision: 2});
    assert.equal(restored.document.entries[0].status, 'invalid');
    assert.equal(restored.document.entries[0].text, text);
    const source = {start: 1, end: 2, hashes: await fingerprintMessages(changed)};
    const redone = await f.store.change(f.request, binding, {id: 'explicit_redo', type: 'redo', entryId: 'slice_1', expectedRevision: 3,
        expectedEpoch: 1, entry: {id: 'slice_1', kind: 'summary', text: '依据新原文重新整理', source}});
    assert.equal(redone.document.entries[0].status, 'active');
    assert.equal(redone.document.entries[0].text, '依据新原文重新整理');
});

test('restoring with missing original retains invalid content, but link anomalies are not swallowed', async t => {
    const f = await fixture(t);
    await f.enable(); await f.summary();
    await f.store.change(f.request, binding, {id: 'exclude', type: 'entry', action: 'exclude', entryId: 'slice_1', expectedRevision: 1});
    const linked = path.join(f.root, 'source-hardlink.jsonl');
    await fs.link(f.chatFile, linked);
    const operation = {id: 'restore', type: 'entry', action: 'restore', entryId: 'slice_1', expectedRevision: 2};
    await assert.rejects(f.store.change(f.request, binding, operation), {code: 'yimu_source'});
    assert.equal((await f.store.read(f.request, binding)).document.entries[0].status, 'excluded');
    await fs.unlink(linked); await fs.unlink(f.chatFile);
    const restored = await f.store.change(f.request, binding, operation);
    assert.equal(restored.document.entries[0].status, 'invalid');
    assert.equal(restored.document.entries[0].text.includes('确实进行了'), true);
});

test('selected conflicting manual text survives source changes without becoming active or losing its manual protection', async t => {
    const f = await fixture(t);
    await f.enable(); await f.summary();
    await f.store.change(f.request, binding, {id: 'pc_edit', type: 'edit', entryId: 'slice_1', expectedRevision: 1, text: 'PC人工修订'});
    await f.store.change(f.request, binding, {id: 'phone_edit', type: 'edit', entryId: 'slice_1', expectedRevision: 1, text: '手机人工修订'});
    const changed = [{...messages[0], mes: '原文已变但人工版本必须保全'}, messages[1]];
    await f.writeChat(changed);
    const selected = await f.store.change(f.request, binding, {id: 'choose_phone', type: 'entry', action: 'acceptConflict',
        entryId: 'slice_1', expectedRevision: 2, conflictId: 'phone_edit'});
    assert.equal(selected.document.entries[0].status, 'invalid');
    assert.equal(selected.document.entries[0].text, '手机人工修订');
    assert.equal(selected.document.entries[0].edited, true);
    const source = {start: 1, end: 2, hashes: await fingerprintMessages(changed)};
    const proposed = await f.store.change(f.request, binding, {id: 'redo_selected', type: 'redo', entryId: 'slice_1', expectedRevision: 3,
        expectedEpoch: 1, entry: {id: 'slice_1', kind: 'summary', text: '新来源总结只能作为候选', source}});
    assert.equal(proposed.document.entries[0].text, '手机人工修订');
    assert.equal(proposed.document.entries[0].status, 'invalid');
    assert.equal(proposed.document.entries[0].candidate.text, '新来源总结只能作为候选');
});

test('read checks all active source windows in one streamed pass without writing invalidations implicitly', async t => {
    const f = await fixture(t);
    await f.enable();
    for (let i = 0; i < 2; i++) await f.store.change(f.request, binding, {id: `source_${i}`, type: 'append', expectedEpoch: 1,
        entry: {id: `slice_${i}`, kind: 'summary', text: `独立记忆${i}`, source: {start: i + 1, end: i + 1, hashes: [f.source.hashes[i]]}}});
    const before = await f.store.read(f.request, binding);
    let rawReads = 0;
    const counting = createYimuStore({hostCwd: f.root, io: {...fs, async open(target, ...args) {
        if (target === f.chatFile) rawReads++;
        return fs.open(target, ...args);
    }}});
    await f.writeChat([{...messages[0], mes: '另一设备已经修改第一层'}, messages[1]]);
    const checked = await counting.read(f.request, binding);
    assert.equal(rawReads, 1);
    assert.equal(checked.sourceAvailable, true);
    assert.equal(checked.sourceFloorCount, 2);
    assert.deepEqual(checked.invalidSourceIds, ['slice_0']);
    assert.notEqual(checked.sourceFingerprint, before.sourceFingerprint);
    assert.ok(checked.document.entries.every(entry => entry.status === 'active'), 'read returns evidence, not an implicit mutation');
    assert.equal(checked.document.revision, before.document.revision);
    await fs.appendFile(f.chatFile, '\n{incomplete-json');
    assert.equal((await counting.read(f.request, binding)).sourceAvailable, false);
});

test('summary commit fences the current defaults revision while completed operation replay stays idempotent', async t => {
    const f = await fixture(t);
    await f.enable();
    await f.store.defaults(f.request, {id: 'remote_settings', expectedRevision: 0, values: {...DEFAULTS, preference: '新偏好'}});
    const op = {id: 'with_defaults', type: 'append', expectedEpoch: 1, expectedDefaultsRevision: 0,
        entry: {id: 'slice', kind: 'summary', text: '只采用匹配设置的结果', source: f.source}};
    await assert.rejects(f.store.change(f.request, binding, op), {code: 'yimu_defaults_changed'});
    assert.equal((await f.store.read(f.request, binding)).document.entries.length, 0);
    op.expectedDefaultsRevision = 1;
    await f.store.change(f.request, binding, op);
    await f.store.defaults(f.request, {id: 'remote_settings_2', expectedRevision: 1, values: {...DEFAULTS, recent: 9}});
    const repeated = await f.store.change(f.request, binding, op);
    assert.equal(repeated.outcome, 'duplicate');
    assert.equal(repeated.document.entries.length, 1);
    assert.equal(repeated.document.entries[0].status, 'active');
});

async function stagedFixture(f, {recentTail = true} = {}) {
    if (recentTail) await f.writeChat([...messages, ...Array.from({length: 5}, (_, i) => ({name: '角色', mes: `近期原文${i}`, send_date: `recent_${i}`}))]);
    await f.enable();
    for (let i = 0; i < 2; i++) await f.store.change(f.request, binding, {id: `fine_save_${i}`, type: 'append', expectedEpoch: 1,
        entry: {id: `fine_${i}`, kind: 'summary', text: `连续细摘要${i}`, source: {start: i + 1, end: i + 1, hashes: [f.source.hashes[i]]}}});
    return {id: 'stage_save', type: 'append', expectedEpoch: 1, expectedDefaultsRevision: 0,
        entry: {id: 'stage_1', kind: 'stage', text: '连续细摘要的阶段整理', source: {parents: [{id: 'fine_0', revision: 1}, {id: 'fine_1', revision: 1}]}}};
}

test('stage commits derive source under the chat lock and parent edits invalidate stage atomically', async t => {
    const f = await fixture(t), op = await stagedFixture(f);
    op.entry.source.ranges = [{start: 1, end: 999, hashes: []}];
    const saved = await f.store.change(f.request, binding, op);
    assert.deepEqual(saved.document.entries.at(-1).source.ranges, [{start: 1, end: 2, hashes: f.source.hashes}]);
    const edited = await f.store.change(f.request, binding, {id: 'edit_parent', type: 'edit', entryId: 'fine_0', expectedRevision: 1, text: '此人工内容不再压缩'});
    assert.equal(edited.document.entries.find(entry => entry.id === 'fine_0').text, '此人工内容不再压缩');
    assert.equal(edited.document.entries.find(entry => entry.id === 'stage_1').status, 'invalid');
    await assert.rejects(f.store.change(f.request, binding, {...op, id: 'late_stage', entry: {...op.entry, id: 'stage_late'}}), /细摘要已修改|停用|失效/);
    assert.equal((await f.store.read(f.request, binding)).document.entries.length, 3);
});

test('stage writes require defaults revision, current raw fingerprints, and exclusion of recent raw floors', async t => {
    const f = await fixture(t), op = await stagedFixture(f, {recentTail: false});
    const {expectedDefaultsRevision: ignored, ...missingRevision} = op;
    await assert.rejects(f.store.change(f.request, binding, missingRevision), {code: 'yimu_defaults_revision'});
    await assert.rejects(f.store.change(f.request, binding, op), {code: 'yimu_stage_recent'});
    const expanded = [...messages, ...Array.from({length: 5}, (_, i) => ({name: '角色', mes: `近期原文${i}`}))];
    await f.writeChat(expanded);
    await f.store.change(f.request, binding, op);
    await f.writeChat([{...messages[0], mes: '远端原文已变化'}, ...expanded.slice(1)]);
    const read = await f.store.read(f.request, binding);
    assert.ok(read.invalidSourceIds.includes('fine_0')); assert.ok(read.invalidSourceIds.includes('stage_1'));
    assert.ok(!read.invalidSourceIds.includes('fine_1'));
    await assert.rejects(f.store.change(f.request, binding, {...op, id: 'stale_raw', type: 'redo', entryId: 'stage_1', expectedRevision: 1}), {code: 'yimu_source_changed'});
});

for (const schema of [1, 5]) test(`schema ${schema} reads are non-mutating and first actual write preserves byte-exact legacy backup before upgrading`, async t => {
    const f = await fixture(t), folder = path.join(f.account, '.yimu');
    await fs.mkdir(folder);
    const legacy = {...createDocument(binding), schema}; delete legacy.autoSummary;
    const envelope = value => Buffer.from(JSON.stringify({schema: 1, value, checksum: createHash('sha256').update(JSON.stringify(value)).digest('hex')}));
    const file = path.join(folder, chatStorageName(binding)), original = envelope(legacy);
    await fs.writeFile(file, original);
    const read = await f.store.read(f.request, binding);
    assert.equal(read.document.schema, SCHEMA); assert.deepEqual(await fs.readFile(file), original);
    assert.deepEqual(await fs.readdir(folder), [chatStorageName(binding)]);
    await f.append('migrated');
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).value.schema, SCHEMA);
    assert.deepEqual(await fs.readFile(`${file}.schema${schema}.bak`), original);
    const backup = await fs.stat(`${file}.schema${schema}.bak`);
    assert.equal(backup.mode & 0o200, 0, 'legacy snapshot is created read-only');
    await f.append('later');
    assert.deepEqual(await fs.readFile(`${file}.schema${schema}.bak`), original, 'later saves never rewrite rollback material');
    const values = {...DEFAULTS}; delete values.stageAuto; delete values.stageBasis; delete values.stageThreshold; delete values.recall;
    const oldDefaults = envelope({schema, revision: 0, operations: [], receipts: {}, values});
    await fs.writeFile(path.join(folder, 'defaults.json'), oldDefaults);
    await f.store.defaults(f.request, {id: 'upgrade_defaults', expectedRevision: 0, values: {recent: 9}});
    assert.deepEqual(await fs.readFile(path.join(folder, `defaults.json.schema${schema}.bak`)), oldDefaults);
    assert.equal((await f.store.read(f.request, binding)).defaults.values.recall, true);
});

test('an occupied or corrupt legacy backup blocks upgrade without replacing legacy memory', async t => {
    const f = await fixture(t), folder = path.join(f.account, '.yimu');
    await fs.mkdir(folder);
    const legacy = {...createDocument(binding), schema: 1};
    const body = JSON.stringify({schema: 1, value: legacy, checksum: createHash('sha256').update(JSON.stringify(legacy)).digest('hex')});
    const file = path.join(folder, chatStorageName(binding));
    await fs.writeFile(file, body); await fs.writeFile(`${file}.schema1.bak`, 'unrelated occupied file');
    await assert.rejects(f.append('blocked'), {code: 'yimu_corrupt'});
    assert.equal(await fs.readFile(file, 'utf8'), body);
    assert.equal(await fs.readFile(`${file}.schema1.bak`, 'utf8'), 'unrelated occupied file');
});

test('standalone routes retain ST authentication, route errors, and never return filesystem internals', async () => {
    const routes = new Map();
    const router = {get(route, handler) { routes.set(`GET ${route}`, handler); }, post(route, handler) { routes.set(`POST ${route}`, handler); }};
    registerYimuRoutes(router, {store: {read: async () => { throw Object.assign(new Error('private server path'), {code: 'EACCES'}); }}});
    const call = async (key, request) => {
        const result = {status: 200, body: null};
        const response = {status(code) { result.status = code; return this; }, json(body) { result.body = body; return this; }};
        await routes.get(key)(request, response);
        return result;
    };
    assert.equal((await call('GET /health', {})).status, 403);
    const request = {user: {profile: {handle: 'alpha'}, directories: {}}, body: {binding}};
    assert.deepEqual((await call('GET /health', request)).body, {version: VERSION, schema: SCHEMA});
    const failure = await call('POST /read', request);
    assert.equal(failure.status, 500);
    assert.ok(!JSON.stringify(failure).includes('private server path'));
});
