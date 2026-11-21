import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, createDocument, applyOperation, fingerprintMessages, validateDocument } from '../yimu/contract.mjs';
import { nextBatch, planManualRange } from '../yimu/core.mjs';

const binding = { avatar: 'Small.png', file: 'Small', integrity: 'small-identity' };
// 第 1 层是用户发言，之后一人一句：奇数层用户、偶数层角色。
const chat = n => Array.from({ length: n }, (_, i) => ({ name: i % 2 ? '角色' : '用户', is_user: i % 2 === 0, mes: `第 ${i + 1} 层：` + '正文'.repeat(40), send_date: String(i) }));
const enabled = () => ({ ...applyOperation(createDocument(binding), { id: 'enable', type: 'enable', enabled: true, expectedRevision: 0, range: { start: 1, end: 0, total: 0 } }).document, autoSummary: true });
const settings = { ...DEFAULTS, trigger: 500000, triggerFloors: 4, recent: 2 };

test('automatic batches end on a full turn: a trailing user message waits for its reply', () => {
    const doc = enabled();
    // 8 层：最新 3 层是重 roll 保护，可整理的是 1–5（与保留层数无关），第 5 层是用户发言 → 回退到第 4 层（角色回复），第 5 层留给下一批。
    assert.deepEqual(nextBatch(doc, chat(8), settings, { align: true }), { start: 1, end: 4 });
    assert.deepEqual(nextBatch(doc, chat(8), settings), { start: 1, end: 5 }, '不对齐时照旧');
    // 9 层：可整理的是 1–6，第 6 层是角色回复 → 不动。
    assert.deepEqual(nextBatch(doc, chat(9), settings, { align: true }), { start: 1, end: 6 });
    // 只剩一层可整理且它是用户发言：不退，否则这一层永远整理不了。
    const single = [{ name: '用户', is_user: true, mes: '只有这一句。'.repeat(30), send_date: '0' }, ...chat(3)];
    assert.deepEqual(nextBatch(doc, single, { ...settings, triggerFloors: 1 }, { align: true }), { start: 1, end: 1 });
});

async function withSlices() {
    const messages = chat(10), hashes = await fingerprintMessages(messages);
    let doc = enabled();
    for (const [id, start, end] of [['a', 1, 2], ['b', 3, 4]]) doc = applyOperation(doc, { id: `add_${id}`, type: 'append', expectedEpoch: doc.epoch,
        entry: { id, kind: 'summary', title: `标题${id}`, text: `旧切片 ${id} 的全文，篇幅不短。`.repeat(20), source: { start, end, hashes: hashes.slice(start - 1, end) } } }).document;
    return { doc, messages, hashes };
}

test('a slice replaced by a new one keeps only a minimal record: no text, no history, still marked as replaced', async () => {
    const { doc, messages, hashes } = await withSlices();
    const plan = planManualRange(doc, messages, { ...DEFAULTS }, { start: 1, end: 4 }, { batchFloors: 10 });
    const after = applyOperation(doc, { id: 'redo', type: 'append', expectedEpoch: doc.epoch, replaces: plan.batches[0].replaces, replaceRange: { start: 1, end: 4 },
        entry: { id: 'new', kind: 'summary', text: '重新整理后的一条。', source: { start: 1, end: 4, hashes: hashes.slice(0, 4) } } }).document;
    for (const id of ['a', 'b']) {
        const old = after.entries.find(entry => entry.id === id);
        assert.equal(old.replacedBy, 'new'); assert.equal(old.status, 'deleted'); assert.equal(old.discarded, true);
        assert.equal(old.text, '已删除'); assert.equal(old.title, undefined); assert.deepEqual(old.history, []);
        assert.deepEqual([old.source.start, old.source.end], id === 'a' ? [1, 2] : [3, 4], '来源范围留着，防旧备份把它带回来');
    }
    assert.ok(!JSON.stringify(after.entries).includes('旧切片'), '旧全文不再留在文件里');
    assert.doesNotThrow(() => validateDocument(after));
    // 最小记录不挡以后的再次总结，也不被当成「已清除的来源」要求额外授权。
    const again = planManualRange(after, messages, { ...DEFAULTS }, { start: 1, end: 4 }, { batchFloors: 10 });
    assert.deepEqual(again.batches.map(batch => [batch.start, batch.end, (batch.replaces || []).map(ref => ref.id), batch.discardedSources]), [[1, 4, ['new'], undefined]]);
});

test('records left by earlier versions (replaced, but still carrying full text) are compacted on the next change', async () => {
    const { doc } = await withSlices();
    // 模拟旧版本留下的形态：带全文的「已被替换」记录。
    const legacy = structuredClone(doc);
    Object.assign(legacy.entries.find(entry => entry.id === 'a'), { status: 'deleted', replacedBy: 'someone' });
    const next = applyOperation(legacy, { id: 'touch', type: 'entry', action: 'exclude', entryId: 'b', expectedRevision: legacy.entries.find(entry => entry.id === 'b').revision }).document;
    const old = next.entries.find(entry => entry.id === 'a');
    assert.equal(old.discarded, true); assert.equal(old.text, '已删除'); assert.equal(old.replacedBy, 'someone');
});
