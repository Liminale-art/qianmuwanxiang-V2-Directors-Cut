import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createYimuStore, chatStorageName} from '../yimu/server-store.mjs';
import {registerYimuRoutes} from '../yimu/server-plugin.mjs';
import {fingerprintMessages, createDocument, createDefaults, DEFAULTS, SCHEMA, VERSION, applyOperation, recallBlockReason, excerptDependenciesValid} from '../yimu/contract.mjs';
import {plantExcerpt} from './helpers/yimu-excerpt-fixture.mjs';

// 「原文回查与补充」已去掉（用户 2026-11-24）：服务端不再读出回查原文、也不再新建原文摘录。
// 这里验的是两件事：回查的读写入口一律拒绝（旧资料里存着 recall: true 也一样）；
// 早先已经存下的摘录照旧只存指针、读取时从原文核对后取出，并能屏蔽、删除、改成自定义、随来源变化失效。
const clone = value => structuredClone(value);
const binding = {avatar: 'Recall.png', file: 'Synthetic-recall', integrity: 'recall_identity'};
const original = [
    {name: '角色', is_user: false, mes: '她把蓝色手链收进木盒。\n她还没有告诉他。', send_date: '2026-10-25T10:00:00Z'},
    {name: '用户', is_user: true, mes: '他说约定仍然没有兑现。\n请等到明天。', send_date: '2026-10-25T10:01:00Z'},
    ...Array.from({length: 6}, (_, i) => ({name: '角色', is_user: false, mes: `第${i + 3}层的新事件，不包含旧回查答案。`, send_date: `2026-10-25T10:0${i + 2}:00Z`})),
];
const QUOTE = '她把蓝色手链收进木盒。';
const envelope = value => Buffer.from(JSON.stringify({schema: 1, value, checksum: createHash('sha256').update(JSON.stringify(value)).digest('hex')}));

async function fixture(t, {messages = original, parentEnd = 2, seed = true, legacyRecall = true} = {}) {
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
        // 旧账户里可能还存着「回查开着」：它不再有任何作用（修订号仍是 0）。
        await fs.mkdir(path.join(account, '.yimu'), {recursive: true});
        await fs.writeFile(path.join(account, '.yimu', 'defaults.json'), envelope({...createDefaults(), values: {...createDefaults().values, recall: legacyRecall}}));
        await change({type: 'enable', expectedRevision: 0, enabled: true, range: {start: 1, end: messages.length, total: messages.length}});
        await change({type: 'append', expectedEpoch: 1, entry: {id: 'parent', kind: 'summary', text: '保留了手链与未完成约定的经历。', source}});
    }
    const query = async extra => {
        const current = await read();
        return {parentId: 'parent', parentRevision: current.document.entries.find(entry => entry.id === 'parent')?.revision || 1,
            expectedEpoch: current.document.epoch, expectedDefaultsRevision: current.defaults.revision, triggerSource, ...extra};
    };
    const recallSource = async extra => store.recallSource(request, binding, await query(extra));
    // 早先存下的一条摘录：直接写进资料（见 helpers/yimu-excerpt-fixture.mjs）。
    const plant = (text = QUOTE, floor = 1, entryId = `excerpt_${++serial}`) => plantExcerpt({account, binding, messages, parentId: 'parent', floor, text, entryId, triggerSource});
    t.after(async () => {
        const real = await fs.realpath(root); assert.equal(path.dirname(real), base); assert.match(path.basename(real), /^yimu-recall-server-/);
        await fs.rm(real, {recursive: true, force: true});
    });
    return {root, account, chats, request, chatFile, store, hashes, source, triggerSource, read, change, query, recallSource, plant, writeChat};
}

test('recall-source and recall writes are refused even with an old recall-on value, and nothing is read or written', async t => {
    const f = await fixture(t), file = path.join(f.account, '.yimu', chatStorageName(binding));
    await f.change({type: 'settings', expectedRevision: 1, values: {recall: true}}); // 旧资料里聊天也开着
    const before = await fs.readFile(file), listing = await fs.readdir(path.dirname(file));
    let scans = 0;
    const counted = createYimuStore({hostCwd: f.root, io: {...fs, async open(target, ...args) {if (target === f.chatFile) scans++; return fs.open(target, ...args);}}});
    await assert.rejects(counted.recallSource(f.request, binding, await f.query()), {code: 'yimu_recall_disabled'});
    const current = await f.read();
    const write = {id: 'late_recall', type: 'recall', entryId: 'late_excerpt', expectedRevision: current.document.revision, expectedEpoch: current.document.epoch,
        expectedDefaultsRevision: current.defaults.revision, parent: {id: 'parent', revision: 1}, triggerSource: f.triggerSource, quote: {floor: 1, text: QUOTE}};
    await assert.rejects(counted.change(f.request, binding, write), {code: 'yimu_recall_disabled'});
    assert.equal(scans, 0, 'no original is read for a removed feature');
    assert.deepEqual(await fs.readFile(file), before); assert.deepEqual(await fs.readdir(path.dirname(file)), listing);
});

