import assert from 'node:assert/strict';
import {
  STORYBOARD_MESSAGE_LINK_STATES,
  STORYBOARD_PIPELINE_LOG_LIMIT,
  STORYBOARD_WORKFLOW_STATES,
  createStoryboardDefaults,
  createStoryboardMessageReference,
  createStoryboardWorkflowTicket,
  normalizeStoryboardAutomation,
  normalizeStoryboardState,
  resolveStoryboardMessageReference,
} from '../qianmu-storyboard.js';

const assistant = {
  name: 'Erebus', is_user: false, is_system: false, send_date: '2026-08-27T10:00:00Z',
  mes: 'The first finished reply.', swipe_id: 0,
  swipes: ['The first finished reply.', 'An alternate finished reply.'],
  swipe_info: [
    { send_date: '2026-08-27T10:00:00Z', extra: { gen_id: 41 } },
    { send_date: '2026-08-27T10:01:00Z', extra: { gen_id: 42 } },
  ],
  extra: { gen_id: 41 },
};
const ref = createStoryboardMessageReference({ message: assistant, chatKey: 'chat-a', floor: 2, now: 100 });
assert.equal(ref.lastKnownFloor, 2);
assert.ok(ref.messageKey);
assert.ok(ref.revisionId);

const shiftedChat = [
  { name: 'System', is_system: true, mes: 'header' },
  { name: 'User', is_user: true, mes: 'earlier' },
  { name: 'User', is_user: true, mes: 'question' },
  structuredClone(assistant),
];
const relocated = resolveStoryboardMessageReference(ref, shiftedChat, { chatKey: 'chat-a' });
assert.equal(relocated.state, 'active');
assert.equal(relocated.floor, 3);
assert.equal(relocated.relocated, true, 'deleting or inserting preceding floors must not break the binding');

const editedChat = structuredClone(shiftedChat);
editedChat[3].mes = 'The same floor was edited after generation.';
assert.equal(resolveStoryboardMessageReference(ref, editedChat, { chatKey: 'chat-a' }).state, 'stale');

const swipedChat = structuredClone(shiftedChat);
Object.assign(swipedChat[3], {
  mes: assistant.swipes[1], swipe_id: 1, send_date: assistant.swipe_info[1].send_date,
  extra: assistant.swipe_info[1].extra,
});
assert.equal(resolveStoryboardMessageReference(ref, swipedChat, { chatKey: 'chat-a' }).state, 'inactive_swipe');
assert.equal(resolveStoryboardMessageReference(ref, [], { chatKey: 'chat-a' }).state, 'orphaned');
assert.equal(resolveStoryboardMessageReference(ref, shiftedChat, { chatKey: 'chat-b' }).state, 'foreign');
for (const state of ['active', 'stale', 'inactive_swipe', 'orphaned', 'foreign']) assert.ok(STORYBOARD_MESSAGE_LINK_STATES.includes(state));

assert.deepEqual(normalizeStoryboardAutomation({ autoCapture: false, autoGenerate: true }), { autoCapture: false, autoGenerate: false });
assert.deepEqual(normalizeStoryboardAutomation({ autoCapture: true, autoGenerate: true }), { autoCapture: true, autoGenerate: true });
const ticket = createStoryboardWorkflowTicket({ messageRef: ref, chatKey: 'chat-a', origin: 'automatic', autoGenerate: true, compilerSignature: 'preset-a', createdAt: 200 });
const duplicate = createStoryboardWorkflowTicket({ messageRef: ref, chatKey: 'chat-a', origin: 'automatic', autoGenerate: true, compilerSignature: 'preset-a', createdAt: 300 });
assert.equal(ticket.idempotencyKey, duplicate.idempotencyKey, 'one message revision and compiler setup may run only once');
assert.equal(ticket.autoGenerate, true);
assert.equal(ticket.status, 'idle');
assert.ok(STORYBOARD_WORKFLOW_STATES.includes('prompt_ready'));
assert.ok(STORYBOARD_WORKFLOW_STATES.includes('generating'));
assert.ok(STORYBOARD_WORKFLOW_STATES.includes('stale'));

const defaults = createStoryboardDefaults();
assert.equal(defaults.enabled, false, 'a new install must never spend image credits without opt-in');
const upgraded = normalizeStoryboardState({
  schemaVersion: 2,
  logs: Array.from({ length: 35 }, (_, index) => ({ id: `legacy-${index}`, source: 'novel', status: 'success', finishedAt: 1000 + index })),
  pipelineLogs: Array.from({ length: 35 }, (_, index) => ({ id: `pipe-${index}`, providerId: 'novel', status: 'success', finishedAt: 1000 + index })),
  automation: { autoCapture: false, autoGenerate: true },
  shotPlans: [{ id: 'legacy-plan', status: 'ready', shots: [{ id: 'legacy-shot', status: 'running' }] }],
});
assert.equal(upgraded.enabled, true);
assert.equal(upgraded.logs.length, STORYBOARD_PIPELINE_LOG_LIMIT);
assert.equal(upgraded.pipelineLogs.length, STORYBOARD_PIPELINE_LOG_LIMIT);
assert.deepEqual(upgraded.automation, { autoCapture: false, autoGenerate: false });
assert.equal(upgraded.shotPlans[0].status, 'prompt_ready');
assert.equal(upgraded.shotPlans[0].shots[0].status, 'generating');

console.log('Storyboard v3 lifecycle contract OK');
