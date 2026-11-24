// 痕迹（观察日记的原料）：跟着切片总结一起要，只存不注入；随备份走，随清理清。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, applyOperation, fingerprintMessages, parseObservations, validateDocument, OBSERVATION_LIMIT, DEFAULTS } from '../yimu/contract.mjs';
import { summaryPrompt, observationProtocol, selectMemories } from '../yimu/core.mjs';
import { portableDocument, restoreBackupDocument } from '../yimu/backup-contract.mjs';
import { mergeBackupDocument } from '../yimu/backup-merge.mjs';

const binding = { avatar: 'Seen.png', file: 'observed', integrity: 'seen-id' };
const messages = Array.from({ length: 12 }, (_, i) => ({ name: i % 2 ? '阿澈' : '小满', is_user: i % 2 === 0, mes: `第 ${i + 1} 层正文。`, send_date: String(i) }));
const enabled = () => applyOperation(createDocument(binding), { id: 'enable', type: 'enable', enabled: true, expectedRevision: 0, range: { start: 1, end: 12, total: 12 } }).document;
const observe = (doc, id, items, range, at = 1000) => applyOperation(doc, { id, type: 'observe', items, range, at }).document;

test('the protocol names the character and the user, and is left out when there is no character name', () => {
    const text = observationProtocol({ char: '阿澈', user: '小满' });
    assert.match(text, /记 阿澈 在这段正文里留意到的、关于 小满 或其他角色的事/); assert.match(text, /以 阿澈 的第一人称写/);
    assert.ok(!/\{\{|TA|用户/.test(text), '发出去的文字里没有宏，也没有「TA／用户」这类称谓');
    assert.equal(observationProtocol({ char: '', user: '小满' }), ''); assert.equal(observationProtocol(null), '');
    const batch = { start: 1, end: 4 };
    const flat = value => JSON.stringify(value);
    assert.ok(flat(summaryPrompt(messages, batch, { ...DEFAULTS }, { names: { char: '阿澈', user: '小满' } })).includes('traces'));
    assert.ok(!flat(summaryPrompt(messages, batch, { ...DEFAULTS })).includes('traces'), '没有名字（整段重做）时不要痕迹');
});

test('traces are read leniently: malformed ones are dropped one by one, never failing the summary', () => {
    const reply = JSON.stringify({ slices: [], traces: [
        { about: '小满', text: '我注意到她又点了辣的。', floor: 2 }, { about: '小满', text: '我注意到她又点了辣的。', floor: 3 },
        { about: '', text: '没有写是谁', floor: 2 }, { about: '店主', text: '越界的楼层', floor: 9 }, { about: '店主', text: '他记得她的口味。', floor: 4 },
        { about: '小满', text: '第四条有效的，但一次最多三条。', floor: 1 }, '不是对象'] });
    // n：这条在返回的 traces 里的序号（从 1 数起，丢掉的也占位），同一次返回里的印象按它指认痕迹。
    assert.deepEqual(parseObservations(reply, { start: 1, end: 4 }), [
        { about: '小满', text: '我注意到她又点了辣的。', floor: 2, n: 1 }, { about: '店主', text: '他记得她的口味。', floor: 4, n: 5 }, { about: '小满', text: '第四条有效的，但一次最多三条。', floor: 1, n: 6 }]);
    for (const bad of ['不是 JSON', '{"slices":[]}', '{"traces":"x"}', '', undefined]) assert.deepEqual(parseObservations(bad), []);
    assert.equal(parseObservations('```json\n' + reply + '\n```', { start: 1, end: 4 }).length, 3);
});

test('a batch of traces is stored once; re-summarizing the same floors replaces them; clearing memory clears them', () => {
    let doc = observe(enabled(), 'o1', [{ about: '小满', text: '她又点了辣的。', floor: 2, date: '1999-01-02' }, { about: '店主', text: '他记得她的口味。', floor: 4 }], { start: 1, end: 4 }, 111);
    assert.deepEqual(doc.observations, [{ id: 'o1_0', about: '小满', text: '她又点了辣的。', floor: 2, at: 111, date: '1999-01-02' }, { id: 'o1_1', about: '店主', text: '他记得她的口味。', floor: 4, at: 111 }]);
    doc = observe(doc, 'o2', [{ about: '小满', text: '她怕冷。', floor: 6 }], { start: 5, end: 8 }, 222);
    assert.equal(doc.observations.length, 3);
    // 第 1–4 层重新总结：这一段的旧痕迹换成新的一批（可以是空的）。
    doc = observe(doc, 'o3', [{ about: '小满', text: '她其实更爱吃酸的。', floor: 3 }], { start: 1, end: 4 }, 333);
    assert.deepEqual(doc.observations.map(item => item.text), ['她怕冷。', '她其实更爱吃酸的。']);
    assert.equal(applyOperation(doc, { id: 'o3', type: 'observe', items: [{ about: '小满', text: '她其实更爱吃酸的。', floor: 3 }], range: { start: 1, end: 4 }, at: 333 }).outcome, 'duplicate');
    assert.throws(() => observe(doc, 'o4', [{ about: '小满', text: '范围外', floor: 9 }], { start: 1, end: 4 }), /不在本次总结范围内/);
    assert.throws(() => observe(doc, 'o5', Array.from({ length: 4 }, (_, i) => ({ about: '小满', text: `第 ${i} 条`, floor: 1 })), { start: 1, end: 4 }), /数量无效/);
    // 清理留痕（已删除的旧记录）不动痕迹；清空全部记忆时一并清。
    assert.equal(applyOperation(doc, { id: 'p1', type: 'purge', scope: 'traces', expectedRevision: doc.revision }).document.observations.length, 2);
    assert.equal(applyOperation(doc, { id: 'p2', type: 'purge', scope: 'all', expectedRevision: doc.revision }).document.observations, undefined);
    // 上限：只留最新的。
    const many = { ...doc, observations: Array.from({ length: OBSERVATION_LIMIT }, (_, i) => ({ id: `x${i}`, about: '小满', text: `旧 ${i}`, floor: 12, at: 1 })) };
    const capped = observe(validateDocument(many), 'o6', [{ about: '小满', text: '最新的一条', floor: 2 }], { start: 1, end: 4 });
    assert.equal(capped.observations.length, OBSERVATION_LIMIT); assert.equal(capped.observations.at(-1).text, '最新的一条'); assert.equal(capped.observations[0].text, '旧 1');
});

test('traces never reach the reply: selection only ever returns memory entries', async () => {
    const hashes = await fingerprintMessages(messages);
    let doc = applyOperation(enabled(), { id: 'add', type: 'append', expectedEpoch: 1, entry: { id: 's', kind: 'summary', text: '两人在面馆吃了一顿辣的。', source: { start: 1, end: 2, hashes: hashes.slice(0, 2) } } }).document;
    doc = observe(doc, 'o1', [{ about: '小满', text: '她又点了辣的。', floor: 2 }], { start: 1, end: 2 });
    const chosen = selectMemories(doc, { messages }, { ...DEFAULTS }, hashes);
    assert.ok(chosen.every(entry => entry.kind)); assert.ok(!JSON.stringify(chosen).includes('她又点了辣的'));
});

test('traces travel with a backup and merge by identity', () => {
    const doc = observe(enabled(), 'o1', [{ about: '小满', text: '她又点了辣的。', floor: 2 }], { start: 1, end: 4 });
    const portable = portableDocument(doc);
    assert.deepEqual(portable.observations, doc.observations);
    assert.equal(portableDocument(enabled()).observations, undefined, '没有痕迹时备份里不留空字段');
    const restored = restoreBackupDocument(portable, { binding, mappings: { source_0: binding } }).document;
    assert.deepEqual(restored.observations, doc.observations);
    // 合并进已有文档：已有的不重复，新的接在后面。
    const receiver = observe(enabled(), 'o9', [{ about: '店主', text: '他记得她的口味。', floor: 4 }], { start: 1, end: 4 });
    const merged = mergeBackupDocument(receiver, restored, { operationId: 'merge_1', packageId: 'a'.repeat(64) }).document;
    assert.deepEqual(merged.observations.map(item => item.text), ['他记得她的口味。', '她又点了辣的。']);
    const again = mergeBackupDocument(merged, restored, { operationId: 'merge_2', packageId: 'a'.repeat(64) });
    assert.equal(again.document.observations.length, 2);
});
