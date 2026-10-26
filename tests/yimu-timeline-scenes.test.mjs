import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperation, createDocument, createDefaults, DEFAULTS, effectiveSettings, fingerprintMessages, validateDocument, canUndoText, stageSourceFromParents } from '../yimu/contract.mjs';
import { normalizeEntryOrder, orderedEntries, orderForInjection } from '../yimu/timeline.mjs';
import { validateScenes, unknownScenes, sceneProjection } from '../yimu/scene-contract.mjs';
import { parseSummary, buildPlan, summaryPrompt, summaryCoverage } from '../yimu/core.mjs';
import { stageGroups, planStageRange, nextStage } from '../yimu/layers.mjs';
import { buildBudgetedMessages, captureCore, byteBudget, memoryMessage } from '../yimu/budget.mjs';

const binding = { avatar: 'Timeline.png', file: 'Story', integrity: 'timeline-id' };
const messages = Array.from({ length: 14 }, (_, i) => ({ name: i % 2 ? '甲' : '乙', is_user: i % 2 === 0,
    mes: `第${i + 1}层：故事资料${'正文'.repeat(40)}`, send_date: String(i) }));
const change = (document, operation) => applyOperation(document, operation).document;
async function fixture() {
    const hashes = await fingerprintMessages(messages);
    let document = change(createDocument(binding), { id: 'enable', type: 'enable', expectedRevision: 0, enabled: true });
    const source = floor => ({ start: floor, end: floor, hashes: [hashes[floor - 1]] });
    const addFine = (doc, floor) => change(doc, { id: `append_f${floor}`, type: 'append', expectedEpoch: doc.epoch,
        entry: { id: `f${floor}`, kind: 'summary', text: `原文第${floor}层的有据叙事`, source: source(floor) } });
    for (const floor of [1, 2, 3, 4]) document = addFine(document, floor);
    const placement = floor => ({ binding, fromFloor: floor, hash: hashes[floor - 1] });
    const addManual = (doc, id = 'm1', floor = 1, afterId = 'f1') => change(doc, { id: `append_${id}`, type: 'append', afterId,
        entry: { id, kind: 'manual', text: '用户写定：她还不知道那封信。', source: null, placement: placement(floor) } });
    return { document, hashes, source, addFine, addManual, placement };
}
const refs = (document, ids) => ids.map(id => ({ id, revision: document.entries.find(entry => entry.id === id).revision }));
const addStage = (document, id, ids) => change(document, { id: `append_${id}`, type: 'append', expectedEpoch: document.epoch,
    entry: { id, kind: 'stage', text: `阶段${id}保留用户含义`, source: { parents: refs(document, ids) } } });

test('schema-six read migration preserves explicit switches, records and input bytes without inventing placements', () => {
    const old = { ...createDocument(binding), schema: 6, enabled: true, autoSummary: false };
    delete old.entryOrder;
    old.entries = [{ id: 'legacy', kind: 'manual', source: null, text: '旧自定义原件', status: 'active', edited: true,
        revision: 1, history: [], conflicts: [], candidate: null }];
    const before = structuredClone(old), migrated = validateDocument(old);
    assert.deepEqual(old, before); assert.equal(migrated.schema, 7); assert.equal(migrated.autoSummary, false);
    assert.deepEqual(migrated.entryOrder, ['legacy']); assert.equal(migrated.entries[0].placement, null);
    assert.deepEqual(migrated.entries[0].scenes, unknownScenes()); assert.equal(migrated.entries[0].text, before.entries[0].text);
});

test('new custom slices require an identity/floor/hash anchor and remain source-free', async () => {
    const f = await fixture();
    assert.throws(() => change(f.document, { id: 'missing', type: 'append', entry: { id: 'm', kind: 'manual', text: '缺锚点', source: null } }), /插入楼层/);
    assert.throws(() => change(f.document, { id: 'foreign', type: 'append', entry: { id: 'm', kind: 'manual', text: '异聊', source: null,
        placement: { ...f.placement(1), binding: { ...binding, file: 'Other' } } } }), /当前聊天/);
    const saved = f.addManual(f.document), item = saved.entries.find(entry => entry.id === 'm1');
    assert.equal(item.source, null); assert.deepEqual(item.placement, f.placement(1));
    assert.deepEqual(saved.entryOrder, ['f1', 'm1', 'f2', 'f3', 'f4']);
});

