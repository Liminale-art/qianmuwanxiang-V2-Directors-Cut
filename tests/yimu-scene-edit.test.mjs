import test from 'node:test';
import assert from 'node:assert/strict';
import { editableMemoryText, editedMemoryValue, renderSceneLabels } from '../yimu/scene-view.mjs';
import { textCollectionDom } from './helpers/text-collection-dom.mjs';

const sample = () => ({ kind: 'summary', text: '他们约好次日重逢。', scenes: [
    { world: '故乡', timeline: '原时空', date: '五月十日', period: '傍晚', place: '车站', characters: ['甲', '乙'], event: '二人在车站告别。', nature: 'present', evidence: { floors: [1] } },
    { world: '远方', timeline: '另一时空', date: '当地同日', period: '清晨', place: '港口', characters: ['丙'], event: '丙独自等船。', nature: 'parallel', evidence: { floors: [2] } },
] });

test('one editor exposes every scene and prose while body-only changes retain source-backed anchors', () => {
    const entry = sample(), text = editableMemoryText(entry);
    assert.match(text, /甲、乙.*故乡／原时空.*五月十日.*傍晚.*车站/);
    assert.match(text, /丙.*远方／另一时空.*当地同日.*清晨.*港口.*同时异地/);
    const next = editedMemoryValue(text.replace(entry.text, '他们约好下周重逢。'), entry);
    assert.equal(next.text, '他们约好下周重逢。'); assert.deepEqual(next.scenes, entry.scenes);
});

test('free changes to a date keep the complete edited text and cannot inject stale structured dates', () => {
    const entry = sample(), changed = editableMemoryText(entry).replace('五月十日', '五月十一日');
    const next = editedMemoryValue(changed, entry);
    assert.equal(next.text, changed); assert.deepEqual(next.scenes, []);
    assert.match(next.text, /五月十一日/); assert.doesNotMatch(next.text, /五月十日/);
    assert.equal(editableMemoryText({ ...entry, ...next }), changed);
});

test('plain custom content and quotations use the same editor without a second metadata form', () => {
    assert.deepEqual(editedMemoryValue(' 自定义的清晨地点与事件 ', { kind: 'manual', text: '' }), { text: '自定义的清晨地点与事件', scenes: [] });
    assert.equal(editableMemoryText({ kind: 'excerpt', text: 'stored pointer', quoteText: '实际引文' }), '实际引文');
    const { doc, parent } = textCollectionDom(); renderSceneLabels(parent, [{}], { document: doc });
    assert.equal(parent.children.length, 0);
});
