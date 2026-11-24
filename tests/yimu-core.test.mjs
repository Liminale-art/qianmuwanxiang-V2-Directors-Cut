import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS as FACTORY_DEFAULTS, SCHEMA, validateSettings as validateSettingsFor, createDocument, createDefaults as factoryDefaults, validateDocument, applyOperation, applyDefaultsOperation, fingerprintMessages, sourceMatches } from '../yimu/contract.mjs';
import {legacySettings, legacyDefaults} from './helpers/yimu-legacy-defaults.mjs';
import { nextBatch, parseSummary, summaryPrompt, buildPlan, inspectSources, initialRangePreview, planManualRange, summaryCoverage, hiddenFloorsFor, autoBacklog, REROLL_GUARD } from '../yimu/core.mjs';
import { buildBudgetedMessages, captureCore } from '../yimu/budget.mjs';
import { mergeCompanionBook, companionEntries } from '../yimu/companion-contract.mjs';
// Fixtures assume the pre-0.8.20 defaults (five recent originals, token-only trigger).
const DEFAULTS = legacySettings(FACTORY_DEFAULTS), createDefaults = legacyDefaults;

const binding = { avatar: 'Fixture.png', file: 'fixture', integrity: 'fixture-id' };
const messages = Array.from({ length: 12 }, (_, i) => ({ name: i % 2 ? '角色' : '用户', is_user: i % 2 === 0, mes: `合成第${i + 1}层：两人首次约会，秘密并未告诉旁人。`, send_date: `2026-10-25 ${i}` }));
const enable = (range = { start: 1, end: 12, total: 12 }) => ({ ...applyOperation(createDocument(binding), { id: 'enable', type: 'enable', expectedRevision: 0, enabled: true, range }).document, autoSummary: true });
const entry = async (id, start, end, text = '初次约会很重要；未告知的秘密不成为他人所知。') => ({ id, kind: 'summary', text, source: { start, end, hashes: (await fingerprintMessages(messages)).slice(start - 1, end) } });
const append = (doc, item, id = item.id) => applyOperation(doc, { id, type: 'append', expectedEpoch: doc.epoch, entry: item }).document;

test('sources fingerprint exact content, sender and time; hiding a floor never invalidates its source', async () => {
    const source = (await entry('s', 2, 4)).source;
    assert.equal(sourceMatches(source, await fingerprintMessages(messages)), true);
    for (const [key, value] of [['mes', '改写'], ['name', '其他人'], ['send_date', '不同时间']]) {
        const copy = structuredClone(messages); copy[2][key] = value;
        assert.equal(sourceMatches(source, await fingerprintMessages(copy)), false);
    }
    // 忆幕按「保留最近 N 层」原生隐藏旧楼；隐藏不改变那层写了什么，来源必须仍然成立，
    // 否则忆幕刚隐藏就把自己的切片判失效，手动总结的下一批随即被「记忆已变化」拦下。
    const hidden = structuredClone(messages); for (const i of [1, 2, 3]) hidden[i].is_system = true;
    assert.equal(sourceMatches(source, await fingerprintMessages(hidden)), true);
    assert.ok(!JSON.stringify(source).includes('约会'));
});

test('feature enable does not authorize automatic work; empty and confirmed history decisions survive reenable', () => {
    const fresh = applyOperation(createDocument(binding), { id: 'x', type: 'enable', expectedRevision: 0, enabled: true }).document;
    assert.equal(fresh.initialRange, null); assert.equal(fresh.autoSummary, false);
    assert.equal(nextBatch(fresh, messages, DEFAULTS), null);
    const empty = enable({ start: 1, end: 0, total: 0 });
    assert.equal(empty.enabled, true);
    const off = applyOperation(empty, { id: 'off', type: 'enable', expectedRevision: 1, enabled: false }).document;
    const on = applyOperation(off, { id: 'on', type: 'enable', expectedRevision: 2, enabled: true }).document;
    assert.deepEqual(on.initialRange, empty.initialRange);
});

test('content batches stop before the three newest floors whatever the kept-recent setting, and start at the chosen first floor', () => {
    // 触发 10 层：12 层未总结已够数，一次总结到「总层数 − 3」为止；正文保留层数（5）不决定终点。
    const auto = { ...DEFAULTS, triggerFloors: 10 };
    assert.equal(REROLL_GUARD, 3);
    assert.deepEqual(nextBatch(enable(), messages, auto), { start: 1, end: 9 });
    assert.deepEqual(nextBatch(enable(), messages, { ...auto, recent: 9 }), { start: 1, end: 9 }, 'recent no longer decides where a summary ends');
    // initialRange.start 是自动总结的起点；end／total 不再限定资格。
    assert.deepEqual(nextBatch(enable({ start: 3, end: 4, total: 12 }), messages, auto), { start: 3, end: 9 });
    assert.equal(nextBatch(enable({ start: 4, end: 4, total: 12 }), messages, auto), null, 'only nine floors from the start point: below the trigger');
    assert.equal(nextBatch(enable(), messages.slice(0, 9), auto), null);
    assert.equal(nextBatch(enable(), messages.slice(0, 3), { ...auto, triggerFloors: 3 }), null, 'the three newest floors are never summarized automatically');
    assert.deepEqual(nextBatch(enable(), messages.slice(0, 4), { ...auto, triggerFloors: 3 }), { start: 1, end: 1 });
    assert.equal(nextBatch(enable(), messages, DEFAULTS), null, 'token-only triggering waits for the token threshold even inside the initial range');
});

test('schema seven preserves schema-six explicit auto choices and migrates earlier enabled chats without writes', () => {
    const fresh = createDocument(binding);
    assert.equal(SCHEMA, 8); assert.equal(fresh.autoSummary, false);
    assert.equal(validateDocument({ ...fresh, schema: 6, enabled: true, autoSummary: false }).autoSummary, false);
    for (const enabled of [true, false]) {
        const legacy = { ...fresh, schema: 5, enabled }; delete legacy.autoSummary;
        assert.equal(validateDocument(legacy).autoSummary, enabled);
        assert.equal(legacy.schema, 5, 'read validation does not mutate old data');
    }
    assert.throws(() => validateDocument({ ...fresh, autoSummary: undefined }), /自动总结/);
});

test('the legacy empty history range now means every floor; a history operation may move the automatic start point later', () => {
    let doc = enable(); doc.initialRange = null;
    doc = applyOperation(doc, { id: 'skip', type: 'history', expectedRevision: doc.configRevision, range: { start: 1, end: 0, total: 12 } }).document;
    // 旧形态 {start:1,end:0,total:T} 不再表示「开启前的楼层不整理」：全部楼层都可总结。
    assert.deepEqual(nextBatch(doc, messages, DEFAULTS, { force: true }), { start: 1, end: 9 });
    assert.deepEqual(nextBatch(doc, messages, { ...DEFAULTS, triggerFloors: 10 }), { start: 1, end: 9 });
    assert.equal(autoBacklog(doc, messages), 9);
    // 「不从首层总结」：起点改到当时那一层，已有的 initialRange 可以被覆盖。
    const moved = applyOperation(doc, { id: 'again', type: 'history', expectedRevision: doc.configRevision, range: { start: 12, end: 12, total: 12 } }).document;
    assert.deepEqual(moved.initialRange, { start: 12, end: 12, total: 12 }); assert.equal(moved.configRevision, doc.configRevision + 1);
    assert.equal(nextBatch(moved, messages, DEFAULTS, { force: true }), null);
    assert.equal(autoBacklog(moved, messages), 0);
    const future = [...messages, ...messages.slice(0, 6)];
    assert.deepEqual(nextBatch(moved, future, DEFAULTS, { force: true }), { start: 12, end: 15 }, 'earlier floors stay out; the newest three stay protected');
    assert.equal(autoBacklog(moved, future), 4);
    assert.equal(autoBacklog({ ...moved, initialRange: null }, future), 0);
});