test('coverage counts valid custom slices once but never adds artificial organized floors', async () => {
    const f = await fixture(), before = summaryCoverage(f.document, messages, DEFAULTS);
    let document = f.addManual(f.document), withCustom = summaryCoverage(document, messages, DEFAULTS);
    assert.equal(withCustom.sliceCount, before.sliceCount + 1); assert.equal(withCustom.organizedFloors, before.organizedFloors);
    assert.equal(withCustom.pendingFloors, before.pendingFloors);
    document = change(document, { id: 'count_shield', type: 'entry', entryId: 'm1', expectedRevision: 1, action: 'exclude' });
    assert.equal(summaryCoverage(document, messages, DEFAULTS).sliceCount, before.sliceCount);
    document.entries.find(entry => entry.id === 'm1').status = 'active';
    document.entries.find(entry => entry.id === 'm1').placement.fromFloor = 999;
    assert.equal(summaryCoverage(document, messages, DEFAULTS).sliceCount, before.sliceCount);
});

test('complete-order CAS rejects stale or partial reorder and does not rewrite original source claims', async () => {
    const f = await fixture(), document = f.addManual(f.document), before = structuredClone(document);
    assert.throws(() => change(document, { id: 'partial', type: 'reorder', expectedRevision: document.revision, entryOrder: ['m1'] }), /列表已变化/);
    assert.throws(() => change(document, { id: 'stale', type: 'reorder', expectedRevision: document.revision - 1, entryOrder: document.entryOrder }), /另一设备/);
    const entryOrder = ['f2', 'f1', 'm1', 'f3', 'f4'];
    const saved = change(document, { id: 'ordered', type: 'reorder', expectedRevision: document.revision, entryOrder,
        placements: { m1: f.placement(2) } });
    assert.deepEqual(document, before); assert.deepEqual(saved.entryOrder, entryOrder);
    assert.deepEqual(saved.entries.find(entry => entry.id === 'f2').source, before.entries.find(entry => entry.id === 'f2').source);
    assert.equal(saved.entries.find(entry => entry.id === 'm1').placement.fromFloor, 2);
    assert.deepEqual(orderedEntries(saved.entries, entryOrder).map(entry => entry.id), entryOrder);
    const later = f.addFine(saved, 5);
    assert.deepEqual(later.entryOrder.slice(0, 5), entryOrder); assert.equal(later.entryOrder.at(-1), 'f5');
    assert.deepEqual(orderedEntries(saved.entries.filter(entry => ['m1', 'f1'].includes(entry.id)), entryOrder).map(entry => entry.id), ['f1', 'm1']);
});

test('manual placement is validated at selection and cannot grant source removal or future applicability', async () => {
    const f = await fixture(); let document = f.addManual(f.document, 'm1', 12, 'f4');
    let plan = await buildPlan(document, createDefaults(), { messages });
    assert.ok(plan.memoryIds.includes('m1'));
    plan = await buildPlan(document, createDefaults(), { messages: messages.slice(0, 11) });
    assert.ok(!plan.memoryIds.includes('m1'));
    const changed = structuredClone(messages); changed[11].mes = '锚点原文已变化';
    plan = await buildPlan(document, createDefaults(), { messages: changed });
    assert.ok(!plan.memoryIds.includes('m1'));
    document.entries.find(entry => entry.id === 'm1').placementVerified = true;
    const clean = validateDocument(document);
    assert.equal(clean.entries.find(entry => entry.id === 'm1').placementVerified, undefined);
});

test('text undo ignores exclusion/restore history and never changes the current injection shield', async () => {
    const f = await fixture(); let document = f.document;
    const original = document.entries[0].text;
    document = change(document, { id: 'edit1', type: 'edit', entryId: 'f1', expectedRevision: 1, text: '手修第一版' });
    document = change(document, { id: 'edit2', type: 'edit', entryId: 'f1', expectedRevision: 2, text: '手修第二版' });
    document = change(document, { id: 'exclude', type: 'entry', entryId: 'f1', expectedRevision: 3, action: 'exclude' });
    assert.equal(canUndoText(document.entries[0]), true);
    document = change(document, { id: 'undo1', type: 'entry', entryId: 'f1', expectedRevision: 4, action: 'undoText' });
    assert.equal(document.entries[0].text, '手修第一版'); assert.equal(document.entries[0].status, 'excluded');
    document = change(document, { id: 'undo2', type: 'entry', entryId: 'f1', expectedRevision: 5, action: 'undoText' });
    assert.equal(document.entries[0].text, original); assert.equal(document.entries[0].status, 'excluded');
    assert.equal(canUndoText(document.entries[0]), false);
    assert.throws(() => change(document, { id: 'old_undo', type: 'entry', entryId: 'f1', expectedRevision: 6, action: 'undo' }), /仅用于撤回删除/);
});

