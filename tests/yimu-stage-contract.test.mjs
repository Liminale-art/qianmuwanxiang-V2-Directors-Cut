import test from 'node:test';
import assert from 'node:assert/strict';
import {SCHEMA, VERSION, createDocument, createDefaults, validateDocument, validateDefaults, applyOperation, applyDefaultsOperation,
    sourceRanges, stageDependenciesValid, stageSourceFromParents} from '../yimu/contract.mjs';

const binding = {avatar: 'Stage.png', file: 'Fixture', integrity: 'stage_identity'};
const source = floor => ({start: floor, end: floor, hashes: [String(floor).repeat(64)]});
const change = (doc, operation) => applyOperation(doc, operation).document;
function fineDocument() {
    let document = change(createDocument(binding), {id: 'enable', type: 'enable', expectedRevision: 0, enabled: true, range: {start: 1, end: 8, total: 8}});
    for (let floor = 1; floor <= 3; floor++) document = change(document, {id: `fine_${floor}`, type: 'append', expectedEpoch: 1,
        entry: {id: `fine_${floor}`, kind: 'summary', text: `第${floor}片已核对的经历`, source: source(floor)}});
    return document;
}
const refs = document => document.entries.filter(entry => entry.kind === 'summary').slice(0, 2).map(entry => ({id: entry.id, revision: entry.revision}));
const stageOperation = document => ({id: 'stage_append', type: 'append', expectedEpoch: document.epoch,
    entry: {id: 'stage_1', kind: 'stage', text: '按连续经历形成的精简阶段。', source: {parents: refs(document)}}});
const withStage = () => {const doc = fineDocument(); return change(doc, stageOperation(doc));};

test('current schema upgrades legacy data only in memory and preserves original legacy objects', () => {
    assert.equal(SCHEMA, 4); assert.equal(VERSION, '0.4.0');
    const legacy = {...fineDocument(), schema: 1}, before = structuredClone(legacy);
    const upgraded = validateDocument(legacy);
    assert.equal(upgraded.schema, SCHEMA); assert.deepEqual(upgraded.entries, legacy.entries); assert.deepEqual(legacy, before);
    const old = {schema: 1, revision: 3, operations: [], receipts: {}, values: {recent: 9, trigger: 5000, batch: 6000, budget: 0, preference: '旧偏好', profileId: '', model: ''}};
    const defaults = validateDefaults(old);
    assert.equal(defaults.schema, SCHEMA); assert.equal(defaults.values.recent, 9); assert.equal(defaults.values.stageAuto, false);
    assert.equal(old.schema, 1); assert.equal(old.values.stageAuto, undefined);
});

test('stage coverage derives from current fine revisions, never submitted coverage claims', () => {
    const doc = fineDocument(), op = stageOperation(doc);
    op.entry.source.ranges = [{start: 1, end: 999, hashes: []}];
    const saved = change(doc, op), stage = saved.entries.at(-1);
    assert.deepEqual(stage.source, {parents: refs(doc), ranges: [{start: 1, end: 2, hashes: [source(1).hashes[0], source(2).hashes[0]]}]});
    assert.equal(stageDependenciesValid(stage, saved), true);
    assert.deepEqual(sourceRanges(stage), stage.source.ranges);
    assert.deepEqual(sourceRanges(saved.entries[0]), [source(1)]);
    assert.deepEqual(sourceRanges({kind: 'manual', source: null}), []);
    assert.equal(saved.entries.length, 4);
});

test('edited, stale, disabled, missing, nested and gapped parents cannot be compressed', () => {
    const base = fineDocument();
    const edited = change(base, {id: 'edit', type: 'edit', entryId: 'fine_1', expectedRevision: 1, text: '用户手动确定的含义'});
    assert.throws(() => change(edited, stageOperation(edited)), /修改|停用|失效/);
    for (const parents of [[{id: 'fine_1', revision: 9}], [{id: 'missing', revision: 1}], [{id: 'stage_1', revision: 1}]]) {
        assert.throws(() => stageSourceFromParents(withStage(), parents), /修改|停用|失效/);
    }
    assert.throws(() => stageSourceFromParents(base, [{id: 'fine_1', revision: 1}, {id: 'fine_3', revision: 1}]), /连续/);
    assert.throws(() => stageSourceFromParents(base, [{id: 'fine_2', revision: 1}, {id: 'fine_1', revision: 1}]), /连续/);
    for (const action of ['exclude', 'delete']) {
        const doc = change(base, {id: action, type: 'entry', action, entryId: 'fine_1', expectedRevision: 1});
        assert.throws(() => stageSourceFromParents(doc, refs(doc)), /修改|停用|失效/);
    }
});

test('parent edits and invalidations disable stages in the same operation without erasing them', () => {
    for (const operation of [
        {id: 'edit', type: 'edit', entryId: 'fine_1', expectedRevision: 1, text: '人工修订不得被旧阶段盖回'},
        {id: 'exclude', type: 'entry', entryId: 'fine_1', expectedRevision: 1, action: 'exclude'},
        {id: 'delete', type: 'entry', entryId: 'fine_1', expectedRevision: 1, action: 'delete'},
        {id: 'invalid', type: 'invalidate', entries: [{id: 'fine_1', revision: 1}]},
    ]) {
        const before = withStage(), doc = change(before, operation), stage = doc.entries.find(entry => entry.kind === 'stage');
        assert.equal(stage.status, 'invalid'); assert.equal(stage.revision, 2);
        assert.equal(stage.text, before.entries.at(-1).text); assert.equal(stage.history[0].status, 'active');
        assert.equal(doc.entries.find(entry => entry.id === 'fine_3').status, 'active');
    }
});

