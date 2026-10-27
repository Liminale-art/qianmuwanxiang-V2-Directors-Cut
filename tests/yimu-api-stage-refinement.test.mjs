import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiSettings } from '../yimu/api-settings.mjs';
import { createHost } from '../yimu/host.mjs';
import { DEFAULTS, VERSION, createDocument, createDefaults, effectiveSettings, validateSettings, validateDefaults, applyOperation } from '../yimu/contract.mjs';
import { nextBatch, planManualRange, parseSummary } from '../yimu/core.mjs';
import { nextStage, planStageRange, parseStage } from '../yimu/layers.mjs';
import { recentStageEntryIds, stageSourceFromParents } from '../yimu/stage-contract.mjs';
import { generatedTextLength, validateGeneratedLength } from '../yimu/scene-contract.mjs';

const binding = { avatar: 'Refinement.png', file: 'Synthetic', integrity: 'refinement-id' };
const profile = () => ({ id: 'qianmu-one', name: '既有千幕预设', apiUrl: 'https://synthetic.example/v1', apiKey: 'synthetic-not-real-key', model: 'shared-model', temperature: 0 });
function apiFixture() {
    const calls = [], writes = [];
    const owner = { apiProfiles: [profile()] };
    const ctx = { extensionSettings: { story_director_liminale: owner }, getRequestHeaders: () => ({}),
        async saveSettingsDebounced() { writes.push(structuredClone(ctx.extensionSettings.yimu)); },
        async generateRaw() { throw Error('must not fall back'); } };
    let answer = () => Response.json({ choices: [{ message: { content: '完整结果' }, finish_reason: 'stop' }] });
    const fetcher = async (path, options) => { calls.push({ path, body: JSON.parse(options.body) }); return answer(); };
    const api = createApiSettings({ getContext: () => ctx, fetchImpl: fetcher });
    return { ctx, owner, calls, writes, api, fetcher, set answer(value) { answer = value; } };
}

test('new API defaults and algorithm defaults do not overwrite explicit saved values or trigger a save on read', () => {
    const f = apiFixture(), fresh = f.api.read();
    assert.equal(fresh.temperature, 1); assert.equal(fresh.maxTokens, 32000); assert.equal(fresh.contextTokens, 1000000);
    f.ctx.extensionSettings.yimu = { api: { temperature: 0.7, maxTokens: 2048, contextTokens: 32768 } };
    assert.equal(f.api.read().temperature, 0.7); assert.equal(f.api.read().maxTokens, 2048); assert.equal(f.api.read().contextTokens, 32768);
    assert.equal(f.writes.length, 0); assert.equal(VERSION, '0.8.3');
    assert.equal(DEFAULTS.trigger, 50000); assert.equal(DEFAULTS.stageThreshold, 65000); assert.equal(DEFAULTS.stageRecent, 10);
    const old = { ...createDefaults(), values: { ...DEFAULTS, trigger: 4000, stageThreshold: 6000 } };
    assert.equal(validateDefaults(old).values.trigger, 4000); assert.equal(validateDefaults(old).values.stageThreshold, 6000);
});

test('Qianmu selection resolves the companion-owned live preset and stores only its ID, never its credentials', async () => {
    const f = apiFixture(), before = structuredClone(f.owner);
    await f.api.update({ mode: 'qianmu', qianmuPresetId: 'qianmu-one' });
    assert.deepEqual(f.api.qianmuProfiles(), [{ id: 'qianmu-one', name: '既有千幕预设', model: 'shared-model' }]);
    const connection = f.api.effectiveConnection();
    assert.ok(!JSON.stringify(connection).includes(profile().apiKey)); assert.ok(!JSON.stringify(connection).includes(profile().apiUrl));
    assert.ok(!JSON.stringify(f.ctx.extensionSettings.yimu).includes(profile().apiKey)); assert.equal(f.api.read().apiUrl, '');
    assert.equal(await f.api.generate('仅合成原文', { connection }), '完整结果');
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.custom_url, profile().apiUrl);
    assert.equal(JSON.parse(f.calls[0].body.custom_include_headers).Authorization, `Bearer ${profile().apiKey}`);
    assert.equal(f.calls[0].body.model, 'shared-model'); assert.equal(f.calls[0].body.temperature, 0);
    assert.equal(f.calls[0].body.max_tokens, 32000); assert.deepEqual(f.owner, before);
});