test('redo and candidate adoption preserve an explicit injection shield', async () => {
    const f = await fixture(); let document = f.document;
    document = change(document, { id: 'edit', type: 'edit', entryId: 'f1', expectedRevision: 1, text: '人工原件' });
    document = change(document, { id: 'shield', type: 'entry', entryId: 'f1', expectedRevision: 2, action: 'exclude' });
    document = change(document, { id: 'redo', type: 'redo', entryId: 'f1', expectedRevision: 3, expectedEpoch: document.epoch,
        entry: { id: 'f1', kind: 'summary', text: '新候选', source: f.source(1) } });
    assert.equal(document.entries[0].text, '人工原件'); assert.equal(document.entries[0].status, 'excluded');
    document = change(document, { id: 'adopt', type: 'entry', entryId: 'f1', expectedRevision: 4, action: 'acceptCandidate' });
    assert.equal(document.entries[0].text, '新候选'); assert.equal(document.entries[0].status, 'excluded');
});

test('custom text undo preserves its current drag placement rather than rewinding applicability', async () => {
    const f = await fixture(); let document = f.addManual(f.document);
    document = change(document, { id: 'custom_edit', type: 'edit', entryId: 'm1', expectedRevision: 1, text: '新文字' });
    document = change(document, { id: 'custom_drag', type: 'reorder', expectedRevision: document.revision,
        entryOrder: ['f1', 'f2', 'm1', 'f3', 'f4'], placements: { m1: f.placement(2) } });
    document = change(document, { id: 'custom_undo', type: 'entry', entryId: 'm1', expectedRevision: 3, action: 'undoText' });
    assert.equal(document.entries.find(entry => entry.id === 'm1').text, '用户写定：她还不知道那封信。');
    assert.deepEqual(document.entries.find(entry => entry.id === 'm1').placement, f.placement(2));
    assert.deepEqual(document.entryOrder, ['f1', 'f2', 'm1', 'f3', 'f4']);
});

test('scene parsing keeps simultaneous places, people, events and clocks separate without inventing unknown dates', async () => {
    const f = await fixture(), scenes = [
        { world: '甲世界', timeline: '主线', date: '历元三年六月二日', period: '早晨', place: '桥上', characters: ['甲'], event: '甲在等信', nature: 'present', evidence: { floors: [1] } },
        { world: '乙世界', timeline: '平行线', date: '', period: '夜晚', place: '书房', characters: ['乙'], event: '乙正在写信', nature: 'parallel', evidence: { floors: [2] } },
    ];
    const parsed = parseSummary(JSON.stringify({ slices: [{ start: 1, end: 2, text: '同时异地分别行动，互不知情。', scenes }] }), { start: 1, end: 2 }, f.hashes);
    assert.deepEqual(parsed[0].scenes, scenes);
    assert.equal(parsed[0].scenes[1].date, ''); assert.deepEqual(parsed[0].scenes[1].characters, ['乙']);
    assert.throws(() => parseSummary(JSON.stringify({ slices: [{ start: 1, end: 2, text: '越界', scenes: [{ ...scenes[0], evidence: { floors: [3] } }] }] }), { start: 1, end: 2 }, f.hashes), /依据楼层/);
    assert.deepEqual(parseSummary('{"slices":[{"start":1,"end":1,"text":"旧格式"}]}', { start: 1, end: 1 }, f.hashes)[0].scenes, unknownScenes());
    assert.equal(validateScenes([{ date: '编造日期' }])[0].date, '');
    assert.equal(validateScenes([{ date: '用户写定日期', evidence: { user: true } }])[0].date, '用户写定日期');
    assert.equal(validateScenes([{ date: '模型伪称用户写定', evidence: { user: true } }], { allowUser: false })[0].date, '');
});

