import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHeartOperation, gradeOf, sureOf } from '../yimu/heart-contract.mjs';
import { fillPlan, sourceRows, REROLL_GUARD } from '../yimu/core.mjs';
import { fillPrompt, chronicleAsk } from '../yimu/heart-core.mjs';
import { heartData } from '../yimu/heart-view.mjs';
import { DEFAULTS } from '../yimu/contract.mjs';

const day = n => ({ day: `d${n}`, text: '依据', at: n });
const base = () => ({ observations: [{ id: 'o1', about: '小满', text: '她又点了辣的。', floor: 2, at: 5 }, { id: 'o2', about: '店主', text: '他记得熟客。', floor: 3, at: 6, used: true }],
    heart: { eventFloor: 0, thoughtFloor: 0, impressions: [{ id: 'i1', about: '小满', text: '她离不开辣。', days: [1, 2, 3].map(day), at: 1, updatedAt: 3 }],
        thoughts: [{ id: 't1', group: 'you', about: '小满', text: '她比看上去更怕冷场。', floor: 4, at: 2 }], events: [{ id: 'e1', title: '第一次同桌', text: '两人拼了一张桌。', floor: 5, at: 2 }] } });

test('a note the user wrote or revised counts as settled, and tidying the diary adds evidence without rewording it', () => {
    const doc = base();
    assert.equal(gradeOf(doc.heart.impressions[0]), sureOf(3));
    applyHeartOperation(doc, { type: 'heartEdit', kind: 'impression', itemId: 'i1', text: '她是真的爱吃辣。', at: 9 }, 'op1');
    assert.deepEqual([doc.heart.impressions[0].text, doc.heart.impressions[0].own, doc.heart.impressions[0].updatedAt, gradeOf(doc.heart.impressions[0])], ['她是真的爱吃辣。', true, 9, 3]);
    applyHeartOperation(doc, { type: 'heartDiary', at: 12, impressions: [{ id: 'i1', about: '小满', text: '模型想改口。', was: '她是真的爱吃辣。', traces: [{ id: 'o1', day: 'd9' }] }], events: [], used: [] }, 'op2');
    const kept = doc.heart.impressions[0];
    assert.equal(kept.text, '她是真的爱吃辣。'); assert.equal(kept.was, undefined); assert.equal(kept.days.length, 4, '依据照添');
    assert.equal(doc.observations.find(item => item.id === 'o1').used, true);
    assert.throws(() => applyHeartOperation(base(), { type: 'heartEdit', kind: 'impression', itemId: 'gone', text: '没有这条', at: 1 }, 'x'), /已经不在了/);
});

test('notes, thoughts and chronicle entries can be revised and added by hand; a chronicle entry moves when its floor changes', () => {
    const doc = base();
    applyHeartOperation(doc, { type: 'heartEdit', kind: 'thought', itemId: 't1', text: '她其实不怕冷场。', at: 9 }, 'a');
    assert.equal(doc.heart.thoughts[0].text, '她其实不怕冷场。');
    applyHeartOperation(doc, { type: 'heartAdd', kind: 'event', item: { title: '林间婚礼', text: '两人办了婚礼。', floor: 2, date: '三月初四' }, at: 10 }, 'b');
    assert.deepEqual(doc.heart.events.map(item => [item.title, item.floor]), [['林间婚礼', 2], ['第一次同桌', 5]], '按楼层排进去');
    applyHeartOperation(doc, { type: 'heartEdit', kind: 'event', itemId: 'e1', title: '第一次正式接触', text: '两人拼了一张桌。', floor: 1, date: '', at: 11 }, 'c');
    assert.deepEqual(doc.heart.events.map(item => item.title), ['第一次正式接触', '林间婚礼']);
    applyHeartOperation(doc, { type: 'heartAdd', kind: 'impression', item: { about: '小满', text: '她总在天黑前回来。', day: '2026-11-21' }, at: 12 }, 'd');
    const added = doc.heart.impressions.at(-1);
    assert.deepEqual([added.own, added.days.length, gradeOf(added)], [true, 1, 3], '自己写的直接算认定，不用等三个日子');
    applyHeartOperation(doc, { type: 'heartAdd', kind: 'thought', item: { group: 'self', about: '自己', text: '我比自己以为的更在意。', floor: 6 }, at: 13 }, 'e');
    assert.deepEqual(doc.heart.thoughts.map(item => item.floor), [4, 6]);
    assert.throws(() => applyHeartOperation(doc, { type: 'heartAdd', kind: 'event', item: { title: '', text: '没有标题' , floor: 1 }, at: 1 }, 'f'), /年表标题/);
    assert.throws(() => applyHeartOperation(doc, { type: 'heartAdd', kind: 'thought', item: { group: 'nobody', about: '谁', text: '类别不对', floor: 1 }, at: 1 }, 'g'), /类别无效/);
});

