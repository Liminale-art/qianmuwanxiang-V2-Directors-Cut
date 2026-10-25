import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createYimuStore} from '../yimu/server-store.mjs';
import {createController} from '../yimu/runtime.mjs';
import {fingerprintMessages, sourceRanges} from '../yimu/contract.mjs';
import {buildPlan} from '../yimu/core.mjs';
import {stageWeight} from '../yimu/layers.mjs';

const clone = value => structuredClone(value);
const deferred = () => {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return {promise, resolve};
};

async function fixture(t, {floors = 11, fine = 6} = {}) {
    const parent = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(parent, 'yimu-layers-runtime-'));
    const account = path.join(root, 'account'), chats = path.join(account, 'chats');
    const binding = {avatar: 'Layer.png', file: 'Synthetic-layer', integrity: 'synthetic_layer_identity'};
    const messages = Array.from({length: floors}, (_, index) => ({name: index % 2 ? '角色' : '用户', is_user: !(index % 2),
        mes: `第${index + 1}层的原文，经历发生在此，不把未来计划写成事实。`, send_date: `2026-10-25T10:${String(index).padStart(2, '0')}:00Z`}));
    await fs.mkdir(path.join(chats, 'Layer'), {recursive: true});
    const rawPath = path.join(chats, 'Layer', `${binding.file}.jsonl`);
    const writeChat = items => fs.writeFile(rawPath, [{chat_metadata: {integrity: binding.integrity}}, ...items].map(JSON.stringify).join('\n'), 'utf8');
    await writeChat(messages);
    const request = {user: {profile: {handle: 'fixture'}, directories: {root: account, chats}}};
    const store = createYimuStore({hostCwd: root});
    const api = {health: async () => ({}), read: key => store.read(request, key), change: (key, op) => store.change(request, key, op),
        defaults: op => store.defaults(request, op), rename: (old, next) => store.rename(request, old, next)};
    let document = (await api.change(binding, {id: 'seed_enable', type: 'enable', expectedRevision: 0, enabled: true,
        range: {start: 1, end: floors, total: floors}})).document;
    const hashes = await fingerprintMessages(messages);
    for (let floor = 1; floor <= fine; floor++) {
        document = (await api.change(binding, {id: `seed_${floor}`, type: 'append', expectedEpoch: document.epoch,
            entry: {id: `fine_${floor}`, kind: 'summary', text: `第${floor}片已确认的经历与关系变化，秘密只属于已知情者。`,
                source: {start: floor, end: floor, hashes: [hashes[floor - 1]]}}})).document;
    }
    const snapshot = {binding, messages, maxContext: 65536, name: 'Layer'};
    const tasks = [], generated = [];
    let model = async () => JSON.stringify({text: '持续形成的阶段经历；只保留已有依据，不虚构秘密知情。'});
    const host = {snapshot: async () => clone(snapshot), profiles: () => [], clear() {},
        async generate(prompt, options) { generated.push(prompt); return model(prompt, options); }};
    let sequence = 0;
    const controller = createController({host, api, defer: fn => tasks.push(fn), id: () => `runtime_${++sequence}`});
    const read = () => api.read(binding);
    const defaults = async values => {
        const prior = (await read()).defaults;
        await api.defaults({id: `defaults_${++sequence}`, expectedRevision: prior.revision, values});
        await controller.refresh();
    };
    const remoteEdit = async (entryId, text) => {
        const entry = (await read()).document.entries.find(item => item.id === entryId);
        return api.change(binding, {id: `remote_edit_${++sequence}`, type: 'edit', entryId, expectedRevision: entry.revision, text});
    };
    const flush = async () => { while (tasks.length) await tasks.shift()(); };
    t.after(async () => {
        controller.destroy();
        const real = await fs.realpath(root);
        assert.equal(path.dirname(real), parent); assert.match(path.basename(real), /^yimu-layers-runtime-/);
        await fs.rm(real, {recursive: true});
    });
    await controller.refresh();
    return {api, controller, snapshot, generated, read, defaults, remoteEdit, flush, writeChat, model: fn => { model = fn; }};
}

for (const basis of ['tokens', 'floors', 'slices']) {
    test(`automatic stage uses only the ${basis} threshold and does not regenerate covered fine slices`, async t => {
        const f = await fixture(t);
        const fine = (await f.read()).document.entries;
        const threshold = stageWeight(fine, basis);
        await f.defaults({stageAuto: true, stageBasis: basis, stageThreshold: threshold + 1});
        await f.controller.startStage();
        assert.equal(f.generated.length, 0);
        await f.defaults({stageThreshold: threshold});
        await f.controller.startStage();
        const saved = (await f.read()).document;
        assert.equal(f.generated.length, 1);
        assert.equal(saved.entries.filter(entry => entry.kind === 'summary').length, 6);
        assert.deepEqual(sourceRanges(saved.entries.at(-1)).map(range => [range.start, range.end]), [[1, 6]]);
        await f.controller.startStage();
        assert.equal(f.generated.length, 1, 'automatic follow-up does not summarize the same complete stage again');
    });
}