test('injection scene projection retains only meaningful story semantics and compresses unknown fields', () => {
    const scenes = validateScenes([{ world: '异世界', date: '冬月初三', place: '桥边', characters: ['甲'], event: '等待回信',
        nature: 'present', evidence: { floors: [1], inheritedFrom: { id: 'earlier', revision: 2 } } }]);
    assert.deepEqual(sceneProjection(scenes), [{ world: '异世界', date: '冬月初三', place: '桥边', characters: ['甲'], event: '等待回信', nature: 'present' }]);
    const message = memoryMessage([{ id: 'entry', kind: 'manual', source: null, text: '人物尚不知情', scenes }]);
    assert.ok(message.content.includes('冬月初三')); assert.ok(message.content.includes('等待回信'));
    assert.ok(!message.content.includes('"evidence"')); assert.ok(!message.content.includes('"inheritedFrom"'));
    assert.deepEqual(sceneProjection(unknownScenes()), '未注明');
    assert.ok(!memoryMessage([{ id: 'unknown', kind: 'manual', source: null, text: '旧切片', scenes: unknownScenes() }]).content.includes('"place":""'));
});

test('scene inheritance requires the exact earlier active revision and never relies on list position', async () => {
    const f = await fixture(); let document = f.document;
    document = change(document, { id: 'scene_edit', type: 'edit', entryId: 'f1', expectedRevision: 1, text: '日期有据',
        scenes: [{ date: '冬月初三', place: '桥边', evidence: { floors: [1] } }] });
    const inherited = [{ date: '冬月初三', place: '桥边', evidence: { floors: [], inheritedFrom: { id: 'f1', revision: 2 } } }];
    document = change(document, { id: 'scene_redo', type: 'redo', entryId: 'f2', expectedRevision: 1, expectedEpoch: document.epoch,
        entry: { id: 'f2', kind: 'summary', text: '明示同场延续', source: f.source(2), scenes: inherited } });
    assert.equal(document.entries.find(entry => entry.id === 'f2').scenes[0].date, '冬月初三');
    const bad = structuredClone(inherited); bad[0].evidence.inheritedFrom.revision = 1;
    assert.throws(() => change(document, { id: 'stale_scene', type: 'redo', entryId: 'f2', expectedRevision: 2, expectedEpoch: document.epoch,
        entry: { id: 'f2', kind: 'summary', text: '迟到', source: f.source(2), scenes: bad } }), /继承依据已变化/);
    const prompt = summaryPrompt(messages, { start: 2, end: 2 }, DEFAULTS, { previousContext: [{ id: 'f1', revision: 2, scenes: inherited }] });
    assert.match(prompt, /来源有效的上文锚点/); assert.match(prompt, /同时异地多视角/); assert.match(prompt, /event/);
});

test('custom slices participate in protected stages without acquiring raw-floor deletion rights', async () => {
    const f = await fixture(); let document = f.addManual(f.document);
    const parents = refs(document, ['f1', 'm1', 'f2']);
    assert.deepEqual(stageSourceFromParents(document, parents).ranges, [{ start: 1, end: 2, hashes: f.hashes.slice(0, 2) }]);
    assert.deepEqual(stageGroups(document)[0].map(entry => entry.id), ['f1', 'm1', 'f2', 'f3', 'f4']);
    document = addStage(document, 'stage', ['f1', 'm1', 'f2']);
    assert.equal(document.entries.find(entry => entry.id === 'stage').edited, false, 'machine stage is not mislabeled as a hand-edit; custom parent protection is derived');
    const plan = await buildPlan(document, createDefaults(), { messages });
    assert.ok(plan.memoryIds.includes('stage')); assert.ok(!plan.memoryIds.includes('m1'));
    assert.equal(document.entries.find(entry => entry.id === 'm1').text, '用户写定：她还不知道那封信。');
    document = change(document, { id: 'shield_custom', type: 'entry', entryId: 'm1', expectedRevision: 1, action: 'exclude' });
    assert.equal(document.entries.find(entry => entry.id === 'stage').status, 'invalid');
    assert.ok(!nextStage(document, { ...DEFAULTS, stageAuto: true }, { force: false })?.parents.some(entry => entry.id === 'm1'));
});