test('auto switch never turns on the master switch and turning off auto preserves enabled memory use', () => {
    const fresh = createDocument(binding);
    assert.throws(() => applyOperation(fresh, { id: 'auto', type: 'autoSummary', expectedRevision: 0, value: true }), /先启用/);
    const on = enable();
    const off = applyOperation(on, { id: 'auto_off', type: 'autoSummary', expectedRevision: on.configRevision, value: false }).document;
    assert.equal(off.enabled, true); assert.equal(off.autoSummary, false);
    assert.equal(nextBatch(off, messages, DEFAULTS), null);
    assert.deepEqual(nextBatch(off, messages, DEFAULTS, { force: true }), { start: 1, end: 9 });
});

test('manual range preview expands whole affected slices visibly and never relabels outside text', async () => {
    const doc = append(append(enable(), await entry('one', 1, 3)), await entry('two', 5, 7));
    const before = structuredClone(doc);
    const plan = planManualRange(doc, messages, DEFAULTS, { start: 2, end: 6 });
    assert.deepEqual(plan.requestedRange, { start: 2, end: 6 });
    assert.deepEqual(plan.range, { start: 1, end: 7 }); assert.equal(plan.expanded, true);
    // 批次按「每批 N 层」（默认 20）切，不跟随旧切片边界；旧切片随本批整组替换。
    assert.deepEqual(plan.batches.map(batch => [batch.start, batch.end]), [[1, 7]]);
    assert.deepEqual(plan.batches[0].replaces.map(ref => ref.id), ['one', 'two']);
    assert.deepEqual(doc, before);
    const hidden = structuredClone(messages); hidden[3].is_system = true;
    assert.deepEqual(planManualRange(doc, hidden, DEFAULTS, { start: 4, end: 4 }).range, { start: 4, end: 4 });
});

test('manual ranges reject deleted choices, bridge originals, unsupported floors and oversized whole slices', async () => {
    const doc = append(enable(), await entry('one', 1, 4));
    for (const status of ['deleted', 'excluded']) {
        const changed = structuredClone(doc); changed.entries[0].status = status;
        assert.throws(() => planManualRange(changed, messages, DEFAULTS, { start: 2, end: 3 }), /删除|暂不使用/);
    }
    assert.throws(() => planManualRange({ ...doc, lineage: { bridgeCount: 2 } }, messages, DEFAULTS, { start: 1, end: 3 }), /续接/);
    // 单层本身就超出连接容量：整批缩到不能再缩时如实报容量不足，而不是悄悄截断。
    assert.throws(() => planManualRange(doc, messages, { ...DEFAULTS, batch: 1, trigger: 1 }, { start: 2, end: 3 }), /容量/);
    const tools = structuredClone(messages); tools[5].tool_calls = [];
    assert.throws(() => planManualRange(doc, tools, DEFAULTS, { start: 5, end: 7 }), /工具调用/);
});

test('manual exact redo cannot silently shrink an existing source range', async () => {
    const doc = append(enable(), await entry('one', 1, 4));
    const shortened = await entry('one', 2, 3);
    assert.throws(() => applyOperation(doc, { id: 'shrink', type: 'redo', entryId: 'one', expectedEpoch: doc.epoch, expectedRevision: 1,
        entry: shortened }), /不能改变/);
});

test('status counts fine-slice floor unions once; pending work is every unsummarized floor, recent ones included, user-deleted ones excluded', async () => {
    let doc = append(append(enable(), await entry('one', 1, 2)), await entry('two', 4, 4));
    doc.entries[1].status = 'deleted';
    doc.entries.push({ kind: 'stage', status: 'active', source: { ranges: [doc.entries[0].source] } });
    assert.deepEqual(summaryCoverage(doc, messages, DEFAULTS), { sliceCount: 1, organizedFloors: 2, pendingFloors: 9, pendingRange: { start: 3, end: 12 } });
    // 不受正文保留层数与 initialRange 限制：开启前的旧楼也算未整理。
    assert.deepEqual(summaryCoverage({ ...doc, initialRange: { start: 12, end: 12, total: 12 } }, messages, { ...DEFAULTS, recent: 9 }),
        { sliceCount: 1, organizedFloors: 2, pendingFloors: 9, pendingRange: { start: 3, end: 12 } });
    const all = append(enable(), await entry('all', 1, 12));
    assert.deepEqual(summaryCoverage(all, messages, DEFAULTS), { sliceCount: 1, organizedFloors: 12, pendingFloors: 0, pendingRange: null });
});

test('first-enable preview includes hidden source floors while preserving recent raw and hidden flags', () => {
    const source = structuredClone(messages.slice(0, 11));
    source.slice(0, 5).forEach(message => { message.is_system = true; });
    const before = structuredClone(source), doc = enable({ start: 1, end: 11, total: 11 });
    const preview = initialRangePreview(doc, source, { start: 1, end: 11 }, DEFAULTS);
    assert.deepEqual(preview, { valid: true, hidden: [1, 2, 3, 4, 5], recent: [7, 8, 9, 10, 11], handled: [], unsupported: [], eligible: [1, 2, 3, 4, 5, 6] });
    assert.deepEqual(nextBatch(doc, source, { ...DEFAULTS, triggerFloors: 10 }), { start: 1, end: 8 });
    assert.deepEqual(source, before);
    assert.deepEqual(initialRangePreview(doc, source, { start: 3, end: 5 }, DEFAULTS).eligible, [3, 4, 5]);
    assert.deepEqual(initialRangePreview(doc, source, { start: 7, end: 11 }, DEFAULTS).hidden, []);
    assert.deepEqual(initialRangePreview(doc, source, { start: 1, end: 11 }, { recent: 6 }).eligible, [1, 2, 3, 4, 5]);
});

