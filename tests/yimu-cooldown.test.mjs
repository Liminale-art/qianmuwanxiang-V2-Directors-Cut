// 「刚提过」冷却：一条细切片被带入后的若干层内，不再仅因沾边就又被带一次。
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperation, createDocument, fingerprintMessages, DEFAULTS, validateSettings } from '../yimu/contract.mjs';
import { selectMemories } from '../yimu/core.mjs';

const binding = { avatar: 'Cool.png', file: 'cooldown', integrity: 'cool-id' };
// 40 层：前 12 层分成六条切片，各带一个专名；后面是普通正文，最后一条（用户发言）决定本轮在聊什么。
const topics = ['灯塔', '码头', '面包房', '钟楼', '裁缝铺', '邮局'];
const build = async last => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ name: i % 2 ? '甲' : '乙', is_user: i % 2 === 1, mes: i < 12 ? `第 ${i + 1} 层，他们去了${topics[Math.floor(i / 2)]}。` : `第 ${i + 1} 层的平常对话。`, send_date: String(i) }));
    messages[39] = { ...messages[39], mes: last };
    const hashes = await fingerprintMessages(messages);
    let doc = applyOperation(createDocument(binding), { id: 'enable', type: 'enable', enabled: true, expectedRevision: 0, range: { start: 1, end: 40, total: 40 } }).document;
    topics.forEach((topic, i) => {
        doc = applyOperation(doc, { id: `add_${i}`, type: 'append', expectedEpoch: doc.epoch,
            entry: { id: `s${i}`, kind: 'summary', text: `两人在${topic}待了一下午，聊起${topic}的旧事。`, source: { start: i * 2 + 1, end: i * 2 + 2, hashes: hashes.slice(i * 2, i * 2 + 2) } } }).document;
    });
    return { doc, messages, hashes };
};
const pick = (f, settings, recalledAt) => selectMemories(f.doc, { messages: f.messages }, { ...DEFAULTS, ...settings }, f.hashes, '', null, '', recalledAt).map(entry => entry.id);

test('a slice carried a few floors ago is not carried again just for being related; the most relevant one and a direct question still are', async () => {
    const f = await build('我们顺路经过灯塔和码头，再去面包房买点东西。');
    const fresh = pick(f, {}, null);
    for (const id of ['s0', 's1', 's2']) assert.ok(fresh.includes(id), `没有记录时相关的都带：${id}`);
    // 三条都在 4 层前带过：冷却期内只留本轮最相关的一条，其余两条不再重复带。
    const recent = new Map([['s0', 36], ['s1', 36], ['s2', 36]]);
    const cooled = pick(f, {}, recent).filter(id => ['s0', 's1', 's2'].includes(id));
    assert.equal(cooled.length, 1, '冷却期内只破例带最相关的一条');
    // 超过冷却层数就恢复；填 0 关闭冷却。
    const old = new Map([['s0', 30], ['s1', 30], ['s2', 30]]);
    assert.equal(pick(f, {}, old).filter(id => ['s0', 's1', 's2'].includes(id)).length, 3, '过了冷却期照常带');
    assert.equal(pick(f, { recallCooldown: 0 }, recent).filter(id => ['s0', 's1', 's2'].includes(id)).length, 3, '填 0 关闭');
    // 同一楼层重新生成：不算冷却，带的记忆与上一次相同。
    const sameFloor = new Map([['s0', 40], ['s1', 40], ['s2', 40]]);
    assert.equal(pick(f, {}, sameFloor).filter(id => ['s0', 's1', 's2'].includes(id)).length, 3, '重随时带同样的记忆');
    // 正文在问「还记得吗」：冷却让路。
    const asked = await build('你还记得我们去过灯塔、码头和面包房吗？');
    assert.equal(pick(asked, {}, recent).filter(id => ['s0', 's1', 's2'].includes(id)).length, 3, '被问到时照常带');
});

test('the cooldown is an ordinary bounded setting, on by default', () => {
    assert.equal(DEFAULTS.recallCooldown, 6);
    assert.deepEqual(validateSettings({ recallCooldown: 0 }), { recallCooldown: 0 });
    assert.throws(() => validateSettings({ recallCooldown: -1 }));
    assert.throws(() => validateSettings({ recallCooldown: 1.5 }));
});
