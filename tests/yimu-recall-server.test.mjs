import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createYimuStore, chatStorageName} from '../yimu/server-store.mjs';
import {registerYimuRoutes} from '../yimu/server-plugin.mjs';
import {fingerprintMessages, createDocument, DEFAULTS, SCHEMA, VERSION, applyOperation, recallBlockReason, excerptDependenciesValid} from '../yimu/contract.mjs';

const clone = value => structuredClone(value);
const binding = {avatar: 'Recall.png', file: 'Synthetic-recall', integrity: 'recall_identity'};
const original = [
    {name: '角色', is_user: false, mes: '她把蓝色手链收进木盒。\n她还没有告诉他。', send_date: '2026-10-25T10:00:00Z'},
    {name: '用户', is_user: true, mes: '他说约定仍然没有兑现。\n请等到明天。', send_date: '2026-10-25T10:01:00Z'},
    ...Array.from({length: 6}, (_, i) => ({name: '角色', is_user: false, mes: `第${i + 3}层的新事件，不包含旧回查答案。`, send_date: `2026-10-25T10:0${i + 2}:00Z`})),
];
const envelope = value => Buffer.from(JSON.stringify({schema: 1, value, checksum: createHash('sha256').update(JSON.stringify(value)).digest('hex')}));

async function fixture(t, {messages = original, parentEnd = 2, seed = true} = {}) {
    const base = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(base, 'yimu-recall-server-'));
    const account = path.join(root, 'account'), chats = path.join(account, 'chats');
    await fs.mkdir(path.join(chats, 'Recall'), {recursive: true});
    const request = {user: {profile: {handle: 'synthetic'}, directories: {root: account, chats}}};
    const chatFile = path.join(chats, 'Recall', `${binding.file}.jsonl`);
    const writeChat = items => fs.writeFile(chatFile, [{chat_metadata: {integrity: binding.integrity}}, ...items].map(JSON.stringify).join('\n'), 'utf8');
    await writeChat(messages);
    const store = createYimuStore({hostCwd: root});
    const hashes = await fingerprintMessages(messages);
    const source = {start: 1, end: parentEnd, hashes: hashes.slice(0, parentEnd)};
    const triggerSource = {start: parentEnd + 1, end: parentEnd + 1, hashes: [hashes[parentEnd]]};
    let serial = 0;
    const read = () => store.read(request, binding);
    const change = operation => store.change(request, binding, {id: `op_${++serial}`, ...operation});
    if (seed) {
        await change({type: 'enable', expectedRevision: 0, enabled: true, range: {start: 1, end: messages.length, total: messages.length}});
        await change({type: 'append', expectedEpoch: 1, entry: {id: 'parent', kind: 'summary', text: '保留了手链与未完成约定的经历。', source}});
    }
    const query = async extra => {
        const current = await read();
        return {parentId: 'parent', parentRevision: current.document.entries.find(entry => entry.id === 'parent')?.revision || 1,
            expectedEpoch: current.document.epoch, expectedDefaultsRevision: current.defaults.revision, triggerSource, ...extra};
    };
    const recallSource = async extra => store.recallSource(request, binding, await query(extra));
    const operation = async (text = '她把蓝色手链收进木盒。', floor = 1, extra = {}) => {
        const response = await recallSource();
        const current = await read();
        return {id: `recall_${++serial}`, type: 'recall', entryId: `excerpt_${serial}`, expectedRevision: response.documentRevision,
            expectedEpoch: current.document.epoch, expectedDefaultsRevision: current.defaults.revision, parent: response.parent, triggerSource, quote: {floor, text}, ...extra};
    };
    const save = async (text, floor, extra) => store.change(request, binding, await operation(text, floor, extra));
    t.after(async () => {
        const real = await fs.realpath(root); assert.equal(path.dirname(real), base); assert.match(path.basename(real), /^yimu-recall-server-/);
        await fs.rm(real, {recursive: true, force: true});
    });
    return {root, account, chats, request, chatFile, store, hashes, source, triggerSource, read, change, query, recallSource, operation, save, writeChat};
}