test('initial-range preview never counts tool, empty, inherited or already handled floors as ordinary new work', () => {
    const source = structuredClone(messages);
    source[0].mes = ''; source[1].extra = { tool_invocations: [] }; source[2].tool_calls = [];
    source[3].tool_call_id = 'call-id'; source[11].is_system = true;
    const doc = { lineage: { bridgeCount: 5 }, entries: [{ kind: 'summary', source: { start: 6, end: 6 }, status: 'deleted' }] };
    const preview = initialRangePreview(doc, source, { start: 1, end: 12 }, { recent: 1 });
    assert.deepEqual(preview.handled, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(preview.hidden, [12]); assert.deepEqual(preview.recent, [12]);
    assert.deepEqual(preview.eligible, [7, 8, 9, 10, 11]);
    assert.deepEqual(initialRangePreview({}, source, { start: 1, end: 4 }, DEFAULTS).unsupported, [1, 2, 3, 4]);
    assert.equal(initialRangePreview({}, source, { start: 8, end: 3 }, DEFAULTS).valid, false);
    assert.equal(initialRangePreview({}, source, { start: 1, end: 13 }, DEFAULTS).valid, false);
    assert.equal(initialRangePreview({}, source, { start: 1.5, end: 5 }, DEFAULTS).valid, false);
});

test('incremental batches require content threshold, explicit summarize may process the smaller gap', async () => {
    const doc = append(enable({ start: 1, end: 2, total: 2 }), await entry('a', 1, 2));
    assert.equal(nextBatch(doc, messages, DEFAULTS), null);
    assert.deepEqual(nextBatch(doc, messages, DEFAULTS, { force: true }), { start: 3, end: 9 });
});

test('deleted and excluded slices do not silently reappear; invalid sources wait for an explicit user repair', async () => {
    let doc = append(enable(), await entry('a', 1, 4));
    // 第 5–12 层共 8 层未总结：触发设为 8 才够数；被删除的第 1–4 层不算进度，也不会被重新总结。
    const auto = { ...DEFAULTS, triggerFloors: 8 };
    doc = applyOperation(doc, { id: 'del', type: 'entry', entryId: 'a', expectedRevision: 1, action: 'delete' }).document;
    assert.deepEqual(nextBatch(doc, messages, auto), { start: 5, end: 9 });
    assert.equal(nextBatch(doc, messages, { ...auto, triggerFloors: 9 }), null, 'deleted floors do not count toward the trigger');
    doc = append(enable(), await entry('b', 1, 4));
    doc = applyOperation(doc, { id: 'bad', type: 'invalidate', entries: [{ id: 'b', revision: 1 }] }).document;
    assert.deepEqual(nextBatch(doc, messages, auto), { start: 5, end: 9 });
    assert.deepEqual(nextBatch(doc, messages, DEFAULTS, { force: true }), { start: 5, end: 9 });
    doc = applyOperation(doc, { id: 'edit', type: 'edit', entryId: 'b', expectedRevision: 2, text: '手动修订' }).document;
    assert.equal(doc.entries[0].status, 'invalid');
    assert.deepEqual(nextBatch(doc, messages, auto), { start: 5, end: 9 });
});

test('invalidation only touches affected active sources and never revives on raw rollback', async () => {
    let doc = append(append(enable(), await entry('a', 1, 2)), await entry('b', 3, 4));
    const changed = structuredClone(messages); changed[1].mes = '改写';
    const scan = await inspectSources(doc, changed);
    assert.deepEqual(scan.invalid, [{ id: 'a', revision: 1 }]);
    doc = applyOperation(doc, { id: 'invalidate', type: 'invalidate', entries: scan.invalid }).document;
    assert.equal(doc.entries[1].status, 'active');
    assert.deepEqual((await inspectSources(doc, messages)).invalid, []);
    assert.equal(doc.entries[0].status, 'invalid', 'matching the old text again does not auto-reactivate it');
});

test('summary schema requires complete ordered source coverage, never trusts fabricated floor bounds', async () => {
    const hashes = await fingerprintMessages(messages), batch = { start: 1, end: 4 };
    const parsed = parseSummary(JSON.stringify({ slices: [{ start: 1, end: 2, text: '前半' }, { start: 3, end: 4, text: '后半未结束' }] }), batch, hashes);
    // Two bare fragments now coalesce into one slice; coverage is still exact and ordered.
    assert.deepEqual(parsed.map(item => [item.source.start, item.source.end]), [[1, 4]]);
    for (const slices of [[], [{ start: 1, end: 3, text: '缺层' }], [{ start: 0, end: 4, text: '越界' }], [{ start: 1, end: 4, text: '' }], [{ start: 1, end: 2, text: 'a' }, { start: 2, end: 4, text: 'b' }]]) {
        assert.throws(() => parseSummary(JSON.stringify({ slices }), batch, hashes));
    }
    assert.throws(() => parseSummary('不是 JSON', batch, hashes));
    const prompt = summaryPrompt(messages, batch, DEFAULTS);
    assert.ok(prompt.includes('区分公开事实与各角色的个体知情范围'));
    assert.ok(!prompt.includes('合成第5层'));
});

test('generation selects only whole valid slices outside recent raw, with explicit token estimate and no raw mutation', async () => {
    let doc = append(append(enable(), await entry('a', 1, 2)), await entry('b', 8, 9));
    const before = structuredClone(messages);
    const plan = await buildPlan(doc, createDefaults(), { messages, maxContext: 8192 });
    assert.deepEqual(plan.memoryIds, ['a']);
    assert.equal(plan.estimated, true);
    assert.deepEqual(messages, before);
    const tiny = createDefaults(); tiny.values.budget = 1; // 设置是账户全局的：预算写在全局默认里
    const tinyBudget = await buildPlan(doc, tiny, { messages, maxContext: 8192 });
    assert.equal(tinyBudget.settings.budget, 1, 'selection retains complete entries; final-payload admission enforces the actual budget');
    assert.equal(tinyBudget.entries[0].text, doc.entries[0].text);
});

test('a slice inside the kept recent window is injected only when every floor it covers is already hidden', async () => {
    const doc = append(append(enable(), await entry('a', 1, 2)), await entry('b', 8, 9));
    const plan = async source => [...(await buildPlan(doc, createDefaults(), { messages: source, maxContext: 8192 })).memoryIds].sort();
    // 重新生成／删掉最新几层之后保留区暂时前移：原文已经隐藏的那一段仍由它的切片顶上。
    const hidden = structuredClone(messages); hidden[7].is_system = true; hidden[8].is_system = true;
    assert.deepEqual(await plan(hidden), ['a', 'b']);
    const partly = structuredClone(messages); partly[7].is_system = true;
    assert.deepEqual(await plan(partly), ['a'], 'one visible floor keeps the slice out, symmetric with hiding');
});

test('source-changed slices remain injected while raw edited floors stay intact', async () => {
    let doc = append(enable(), await entry('stale', 1, 2));
    doc = applyOperation(doc, { id: 'invalidate-stale', type: 'invalidate', entries: [{ id: 'stale', revision: 1 }] }).document;
    const changed = structuredClone(messages); changed[0].mes = '用户后来改写的正文';
    const plan = await buildPlan(doc, createDefaults(), { messages: changed, maxContext: 8192 });
    assert.deepEqual(plan.memoryIds, ['stale']);
    const core = changed.map((message, index) => ({ ...message, index }));
    const { processed } = captureCore(core, { messages: changed }, { namesBehavior: 0, userName: '用户' });
    const result = await buildBudgetedMessages({ messages: processed.map(item => item.request) }, {
        entries: plan.entries, processed, sourceHashes: await fingerprintMessages(changed), recent: DEFAULTS.recent,
        budget: 20000, contextTokens: 60000, responseTokens: 1024,
    });
    assert.equal(result.applied, true);
    assert.deepEqual(result.removedFloors, []);
    assert.equal(result.entries[0].id, 'stale');
    assert.match(result.messages.find(message => message.content.startsWith('<yimu_memory>')).content, /stale/);
});

test('summary prompt balances source-grounded narrative texture with factual and knowledge boundaries', () => {
    const source = [
        {name: '甲', mes: '甲将茶杯往乙手边推了推，说：“趁热。”乙没有回答。'},
        {name: '乙', mes: '第二天，乙照常买菜回家，没有提起那杯茶。'},
        {name: '甲', mes: '范围外内容不能带入。'},
    ], before = structuredClone(source);
    const prompt = summaryPrompt(source, {start: 1, end: 2}, DEFAULTS);
    for (const rule of ['精炼连贯、表意自足的叙事单元', '情绪流转', '缺乏原文支撑的字段保持空缺', '贴合原文情绪浓度',
        '不推演角色深层动机', '区分公开事实与各角色的个体知情范围', 'scenes']) assert.ok(prompt.includes(rule), rule);
    assert.deepEqual(JSON.parse(prompt.split('原文：')[1]), source.slice(0, 2).map((m, i) => ({floor: i + 1, speaker: m.name, role: 'character', text: m.mes})));
    assert.deepEqual(source, before);
    const withRecall = summaryPrompt(source, {start: 1, end: 2}, DEFAULTS, {recallCandidates: [{id: 'past', text: '往事'}]});
    assert.ok(withRecall.includes('确有明确旧细节缺口'));
});

test('memory-use guidance does not dictate the current mood or rewrite hand-edited narrative text', async () => {
    let doc = append(enable(), await entry('a', 1, 2));
    const text = '甲只说了“趁热”。乙没有回答；两人的心意尚未明说。';
    doc = applyOperation(doc, {id: 'texture-edit', type: 'edit', entryId: 'a', expectedRevision: 1, text}).document;
    const before = structuredClone(doc);
    const plan = await buildPlan(doc, createDefaults(), {messages, maxContext: 8192});
    assert.equal(plan.entries[0].text, text);
    assert.ok(plan.prompt.includes(JSON.stringify(text)));
    for (const rule of ['不是当前场景的固定基调', '近期原文的文风', '不模仿摘要的压缩措辞', '不改变手动修订的含义']) assert.ok(plan.prompt.includes(rule), rule);
    assert.deepEqual(doc, before);
});

test('manual memories are source-free; excluded or mismatched summaries cannot be injected', async () => {
    let doc = append(enable(), await entry('a', 1, 2));
    doc = append(doc, { id: 'manual', kind: 'manual', text: '计划尚未完成。', source: null,
        placement: { binding, fromFloor: 2, hash: (await fingerprintMessages(messages))[1] } });
    const changed = structuredClone(messages); changed[0].mes = '改变';
    const plan = await buildPlan(doc, createDefaults(), { messages: changed, maxContext: 8192 });
    assert.deepEqual(plan.memoryIds, ['manual']);
    assert.match(plan.prompt, /自定义切片/);
});

test('same-record concurrent writes preserve both contents and unrelated record edits remain writable', async () => {
    let doc = append(append(enable(), await entry('a', 1, 2)), await entry('b', 3, 4));
    doc = applyOperation(doc, { id: 'edit1', type: 'edit', entryId: 'a', expectedRevision: 1, text: '已保存版' }).document;
    const conflict = applyOperation(doc, { id: 'edit2', type: 'edit', entryId: 'a', expectedRevision: 1, text: '另一设备稿' });
    assert.equal(conflict.outcome, 'conflict');
    assert.equal(conflict.document.entries[0].text, '已保存版');
    assert.equal(conflict.document.entries[0].conflicts[0].text, '另一设备稿');
    doc = applyOperation(conflict.document, { id: 'editB', type: 'edit', entryId: 'b', expectedRevision: 1, text: 'B独立保存' }).document;
    assert.equal(doc.entries[1].text, 'B独立保存');
});

test('ordinary edit supports undo, and human redo only produces an inline candidate', async () => {
    const original = await entry('a', 1, 2);
    let doc = append(enable(), original);
    doc = applyOperation(doc, { id: 'edit', type: 'edit', entryId: 'a', expectedRevision: 1, text: '人工版本' }).document;
    doc = applyOperation(doc, { id: 'redo', type: 'redo', entryId: 'a', expectedRevision: 2, expectedEpoch: doc.epoch, entry: { ...original, text: '模型候选' } }).document;
    assert.equal(doc.entries[0].text, '人工版本');
    assert.equal(doc.entries[0].candidate.text, '模型候选');
    doc = applyOperation(doc, { id: 'undo', type: 'entry', entryId: 'a', expectedRevision: 3, action: 'undoText' }).document;
    assert.equal(doc.entries[0].text, original.text);
});

test('stale enable and summary epochs cannot overwrite changes, replay IDs never hide different content', () => {
    const doc = enable();
    assert.throws(() => applyOperation(doc, { id: 'old', type: 'enable', expectedRevision: 0, enabled: false }));
    const op = { id: 'manual1', type: 'append', entry: { id: 'm', kind: 'manual', text: '手动', source: null,
        placement: { binding, fromFloor: 1, hash: 'a'.repeat(64) } } };
    const saved = applyOperation(doc, op).document;
    assert.equal(applyOperation(saved, op).outcome, 'duplicate');
    assert.throws(() => applyOperation(saved, { ...op, entry: { ...op.entry, text: '不同内容' } }), /不同内容/);
});

test('global defaults patch rather than resetting unrelated settings, explicit null resets just that field', () => {
    let defaults = applyDefaultsOperation(factoryDefaults(), { id: 'd1', expectedRevision: 0, values: { profileId: 'profile', preference: '侧重承诺' } }).defaults;
    defaults = applyDefaultsOperation(defaults, { id: 'd2', expectedRevision: 1, values: { recent: 8 } }).defaults;
    assert.equal(defaults.values.profileId, 'profile');
    defaults = applyDefaultsOperation(defaults, { id: 'd3', expectedRevision: 2, values: { recent: null } }).defaults;
    assert.equal(defaults.values.recent, FACTORY_DEFAULTS.recent);
    assert.equal(defaults.values.preference, '侧重承诺');
});

test('schema eight accepts optional temporal fields for fact lifecycle tracking', async () => {
    assert.equal(SCHEMA, 8);
    const doc = enable();
    // Temporal fields are optional and validated when present
    const withTemporal = await entry('t1', 2, 4, '事实在第二幕确立。');
    withTemporal.validFrom = 2;
    withTemporal.validTo = 10;
    withTemporal.observedAt = 4;
    withTemporal.supersedes = ['old1', 'old2'];
    withTemporal.factStatus = 'active';
    const saved = append(doc, withTemporal);
    const retrieved = saved.entries.find(e => e.id === 't1');
    assert.equal(retrieved.validFrom, 2);
    assert.equal(retrieved.validTo, 10);
    assert.equal(retrieved.observedAt, 4);
    assert.deepEqual(retrieved.supersedes, ['old1', 'old2']);
    assert.equal(retrieved.factStatus, 'active');
    // Entries without temporal fields remain valid
    const plain = await entry('t2', 5, 6, '普通记忆无时效字段。');
    const plainSaved = append(saved, plain);
    assert.equal(plainSaved.entries.find(e => e.id === 't2').validFrom, undefined);
    // Invalid temporal fields are rejected
    const badFrom = await entry('bad1', 7, 8);
    badFrom.validFrom = 0;
    assert.throws(() => append(plainSaved, badFrom), /validFrom/);
    const badTo = await entry('bad2', 7, 8);
    badTo.validFrom = 10;
    badTo.validTo = 5;
    assert.throws(() => append(plainSaved, badTo), /validTo.*validFrom/);
    const badSupersedes = await entry('bad3', 7, 8);
    badSupersedes.supersedes = ['valid-id', 'invalid id with spaces'];
    assert.throws(() => append(plainSaved, badSupersedes), /标识无效/);
    const badStatus = await entry('bad4', 7, 8);
    badStatus.factStatus = 'unknown';
    assert.throws(() => append(plainSaved, badStatus), /factStatus/);
});


test('automatic trigger counts every unsummarized floor and organizes up to the three newest ones, in batches when the backlog is long', async () => {
    const live = Array.from({ length: 30 }, (_, i) => ({ name: i % 2 ? '角色' : '用户', is_user: i % 2 === 0, mes: '文'.repeat(400), send_date: `t${i}` }));
    const doc = enable({ start: 1, end: 0, total: 0 });
    const tokensOnly = { ...DEFAULTS, trigger: 50000, triggerFloors: 0 };
    assert.equal(nextBatch(doc, live, tokensOnly), null, 'zero floor count keeps token-only behaviour');
    // 用户 2026-11-21 的口径：10 层、触发 10、保留 5 → 总结第 1–7 层。保留层、保护层都算进度，
    // 正文保留层数不决定总结到哪一层。
    const habit = { ...DEFAULTS, trigger: 50000, triggerFloors: 10, recent: 5 };
    assert.equal(nextBatch(doc, live.slice(0, 9), habit), null, '十层未满，不动');
    assert.deepEqual(nextBatch(doc, live.slice(0, 10), habit), { start: 1, end: 7 });
    assert.deepEqual(nextBatch(doc, live.slice(0, 10), { ...habit, recent: 1 }), { start: 1, end: 7 });
    // 自动总结按回合对齐：终点是用户发言时回退一层。
    assert.equal(live[6].is_user, true);
    assert.deepEqual(nextBatch(doc, live.slice(0, 10), habit, { align: true }), { start: 1, end: 6 });
    assert.deepEqual(nextBatch(doc, live.slice(0, 11), habit, { align: true }), { start: 1, end: 8 });
    // Factory defaults (10 / 5).
    const factory = { ...FACTORY_DEFAULTS, trigger: 50000 };
    assert.equal(FACTORY_DEFAULTS.triggerFloors, 10); assert.equal(FACTORY_DEFAULTS.recent, 5);
    assert.equal(nextBatch(doc, live.slice(0, 9), factory), null);
    assert.deepEqual(nextBatch(doc, live.slice(0, 10), factory), { start: 1, end: 7 });
    // Later rounds count every floor not yet summarized, the protected newest ones included.
    const hashes = await fingerprintMessages(live);
    const cover = (base, id, start, end) => applyOperation(base, { id: `op_${id}`, type: 'append', expectedEpoch: base.epoch, entry: { id, kind: 'summary', text: '摘要',
        source: { start, end, hashes: hashes.slice(start - 1, end) } } }).document;
    const organized = cover(doc, 's1', 1, 7);
    assert.equal(nextBatch(organized, live.slice(0, 16), factory), null);
    assert.deepEqual(nextBatch(organized, live.slice(0, 17), factory), { start: 8, end: 14 });
    // 积压多时按触发楼层数分批；剩下不超过一批半就并成一批。
    assert.deepEqual(nextBatch(doc, live.slice(0, 18), factory), { start: 1, end: 15 }, 'fifteen floors are one batch and a half: still one request');
    assert.deepEqual(nextBatch(doc, live.slice(0, 19), factory), { start: 1, end: 10, targetEnd: 16 });
    assert.deepEqual(nextBatch(doc, live, factory), { start: 1, end: 10, targetEnd: 27 });
    const second = cover(doc, 'b1', 1, 10);
    assert.deepEqual(nextBatch(second, live, factory, { limitEnd: 27 }), { start: 11, end: 20, targetEnd: 27 });
    assert.deepEqual(nextBatch(cover(second, 'b2', 11, 20), live, factory, { limitEnd: 27 }), { start: 21, end: 27 }, 'the seven left over are one last batch');
    // 强制总结同样以「总层数 − 3」为界；historyOnly 仍受 initialRange.end 限制。
    assert.deepEqual(nextBatch(organized, live.slice(0, 12), factory, { force: true }), { start: 8, end: 9 });
    assert.deepEqual(nextBatch(enable({ start: 1, end: 4, total: 12 }), live.slice(0, 12), factory, { force: true, historyOnly: true }), { start: 1, end: 4 });
    assert.deepEqual(nextBatch(doc, live.slice(0, 19), { ...DEFAULTS, trigger: 2000, triggerFloors: 20 }), { start: 1, end: 5 }, 'tokens can still arrive first');
    const short = live.map(message => ({ ...message, mes: '短句。' }));
    assert.deepEqual(nextBatch(doc, short.slice(0, 6), { ...tokensOnly, triggerFloors: 3, recent: 1 }), { start: 1, end: 3 }, 'no minimum token floor once the floor count is reached');
    assert.throws(() => validateSettingsFor({ triggerFloors: 2001 }), /超出范围/);
    assert.deepEqual(validateSettingsFor({ triggerFloors: 0 }), { triggerFloors: 0 });
});

test('the hide boundary is independent of what this round injects: the kept recent floors stay visible and slices hide whole', () => {
    const live = n => Array.from({ length: n }, (_, i) => ({ mes: `第${i + 1}层` }));
    const summary = (id, start, end) => ({ id, kind: 'summary', status: 'active', revision: 1, origin: null, text: id, source: { start, end } });
    const doc = entries => ({ entries });
    const span = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i);
    // 用户 2026-11-19 的例子：28 层、每 10 层一总结、保留 5 层 → 隐藏到 23，可见的永远是最近 5 层。
    assert.deepEqual(hiddenFloorsFor(doc([summary('a', 1, 10), summary('b', 11, 20), summary('c', 21, 23)]), live(28), { recent: 5 }).floors, span(1, 23));
    // 往前推进到 40 层、全部覆盖时，隐藏边界跟着保留层走（35），而不是停在 23。
    assert.equal(hiddenFloorsFor(doc([summary('a', 1, 35)]), live(40), { recent: 5 }).floors.at(-1), 35);
    // 保留区之内即使已经被总结覆盖也保持原文可见；隐藏边界严格等于保留层数，切片压在边界上时只藏它在保留区之外的楼层。
    assert.deepEqual(hiddenFloorsFor(doc([summary('a', 1, 10)]), live(10), { recent: 5 }), { frontier: 10, floors: span(1, 5), keep: 5, total: 10 });
    assert.deepEqual(hiddenFloorsFor(doc([summary('a', 1, 10)]), live(14), { recent: 5 }).floors, span(1, 9));
    assert.deepEqual(hiddenFloorsFor(doc([summary('a', 1, 10)]), live(15), { recent: 5 }).floors, span(1, 10));
    // 用户 2026-11-22 的例子：共 23 层、已总结到第 19 层、保留 5 层 → 隐藏到第 18 层（界面上是 0–17），不因最后一条切片压线而停在更前面。
    const crossing = hiddenFloorsFor(doc([summary('a', 1, 15), summary('b', 16, 19)]), live(23), { recent: 5 });
    assert.deepEqual(crossing.floors, span(1, 18)); assert.equal(crossing.frontier, 19);
    // 多段来源的切片同样按楼层算。
    const split = { ...summary('m', 1, 3), source: { ranges: [{ start: 1, end: 3 }, { start: 9, end: 11 }] } };
    assert.deepEqual(hiddenFloorsFor(doc([split]), live(12), { recent: 2 }).floors, [1, 2, 3, 9, 10]);
    assert.deepEqual(hiddenFloorsFor(doc([split]), live(13), { recent: 2 }).floors, [1, 2, 3, 9, 10, 11]);
    // 中间有缺口：没总结的那一层自己保持可见，不挡后面已总结楼层的隐藏；frontier 仍是从第 1 层起连续覆盖到的位置。
    const gap = hiddenFloorsFor(doc([summary('a', 1, 3), summary('b', 5, 9)]), live(12), { recent: 2 });
    assert.deepEqual(gap.floors, [1, 2, 3, 5, 6, 7, 8, 9]); assert.equal(gap.frontier, 3);
    assert.deepEqual(hiddenFloorsFor(doc([summary('b', 5, 9)]), live(12), { recent: 2 }), { frontier: 0, floors: [5, 6, 7, 8, 9], keep: 2, total: 12 });
    assert.equal(hiddenFloorsFor(doc([summary('a', 1, 9)]), live(12), { recent: 2 }).floors.length, 9);
    // 删除的、屏蔽的、继承的来源都不授权隐藏。
    assert.deepEqual(hiddenFloorsFor(doc([{ ...summary('a', 1, 9), status: 'deleted' }]), live(12), { recent: 2 }).floors, []);
    assert.deepEqual(hiddenFloorsFor(doc([summary('a', 1, 9), { ...summary('b', 10, 12), status: 'excluded' }]), live(12), { recent: 0 }).floors, span(1, 9));
    assert.deepEqual(hiddenFloorsFor(doc([{ ...summary('a', 1, 9), origin: { binding: { file: 'other' } } }]), live(12), { recent: 0 }).floors, []);
    // 一个聊天都没有时什么都不藏。
    assert.deepEqual(hiddenFloorsFor(doc([]), [], { recent: 5 }).floors, []);
});

