import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createDefaults, DEFAULTS, fingerprintMessages, applyOperation} from '../yimu/contract.mjs';
import {buildPlan, inspectSources, nextBatch} from '../yimu/core.mjs';
import {captureCore, buildBudgetedMessages} from '../yimu/budget.mjs';
import {stageGroups} from '../yimu/layers.mjs';
import {recallCandidates} from '../yimu/recall.mjs';
import {createController} from '../yimu/runtime.mjs';

const binding = {avatar: 'Fixture.png', file: 'branch', integrity: 'branch-id'};
const ancestor = {...binding, file: 'original', integrity: 'original-id'};
const original = Array.from({length: 15}, (_, i) => ({name: '角色', is_user: false, mes: `合成剧情${i + 1}，第一次约会。`, send_date: String(i)}));
async function fixture(count = 10) {
    const originalHashes = await fingerprintMessages(original), messages = structuredClone(original.slice(5, 5 + count));
    const document = createDocument(binding); document.enabled = true; document.epoch = 1;
    document.initialRange = {start: 1, end: 5, total: 5};
    document.lineage = {sourceBinding: ancestor, cutoff: 10, offset: 5, bridgeCount: 5, bridgeHashes: originalHashes.slice(5, 10)};
    const entry = (id, start, end) => ({id, kind: 'summary', text: `已确认的合成记忆${id}`, source: {start, end, hashes: originalHashes.slice(start - 1, end)},
        origin: {binding: ancestor, offset: 0}, originVerified: true, revision: 1, status: 'active', edited: false, history: [], conflicts: [], candidate: null});
    document.entries = [entry('old', 1, 5), entry('bridge', 6, 10)];
    return {document, defaults: createDefaults(), snapshot: {binding, messages}, entry};
}

test('inherited sources use ancestor coordinates and recent bridge stays raw', async () => {
    const f = await fixture(5), plan = await buildPlan(f.document, f.defaults, f.snapshot);
    assert.deepEqual(plan.memoryIds, ['old']);
    assert.deepEqual(plan.coveredRanges, []);
    assert.match(plan.prompt, /继承来源 original/);
    assert.deepEqual((await inspectSources(f.document, f.snapshot.messages)).invalid, []);
    assert.equal(nextBatch(f.document, f.snapshot.messages, DEFAULTS, {force: true}), null);
});

test('foreign memory never deletes local raw even when floor numbers and content collide', async () => {
    const f = await fixture(), plan = await buildPlan(f.document, f.defaults, f.snapshot);
    const core = structuredClone(f.snapshot.messages).map((message, index) => ({...message, index}));
    const {processed} = captureCore(core, f.snapshot);
    const payload = {messages: [{role: 'system', content: '固定设定'}, ...processed.map(item => item.request)]};
    const result = await buildBudgetedMessages(payload, {entries: plan.entries, processed, sourceHashes: await fingerprintMessages(f.snapshot.messages),
        recent: 5, budget: 10000, contextTokens: 30000, responseTokens: 1000});
    assert.equal(result.applied, true); assert.deepEqual(result.removedFloors, []);
    assert.deepEqual(result.messages.filter(item => item.role === 'assistant'), payload.messages.filter(item => item.role === 'assistant'));
});

test('editing the local bridge invalidates only overlapping inherited memories', async () => {
    const f = await fixture(); f.snapshot.messages[0].mes = '分支内改写，祖先文件没有变';
    assert.deepEqual((await inspectSources(f.document, f.snapshot.messages)).invalid, [{id: 'bridge', revision: 1}]);
    const plan = await buildPlan(f.document, f.defaults, f.snapshot);
    assert.deepEqual(plan.memoryIds, ['old']);
});

test('unverified ancestor proof is never accepted and inherited floors do not block new batches', async () => {
    const f = await fixture(); f.document.entries.forEach(entry => delete entry.originVerified);
    assert.equal((await buildPlan(f.document, f.defaults, f.snapshot)).entries.length, 0);
    f.snapshot.messages.push(...structuredClone(original.slice(0, 5)));
    assert.deepEqual(nextBatch(f.document, f.snapshot.messages, DEFAULTS, {force: true}), {start: 6, end: 10});
    assert.deepEqual(stageGroups(f.document), []);
    assert.deepEqual(recallCandidates(f.document, DEFAULTS, f.snapshot.messages, {start: 6, end: 10}, await fingerprintMessages(f.snapshot.messages)), []);
});

test('new local summaries can share floor numbers with independent inherited summaries', async () => {
    const f = await fixture();
    const document = applyOperation(f.document, {id: 'append-local', type: 'append', expectedEpoch: 1,
        entry: {id: 'local', kind: 'summary', text: '本地新剧情', source: {start: 6, end: 7, hashes: (await fingerprintMessages(f.snapshot.messages)).slice(5, 7)}}}).document;
    assert.equal(document.entries.length, 3);
    assert.throws(() => applyOperation(document, {id: 'redo-foreign', type: 'redo', expectedEpoch: 1, entryId: 'old', expectedRevision: 1,
        entry: {...f.document.entries[0], text: '错误套用本地楼层'}}), /继承|来源|跨/);
});

test('ancestor edits after interception retain the raw chat while stale memory remains available', async () => {
    const f = await fixture(), state = {invalid: false, applied: 0};
    const host = {snapshot: async () => structuredClone(f.snapshot), profiles: () => [], clear() {},
        prepare: () => ({prepared: true, session: {}}), applyPrepared: async () => {state.applied++; return {applied: false};}};
    const api = {health: async () => ({}), read: async () => ({document: structuredClone(f.document), defaults: f.defaults, sourceAvailable: true,
        invalidSourceIds: state.invalid ? ['old'] : []})};
    const controller = createController({host, api, defer: () => {}});
    await controller.refresh(); await controller.event('GENERATION_STARTED', ['normal', {}, false]);
    await controller.intercept([], 10000, () => {});
    state.invalid = true;
    await controller.event('CHAT_COMPLETION_SETTINGS_READY', [{messages: [{role: 'user', content: '原文'}]}]);
    assert.equal(state.applied, 1); controller.destroy();
});

test('server-invalid human stage remains injectable without exposing its automatic children', async () => {
    const f = await fixture(), stage = {...structuredClone(f.document.entries[0]), id: 'stage', kind: 'stage', edited: true,
        text: '用户明确修订的含义', source: {ranges: [{start: 1, end: 10, hashes: f.document.entries.flatMap(entry => entry.source.hashes)}],
            parents: f.document.entries.map(entry => ({id: entry.id, revision: entry.revision}))}};
    f.document.entries.push(stage);
    let selected;
    const host = {snapshot: async () => structuredClone(f.snapshot), profiles: () => [], clear() {}, prepare: (_core, plan) => {selected = plan.entries; return {prepared: false};}};
    const api = {health: async () => ({}), read: async () => ({document: structuredClone(f.document), defaults: f.defaults, sourceAvailable: true, invalidSourceIds: ['stage']})};
    const controller = createController({host, api, defer: () => {}});
    await controller.refresh();
    await controller.intercept([], 10000, () => {});
    assert.deepEqual(selected.map(entry => entry.id), ['stage']);
    controller.destroy();
});
