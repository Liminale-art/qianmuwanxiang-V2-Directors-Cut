import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryboardMessageReference, resolveStoryboardMessageReference } from '../qianmu-storyboard.js';

const strip = ref => ({ ...ref, createdAt: 0, updatedAt: 0 });
const fresh = message => strip(createStoryboardMessageReference({ message: structuredClone(message), chatKey: 'c', floor: 0, now: 1 }));

test('the remembered identity always equals a fresh computation, across edits, swipes and regenerations', () => {
  const message = { name: 'A', is_user: false, mes: '第一版正文', send_date: '2026-01-01T00:00:00Z', swipe_id: 0, swipes: ['第一版正文'], swipe_info: [{ send_date: '2026-01-01T00:00:00Z', extra: { gen_id: 'g1' } }], extra: { gen_id: 'g1' } };
  const read = () => strip(createStoryboardMessageReference({ message, chatKey: 'c', floor: 0, now: 1 }));
  const first = read(); assert.deepEqual(first, fresh(message)); assert.deepEqual(read(), first, 'second read reuses the entry');
  message.mes = '第一版正文（改）'; message.swipes[0] = message.mes;
  const edited = read(); assert.deepEqual(edited, fresh(message)); assert.notEqual(edited.revisionId, first.revisionId);
  message.swipes.push('第二版'); message.swipe_info.push({ send_date: '2026-01-02T00:00:00Z', extra: { gen_id: 'g2' } }); message.swipe_id = 1; message.mes = '第二版';
  const swiped = read(); assert.deepEqual(swiped, fresh(message)); assert.equal(swiped.messageKey, edited.messageKey); assert.notEqual(swiped.revisionId, edited.revisionId);
  message.name = 'B'; assert.deepEqual(read(), fresh(message));
  delete message.swipe_info; delete message.extra; delete message.send_date; assert.deepEqual(read(), fresh(message), 'fallback identity (no date, no generation id) is covered too');
});

test('resolving a reference in a long chat hashes each message text once, not once per lookup', () => {
  const chat = Array.from({ length: 400 }, (_, i) => ({ name: 'A', is_user: i % 2 === 0, mes: `楼层 ${i} ` + '正文'.repeat(600), send_date: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z`, swipe_id: 0 }));
  const target = createStoryboardMessageReference({ message: chat[321], chatKey: 'c', floor: 321 });
  const cold = performance.now(); assert.equal(resolveStoryboardMessageReference(target, chat, { chatKey: 'c' }).floor, 321); const coldMs = performance.now() - cold;
  const warm = performance.now(); for (let i = 0; i < 20; i++) assert.equal(resolveStoryboardMessageReference(target, chat, { chatKey: 'c' }).floor, 321); const warmMs = (performance.now() - warm) / 20;
  assert.ok(warmMs < coldMs / 3, `repeat lookups must be much cheaper than the first (cold ${coldMs.toFixed(1)}ms, warm ${warmMs.toFixed(2)}ms)`);
  chat[321].mes += '！';
  assert.deepEqual(strip(createStoryboardMessageReference({ message: chat[321], chatKey: 'c', floor: 321, now: 1 })), strip(createStoryboardMessageReference({ message: structuredClone(chat[321]), chatKey: 'c', floor: 321, now: 1 })));
});