test('floor numbers shown to the user follow ST #0 numbering while storage stays 1-based', async () => {
    const { shownFloor, floorField, floorValue } = await import('../yimu/contract.mjs');
    assert.equal(shownFloor(1), 0); assert.equal(shownFloor(15), 14);
    assert.equal(floorField(1), '0'); assert.equal(floorField(15), '14'); assert.equal(floorField(0), ''); assert.equal(floorField(undefined), '');
    assert.equal(floorValue('0'), 1); assert.equal(floorValue('14'), 15); assert.equal(floorValue(''), 0); assert.equal(floorValue(' '), 0);
    for (const floor of [1, 2, 9, 120]) assert.equal(floorValue(floorField(floor)), floor);
    assert.ok(Number.isNaN(floorValue('abc')));
    // The manual range validator still rejects what an empty or invalid field converts to.
    const live = Array.from({ length: 3 }, (_, i) => ({ mes: `正文${i}` }));
    assert.throws(() => planManualRange(null, live, DEFAULTS, { start: floorValue(''), end: floorValue('2') }), /有效的起止楼层/);
    assert.throws(() => planManualRange(null, live, DEFAULTS, { start: floorValue('0'), end: floorValue('3') }), /有效的起止楼层/);
});

// 设置是账户全局的（2026-11-24）：向量开关写在全局默认里。
const vectorDefaults = () => { const defaults = createDefaults(); defaults.values.vectorEnabled = true; return defaults; };

