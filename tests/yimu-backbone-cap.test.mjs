import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, createDocument, createDefaults, applyOperation, fingerprintMessages, validateSettings } from '../yimu/contract.mjs';
import { buildPlan, capSlices, parseSummary, summaryPrompt } from '../yimu/core.mjs';
import { memoryWarmth, FRESH, SUNKEN, DECAY } from '../yimu/decay.mjs';

const binding = { avatar: 'Backbone.png', file: 'Story', integrity: 'backbone-identity' };
const base = Array.from({ length: 16 }, (_, i) => ({ name: i % 2 ? '甲' : '乙', is_user: i % 2 === 0, mes: `合成楼层${i + 1}：今晚下雨，故事仍在进行。`, send_date: String(i) }));
// 故事又推进了几百层：早期切片早已沉底。
const later = Array.from({ length: 400 }, (_, i) => ({ name: i % 2 ? '甲' : '乙', is_user: i % 2 === 0, mes: `后来的第${i + 17}层：两人谈论天气与行程。`, send_date: String(100 + i) }));

async function fixture({ stages = 1 } = {}) {
    const messages = [...base, ...later], hashes = await fingerprintMessages(messages);
    let document = applyOperation(createDocument(binding), { id: 'enable', type: 'enable', enabled: true, expectedRevision: 0, range: { start: 1, end: 16, total: 16 } }).document;
    for (let i = 0; i < 8; i++) document = applyOperation(document, { id: `save${i}`, type: 'append', expectedEpoch: document.epoch,
        entry: { id: `fine${i}`, kind: 'summary', text: `早期经历第 ${i + 1} 段：桥边的约定与红围巾。`, source: { start: i * 2 + 1, end: i * 2 + 2, hashes: hashes.slice(i * 2, i * 2 + 2) } } }).document;
    for (let s = 0; s < stages; s++) {
        const ids = [`fine${s * 2}`, `fine${s * 2 + 1}`];
        document = applyOperation(document, { id: `stage-op${s}`, type: 'append', expectedEpoch: document.epoch,
            entry: { id: `stage${s}`, kind: 'stage', text: `阶段 ${s + 1}：两人立下约定后继续赶路。`, source: { parents: ids.map(id => ({ id, revision: document.entries.find(e => e.id === id).revision })) } } }).document;
    }
    return { document, messages, hashes };
}

test('stage summaries never sink: they are the always-on backbone while fine slices still fade', () => {
    const far = DECAY.fadingWithin + 500;
    const stage = { id: 'st', kind: 'stage', source: { parents: [], ranges: [{ start: 1, end: 4 }] } };
    const fine = { id: 'fi', kind: 'summary', source: { start: 1, end: 2 } };
    assert.equal(memoryWarmth(stage, { floor: far }), FRESH);
    assert.equal(memoryWarmth(fine, { floor: far }), SUNKEN, '细切片照旧遗忘');
});

test('hundreds of floors later an ordinary message still carries the stage backbone, not nothing', async () => {
    const f = await fixture({ stages: 2 });
    const plan = await buildPlan(f.document, createDefaults(), { messages: f.messages, maxContext: 65536 });
    const kinds = plan.entries.map(entry => entry.kind);
    assert.deepEqual(plan.entries.filter(entry => entry.kind === 'stage').map(entry => entry.id).sort(), ['stage0', 'stage1'], '没有任何唤起词，主干照带');
    assert.ok(!kinds.includes('summary') || plan.entries.filter(entry => entry.kind === 'summary').every(entry => ['fine6', 'fine7'].includes(entry.id)),
        '沉底的细切片不因主干常驻而跟着回来（最近两条背景除外）');
});

test('with a slice cap the backbone takes at most half the slots and is ordered ahead of fine slices', async () => {
    const f = await fixture({ stages: 4 });
    // 条数上限是账户全局设置（2026-11-24 起设置不分聊天）。
    const cap = maxSlices => { const defaults = createDefaults(); defaults.values = { ...defaults.values, maxSlices }; return defaults; };
    const plan = await buildPlan(f.document, cap(4), { messages: f.messages, maxContext: 65536 });
    const stages = plan.entries.filter(entry => entry.kind === 'stage');
    assert.equal(stages.length, 2, '上限 4 → 主干最多 2 条');
    assert.deepEqual(stages.map(entry => entry.id), ['stage3', 'stage2'], '相关度相同时取更近的阶段');
    const firstFine = plan.entries.findIndex(entry => entry.kind === 'summary');
    if (firstFine >= 0) assert.ok(plan.entries.findIndex(entry => entry.kind === 'stage') < firstFine, '主干排在细切片之前，不会被条数上限挤掉');
    // 0 为不限条数：主干全带。
    const all = await buildPlan(f.document, cap(0), { messages: f.messages, maxContext: 65536 });
    assert.equal(all.entries.filter(entry => entry.kind === 'stage').length, 4);
});