test('undoing a parent change never resurrects its stale stage', () => {
    let doc = withStage();
    doc = change(doc, {id: 'edit', type: 'edit', entryId: 'fine_1', expectedRevision: 1, text: '临时修订'});
    doc = change(doc, {id: 'undo', type: 'entry', entryId: 'fine_1', expectedRevision: 2, action: 'undo'});
    assert.equal(doc.entries.find(entry => entry.id === 'fine_1').text, '第1片已核对的经历');
    const stage = doc.entries.find(entry => entry.id === 'stage_1');
    assert.equal(stage.status, 'invalid'); assert.equal(stageDependenciesValid(stage, doc), false);
});

test('manually edited stages receive redo candidates; changed parents invalidate candidates', () => {
    let doc = withStage();
    doc = change(doc, {id: 'edit_stage', type: 'edit', entryId: 'stage_1', expectedRevision: 1, text: '人工阶段修订必须保留'});
    doc = change(doc, {id: 'redo_stage', type: 'redo', entryId: 'stage_1', expectedRevision: 2, expectedEpoch: 1,
        entry: {id: 'stage_1', kind: 'stage', text: '新阶段候选', source: {parents: refs(doc)}}});
    let stage = doc.entries.find(entry => entry.id === 'stage_1');
    assert.equal(stage.text, '人工阶段修订必须保留'); assert.equal(stage.candidate.text, '新阶段候选');
    doc = change(doc, {id: 'edit_parent', type: 'edit', entryId: 'fine_1', expectedRevision: 1, text: '上游人工语义已改变'});
    stage = doc.entries.find(entry => entry.id === 'stage_1');
    assert.equal(stage.status, 'invalid'); assert.equal(stage.text, '人工阶段修订必须保留');
    assert.throws(() => change(doc, {id: 'accept', type: 'entry', entryId: 'stage_1', expectedRevision: stage.revision, action: 'acceptCandidate'}), /候选|重总结/);
});

test('deleting a stage retains fine summaries and settings stay single-basis and opt-in', () => {
    const doc = change(withStage(), {id: 'delete_stage', type: 'entry', entryId: 'stage_1', expectedRevision: 1, action: 'delete'});
    assert.ok(doc.entries.filter(entry => entry.kind === 'summary').every(entry => entry.status === 'active'));
    const initial = createDefaults(); assert.equal(initial.values.stageAuto, false);
    const saved = applyDefaultsOperation(initial, {id: 'stage_settings', expectedRevision: 0, values: {stageAuto: true, stageBasis: 'slices', stageThreshold: 12}}).defaults;
    assert.equal(saved.values.stageBasis, 'slices'); assert.equal(saved.values.stageThreshold, 12);
    assert.throws(() => applyDefaultsOperation(saved, {id: 'bad_basis', expectedRevision: 1, values: {stageBasis: ['tokens', 'floors']}}), /依据/);
});

test('stage parents stay reserved after exclusion, deletion or invalidation; only the same stage can be redone', () => {
    const initial = withStage();
    for (const action of [null, 'exclude', 'delete', 'invalid']) {
        let doc = initial;
        if (action === 'invalid') doc = change(doc, {id: action, type: 'invalidate', entries: [{id: 'stage_1', revision: 1}]});
        else if (action) doc = change(doc, {id: action, type: 'entry', action, entryId: 'stage_1', expectedRevision: 1});
        const all = doc.entries.filter(entry => entry.kind === 'summary').map(entry => ({id: entry.id, revision: entry.revision}));
        assert.throws(() => change(doc, {id: 'overlapping', type: 'append', expectedEpoch: doc.epoch,
            entry: {id: 'stage_other', kind: 'stage', text: '不允许绕过原阶段', source: {parents: all}}}), /已有阶段/);
    }
    const redone = change(initial, {id: 'same_redo', type: 'redo', entryId: 'stage_1', expectedRevision: 1, expectedEpoch: initial.epoch,
        entry: {id: 'stage_1', kind: 'stage', text: '同一阶段可以重新总结', source: {parents: refs(initial)}}});
    assert.equal(redone.entries.find(entry => entry.id === 'stage_1').text, '同一阶段可以重新总结');
    const third = change(initial, {id: 'third_stage', type: 'append', expectedEpoch: initial.epoch,
        entry: {id: 'stage_3', kind: 'stage', text: '独立不重叠的阶段', source: {parents: [{id: 'fine_3', revision: 1}]}}});
    assert.throws(() => change(third, {id: 'expand_redo', type: 'redo', entryId: 'stage_1', expectedRevision: 1, expectedEpoch: third.epoch,
        entry: {id: 'stage_1', kind: 'stage', text: '扩大范围会占用另一阶段', source: {parents: third.entries.filter(entry => entry.kind === 'summary').map(entry => ({id: entry.id, revision: entry.revision}))}}}), /已有阶段/);
});