test('vector similarity only reorders selection when the account enables it, and a failed lookup falls back quietly', async () => {
    let doc = append(append(append(enable(), await entry('a', 1, 2)), await entry('c', 3, 4)), await entry('d', 5, 6));
    const snapshot = { messages, maxContext: 8192 }, asked = [];
    const semanticScores = async request => { asked.push(request); return new Map([['a', 0.1], ['c', 0.9], ['d', 0.2]]); };
    const plain = await buildPlan(doc, createDefaults(), snapshot, { semanticScores });
    assert.equal(asked.length, 0, 'the provider is not called unless this chat turned vectors on');
    assert.equal(plain.semantic, false);
    const ranked = await buildPlan(doc, vectorDefaults(), snapshot, { semanticScores });
    assert.equal(asked.length, 1); assert.equal(ranked.semantic, true);
    assert.deepEqual(asked[0].candidates.map(item => item.id).sort(), ['a', 'c', 'd']);
    assert.equal(asked[0].query, messages.slice(-DEFAULTS.recent).map(message => message.mes).join('\n'), 'the query is the recent raw text');
    assert.equal(ranked.entries[0].id, 'c', 'the most similar slice is admitted first');
    assert.deepEqual([...ranked.memoryIds].sort(), [...plain.memoryIds].sort(), 'similarity changes order, not which slices are eligible');
    for (const broken of [async () => { throw new Error('offline'); }, async () => null, async () => new Map()]) {
        const fallback = await buildPlan(doc, vectorDefaults(), snapshot, { semanticScores: broken });
        assert.equal(fallback.semantic, false); assert.deepEqual(fallback.memoryIds, plain.memoryIds);
    }
});

