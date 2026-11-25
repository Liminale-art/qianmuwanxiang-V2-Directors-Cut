// 2026-11-25：自动总结进度（与触发判断同一口径）、确认「正文变了也照旧用这条切片」、模型起的长名字截到上限。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, applyOperation, fingerprintMessages } from '../yimu/contract.mjs';
import { autoProgress, nextBatch, estimateTokens, inspectSources } from '../yimu/core.mjs';
import { fitMemoryTitle } from '../yimu/timeline.mjs';

const binding = { avatar: 'Hero.png', file: 'story', integrity: 'id-1' };
const messages = count => Array.from({ length: count }, (_, i) => ({ name: i % 2 ? '甲' : '乙', is_user: i % 2 === 0, mes: `第 ${i + 1} 层正文，内容不长。`, send_date: String(i) }));
const enabled = total => applyOperation(createDocument(binding), { id: 'on', type: 'enable', enabled: true, expectedRevision: 0, range: { start: 1, end: total, total } }).document;

test('progress counts unsummarized floors (newest included) and only the summarizable chat text in tokens', async () => {
    const chat = messages(12), hashes = await fingerprintMessages(chat);
    let doc = enabled(12);
    let progress = autoProgress(doc, chat);
    assert.equal(progress.floors, 12);
    assert.equal(progress.tokens, chat.slice(0, 9).reduce((sum, item) => sum + estimateTokens(item.mes), 0), 'tokens stop before the three newest floors');
    doc = applyOperation(doc, { id: 'a', type: 'append', expectedEpoch: doc.epoch, entry: { id: 's1', kind: 'summary', text: '前五层', source: { start: 1, end: 5, hashes: hashes.slice(0, 5) } } }).document;
    progress = autoProgress(doc, chat);
    assert.equal(progress.floors, 7);
    assert.equal(progress.tokens, chat.slice(5, 9).reduce((sum, item) => sum + estimateTokens(item.mes), 0));
    assert.equal(autoProgress(createDocument(binding), chat), null, 'not enabled yet: nothing to show');
});

test('with 10-floor trigger the floor rule fires and the range runs to total − 3, as the panel progress shows', () => {
    const chat = messages(28), doc = { ...enabled(28), autoSummary: true };
    const covered = { ...doc, entries: [{ id: 'old', kind: 'summary', status: 'active', source: { start: 1, end: 18, hashes: [] } }] };
    assert.equal(autoProgress(covered, chat).floors, 10);
    const settings = { trigger: 50000, triggerFloors: 10, batch: 50000, inputCapacity: 1e9 };
    assert.deepEqual([nextBatch(covered, chat, settings).start, nextBatch(covered, chat, settings).end], [19, 25], 'floors 19–25 (shown 18–24): up to total − 3');
    const aligned = nextBatch(covered, chat, settings, { align: true });
    assert.equal(aligned.end, 24, 'automatic runs do not stop on a user line: floor 25 is one here, so it waits for its reply');
});

test('confirming a changed source swaps in the current fingerprints without touching text or revision', async () => {
    const chat = messages(6), hashes = await fingerprintMessages(chat);
    let doc = enabled(6);
    doc = applyOperation(doc, { id: 'a', type: 'append', expectedEpoch: doc.epoch, entry: { id: 's1', kind: 'summary', text: '两层', source: { start: 1, end: 2, hashes: hashes.slice(0, 2) } } }).document;
    const before = doc.entries.find(entry => entry.id === 's1');
    doc = applyOperation(doc, { id: 'inv', type: 'invalidate', entries: [{ id: 's1', revision: before.revision }] }).document;
    const invalid = doc.entries.find(entry => entry.id === 's1');
    assert.equal(invalid.status, 'invalid');
    const edited = await fingerprintMessages(chat.map((item, i) => i === 0 ? { ...item, mes: '改过的第一层' } : item));
    doc = applyOperation(doc, { id: 'ok', type: 'entry', action: 'acceptSource', entryId: 's1', expectedRevision: invalid.revision, hashes: edited.slice(0, 2) }).document;
    const after = doc.entries.find(entry => entry.id === 's1');
    assert.equal(after.status, 'active'); assert.deepEqual(after.source.hashes, edited.slice(0, 2));
    assert.equal(after.revision, invalid.revision, 'no new revision: stages built on it stay valid'); assert.equal(after.text, '两层');
    assert.throws(() => applyOperation(doc, { id: 'bad', type: 'entry', action: 'acceptSource', entryId: 's1', expectedRevision: after.revision, hashes: edited.slice(0, 1) }), /指纹无效/);
});

test('model titles longer than the limit are cut, never block the batch', () => {
    assert.equal(fitMemoryTitle('第一次一起去海边看日出了'), '第一次一起去海边');
    assert.equal(fitMemoryTitle('两行\n标题'), '两行 标题');
    assert.equal(fitMemoryTitle(undefined), '');
});

test('confirming stays confirmed: invalidation no longer bumps revisions, so a slice that inherits its scene from the edited one recovers too', async () => {
    const chat = messages(8), hashes = await fingerprintMessages(chat);
    let doc = enabled(8);
    doc = applyOperation(doc, { id: 'a', type: 'append', expectedEpoch: doc.epoch, entry: { id: 'A', kind: 'summary', text: '甲', source: { start: 1, end: 2, hashes: hashes.slice(0, 2) },
        scenes: [{ place: '车站', evidence: { floors: [1] } }] } }).document;
    const a = doc.entries.find(entry => entry.id === 'A');
    doc = applyOperation(doc, { id: 'b', type: 'append', expectedEpoch: doc.epoch, entry: { id: 'B', kind: 'summary', text: '乙', source: { start: 3, end: 4, hashes: hashes.slice(2, 4) },
        scenes: [{ place: '车站', evidence: { floors: [], inheritedFrom: { id: 'A', revision: a.revision } } }] } }).document;
    const edited = chat.map((item, i) => i === 0 ? { ...item, mes: '改过的第一层' } : item), now = await fingerprintMessages(edited);
    // 刷新时的做法：核出失效就记下（A 原文变了；B 继承的 A 不再有效）。
    for (let round = 0; round < 2; round++) { const { invalid } = await inspectSources(doc, edited); if (invalid.length) doc = applyOperation(doc, { id: `inv${round}`, type: 'invalidate', entries: invalid }).document; }
    assert.deepEqual(doc.entries.map(entry => [entry.id, entry.status]), [['A', 'invalid'], ['B', 'invalid']]);
    assert.equal(doc.entries.find(entry => entry.id === 'A').revision, a.revision, 'invalidation is a marker, not a revision');
    for (const id of ['A', 'B']) { const entry = doc.entries.find(item => item.id === id);
        doc = applyOperation(doc, { id: `ok${id}`, type: 'entry', action: 'acceptSource', entryId: id, expectedRevision: entry.revision, hashes: now.slice(entry.source.start - 1, entry.source.end) }).document; }
    assert.deepEqual((await inspectSources(doc, edited)).invalid, [], 'the next refresh finds nothing to flag again');
});
