import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, createDocument, createDefaults, applyOperation, fingerprintMessages } from '../yimu/contract.mjs';
import { stageGroups, nextStage, stageWeight, stagePrompt, parseStage } from '../yimu/layers.mjs';
import { buildPlan } from '../yimu/core.mjs';

const binding = { avatar: 'Layers.png', file: 'Story', integrity: 'layers-identity' };
const messages = Array.from({ length: 16 }, (_, i) => ({ name: i % 2 ? '甲' : '乙', is_user: i % 2 === 0, mes: `合成楼层${i + 1}：今晚下雨，故事仍在进行。`, send_date: String(i) }));
async function fixture() {
    const hashes = await fingerprintMessages(messages);
    let document = applyOperation(createDocument(binding), { id: 'enable', type: 'enable', enabled: true, expectedRevision: 0, range: { start: 1, end: 16, total: 16 } }).document;
    for (let i = 0; i < 4; i++) document = applyOperation(document, { id: `save${i}`, type: 'append', expectedEpoch: document.epoch,
        entry: { id: `fine${i}`, kind: 'summary', text: [`初次约会留下红围巾，甲不知道乙的秘密。`, '相约多年后再到桥边，尚未兑现。', '两人继续赶路，夜雨未停。', '来到新城，住处尚未确定。'][i],
            source: { start: i * 2 + 1, end: i * 2 + 2, hashes: hashes.slice(i * 2, i * 2 + 2) } } }).document;
    const stage = (doc, ids, text = '两人有过重要约定，后来继续赶路。') => applyOperation(doc, { id: `stage${doc.revision}`, type: 'append', expectedEpoch: doc.epoch,
        entry: { id: `stage${doc.revision}`, kind: 'stage', text, source: { parents: ids.map(id => ({ id, revision: doc.entries.find(e => e.id === id).revision })) } } }).document;
    return { document, hashes, stage };
}

test('stage trigger counts pending valid fine summaries, not raw chat length or the full historic library', async () => {
    const { document, stage } = await fixture();
    assert.equal(stageWeight(document.entries, 'slices'), 4);
    assert.equal(stageWeight(document.entries, 'floors'), 8);
    assert.equal(nextStage(document, { ...DEFAULTS, stageAuto: false, stageBasis: 'slices', stageThreshold: 2 }), null);
    const choice = nextStage(document, { ...DEFAULTS, stageAuto: true, stageBasis: 'slices', stageThreshold: 3 });
    assert.equal(choice.parents.length, 4);
    const grouped = stage(document, choice.parents.map(e => e.id));
    assert.equal(nextStage(grouped, { ...DEFAULTS, stageAuto: true, stageBasis: 'slices', stageThreshold: 1 }), null);
    assert.equal(nextStage(document, { ...DEFAULTS, stageAuto: true, stageBasis: 'floors', stageThreshold: 9 }), null);
    assert.ok(nextStage(document, { ...DEFAULTS, stageAuto: true, stageBasis: 'tokens', stageThreshold: 1 }));
});

test('hand edits, excluded slices and source gaps split stage groups instead of being silently compressed', async () => {
    let { document } = await fixture();
    document = applyOperation(document, { id: 'edit', type: 'edit', entryId: 'fine1', expectedRevision: 1, text: '用户亲自确认的约定。' }).document;
    assert.deepEqual(stageGroups(document).map(group => group.map(e => e.id)), [['fine2', 'fine3']]);
    const group = nextStage(document, DEFAULTS, { force: true });
    const prompt = stagePrompt(group.parents, DEFAULTS);
    assert.ok(!prompt.includes('用户亲自确认的约定'));
    const original = document.entries.find(e => e.id === 'fine1').text;
    parseStage('{"text":"后续进展"}', group.parents);
    assert.equal(document.entries.find(e => e.id === 'fine1').text, original);
});

test('stage batches keep whole fine slices and do not reach across the recent-raw cutoff', async () => {
    const { document } = await fixture();
    assert.equal(nextStage(document, { ...DEFAULTS, batch: 1 }, { force: true }), null);
    const group = nextStage(document, DEFAULTS, { force: true, recentCutoff: 4 });
    assert.deepEqual(group.parents.map(e => e.id), ['fine0', 'fine1']);
    const expanded = nextStage(document, DEFAULTS, { force: true, start: 2, end: 3 });
    assert.equal(expanded.expanded, true); assert.deepEqual(expanded.range, { start: 1, end: 4 });
});