test('recall-source returns only the approved parent window and never writes data or copies originals', async t => {
    const f = await fixture(t), file = path.join(f.account, '.yimu', chatStorageName(binding));
    const before = await fs.readFile(file), listing = await fs.readdir(path.dirname(file));
    let scans = 0;
    const counted = createYimuStore({hostCwd: f.root, io: {...fs, async open(target, ...args) {if (target === f.chatFile) scans++; return fs.open(target, ...args);}}});
    const response = await counted.recallSource(f.request, binding, await f.query());
    assert.equal(scans, 1);
    assert.deepEqual(response.messages, original.slice(0, 2).map((item, i) => ({floor: i + 1, name: item.name, is_user: item.is_user, mes: item.mes})));
    assert.deepEqual(response.source, f.source); assert.deepEqual(response.parent, {id: 'parent', revision: 1});
    assert.equal(response.documentRevision, 2);
    assert.deepEqual(await fs.readFile(file), before); assert.deepEqual(await fs.readdir(path.dirname(file)), listing);
});

test('recall persists pointers only and read materializes a uniquely verified quote with speaker', async t => {
    const f = await fixture(t), result = await f.save();
    const entry = result.document.entries.at(-1);
    assert.equal(entry.kind, 'excerpt'); assert.equal(entry.text, '原文补充'); assert.equal(entry.quoteText, undefined);
    assert.deepEqual(entry.source, {start: 1, end: 1, hashes: [f.hashes[0]]});
    assert.deepEqual(entry.quote, {start: 0, end: '她把蓝色手链收进木盒。'.length});
    const stored = await fs.readFile(path.join(f.account, '.yimu', chatStorageName(binding)), 'utf8');
    assert.ok(!stored.includes('她把蓝色手链')); assert.ok(!stored.includes('她还没有告诉他')); assert.ok(!stored.includes('quoteText'));
    let scans = 0;
    const fresh = createYimuStore({hostCwd: f.root, io: {...fs, async open(target, ...args) {if (target === f.chatFile) scans++; return fs.open(target, ...args);}}});
    const read = await fresh.read(f.request, binding);
    assert.equal(scans, 1); assert.equal(read.document.entries.at(-1).quoteText, '她把蓝色手链收进木盒。');
    assert.equal(read.document.entries.at(-1).quoteSpeaker, '角色'); assert.deepEqual(read.invalidSourceIds, []);
});

test('ordinary append cannot forge an excerpt and recall cannot supply its own pointer proof', async t => {
    const f = await fixture(t);
    const forged = {id: 'fake', kind: 'excerpt', text: '原文补充', parent: {id: 'parent', revision: 1}, source: {start: 1, end: 1, hashes: [f.hashes[0]]}, quote: {start: 0, end: 2}};
    await assert.rejects(f.change({type: 'append', expectedEpoch: 1, entry: forged}), /类型/);
    const op = await f.operation('原文中完全不存在的句子'); op.excerpt = forged;
    await assert.rejects(f.store.change(f.request, binding, op), {code: 'yimu_recall_quote'});
    assert.equal((await f.read()).document.entries.length, 1);
});

test('empty, overlong, ambiguous and out-of-scope quotes never write a partial result', async t => {
    const f = await fixture(t);
    const before = await fs.readFile(path.join(f.account, '.yimu', chatStorageName(binding)));
    for (const [text, floor] of [['', 1], ['x'.repeat(1201), 1], ['她', 1], ['她把蓝色手链收进木盒。', 3], ['改写的手链结论', 1]]) {
        await assert.rejects(f.store.change(f.request, binding, await f.operation(text, floor)), {code: 'yimu_recall_quote'});
    }
    assert.deepEqual(await fs.readFile(path.join(f.account, '.yimu', chatStorageName(binding))), before);
});