test('stage stays off by default; manual ranges split at edited fine slices and preserve them exactly', async t => {
    const f = await fixture(t);
    await f.controller.startStage();
    assert.equal(f.generated.length, 0);
    const protectedText = '这段人工修订必须原样保留，不参与阶段压缩。';
    await f.remoteEdit('fine_3', protectedText);
    await f.controller.refresh();
    await f.controller.action('stage', {start: 1, end: 6}); await f.flush();
    const saved = (await f.read()).document;
    const stages = saved.entries.filter(entry => entry.kind === 'stage');
    assert.equal(stages.length, 2);
    assert.deepEqual(stages.flatMap(sourceRanges).map(range => [range.start, range.end]), [[1, 2], [4, 6]]);
    assert.ok(f.generated.every(prompt => !prompt.includes(protectedText)));
    assert.equal(saved.entries.find(entry => entry.id === 'fine_3').text, protectedText);
    assert.ok(stages.every(stage => !stage.source.parents.some(parent => parent.id === 'fine_3')));
});

test('all edited fine slices have no stage job and do not invoke a model', async t => {
    const f = await fixture(t, {fine: 3, floors: 8});
    for (const floor of [1, 2, 3]) await f.remoteEdit(`fine_${floor}`, `人工第${floor}片，不得被二次总结`);
    await f.controller.refresh();
    await f.controller.action('stage', {start: 1, end: 3}); await f.flush();
    assert.equal(f.generated.length, 0);
    assert.match(f.controller.state.status, /没有可合并|人工/);
});

test('manual stage never crosses the recent-raw boundary, even if a preexisting fine slice does', async t => {
    const f = await fixture(t, {fine: 7, floors: 11});
    await f.controller.action('stage', {start: 5, end: 7}); await f.flush();
    const stage = (await f.read()).document.entries.find(entry => entry.kind === 'stage');
    assert.deepEqual(sourceRanges(stage).map(range => [range.start, range.end]), [[5, 6]]);
    assert.ok(!stage.source.parents.some(parent => parent.id === 'fine_7'));
});

test('a remote parent edit during stage generation rejects the late candidate and preserves the revision', async t => {
    const f = await fixture(t);
    const started = deferred(), answer = deferred();
    f.model(() => { started.resolve(); return answer.promise; });
    const job = f.controller.startStage({force: true, start: 1, end: 3});
    await started.promise;
    await f.remoteEdit('fine_2', '另一设备在模型期间确认的新内容');
    answer.resolve(JSON.stringify({text: '不应采用的旧父条目阶段'})); await job;
    const saved = (await f.read()).document;
    assert.equal(saved.entries.filter(entry => entry.kind === 'stage').length, 0);
    assert.equal(saved.entries.find(entry => entry.id === 'fine_2').text, '另一设备在模型期间确认的新内容');
    assert.match(f.controller.state.error, /修改|停用|失效|父/);
});

test('edited stage redo stores a candidate without replacing the manual stage or its fine parents', async t => {
    const f = await fixture(t);
    await f.controller.startStage({force: true, start: 1, end: 3});
    let stage = (await f.read()).document.entries.find(entry => entry.kind === 'stage');
    await f.controller.action('edit', {entryId: stage.id, text: '人工阶段只记录已经作出的承诺。'});
    f.model(async () => JSON.stringify({text: '新的阶段候选，必须由用户选择。'}));
    await f.controller.action('redo', {entryId: stage.id}); await f.flush();
    const saved = (await f.read()).document;
    stage = saved.entries.find(entry => entry.id === stage.id);
    assert.equal(stage.text, '人工阶段只记录已经作出的承诺。');
    assert.equal(stage.candidate.text, '新的阶段候选，必须由用户选择。');
    assert.ok(saved.entries.filter(entry => entry.kind === 'summary').every(entry => entry.revision === 1));
});