test('a hand-edited stage is never automatically replaced by a new stage over the same parents', async () => {
    const f = await fixture(); let document = f.stage(f.document, ['fine0', 'fine1']);
    const stage = document.entries.find(e => e.kind === 'stage');
    document = applyOperation(document, { id: 'edit-stage', type: 'edit', entryId: stage.id, expectedRevision: 1, text: '人工确立的阶段含义。' }).document;
    assert.deepEqual(stageGroups(document, { automatic: true }).flat().map(e => e.id), ['fine2', 'fine3']);
    document = applyOperation(document, { id: 'parent-edit', type: 'edit', entryId: 'fine0', expectedRevision: 1, text: '细摘要也作人工调整。' }).document;
    assert.equal(document.entries.find(e => e.id === stage.id).status, 'invalid');
    const plan = await buildPlan(document, createDefaults(), { messages, maxContext: 8192 });
    assert.ok(!plan.memoryIds.includes('fine0') && !plan.memoryIds.includes('fine1'), 'automatic children cannot bypass the now-invalid hand revision');
});

test('related specific detail recalls saved fine summaries rather than injecting stage and children twice', async () => {
    const f = await fixture(); const document = f.stage(f.document, ['fine0', 'fine1']);
    document.entries = document.entries.filter(e => !['fine2', 'fine3'].includes(e.id));
    document.entryOrder = document.entryOrder.filter(id => !['fine2', 'fine3'].includes(id));
    const snapshot = { messages: structuredClone(messages), maxContext: 8192 };
    snapshot.messages[15].mes = '还记得当年的红围巾吗？';
    let plan = await buildPlan(document, createDefaults(), snapshot);
    assert.ok(plan.memoryIds.includes('fine0'));
    assert.ok(!plan.entries.some(e => e.kind === 'stage'));
    document.settings.recall = false;
    plan = await buildPlan(document, createDefaults(), snapshot);
    assert.ok(plan.entries.some(e => e.kind === 'stage'));
    assert.ok(!plan.memoryIds.includes('fine0') && !plan.memoryIds.includes('fine1'));
});

test('manual stage meaning remains authoritative even when a child has a stronger query match', async () => {
    const f = await fixture(); let document = f.stage(f.document, ['fine0', 'fine1']);
    const stage = document.entries.find(e => e.kind === 'stage');
    document = applyOperation(document, { id: 'manual-stage', type: 'edit', entryId: stage.id, expectedRevision: 1, text: '这一阶段的手动修订，不可自动绕过。' }).document;
    const snapshot = { messages: structuredClone(messages), maxContext: 8192 }; snapshot.messages[15].mes = '红围巾';
    const plan = await buildPlan(document, createDefaults(), snapshot);
    assert.ok(plan.memoryIds.includes(stage.id));
    assert.ok(!plan.memoryIds.includes('fine0'));
    assert.equal(plan.entries.find(e => e.id === stage.id).text, document.entries.find(e => e.id === stage.id).text);
});

test('stage parsing does not overwrite parents and rejects empty or malformed model output', async () => {
    const { document } = await fixture(); const parents = document.entries.slice(0, 2), before = structuredClone(parents);
    assert.throws(() => parseStage('plain text', parents)); assert.throws(() => parseStage('{"text":""}', parents));
    const parsed = parseStage('{"text":"约定仍未实现，秘密并未公开。"}', parents);
    assert.equal(parsed.kind, 'stage');
    assert.deepEqual(parsed.source.parents, parents.map(e => ({ id: e.id, revision: e.revision })));
    assert.deepEqual(parents, before);
});

test('stage prompt retains supported atmosphere without inventing lost detail or merging scene moods', async () => {
    const {document} = await fixture(), parents = document.entries.slice(0, 2), before = structuredClone(parents);
    const prompt = stagePrompt(parents, DEFAULTS);
    for (const rule of ['情绪过程', '场景气氛', '不统一抒情', '不补输入缺失的细节', '同时异地不能混写成同场景', '事实与角色所知继续区分']) assert.ok(prompt.includes(rule), rule);
    assert.deepEqual(JSON.parse(prompt.split('切片：')[1]), parents.map(e => ({id: e.id, revision: e.revision, kind: e.kind,
        start: e.source.start, end: e.source.end, scenes: e.scenes, text: e.text})));
    assert.deepEqual(parents, before);
});