test('custom parent stages require explicit redo adoption but invalid automatic stages fall back to valid custom originals after drag', async () => {
    const f = await fixture(); let document = addStage(f.addManual(f.document), 'stage', ['f1', 'm1', 'f2']);
    const pending = change(document, { id: 'custom_stage_redo', type: 'redo', entryId: 'stage', expectedRevision: 1, expectedEpoch: document.epoch,
        entry: { id: 'stage', kind: 'stage', text: '候选不能暗改人工含义', source: { parents: refs(document, ['f1', 'm1', 'f2']) } } });
    assert.equal(pending.entries.find(entry => entry.id === 'stage').text, '阶段stage保留用户含义');
    assert.equal(pending.entries.find(entry => entry.id === 'stage').candidate.text, '候选不能暗改人工含义');
    document = change(document, { id: 'drag_custom_out', type: 'reorder', expectedRevision: document.revision,
        entryOrder: ['stage', 'f1', 'f2', 'f3', 'm1', 'f4'], placements: { m1: f.placement(3) } });
    assert.equal(document.entries.find(entry => entry.id === 'stage').status, 'invalid');
    const plan = await buildPlan(document, createDefaults(), { messages });
    assert.ok(plan.memoryIds.includes('m1')); assert.ok(!plan.memoryIds.includes('stage'));
    assert.deepEqual(orderForInjection([{ id: 'stage', kind: 'stage', source: { parents: [{ id: 'f1' }] } }, { id: 'other', kind: 'manual' }], ['f1', 'other', 'stage']).map(entry => entry.id), ['other', 'stage']);
});

test('manual stage range expands whole automatic owners and replaces them only in one successful operation', async () => {
    const f = await fixture(); let document = addStage(f.document, 's1', ['f1', 'f2']);
    document = addStage(document, 's2', ['f3', 'f4']);
    const plan = planStageRange(document, DEFAULTS, { start: 2, end: 3, recentCutoff: 9 });
    assert.equal(plan.expanded, true); assert.deepEqual(plan.range, { start: 1, end: 4 });
    assert.deepEqual(plan.replaceStages.map(ref => ref.id), ['s1', 's2']);
    const saved = change(document, { id: 'replace', type: 'append', expectedEpoch: document.epoch, replaceStages: plan.replaceStages,
        entry: { id: 'combined', kind: 'stage', text: '完整新阶段', source: { parents: refs(document, ['f1', 'f2', 'f3', 'f4']) } } });
    for (const id of ['s1', 's2']) { assert.equal(saved.entries.find(entry => entry.id === id).replacedBy, 'combined'); assert.equal(document.entries.find(entry => entry.id === id).status, 'active'); }
    assert.equal(saved.entries.filter(entry => entry.kind === 'summary').length, 4);
    const newer = change(document, { id: 'old_stage_edit', type: 'edit', entryId: 's1', expectedRevision: 1, text: '人工保护旧阶段' });
    assert.throws(() => planStageRange(newer, DEFAULTS, { start: 1, end: 4, recentCutoff: 9 }), /单独重新总结/);
});

test('inserting after a grouped stage means after its full original block, including later fine-detail fallback', async () => {
    const f = await fixture(), staged = addStage(f.document, 'stage', ['f1', 'f2']);
    const document = f.addManual(staged, 'after_stage', 2, 'stage');
    assert.deepEqual(document.entryOrder, ['stage', 'f1', 'f2', 'after_stage', 'f3', 'f4']);
    assert.deepEqual(orderForInjection(document.entries.filter(entry => ['f1', 'f2', 'after_stage'].includes(entry.id)), document.entryOrder).map(entry => entry.id), ['f1', 'f2', 'after_stage']);
});

test('actual budgeted messages follow narrative order after priority selection and keep each quote with its parent', async () => {
    const f = await fixture(), core = messages.map((item, index) => ({ ...item, index }));
    const { processed } = captureCore(core, { messages }, { namesBehavior: 0, userName: '乙' });
    const payload = { model: 'model', messages: processed.map(item => item.request) };
    const first = f.document.entries[0], second = f.document.entries[1];
    const custom = { id: 'm', kind: 'manual', text: '自定义不等于共同知情', source: null };
    const quote = { id: 'q', kind: 'excerpt', text: '引用占位', quoteText: '逐字引证', parent: { id: first.id, revision: first.revision }, source: f.source(1) };
    const entryOrder = ['f2', 'm', 'q', 'f1'];
    assert.deepEqual(orderForInjection([first, quote, custom, second], entryOrder).map(entry => entry.id), ['f2', 'm', 'f1', 'q']);
    const result = await buildBudgetedMessages(payload, { entries: [first, quote, custom, second], entryOrder,
        sourceHashes: f.hashes, processed, recent: 5, budget: 20000, contextTokens: 60000, responseTokens: 1024 });
    assert.equal(result.applied, true); assert.deepEqual(result.entries.map(entry => entry.id), ['f2', 'm', 'f1', 'q']);
    const memory = result.messages.find(message => message.content.startsWith('<yimu_memory>')).content;
    assert.ok(memory.indexOf('"id":"f2"') < memory.indexOf('"id":"m"'));
    assert.ok(memory.indexOf('"id":"m"') < memory.indexOf('"id":"f1"'));
    assert.deepEqual(result.removedFloors, [1, 2]);
});

