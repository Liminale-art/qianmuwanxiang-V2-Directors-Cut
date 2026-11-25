// 2026-11-25：心迹与存照跟着正文走——重 roll、删楼时撤回那一层写下的；待凝定一栏可单独清空、痕迹可改。
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHeartOperation, gradeOf } from '../yimu/heart-contract.mjs';

const base = () => ({ observations: [{ id: 't1', about: '小满', text: '她又点了辣的。', floor: 2, at: 1 }, { id: 't2', about: '小满', text: '用过的。', floor: 3, at: 1, used: true }],
    heart: { impressions: [{ id: 'old', about: '小满', text: '她怕冷场。', days: [{ day: 'd1', text: '她怕冷场。', at: 1 }], at: 1, updatedAt: 1, sure: 2 },
        { id: 'thin', about: '阿澈', text: '还没凝定的。', days: [{ day: 'd1', text: 'x', at: 1 }], at: 1, updatedAt: 1 }], thoughts: [{ id: 'th', group: 'you', about: '小满', text: '心里话', floor: 10, at: 1 }], events: [], eventFloor: 0, thoughtFloor: 10 } });
const direct = (fields, day = 'd2') => ({ ...fields, direct: { day } });

test('a reply that revises an earlier impression is taken back when that floor is rerolled without writing', () => {
    const doc = base();
    applyHeartOperation(doc, { type: 'heartDiary', at: 5, impressions: [direct({ id: 'old', about: '小满', text: '她不是怕冷场，是怕我走。', sure: 3 })], events: [], used: [], impressionFloor: 12, replaceFloor: 12 }, 'a');
    let old = doc.heart.impressions.find(item => item.id === 'old');
    assert.deepEqual([old.text, old.sure, old.days.length, old.rev.floor], ['她不是怕冷场，是怕我走。', 3, 2, 12]);
    applyHeartOperation(doc, { type: 'heartDiary', at: 6, impressions: [], events: [], used: [], impressionFloor: 12, replaceFloor: 12 }, 'b');
    old = doc.heart.impressions.find(item => item.id === 'old');
    assert.deepEqual([old.text, old.sure, old.days.length, old.rev], ['她怕冷场。', 2, 1, undefined], '重 roll 这次没写：恢复成改写前');
});

test('deleting floors takes back the notes and impressions written in them and rewinds the asked marks', () => {
    const doc = base();
    applyHeartOperation(doc, { type: 'heartDiary', at: 5, impressions: [direct({ about: '小满', text: '新的一条。', sure: 1 })], events: [], used: [], impressionFloor: 12, replaceFloor: 12 }, 'a');
    assert.equal(doc.heart.impressions.find(item => item.born === 12).text, '新的一条。');
    applyHeartOperation(doc, { type: 'heartRevert', fromFloor: 10, at: 7 }, 'r');
    assert.deepEqual(doc.heart.impressions.map(item => item.id), ['old', 'thin']); assert.deepEqual(doc.heart.thoughts, []);
    assert.deepEqual([doc.heart.thoughtFloor, doc.heart.impressionFloor], [9, 9]);
    const own = base(); own.heart.impressions[0].own = true; own.heart.impressions[0].born = 12;
    applyHeartOperation(own, { type: 'heartRevert', fromFloor: 10, at: 7 }, 'r2');
    assert.ok(own.heart.impressions.some(item => item.id === 'old'), '用户改过的不撤');
});

test('the loose column clears on its own and a waiting trace can be edited', () => {
    const doc = base();
    assert.equal(gradeOf(doc.heart.impressions[1]), 0);
    applyHeartOperation(doc, { type: 'heartEdit', kind: 'trace', itemId: 't1', about: '小满', text: '她其实不太能吃辣。', at: 2 }, 'e');
    assert.equal(doc.observations[0].text, '她其实不太能吃辣。');
    applyHeartOperation(doc, { type: 'heartClear', scope: 'loose', at: 3 }, 'c');
    assert.deepEqual(doc.observations.map(item => item.id), ['t2'], '没用过的痕迹清掉，用过的留着');
    assert.deepEqual(doc.heart.impressions.map(item => item.id), ['old'], '还没凝定的印象清掉，存照不动');
    assert.equal(doc.heart.thoughts.length, 1);
});