test('Qianmu credential or owner changes reject late model answers without retries or fallback', async () => {
    for (const mutation of [f => { f.owner.apiProfiles[0].apiKey = 'synthetic-updated-key'; }, f => { f.ctx.extensionSettings.story_director_liminale = structuredClone(f.owner); }]) {
        const f = apiFixture(); await f.api.update({ mode: 'qianmu', qianmuPresetId: 'qianmu-one' });
        let finish, began; const started = new Promise(resolve => { began = resolve; });
        f.answer = () => { began(); return new Promise(resolve => { finish = resolve; }); };
        const pending = f.api.generate('仅合成原文', { connection: f.api.effectiveConnection() }); await started;
        mutation(f); finish(Response.json({ choices: [{ message: { content: '迟到结果' }, finish_reason: 'stop' }] }));
        await assert.rejects(pending, /预设已变化/); assert.equal(f.calls.length, 1);
    }
});

test('missing shared presets fail explicitly and host advertises only Qianmu metadata', async () => {
    const f = apiFixture(), host = createHost({ getContext: () => f.ctx, fetcher: f.fetcher });
    await host.connectionApi.update({ mode: 'qianmu', qianmuPresetId: 'qianmu-one' });
    assert.deepEqual(host.profiles(), [{ id: 'qianmu-one', name: '既有千幕预设', model: 'shared-model' }]);
    f.owner.apiProfiles = [];
    await assert.rejects(host.generate('仅合成原文'), /已不存在/); assert.equal(f.calls.length, 0);
    assert.equal(f.ctx.extensionSettings.yimu.api.qianmuPresetId, 'qianmu-one');
});

function stageFixture(count = 16) {
    const document = createDocument(binding); document.enabled = true;
    document.entries = Array.from({ length: count }, (_, index) => ({ id: `f${index + 1}`, kind: 'summary', text: `第${index + 1}片有据经历`,
        source: { start: index + 1, end: index + 1, hashes: ['a'.repeat(64)] }, status: 'active', edited: false, revision: 1, history: [], conflicts: [], candidate: null }));
    document.entryOrder = document.entries.map(entry => entry.id);
    return document;
}
const refs = entries => entries.map(entry => ({ id: entry.id, revision: entry.revision }));