test('all-custom stages are admitted without deleting any chat originals', async () => {
    const f = await fixture(); let document = f.addManual(f.document, 'm1', 1, 'f1');
    document = f.addManual(document, 'm2', 1, 'm1');
    document = addStage(document, 'custom_stage', ['m1', 'm2']);
    const stage = document.entries.find(entry => entry.id === 'custom_stage');
    assert.deepEqual(stage.source.ranges, []);
    const plan = await buildPlan(document, createDefaults(), { messages });
    assert.ok(plan.memoryIds.includes('custom_stage'));
    const core = messages.map((item, index) => ({ ...item, index })), { processed } = captureCore(core, { messages }, { namesBehavior: 0, userName: '乙' });
    const result = await buildBudgetedMessages({ messages: processed.map(item => item.request) }, { entries: [stage], entryOrder: document.entryOrder,
        sourceHashes: f.hashes, processed, recent: 5, budget: 20000, contextTokens: 60000, responseTokens: 1024 });
    assert.equal(result.applied, true); assert.deepEqual(result.removedFloors, []);
});

test('custom-only stages may use recent applicability anchors without compressing recent raw', async () => {
    const f = await fixture(); let document = f.addManual(f.document, 'm1', 13, 'f4');
    document = f.addManual(document, 'm2', 14, 'm1');
    const plan = planStageRange(document, DEFAULTS, { start: 13, end: 14, recentCutoff: 9 });
    assert.deepEqual(plan.parents.map(entry => entry.id), ['m1', 'm2']);
    assert.deepEqual(stageSourceFromParents(document, refs(document, ['m1', 'm2'])).ranges, []);
});

test('protected custom originals are embedded once in stage admission and survive an oversized stage via valid parent fallback', async () => {
    const f = await fixture(); let document = f.addManual(f.document);
    document = addStage(document, 'stage', ['f1', 'm1', 'f2']);
    const plan = await buildPlan(document, createDefaults(), { messages }), stage = plan.entries.find(entry => entry.id === 'stage');
    assert.deepEqual(stage.customSlices.map(entry => entry.id), ['m1']);
    assert.equal(stage.customSlices[0].text, '用户写定：她还不知道那封信。');
    assert.ok(!document.entries.find(entry => entry.id === 'stage').customSlices, 'derived human contents are not a persistent second copy');
    const core = messages.map((item, index) => ({ ...item, index })), { processed } = captureCore(core, { messages }, { namesBehavior: 0, userName: '乙' });
    const payload = { messages: processed.map(item => item.request) }, options = {
        sourceHashes: f.hashes, processed, recent: 5, contextTokens: 60000, responseTokens: 1024, entryOrder: document.entryOrder,
    };
    const admitted = await buildBudgetedMessages(payload, { ...options, entries: [stage], budget: 20000 });
    assert.equal(admitted.applied, true); assert.deepEqual(admitted.entries.map(entry => entry.id), ['stage']);
    const emitted = admitted.messages.find(message => message.content.startsWith('<yimu_memory>')).content;
    assert.ok(emitted.includes(JSON.stringify(stage.customSlices[0].text)));
    const oversized = { ...stage, text: '自动阶段过大'.repeat(10000) }, custom = stage.fallbackEntries.find(entry => entry.id === 'm1');
    const cap = byteBudget([memoryMessage([custom], document.entryOrder)]) + 10;
    const fallback = await buildBudgetedMessages(payload, { ...options, entries: [oversized], budget: cap });
    assert.equal(fallback.applied, true); assert.deepEqual(fallback.entries.map(entry => entry.id), ['m1']);
    assert.deepEqual(fallback.removedFloors, []); assert.equal(fallback.entries[0].text, custom.text);
});

test('zero factory values resolve only at the shared boundary while zero memory budget remains automatic', () => {
    const settings = effectiveSettings({ settings: { recent: 0, trigger: 0, batch: 0, stageBasis: 'slices', stageThreshold: 0, budget: 0 } }, createDefaults());
    assert.equal(settings.recent, 5); assert.equal(settings.trigger, 4000); assert.equal(settings.batch, 6000);
    assert.equal(settings.stageThreshold, 12); assert.equal(settings.budget, 0);
    assert.throws(() => normalizeEntryOrder({ entries: [{ id: 'a' }], entryOrder: ['a', 'a'] }), /排列无效/);
});