const slice = (start, end, chars, scene) => ({ kind: 'summary', title: `第${start}段`, text: '文'.repeat(chars), scenes: scene ? [scene] : [],
    source: { start, end, hashes: Array.from({ length: end - start + 1 }, (_, i) => String(start + i).padStart(64, '0')) } });

test('the per-summary slice cap merges neighbours instead of rejecting, truncating or asking again', () => {
    const six = [slice(1, 2, 100), slice(3, 3, 20), slice(4, 5, 30), slice(6, 7, 400), slice(8, 8, 25), slice(9, 10, 300)];
    const capped = capSlices(six, { summarySlices: 4, sliceChars: 2000 });
    assert.equal(capped.length, 4);
    assert.deepEqual([capped[0].source.start, capped.at(-1).source.end], [1, 10], '覆盖范围首尾不变');
    for (let i = 1; i < capped.length; i++) assert.equal(capped[i].source.start, capped[i - 1].source.end + 1, '仍然连续、无重叠');
    assert.equal(capped.reduce((n, entry) => n + entry.text.replace(/\n/g, '').length, 0), six.reduce((n, entry) => n + entry.text.length, 0), '正文一个字都没丢');
    for (const entry of capped) assert.equal(entry.source.hashes.length, entry.source.end - entry.source.start + 1, '来源指纹随范围合并');
    assert.deepEqual(capped.map(entry => [entry.source.start, entry.source.end]), [[1, 5], [6, 7], [8, 8], [9, 10]], '每次都并合起来最短的那一对相邻切片');
    assert.equal(six.length, 6, '不改动传入的数组');
});

test('the character limit outranks the slice cap, and 0 means no cap', () => {
    const big = [slice(1, 1, 80), slice(2, 2, 80), slice(3, 3, 80), slice(4, 4, 80)];
    assert.equal(capSlices(big, { summarySlices: 2, sliceChars: 100 }).length, 4, '再并就超过单条字数上限：宁可多一条');
    assert.equal(capSlices(big, { summarySlices: 2, sliceChars: 170 }).length, 2);
    assert.equal(capSlices(big, { summarySlices: 0, sliceChars: 2000 }), big);
    assert.equal(capSlices(big, { sliceChars: 2000 }), big, '未设置时不动');
    assert.equal(capSlices(big, { summarySlices: 9, sliceChars: 2000 }), big);
});

test('same-scene neighbours are merged first when the cap forces a choice', () => {
    const scene = place => ({ world: '', timeline: '', date: '三月初三', period: '夜', place, characters: ['甲'], nature: 'present', event: '', evidence: { floors: [1] } });
    const rows = [slice(1, 1, 200, scene('桥边')), slice(2, 2, 200, scene('桥边')), slice(3, 3, 10, scene('客栈')), slice(4, 4, 10, scene('码头'))];
    const capped = capSlices(rows, { summarySlices: 3, sliceChars: 2000 });
    assert.deepEqual(capped.map(entry => [entry.source.start, entry.source.end]), [[1, 2], [3, 3], [4, 4]], '同场景的两条优先合并，即便另一对更短');
    assert.equal(capped[0].scenes.length, 1);
});

test('the cap is a default setting, is told to the model, and is applied to a parsed summary', async () => {
    assert.equal(DEFAULTS.summarySlices, 4);
    assert.deepEqual(validateSettings({ summarySlices: 0 }), { summarySlices: 0 });
    assert.throws(() => validateSettings({ summarySlices: 2001 }), /超出范围/);
    const messages = Array.from({ length: 12 }, (_, i) => ({ name: 'A', is_user: i % 2 === 0, mes: `第${i + 1}层正文`, send_date: String(i) }));
    const hashes = await fingerprintMessages(messages), batch = { start: 1, end: 12 };
    assert.match(summaryPrompt(messages, batch, { ...DEFAULTS }), /本次最多返回 4 片/);
    assert.doesNotMatch(summaryPrompt(messages, batch, { ...DEFAULTS, summarySlices: 0 }), /本次最多返回/);
    // 六片各在不同地点（有依据的不同场景不会被碎片合并并掉），所以条数上限是唯一把它们并起来的规则。
    const response = JSON.stringify({ slices: Array.from({ length: 6 }, (_, i) => ({ start: i * 2 + 1, end: i * 2 + 2, title: `段${i + 1}`, text: '各在一处发生的一段经历。'.repeat(20),
        scenes: [{ world: '', timeline: '', date: '', period: '', place: `地点${i + 1}`, characters: ['甲'], nature: 'present', event: '', evidence: { floors: [i * 2 + 1] } }] })) });
    assert.equal(parseSummary(response, batch, hashes, { ...DEFAULTS, summarySlices: 0 }).length, 6);
    const capped = parseSummary(response, batch, hashes, { ...DEFAULTS });
    assert.equal(capped.length, 4);
    assert.deepEqual([capped[0].source.start, capped.at(-1).source.end], [1, 12]);
});