test('quote matching cannot cut a negation or whitespace out of a complete original paragraph', async t => {
    const f = await fixture(t, {messages: [{...original[0], mes: '  她没有把蓝色手链交给他，仍在自己手里。  \n另一个完整自然段。'}, ...original.slice(1)]});
    for (const text of ['把蓝色手链交给他', '她没有把蓝色手链交给他，仍在自己手里。', '  她没有把蓝色手链交给他，仍在自己手里。']) {
        await assert.rejects(f.save(text), {code: 'yimu_recall_quote'});
    }
    await f.save('  她没有把蓝色手链交给他，仍在自己手里。  ');
    assert.equal((await f.read()).document.entries.at(-1).quoteText, '  她没有把蓝色手链交给他，仍在自己手里。  ');
});

test('duplicate positions are skipped and excluded/deleted excerpts still reserve two-parent quota', async t => {
    const f = await fixture(t), first = await f.save();
    const duplicate = await f.save();
    assert.equal(duplicate.outcome, 'duplicate'); assert.equal(duplicate.document.entries.length, 2);
    const firstId = first.document.entries.at(-1).id;
    await f.change({type: 'entry', entryId: firstId, expectedRevision: 1, action: 'exclude'});
    assert.equal((await f.save()).document.entries.find(entry => entry.id === firstId).status, 'excluded');
    await assert.rejects(f.save('她把蓝色手链收进木盒。\n她还没有告诉他。'), /已有补充|排除/);
    const second = await f.save('她还没有告诉他。');
    const secondEntry = second.document.entries.at(-1);
    await f.change({type: 'entry', entryId: secondEntry.id, expectedRevision: 1, action: 'delete'});
    await assert.rejects(f.save('他说约定仍然没有兑现。', 2), /两条/);
    assert.equal((await f.read()).document.entries.filter(entry => entry.kind === 'excerpt').length, 2);
});

test('epoch, defaults and document revisions fence delayed recall writes, including off then on', async t => {
    const f = await fixture(t), old = await f.operation();
    await f.change({type: 'settings', expectedRevision: 1, values: {recall: false}});
    await assert.rejects(f.store.change(f.request, binding, old), {code: 'yimu_recall_disabled'});
    await f.change({type: 'settings', expectedRevision: 2, values: {recall: true}});
    await assert.rejects(f.store.change(f.request, binding, old), {code: 'yimu_recall_disabled'});
    const global = await f.operation();
    await f.store.defaults(f.request, {id: 'off_global', expectedRevision: 0, values: {recall: false}});
    await assert.rejects(f.store.change(f.request, binding, global), {code: 'yimu_defaults_changed'});
    await f.store.defaults(f.request, {id: 'on_global', expectedRevision: 1, values: {recall: true}});
    const stale = await f.operation();
    await f.change({type: 'append', expectedEpoch: 3, entry: {id: 'other_fine', kind: 'summary', text: '新的有效细摘要', source: f.triggerSource}});
    await assert.rejects(f.store.change(f.request, binding, stale), {code: 'yimu_recall_changed'});
    assert.ok((await f.read()).document.entries.every(entry => entry.kind !== 'excerpt'));
});

test('trigger source and full parent source must still match, not just the quoted floor', async t => {
    const f = await fixture(t), op = await f.operation();
    await f.writeChat(original.map((entry, i) => i === 2 ? {...entry, mes: '触发的新叙事被修改'} : entry));
    await assert.rejects(f.store.change(f.request, binding, op), {code: 'yimu_source_changed'});
    await f.writeChat(original.map((entry, i) => i === 1 ? {...entry, mes: '父来源中未引用的楼层变化'} : entry));
    await assert.rejects(f.store.change(f.request, binding, op), {code: 'yimu_source_changed'});
    await f.writeChat(original); await f.store.change(f.request, binding, op);
    await f.writeChat(original.map((entry, i) => i === 1 ? {...entry, mes: '父来源再次变化'} : entry));
    const read = await f.read(), entry = read.document.entries.at(-1);
    assert.ok(read.invalidSourceIds.includes(entry.id)); assert.equal(entry.quoteText, undefined);
});