test('parent changes invalidate the old stage in its transaction and do not revive it on refresh', async t => {
    const f = await fixture(t);
    await f.controller.startStage({force: true, start: 1, end: 3});
    const stage = (await f.read()).document.entries.find(entry => entry.kind === 'stage');
    const changed = await f.remoteEdit('fine_2', '手动修订后的第二片');
    assert.equal(changed.document.entries.find(entry => entry.id === stage.id).status, 'invalid');
    await f.controller.refresh();
    const saved = (await f.read()).document;
    assert.equal(saved.entries.find(entry => entry.id === stage.id).status, 'invalid');
    const plan = await buildPlan(saved, f.controller.state.defaults, f.snapshot);
    assert.ok(!plan.entries.some(entry => entry.id === stage.id));
    assert.ok(plan.entries.some(entry => entry.id === 'fine_2'), 'manual fine remains a complete independent memory candidate');
});

test('disabling during stage generation discards late output without changing fine memories', async t => {
    const f = await fixture(t);
    const started = deferred(), answer = deferred();
    f.model(() => { started.resolve(); return answer.promise; });
    const job = f.controller.startStage({force: true}); await started.promise;
    await f.controller.action('enable', {enabled: false});
    answer.resolve(JSON.stringify({text: '关闭后迟到的内容不允许入库'})); await job;
    const saved = (await f.read()).document;
    assert.equal(saved.enabled, false);
    assert.equal(saved.entries.length, 6);
    assert.ok(saved.entries.every(entry => entry.kind === 'summary' && entry.revision === 1));
});

test('stage selection uses either the stage or its fine details, never both, and respects manual stage meaning', async t => {
    const f = await fixture(t);
    await f.controller.startStage({force: true, start: 1, end: 6});
    let saved = await f.read(), stage = saved.document.entries.find(entry => entry.kind === 'stage');
    let plan = await buildPlan(saved.document, saved.defaults, f.snapshot);
    assert.deepEqual(plan.entries.map(entry => entry.id), [stage.id]);
    await f.controller.action('edit', {entryId: stage.id, text: '人工阶段明确保留的解释，不能回退细摘要绕过。'});
    saved = await f.read();
    f.snapshot.messages[10].mes = '第1片已确认的经历与关系变化，秘密只属于已知情者。';
    plan = await buildPlan(saved.document, saved.defaults, f.snapshot);
    assert.deepEqual(plan.entries.map(entry => entry.id), [stage.id]);
    await f.remoteEdit('fine_1', '父细摘要变化使人工阶段失效');
    saved = await f.read();
    plan = await buildPlan(saved.document, saved.defaults, f.snapshot);
    assert.equal(plan.entries.length, 0, 'invalid manually revised stage is not bypassed through its fine parents');
});

test('on-demand recall reads existing fine detail while disabling recall keeps the stage reading layer', async t => {
    const f = await fixture(t);
    let saved = await f.read();
    const fine = saved.document.entries.find(entry => entry.id === 'fine_1');
    await f.api.change(f.snapshot.binding, {id: 'detail_redo', type: 'redo', entryId: fine.id, expectedRevision: fine.revision,
        expectedEpoch: saved.document.epoch, entry: {...fine, text: '她把蓝色手链交给了他，约定归还时再见。'}});
    await f.controller.refresh();
    f.model(async () => JSON.stringify({text: '彼此建立了信任，并约定未来再次相见。'}));
    await f.controller.startStage({force: true});
    saved = await f.read();
    for (let index = 6; index < 10; index++) f.snapshot.messages[index].mes = '窗外阳光明亮。';
    f.snapshot.messages[10].mes = '那条蓝色手链究竟去了哪里？';
    let plan = await buildPlan(saved.document, saved.defaults, f.snapshot);
    assert.ok(plan.entries.some(entry => entry.id === fine.id));
    assert.ok(plan.entries.every(entry => entry.kind !== 'stage'));
    const noRecall = clone(saved.defaults); noRecall.values.recall = false;
    plan = await buildPlan(saved.document, noRecall, f.snapshot);
    assert.deepEqual(plan.entries.map(entry => entry.kind), ['stage']);
    assert.equal(f.generated.length, 1, 'recall uses saved entries and does not generate new facts');
});

test('different manual stage ranges never cause overlapping stage memories in the same prompt', async t => {
    const f = await fixture(t);
    await f.controller.startStage({force: true, start: 1, end: 2});
    await f.controller.startStage({force: true, start: 1, end: 3});
    const saved = await f.read();
    const plan = await buildPlan(saved.document, saved.defaults, f.snapshot);
    const usedFloors = new Set();
    for (const range of plan.entries.flatMap(sourceRanges)) for (let floor = range.start; floor <= range.end; floor++) {
        assert.ok(!usedFloors.has(floor), `floor ${floor} must not be repeated by overlapping stages`);
        usedFloors.add(floor);
    }
});