test('a caller query replaces the recent story window for relevance only; without one nothing changes', async () => {
    const doc = append(append(append(enable(), await entry('a', 1, 2, 'lighthouse keeper storm')), await entry('c', 3, 4, 'orchard harvest cider')), await entry('d', 5, 6, 'library ledger shelf'));
    const story = structuredClone(messages); story[11].mes = 'orchard harvest again';
    const snapshot = { messages: story, maxContext: 8192 };
    const plain = await buildPlan(doc, createDefaults(), snapshot);
    assert.equal(plain.entries[0].id, 'c', 'the story\'s own recent floors favour the orchard slice');
    for (const queryText of [undefined, '', '   ', 42]) {
        const same = await buildPlan(doc, createDefaults(), snapshot, { queryText });
        assert.deepEqual(same.memoryIds, plain.memoryIds); assert.equal(same.prompt, plain.prompt);
    }
    const asked = await buildPlan(doc, createDefaults(), snapshot, { queryText: 'who kept the lighthouse in the storm' });
    assert.equal(asked.entries[0].id, 'a', 'the query, not the story window, ranks the slices');
    assert.ok(asked.memoryIds.indexOf('a') < asked.memoryIds.indexOf('c'));
    assert.deepEqual(asked.coveredRanges.length, asked.memoryIds.length, 'eligibility rules are untouched');
    const requests = [];
    const semanticScores = async request => { requests.push(request.query); return new Map([['a', 0.5]]); };
    await buildPlan(doc, vectorDefaults(), snapshot, { semanticScores, queryText: '  lighthouse  ' });
    await buildPlan(doc, vectorDefaults(), snapshot, { semanticScores });
    assert.deepEqual(requests, ['lighthouse', story.slice(-DEFAULTS.recent).map(message => message.mes).join('\n')]);
});

test('word lists are remembered per text and callers that extend one work on their own copy', async () => {
    const { narrativeTerms } = await import('../yimu/core.mjs'), { recallCandidateScore } = await import('../yimu/recall.mjs');
    const text = '她在雨夜的车站等那封迟到的信', first = narrativeTerms(text), size = first.size;
    assert.equal(narrativeTerms(text), first, 'the same text is segmented once');
    recallCandidateScore({ id: 'x', title: text, text, scenes: [] }, text, { recallSynonyms: '车站=站台=月台' });
    assert.equal(narrativeTerms(text).size, size, 'synonym expansion elsewhere never leaks into the remembered list');
});