test('adding manual authority invalidates stored excerpts in the same transaction without hiding other memory', async t => {
    const f = await fixture(t), saved = await f.save(), excerptId = saved.document.entries.at(-1).id;
    const changed = await f.change({type: 'append', entry: {id: 'manual', kind: 'manual', text: '用户确认的独立背景', source: null,
        placement: {binding, fromFloor: 1, hash: f.hashes[0]}}});
    assert.equal(changed.document.entries.find(entry => entry.id === excerptId).status, 'invalid');
    assert.equal(changed.document.entries.find(entry => entry.id === 'parent').status, 'active');
    await assert.rejects(f.recallSource(), {code: 'yimu_recall_blocked'});
    const retained = (await f.read()).document.entries.find(entry => entry.id === excerptId);
    assert.equal(retained.quoteText, '她把蓝色手链收进木盒。'); assert.equal(retained.status, 'invalid');
});

test('parent redo invalidates its excerpt and never automatically revives the old pointer', async t => {
    const f = await fixture(t), saved = await f.save(), entry = saved.document.entries.at(-1);
    const changed = await f.change({type: 'redo', entryId: 'parent', expectedRevision: 1, expectedEpoch: 1,
        entry: {id: 'parent', kind: 'summary', text: '依据相同原文的新细摘要', source: f.source}});
    assert.equal(changed.document.entries.find(item => item.id === entry.id).status, 'invalid');
    assert.equal(excerptDependenciesValid(entry, changed.document), false);
    const retained = (await f.read()).document.entries.find(item => item.id === entry.id);
    assert.equal(retained.quoteText, '她把蓝色手链收进木盒。'); assert.equal(retained.status, 'invalid');
});

test('deleted source-free manual notes do not permanently disable unrelated recall or revive invalid excerpts', async t => {
    const f = await fixture(t), saved = await f.save(), excerptId = saved.document.entries.at(-1).id;
    await f.change({type: 'append', entry: {id: 'manual', kind: 'manual', text: '后来主动删除的人工背景', source: null,
        placement: {binding, fromFloor: 1, hash: f.hashes[0]}}});
    await assert.rejects(f.recallSource(), {code: 'yimu_recall_blocked'});
    await f.change({type: 'entry', entryId: 'manual', expectedRevision: 1, action: 'delete'});
    assert.ok((await f.recallSource()).messages.length);
    assert.equal((await f.read()).document.entries.find(entry => entry.id === excerptId).status, 'invalid');
    assert.equal((await f.save()).document.entries.find(entry => entry.id === excerptId).status, 'invalid', 'same original pointer is not silently reactivated');
});

test('deleted source-bound manual stages still protect their own parent scope but not an unrelated fine slice', async t => {
    const f = await fixture(t);
    await f.change({type: 'append', expectedEpoch: 1, expectedDefaultsRevision: 0,
        entry: {id: 'stage', kind: 'stage', text: '旧阶段', source: {parents: [{id: 'parent', revision: 1}]}}});
    await f.change({type: 'edit', entryId: 'stage', expectedRevision: 1, text: '用户明确改写的阶段含义'});
    await f.change({type: 'entry', entryId: 'stage', expectedRevision: 2, action: 'delete'});
    await assert.rejects(f.recallSource(), {code: 'yimu_recall_blocked'});
    await f.change({type: 'append', expectedEpoch: 1, entry: {id: 'unrelated', kind: 'summary', text: '另外一段独立经历', source: f.triggerSource}});
    const request = await f.query({parentId: 'unrelated', parentRevision: 1, triggerSource: {start: 4, end: 4, hashes: [f.hashes[3]]}});
    const independent = await f.store.recallSource(f.request, binding, request);
    assert.equal(independent.parent.id, 'unrelated'); assert.deepEqual(independent.messages.map(entry => entry.floor), [3]);
});