test('a stored excerpt keeps only its pointer and read materializes a uniquely verified quote with speaker', async t => {
    const f = await fixture(t), entry = await f.plant();
    assert.equal(entry.kind, 'excerpt'); assert.equal(entry.text, '原文补充'); assert.equal(entry.quoteText, undefined);
    assert.deepEqual(entry.source, {start: 1, end: 1, hashes: [f.hashes[0]]});
    assert.deepEqual(entry.quote, {start: 0, end: QUOTE.length});
    const stored = await fs.readFile(path.join(f.account, '.yimu', chatStorageName(binding)), 'utf8');
    assert.ok(!stored.includes('她把蓝色手链')); assert.ok(!stored.includes('她还没有告诉他')); assert.ok(!stored.includes('quoteText'));
    let scans = 0;
    const fresh = createYimuStore({hostCwd: f.root, io: {...fs, async open(target, ...args) {if (target === f.chatFile) scans++; return fs.open(target, ...args);}}});
    const read = await fresh.read(f.request, binding);
    assert.equal(scans, 1); assert.equal(read.document.entries.at(-1).quoteText, QUOTE);
    assert.equal(read.document.entries.at(-1).quoteSpeaker, '角色'); assert.deepEqual(read.invalidSourceIds, []);
});

test('a stored quote range that no longer covers a complete paragraph is not materialized', async t => {
    const messages = [{...original[0], mes: '  她没有把蓝色手链交给他，仍在自己手里。  \n另一个完整自然段。'}, ...original.slice(1)];
    const f = await fixture(t, {messages});
    const whole = await f.plant('  她没有把蓝色手链交给他，仍在自己手里。  ');
    assert.equal((await f.read()).document.entries.find(entry => entry.id === whole.id).quoteText, '  她没有把蓝色手链交给他，仍在自己手里。  ');
    const g = await fixture(t, {messages}), cut = await g.plant('把蓝色手链交给他', 1, 'excerpt_cut');
    const read = await g.read(), item = read.document.entries.find(entry => entry.id === cut.id);
    assert.equal(item.quoteText, undefined, 'a fragment cut out of a paragraph (dropping a negation) is never shown as the original');
    assert.ok(read.invalidSourceIds.includes(cut.id));
});

test('ordinary append cannot forge an excerpt', async t => {
    const f = await fixture(t);
    const forged = {id: 'fake', kind: 'excerpt', text: '原文补充', parent: {id: 'parent', revision: 1}, source: {start: 1, end: 1, hashes: [f.hashes[0]]}, quote: {start: 0, end: 2}};
    await assert.rejects(f.change({type: 'append', expectedEpoch: 1, entry: forged}), /类型/);
    assert.equal((await f.read()).document.entries.length, 1);
});

test('a stored excerpt is invalidated and not materialized once its parent source changes', async t => {
    const f = await fixture(t), entry = await f.plant();
    assert.equal((await f.read()).document.entries.at(-1).quoteText, QUOTE);
    await f.writeChat(original.map((item, i) => i === 1 ? {...item, mes: '父来源中未引用的楼层变化'} : item));
    const read = await f.read(), stored = read.document.entries.find(item => item.id === entry.id);
    assert.ok(read.invalidSourceIds.includes(entry.id)); assert.equal(stored.quoteText, undefined);
});

test('adding manual authority invalidates stored excerpts in the same transaction without hiding other memory', async t => {
    const f = await fixture(t), excerptId = (await f.plant()).id;
    const changed = await f.change({type: 'append', entry: {id: 'manual', kind: 'manual', text: '用户确认的独立背景', source: null,
        placement: {binding, fromFloor: 1, hash: f.hashes[0]}}});
    assert.equal(changed.document.entries.find(entry => entry.id === excerptId).status, 'invalid');
    assert.equal(changed.document.entries.find(entry => entry.id === 'parent').status, 'active');
    const retained = (await f.read()).document.entries.find(entry => entry.id === excerptId);
    assert.equal(retained.quoteText, QUOTE); assert.equal(retained.status, 'invalid');
});