test('automatic stages preserve the last ten valid narrative slices while explicit manual scope may use them', () => {
    const document = stageFixture(), settings = { ...DEFAULTS, stageAuto: true, stageBasis: 'slices', stageThreshold: 2, inputCapacity: 100000 };
    assert.deepEqual([...recentStageEntryIds(document)], Array.from({ length: 10 }, (_, i) => `f${i + 7}`));
    const group = nextStage(document, settings);
    assert.deepEqual(group.parents.map(entry => entry.id), ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
    assert.throws(() => stageSourceFromParents(document, refs(document.entries.slice(5, 7)), { automatic: true, stageRecent: 10 }), /近期切片/);
    const manual = planStageRange(document, settings, { start: 7, end: 16 });
    assert.equal(manual.parents.length, 10);
    assert.equal(nextStage(stageFixture(9), settings), null);
    assert.equal(nextStage(stageFixture(9), { ...settings, stageRecent: 0 }).parents.length, 9);
});

test('recent-slice retention counts valid custom and hand-edited slices, ignores excluded/invalid and obeys narrative order', () => {
    const document = stageFixture(12);
    document.entries[11].edited = true;
    document.entries[10].status = 'excluded'; document.entries[9].status = 'invalid';
    document.entries.push({ id: 'custom', kind: 'manual', source: null, text: '人工确认', status: 'active',
        placement: { binding, fromFloor: 12, hash: 'a'.repeat(64) } });
    document.entryOrder = ['custom', ...document.entryOrder];
    assert.deepEqual([...recentStageEntryIds(document, 2)], ['f9', 'f12']);
    document.entryOrder = [...document.entryOrder.filter(id => id !== 'custom'), 'custom'];
    assert.deepEqual([...recentStageEntryIds(document, 2)], ['f12', 'custom']);
});

test('floor/slice bases are accepted independently and zero factory thresholds resolve with the selected unit', () => {
    assert.deepEqual(validateSettings({ stageBasis: 'floors', stageThreshold: 9 }), { stageBasis: 'floors', stageThreshold: 9 });
    assert.equal(effectiveSettings({ settings: { stageBasis: 'floors', stageThreshold: 0 } }, createDefaults()).stageThreshold, 100);
    assert.equal(effectiveSettings({ settings: { stageBasis: 'slices', stageThreshold: 0 } }, createDefaults()).stageThreshold, 12);
    assert.equal(effectiveSettings({ settings: { stageBasis: 'tokens', stageThreshold: 0 } }, createDefaults()).stageThreshold, 65000);
    assert.equal(effectiveSettings({ settings: { batch: 1000, trigger: 50000 } }, createDefaults()).batch, 50000);
});

test('trigger remains reachable above actual capacity and approves bounded continuation without reading future floors', () => {
    const document = createDocument(binding); document.enabled = true; document.autoSummary = true;
    document.initialRange = { start: 1, end: 0, total: 0 };
    const messages = Array.from({ length: 5 }, () => ({ mes: '文'.repeat(300) }));
    const settings = { ...DEFAULTS, recent: 1, trigger: 600, inputCapacity: 450 };
    assert.deepEqual(nextBatch(document, messages, settings), { start: 1, end: 1, targetEnd: 2 });
    document.entries.push({ id: 'saved', kind: 'summary', source: { start: 1, end: 1 } });
    assert.deepEqual(nextBatch(document, messages, settings, { force: true, limitEnd: 2 }), { start: 2, end: 2 });
    assert.deepEqual(nextBatch({ ...document, entries: [] }, messages, { ...settings, inputCapacity: 1000 }), { start: 1, end: 2 });
    assert.throws(() => nextBatch({ ...document, entries: [] }, [{ mes: '文'.repeat(1001) }, { mes: '近期' }], { ...settings, inputCapacity: 1000 }), /可用输入容量/);
    assert.equal(planManualRange({ ...document, entries: [] }, messages, { ...settings, batch: 50, inputCapacity: 1000 }, { start: 1, end: 2 }).batches.length, 1);
    assert.deepEqual(planManualRange({ ...document, entries: [] }, messages, { ...settings, inputCapacity: 10000 }, { start: 1, end: 5 }).batches.map(batch => [batch.start, batch.end]), [[1, 2], [3, 4], [5, 5]]);
    const oldSlice = { id: 'whole', kind: 'summary', status: 'active', source: { start: 1, end: 4 }, revision: 1 };
    assert.deepEqual(planManualRange({ ...document, entries: [oldSlice] }, messages, { ...settings, inputCapacity: 10000 }, { start: 1, end: 4 }).batches.map(batch => [batch.start, batch.end]), [[1, 4]], 'redo keeps the existing complete slice even above trigger');
});

test('visible generated length counts Unicode characters without whitespace or JSON evidence and rejects whole oversized results', () => {
    const entry = { kind: 'summary', text: '甲 \n乙A1，😀', scenes: [{ place: '桥', event: '等', characters: ['甲'], nature: 'memory', evidence: { floors: [1] } }] };
    assert.equal(generatedTextLength(entry), 11);
    assert.throws(() => validateGeneratedLength(entry, { sliceChars: 10 }), /超过 10 字/);
    assert.equal(validateGeneratedLength(entry, { sliceChars: 11 }), entry);
    assert.equal(validateGeneratedLength({ kind: 'manual', text: '文'.repeat(5000) }, { sliceChars: 1 }).kind, 'manual');
    const hashes = ['a'.repeat(64)];
    assert.throws(() => parseSummary(JSON.stringify({ slices: [{ start: 1, end: 1, text: '文'.repeat(2001) }] }), { start: 1, end: 1 }, hashes), /2000 字上限/);
    assert.throws(() => parseStage(JSON.stringify({ text: '文'.repeat(3001) }), []), /3000 字上限/);
    assert.deepEqual(validateSettings({ sliceChars: null, stageChars: null }), { sliceChars: null, stageChars: null });
    assert.throws(() => validateSettings({ sliceChars: 0 }), /超出范围/);
    let document = stageFixture(2);
    document = applyOperation(document, { id: 'human', type: 'edit', entryId: 'f1', expectedRevision: 1, text: '手'.repeat(3001) }).document;
    assert.equal(document.entries[0].text.length, 3001, 'human revisions are not retroactively capped');
});