test('a closed panel is not repainted and a quiet refresh does not probe a service it has just confirmed', async () => {
    const { readFile } = await import('node:fs/promises');
    const [entry, runtime, view] = await Promise.all(['index.mjs', 'runtime.mjs', 'view.mjs'].map(name => readFile(new URL(`../yimu/${name}`, import.meta.url), 'utf8')));
    assert.match(entry, /if \(view\.isOpen\?\.\(\) === false\) \{ pending = \{ \.\.\.shown, ui \}; return; \}/);
    assert.match(entry, /view\.open\(\);\s*if \(pending\) \{ const state = pending; pending = null; view\.render\(state\); \}/, 'the latest state is painted when the panel opens');
    assert.match(view, /render, open, close, isOpen: \(\) => opened,/);
    assert.match(runtime, /if \(quiet && probe && !serviceFresh\(\)\) await checkService\(\);/);
    // 生成前的那次刷新不先探服务（省一次网络往返），三处调用（回合开头、提前跑掉排队的、补发的干净读取）都显式关掉。
    assert.equal(runtime.match(/generationRefresh = refresh\(\{ quiet: true, auto: false, probe: false \}\)/g)?.length, 3);
    assert.match(runtime, /state\.service\?\.status === 'ok' && Date\.now\(\) - serviceOkAt < serviceFreshMs/);
});

// ---- linked reading memories (关联伴读) ----
const H = char => char.repeat(64);
let linkHash = 0;
const linkBook = (value, id, title, entries, { terms = [title], floor = null, note = '' } = {}) => mergeCompanionBook(value, {
    account: 'st-user:fixture', key: `scope::${id}`, bookId: id, scope: 'scope', persona: 'Persona.png', avatar: 'Char.png', title, charName: '角色', userName: '用户',
    confirmedReadTo: 1000, readLabel: '第2章 · 30%', terms, hash: H('a'),
    entries: entries.map(([entryId, kind, text, readTo = 10, keywords]) => ({ id: entryId, kind, text, readTo, ...(keywords ? { keywords } : {}), hash: (++linkHash).toString(16).padStart(16, '0').padEnd(64, '0') })),
}, { anchor: floor ? { floor, hash: H('b') } : null, note: note ? { text: note, hash: H('c') } : null });
const reading = plan => plan.entries.filter(item => item.companion).map(item => item.companion.sourceId);
const saying = text => { const copy = structuredClone(messages); copy[11].mes = text; return { messages: copy, maxContext: 8192 }; };
const hotel = () => linkBook(null, 'hotel', '海边旅馆', [
    ['h1', 'book', '林晚登记入住。', 100, ['登记']], ['h2', 'book', '老板说起一场旧火灾。', 200, ['火灾', '老板']],
    ['h3', 'book', '林晚发现地下室的钥匙。', 300, ['钥匙']], ['h4', 'book', '结尾前的暴风雨。', 400],
    ['hd', 'dialog', '两人猜测老板隐瞒了什么。', 250]], { terms: ['海边旅馆', '林晚'] });
const train = value => linkBook(value, 'train', '雪国日记', [
    ['t1', 'book', '主角弄丢了车票。', 50, ['车票']], ['t2', 'book', '列车停在无人小站。', 90, ['小站']], ['td', 'dialog', '两人讨论主角为何不下车。', 60]]);

test('linked reading memories are no longer force-selected: the story comes first and the shared layer is small', async () => {
    let doc = append(enable(), await entry('s', 1, 3));
    doc.companion = linkBook(null, 'hotel', '海边旅馆', [...Array.from({ length: 10 }, (_, i) => [`d${i}`, 'dialog', `无关的闲谈${i}`, i + 1]), ['b', 'book', '书里的情节。', 5]]);
    let plan = await buildPlan(doc, createDefaults(), { messages, maxContext: 8192 });
    assert.equal(plan.memoryIds[0], 's', 'story memories keep their place at the head of the queue');
    assert.deepEqual(reading(plan), ['d9', 'd8'], 'only the two latest exchanges come along when nothing is relevant');
    assert.deepEqual(plan.coveredRanges, [{ start: 1, end: 3, hashes: (await fingerprintMessages(messages)).slice(0, 3) }]);
    doc.companion = train(doc.companion);
    assert.deepEqual(reading(await buildPlan(doc, createDefaults(), { messages, maxContext: 8192 })), ['td', 'd9', 'd8'], 'two latest per book');
    // Relevant exchanges join, but never more than six across all books; the most relevant first.
    doc.companion = linkBook(doc.companion, 'dates', '约会手册', Array.from({ length: 9 }, (_, i) => [`r${i}`, 'dialog', `他们聊起首次约会${i}`, i + 1]), { terms: [] });
    plan = await buildPlan(doc, createDefaults(), { messages, maxContext: 8192 });
    assert.equal(reading(plan).length, 6); assert.ok(reading(plan).every(id => id.startsWith('r')), 'what bears on the current wording outranks mere recency');
    assert.ok(plan.entries.every(item => item.companion?.layer !== 'book'));
    // Every note is wanted, still inside the cap.
    let noted = linkBook(null, 'hotel', '海边旅馆', [['d0', 'dialog', '无关的闲谈', 1]], { note: '第一次记事' });
    noted = linkBook(noted, 'hotel', '海边旅馆', [['d0', 'dialog', '无关的闲谈', 1]], { note: '第二次记事' });
    doc.companion = noted;
    plan = await buildPlan(doc, createDefaults(), { messages, maxContext: 8192 });
    assert.deepEqual(reading(plan), ['note:2', 'note:1', 'd0']);
    assert.match(plan.prompt, /共读记事 ·《海边旅馆》/); assert.match(plan.prompt, /共读交流 ·《海边旅馆》· 读到 第2章 · 30%/);
    assert.doesNotMatch(plan.prompt, /标注「共读书中内容」/, 'the book notice appears only with book content');
});

test('book content is brought only when that book is mentioned: by title, by a bound term or by a slice keyword', async () => {
    const doc = enable(); doc.companion = hotel();
    const plan = text => buildPlan(doc, createDefaults(), text ? saying(text) : { messages, maxContext: 8192 });
    assert.deepEqual(reading(await plan()), ['hd'], 'the gate is closed while the book is not mentioned');
    assert.deepEqual(reading(await plan('今天去海边走走吧')), ['hd'], 'half a title does not open it');
    assert.deepEqual(reading(await plan('你还记得《海边旅馆》吗')), ['hd', 'h4', 'h3', 'h2'], 'only the title: recall where the two had got to');
    assert.deepEqual(reading(await plan('林晚后来怎么样了')), ['hd', 'h4', 'h3', 'h2'], 'a bound dictionary name opens the same book');
    const fire = await plan('那场火灾你还记得吗');
    assert.deepEqual(reading(fire), ['hd', 'h2'], 'a slice keyword brings the slices that match it');
    assert.match(fire.prompt, /共读书中内容 ·《海边旅馆》· 只读到 第2章 · 30% · 这是角色和用户一起读过的书里的情节，不是亲身经历；只有他们两人读过/);
    assert.match(fire.prompt, /标注「共读书中内容」的条目是两人一起读的书，谈到这本书时据此回忆，不超出所标已读位置，不当作亲历，也不推定他人知道。/);
    assert.deepEqual(fire.coveredRanges, []); assert.ok(fire.entries.every(item => item.source === null));
    assert.deepEqual(reading(await plan('ＦＩＲＥ 那场火灾 ＯＫ')), ['hd', 'h2'], 'full-width and case differences do not matter');
    assert.deepEqual(reading(await buildPlan(doc, createDefaults(), { messages, maxContext: 8192 }, { queryText: '钥匙放在哪里' })), ['hd', 'h3'], 'a caller query replaces the recent window');
});