test('parent redo invalidates its excerpt and never automatically revives the old pointer', async t => {
    const f = await fixture(t), entry = await f.plant();
    const changed = await f.change({type: 'redo', entryId: 'parent', expectedRevision: 1, expectedEpoch: 1,
        entry: {id: 'parent', kind: 'summary', text: '依据相同原文的新细摘要', source: f.source}});
    assert.equal(changed.document.entries.find(item => item.id === entry.id).status, 'invalid');
    assert.equal(excerptDependenciesValid(entry, changed.document), false);
    const retained = (await f.read()).document.entries.find(item => item.id === entry.id);
    assert.equal(retained.quoteText, QUOTE); assert.equal(retained.status, 'invalid');
});

test('deleting a source-free manual note does not revive an excerpt it invalidated', async t => {
    const f = await fixture(t), excerptId = (await f.plant()).id;
    await f.change({type: 'append', entry: {id: 'manual', kind: 'manual', text: '后来主动删除的人工背景', source: null,
        placement: {binding, fromFloor: 1, hash: f.hashes[0]}}});
    await f.change({type: 'entry', entryId: 'manual', expectedRevision: 1, action: 'delete'});
    const read = await f.read();
    assert.equal(recallBlockReason(read.document), '', 'the deleted note no longer blocks the chat');
    assert.equal(read.document.entries.find(entry => entry.id === excerptId).status, 'invalid', 'the old pointer is not silently reactivated');
});

test('deleted source-bound manual stages still protect their own parent scope but not an unrelated fine slice', async t => {
    const f = await fixture(t);
    await f.change({type: 'append', expectedEpoch: 1, expectedDefaultsRevision: 0,
        entry: {id: 'stage', kind: 'stage', text: '旧阶段', source: {parents: [{id: 'parent', revision: 1}]}}});
    await f.change({type: 'edit', entryId: 'stage', expectedRevision: 1, text: '用户明确改写的阶段含义'});
    await f.change({type: 'entry', entryId: 'stage', expectedRevision: 2, action: 'delete'});
    await f.change({type: 'append', expectedEpoch: 1, entry: {id: 'unrelated', kind: 'summary', text: '另外一段独立经历', source: f.triggerSource}});
    const {document} = await f.read();
    // 这条规则同时决定已存摘录是否仍然有效（excerptDependenciesValid）。
    assert.match(recallBlockReason(document, {id: 'parent', revision: 1}), /删除|暂不使用/);
    assert.equal(recallBlockReason(document, {id: 'unrelated', revision: 1}), '');
});

test('excluded and deleted excerpts remain inspectable without becoming active or bypassing source validation', async t => {
    const f = await fixture(t), id = (await f.plant()).id;
    await f.change({type: 'entry', entryId: id, expectedRevision: 1, action: 'exclude'});
    let entry = (await f.read()).document.entries.find(item => item.id === id);
    assert.equal(entry.status, 'excluded'); assert.equal(entry.quoteText, QUOTE);
    await f.change({type: 'entry', entryId: id, expectedRevision: 2, action: 'delete'});
    entry = (await f.read()).document.entries.find(item => item.id === id);
    assert.equal(entry.status, 'deleted'); assert.equal(entry.quoteText, QUOTE);
    await f.writeChat([{...original[0], mes: '原文已改变，不可继续显示旧位置的新字句'}, ...original.slice(1)]);
    entry = (await f.read()).document.entries.find(item => item.id === id);
    assert.equal(entry.status, 'deleted'); assert.equal(entry.quoteText, undefined);
});

test('excerpt edit becomes an ordinary protected manual entry; undo safely restores its pointer only', async t => {
    const f = await fixture(t), entry = await f.plant();
    const edited = await f.change({type: 'edit', entryId: entry.id, expectedRevision: 1, text: '用户亲自确认的新含义'});
    const manual = edited.document.entries.find(item => item.id === entry.id);
    assert.equal(manual.kind, 'manual'); assert.equal(manual.source, null); assert.equal(manual.history[0].kind, 'excerpt');
    assert.equal(manual.quoteText, undefined);
    const undone = await f.change({type: 'entry', entryId: entry.id, expectedRevision: 2, action: 'undoText'});
    assert.equal(undone.document.entries.find(item => item.id === entry.id).kind, 'excerpt');
    assert.equal((await f.read()).document.entries.find(item => item.id === entry.id).quoteText, QUOTE);
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