test('excluded and deleted excerpts remain inspectable without becoming active or bypassing source validation', async t => {
    const f = await fixture(t), saved = await f.save(), id = saved.document.entries.at(-1).id;
    await f.change({type: 'entry', entryId: id, expectedRevision: 1, action: 'exclude'});
    let entry = (await f.read()).document.entries.find(item => item.id === id);
    assert.equal(entry.status, 'excluded'); assert.equal(entry.quoteText, '她把蓝色手链收进木盒。');
    await f.change({type: 'entry', entryId: id, expectedRevision: 2, action: 'delete'});
    entry = (await f.read()).document.entries.find(item => item.id === id);
    assert.equal(entry.status, 'deleted'); assert.equal(entry.quoteText, '她把蓝色手链收进木盒。');
    await f.writeChat([{...original[0], mes: '原文已改变，不可继续显示旧位置的新字句'}, ...original.slice(1)]);
    entry = (await f.read()).document.entries.find(item => item.id === id);
    assert.equal(entry.status, 'deleted'); assert.equal(entry.quoteText, undefined);
});

test('excerpt edit becomes an ordinary protected manual entry; undo safely restores its pointer only', async t => {
    const f = await fixture(t), saved = await f.save(), entry = saved.document.entries.at(-1);
    const edited = await f.change({type: 'edit', entryId: entry.id, expectedRevision: 1, text: '用户亲自确认的新含义'});
    const manual = edited.document.entries.find(item => item.id === entry.id);
    assert.equal(manual.kind, 'manual'); assert.equal(manual.source, null); assert.equal(manual.history[0].kind, 'excerpt');
    assert.equal(manual.quoteText, undefined);
    await assert.rejects(f.recallSource(), {code: 'yimu_recall_blocked'});
    const undone = await f.change({type: 'entry', entryId: entry.id, expectedRevision: 2, action: 'undoText'});
    assert.equal(undone.document.entries.find(item => item.id === entry.id).kind, 'excerpt');
    assert.equal((await f.read()).document.entries.find(item => item.id === entry.id).quoteText, '她把蓝色手链收进木盒。');
});

test('editing excerpts into manual notes and deleting them cannot free old quote positions or the parent quota', async t => {
    const f = await fixture(t);
    for (const quote of ['她把蓝色手链收进木盒。', '她还没有告诉他。']) {
        const saved = await f.save(quote), entry = saved.document.entries.at(-1);
        await f.change({type: 'edit', entryId: entry.id, expectedRevision: 1, text: `人工说明：${quote}`});
        await f.change({type: 'entry', entryId: entry.id, expectedRevision: 2, action: 'delete'});
    }
    const duplicate = await f.save('她把蓝色手链收进木盒。');
    assert.equal(duplicate.outcome, 'duplicate');
    assert.ok(duplicate.document.entries.slice(1).every(entry => entry.kind === 'manual' && entry.status === 'deleted'));
    await assert.rejects(f.save('他说约定仍然没有兑现。', 2), /两条/);
});

test('recall source rejects recent, oversized and invalid trigger ranges without truncation', async t => {
    const f = await fixture(t);
    await assert.rejects(f.recallSource({triggerSource: f.source}), {code: 'yimu_recall_trigger'});
    await f.store.defaults(f.request, {id: 'larger_recent', expectedRevision: 0, values: {recent: 7}});
    await assert.rejects(f.recallSource(), {code: 'yimu_recall_recent'});
    const oversized = await fixture(t, {messages: [{...original[0], mes: 'x'.repeat(16001)}, ...original.slice(1)]});
    await assert.rejects(oversized.recallSource(), {code: 'yimu_recall_capacity'});
    const many = Array.from({length: 31}, (_, i) => ({name: '角色', mes: `合成层${i}`, send_date: String(i)}));
    const wide = await fixture(t, {messages: many, parentEnd: 25});
    await assert.rejects(wide.recallSource(), {code: 'yimu_recall_capacity'});
});