test('each linked book has its own gate: mentioning one never pulls another', async () => {
    const doc = enable(); doc.companion = train(hotel());
    const plan = text => buildPlan(doc, createDefaults(), saying(text));
    assert.deepEqual(reading(await plan('车票后来找到了吗')).filter(id => !id.endsWith('d')), ['t1']);
    assert.deepEqual(reading(await plan('你还记得《雪国日记》吗')).filter(id => !id.endsWith('d')), ['t2', 't1']);
    assert.deepEqual(reading(await plan('那场火灾你还记得吗')).filter(id => !id.endsWith('d')), ['h2']);
    const both = reading(await plan('火灾和车票哪个更吓人')).filter(id => !id.endsWith('d'));
    assert.deepEqual(both.sort(), ['h2', 't1']);
    assert.deepEqual(reading(await plan('今天天气不错')).filter(id => !id.endsWith('d')), []);
});

test('at most three whole book slices and 2400 characters come along', async () => {
    const doc = enable(), filler = size => `钥匙的故事。${'字'.repeat(size - 6)}`;
    doc.companion = linkBook(null, 'keys', '钥匙之书', [['big1', 'book', filler(1000), 100, ['钥匙']], ['big2', 'book', filler(1000), 200, ['钥匙']],
        ['big3', 'book', filler(1000), 300, ['钥匙']], ['small', 'book', filler(300), 50, ['钥匙']], ['tiny', 'book', filler(20), 40, ['钥匙']]], { terms: [] });
    const plan = await buildPlan(doc, createDefaults(), saying('钥匙在哪'));
    assert.deepEqual(reading(plan), ['big3', 'big2', 'small'], 'the slice that would cross the limit is skipped whole; a smaller one may still fit');
    assert.ok(plan.entries.reduce((sum, item) => sum + item.text.length, 0) <= 2400);
    assert.ok(plan.entries.every(item => [1000, 300].includes(item.text.length)), 'nothing is truncated');
});

test('a reading memory is placed after the slice covering the floor it was shared at, and an edited floor never withholds it', async () => {
    let doc = append(append(enable(), await entry('s1', 1, 3)), await entry('s2', 4, 6));
    doc.companion = linkBook(null, 'hotel', '海边旅馆', [['early', 'dialog', '两人猜测老板隐瞒了什么。', 10]], { floor: 2 });
    doc.companion = linkBook(doc.companion, 'hotel', '海边旅馆', [['early', 'dialog', '两人猜测老板隐瞒了什么。', 10], ['late', 'dialog', '两人说到结尾。', 20]], { floor: 11 });
    doc.companion = linkBook(doc.companion, 'gone', '消失的楼层', [['far', 'dialog', '锚在已不存在的楼层。', 5]], { floor: 99 });
    const plan = await buildPlan(doc, createDefaults(), { messages, maxContext: 8192 });
    const placed = Object.fromEntries(plan.entries.filter(item => item.companion).map(item => [item.companion.sourceId, item.afterId]));
    assert.deepEqual(placed, { early: 's1', late: undefined, far: undefined }, 'the anchor hash (not this chat\'s) is not required to match');
    assert.deepEqual(JSON.parse(plan.prompt.split('\n').at(-2)).map(item => item.id.startsWith('companion_') ? 'reading' : item.id).slice(0, 3), ['s1', 'reading', 's2']);
    assert.ok(!doc.entryOrder.some(id => id.startsWith('companion_')), 'reading memories never enter the stored order');
});

test('similarity may open a book gate only against real competition, and book slices are offered for scoring', async () => {
    let doc = append(append(append(enable(), await entry('a', 1, 2)), await entry('c', 3, 4)), await entry('d', 5, 6));
    doc.companion = train(hotel());
    const bookId = sourceId => companionEntries(doc.companion).find(item => item.companion.sourceId === sourceId).id, asked = [];
    const scores = values => async request => { asked.push(request); return new Map(values); };
    const snapshot = { messages, maxContext: 8192 };
    let plan = await buildPlan(doc, vectorDefaults(), snapshot, { semanticScores: scores([['a', 0.5], ['c', 0.4], ['d', 0.3], [bookId('h3'), 0.9], [bookId('t1'), 0.1]]) });
    assert.deepEqual(asked[0].candidates.map(item => item.id).slice(3), ['h4', 'h3', 'h2', 'h1', 't2', 't1'].map(bookId), 'book slices follow the story candidates, furthest-read first');
    assert.ok(!asked[0].candidates.some(item => [bookId('hd'), bookId('td')].includes(item.id)), 'exchanges are not sent for scoring');
    assert.deepEqual(reading(plan).filter(id => !id.endsWith('d')), ['h3'], 'a leading book slice opens its own book only');
    plan = await buildPlan(doc, vectorDefaults(), snapshot, { semanticScores: scores([['a', 0.9], ['c', 0.8], ['d', 0.7], [bookId('h3'), 0.2]]) });
    assert.deepEqual(reading(plan).filter(id => !id.endsWith('d')), [], 'a book slice outside the top three opens nothing');
    doc = enable(); doc.companion = hotel();
    plan = await buildPlan(doc, vectorDefaults(), snapshot, { semanticScores: scores([[bookId('h3'), 0.9], [bookId('h1'), 0.8]]) });
    assert.deepEqual(reading(plan), ['hd'], 'with no scored story memory to beat, similarity alone does not open the gate');
});

test('fragment coalescing merges only short same-scene neighbours and leaves full or moved scenes alone', async () => {
    const hashes = await fingerprintMessages(messages);
    const scene = { world: 'w', timeline: 't', date: '', period: '', place: '旅馆', event: '夜里', characters: ['甲'], nature: 'present', evidence: { floors: [1] } };
    const parsed = parseSummary(JSON.stringify({ slices: [
        { start: 1, end: 1, text: '一层', title: '甲', scenes: [{ ...scene, evidence: { floors: [1] } }] },
        { start: 2, end: 2, text: '二层', title: '乙', scenes: [{ ...scene, evidence: { floors: [2] } }] },
        { start: 3, end: 4, text: '长'.repeat(900), title: '丙', scenes: [{ ...scene, evidence: { floors: [3, 4] } }] },
        { start: 5, end: 5, text: '短', title: '丁', scenes: [{ ...scene, evidence: { floors: [5] } }] },
        { start: 6, end: 6, text: '短二', title: '戊', scenes: [{ ...scene, place: '别处', evidence: { floors: [6] } }] },
    ] }), { start: 1, end: 6 }, hashes);
    assert.deepEqual(parsed.map(item => [item.source.start, item.source.end]), [[1, 5], [6, 6]], 'short neighbours merge; a different place stays separate');
    assert.equal(parsed[0].title, '丙', 'the merged slice keeps the longer part\'s name');
    assert.deepEqual(parsed[0].source.hashes.length, 5, 'merged source covers every floor it now stands for');
    const full = parseSummary(JSON.stringify({ slices: [
        { start: 1, end: 1, text: '长'.repeat(1800), title: '甲', scenes: [{ ...scene, evidence: { floors: [1] } }] },
        { start: 2, end: 2, text: '也长'.repeat(900), title: '乙', scenes: [{ ...scene, evidence: { floors: [2] } }] },
    ] }), { start: 1, end: 2 }, hashes);
    assert.equal(full.length, 2, 'two slices that would exceed the cap stay separate');
    const bare = parseSummary(JSON.stringify({ slices: [
        { start: 1, end: 1, text: '一层', title: '甲' },
        { start: 2, end: 2, text: '二层', title: '乙' },
        { start: 3, end: 3, text: '三层', title: '丙' },
    ] }), { start: 1, end: 3 }, hashes);
    assert.deepEqual(bare.map(item => [item.source.start, item.source.end]), [[1, 3]], 'slices without scene metadata still merge, as most model output omits scenes');
});