test('one thing still being noticed can be dropped for good, and the page is told which kind each one is', () => {
    const doc = base();
    doc.heart.impressions.push({ id: 'i2', about: '店主', text: '才看见一次。', days: [day(1)], at: 1, updatedAt: 7 });
    const data = heartData({ document: doc, snapshot: { name: '阿澈', userName: '小满', messages: [] } });
    assert.deepEqual(data.loose.map(item => [item.kind, item.id]), [['impression', 'i2'], ['trace', 'o1']]);
    applyHeartOperation(doc, { type: 'heartRemove', kind: 'trace', itemId: 'o1', at: 9 }, 'r');
    assert.deepEqual(doc.observations.map(item => item.id), ['o2']);
    assert.throws(() => applyHeartOperation(doc, { type: 'heartRemove', kind: 'trace', itemId: 'o1', at: 9 }, 'r2'), /已经不在了/);
});

test('filling in from the original text goes floor by floor in batches, leaves the newest floors alone, and asks only for traces and chronicle entries', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ name: i % 2 ? '小满' : '阿澈', is_user: i % 2 === 1, mes: `第${i}层的正文` }));
    messages[9] = { ...messages[9], mes: '' };
    const plan = fillPlan({ entries: [] }, messages);
    assert.deepEqual(plan, [{ start: 1, end: 9 }, { start: 11, end: 30 }, { start: 31, end: 47 }], '空楼断开一批；最新三层不碰');
    assert.equal(plan.at(-1).end, messages.length - REROLL_GUARD);
    assert.deepEqual(fillPlan({ entries: [], lineage: { bridgeCount: 40 } }, messages), [{ start: 41, end: 47 }]);
    assert.deepEqual(fillPlan({ entries: [] }, messages.slice(0, 3)), []);
    assert.deepEqual(fillPlan({ entries: [] }, messages, { from: 12, to: 26, perBatch: 6 }), [{ start: 12, end: 17 }, { start: 18, end: 23 }, { start: 24, end: 26 }]);
    const names = { char: '阿澈', user: '小满' }, settings = { ...DEFAULTS };
    const chronicle = chronicleAsk(settings, names, { heart: { impressions: [], thoughts: [], events: [{ id: 'e', title: '第一次同桌', text: '拼桌', floor: 2, at: 1 }], eventFloor: 0, thoughtFloor: 0 } });
    const prompt = fillPrompt(settings, sourceRows(messages, plan[0], settings), { observation: '另外返回 "traces"：痕迹要求', chronicle });
    assert.match(prompt, /输出一个JSON对象，不用Markdown：\{"traces":\[\],"events":\[\]\}。/);
    assert.ok(prompt.includes('痕迹要求') && prompt.includes('另外返回"events"字段') && prompt.includes('已有年表：[{"title":"第一次同桌","floor":2}]'));
    assert.ok(prompt.includes('"floor":1') && prompt.includes('第8层的正文') && !prompt.includes('第9层的正文'), '只带这一批的原文');
    assert.ok(!prompt.includes('"slices"'), '补全不出切片');
    assert.match(fillPrompt(settings, [], { chronicle }), /\{"events":\[\]\}。/);
    assert.equal(chronicleAsk({ ...settings, chronicle: false }, names, {}), null);
});