test('schema 2 upgrade keeps recall false and preserves byte-exact read-only backups before first write', async t => {
    const f = await fixture(t, {seed: false}), folder = path.join(f.account, '.yimu');
    await fs.mkdir(folder);
    const legacy = {...createDocument(binding), schema: 2}, bytes = envelope(legacy), file = path.join(folder, chatStorageName(binding));
    const oldDefaults = envelope({schema: 2, revision: 0, values: {...DEFAULTS, recall: false}, operations: [], receipts: {}});
    await fs.writeFile(file, bytes); await fs.writeFile(path.join(folder, 'defaults.json'), oldDefaults);
    const read = await f.read(); assert.equal(read.document.schema, SCHEMA); assert.equal(read.defaults.values.recall, false);
    assert.deepEqual(await fs.readFile(file), bytes); assert.equal((await fs.readdir(folder)).length, 2);
    await f.change({type: 'append', entry: {id: 'manual', kind: 'manual', text: '迁移后的人工记录', source: null,
        placement: {binding, fromFloor: 1, hash: f.hashes[0]}}});
    assert.deepEqual(await fs.readFile(`${file}.schema2.bak`), bytes);
    assert.equal((await fs.stat(`${file}.schema2.bak`)).mode & 0o200, 0);
    await f.store.defaults(f.request, {id: 'defaults_upgrade', expectedRevision: 0, values: {recent: 8}});
    assert.deepEqual(await fs.readFile(path.join(folder, 'defaults.json.schema2.bak')), oldDefaults);
    assert.equal((await f.read()).defaults.values.recall, false);
});

test('pure contract blocks edited-stage and pending-conflict authority without accepting normal append excerpts', () => {
    let doc = createDocument(binding);
    doc = applyOperation(doc, {id: 'enable', type: 'enable', expectedRevision: 0, enabled: true, range: {start: 1, end: 8, total: 8}}).document;
    doc = applyOperation(doc, {id: 'fine', type: 'append', expectedEpoch: 1, entry: {id: 'fine', kind: 'summary', text: '旧细摘要', source: {start: 1, end: 1, hashes: ['a'.repeat(64)]}}}).document;
    assert.equal(recallBlockReason(doc, {id: 'fine', revision: 1}), '');
    doc.entries[0].conflicts.push({id: 'conflict', text: '待决定'});
    assert.match(recallBlockReason(doc), /冲突/);
    doc.entries[0].conflicts = [];
    doc.entries.push({id: 'stage', kind: 'stage', edited: true, status: 'invalid', source: {parents: [{id: 'fine', revision: 1}]}});
    assert.match(recallBlockReason(doc), /人工/);
});

test('recall-source route enforces ST account identity and returns no private paths', async () => {
    const routes = new Map();
    registerYimuRoutes({get(key, fn) {routes.set(key, fn);}, post(key, fn) {routes.set(key, fn);}}, {store: {recallSource: async () => {throw new Error('C:/private/source.jsonl');}}});
    let status = 200, body;
    const response = {status(code) {status = code; return this;}, json(value) {body = value;}};
    await routes.get('/recall-source')({}, response); assert.equal(status, 403);
    await routes.get('/recall-source')({user: {profile: {handle: 'fixture'}, directories: {}}, body: {binding}}, response);
    assert.equal(status, 500); assert.ok(!JSON.stringify(body).includes('private'));
    await routes.get('/health')({user: {profile: {handle: 'fixture'}, directories: {}}}, response);
    assert.deepEqual(body, {schema: SCHEMA, version: VERSION});
});
