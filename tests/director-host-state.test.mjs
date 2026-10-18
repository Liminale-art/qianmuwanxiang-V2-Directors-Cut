import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectorHostState } from '../qianmu-director-host-state.js';

function fixture(overrides = {}) {
  let loads = 0, closes = 0;
  const host = { isGenerating: () => false, isChatSaving: false, streamingProcessor: null,
    closeCurrentChat: () => { closes++; return Promise.resolve(true); }, ...overrides };
  const state = createDirectorHostState({ loadHost: async () => { loads++; return host; } });
  return { host, state, get loads() { return loads; }, get closes() { return closes; } };
}

test('unloaded host is unknown and fails closed without automatically importing', () => {
  const f = fixture();
  assert.deepEqual(f.state.read(), { known: false, generating: false, saving: false, streaming: false, streamingStopped: false, idle: false });
  assert.throws(() => f.state.assertIdle(), { code: 'DIRECTOR_HOST_UNAVAILABLE' });
  assert.throws(() => f.state.closeChat(), { code: 'DIRECTOR_HOST_UNAVAILABLE' });
  assert.equal(f.loads, 0); assert.equal(f.closes, 0);
});

test('ready coalesces only the module load, caches success, and re-reads live state', async () => {
  const f = fixture(); await Promise.all([f.state.ready(), f.state.ready()]);
  assert.equal(f.loads, 1); assert.equal(f.state.assertIdle().idle, true);
  f.host.isChatSaving = true;
  assert.equal((await f.state.ready()).saving, true); assert.equal(f.loads, 1);
});

test('load failure is not automatically retried, but a later explicit ready can recover', async () => {
  let attempts = 0;
  const f = fixture();
  const state = createDirectorHostState({ loadHost: async () => { if (++attempts === 1) throw new Error('synthetic'); return f.host; } });
  await assert.rejects(state.ready(), { code: 'DIRECTOR_HOST_UNAVAILABLE' });
  assert.equal(attempts, 1); assert.equal(state.read().known, false);
  assert.equal((await state.ready()).idle, true); assert.equal(attempts, 2);
});

for (const [label, value] of [
  ['missing loader', undefined], ['nonfunction loader', 1],
]) test(label, () => assert.throws(() => createDirectorHostState({ loadHost: value }), { code: 'DIRECTOR_HOST_UNAVAILABLE' }));

for (const [label, overrides] of [
  ['missing isGenerating', { isGenerating: undefined }],
  ['missing close', { closeCurrentChat: undefined }],
  ['nonboolean saving', { isChatSaving: 0 }],
  ['undefined stream', { streamingProcessor: undefined }],
  ['false stream', { streamingProcessor: false }],
  ['primitive stream', { streamingProcessor: 'active' }],
  ['incomplete stream', { streamingProcessor: { isStopped: false } }],
  ['invalid stopped flag', { streamingProcessor: { isStopped: 0, isFinished: true } }],
  ['invalid finished flag', { streamingProcessor: { isStopped: false, isFinished: 'true' } }],
  ['nonboolean generation', { isGenerating: () => 1 }],
  ['throwing generation', { isGenerating: () => { throw new Error('synthetic'); } }],
]) test(`${label} fails closed without native calls`, async () => {
  const f = fixture(overrides);
  await assert.rejects(f.state.ready(), { code: 'DIRECTOR_HOST_UNAVAILABLE' });
  assert.equal(f.state.read().known, false); assert.equal(f.closes, 0);
});

test('throwing live getter makes cached module unavailable without replacing it', async () => {
  const f = fixture(); await f.state.ready();
  Object.defineProperty(f.host, 'isChatSaving', { get() { throw new Error('synthetic'); } });
  assert.equal(f.state.read().known, false);
  await assert.rejects(f.state.ready(), { code: 'DIRECTOR_HOST_UNAVAILABLE' });
  assert.throws(() => f.state.closeChat(), { code: 'DIRECTOR_HOST_UNAVAILABLE' });
  assert.equal(f.loads, 1); assert.equal(f.closes, 0);
});

test('host generation gate also covers nonstreaming and group states', async () => {
  const f = fixture({ isGenerating: () => true }); await f.state.ready();
  assert.equal(f.state.read().generating, true); assert.equal(f.state.read().idle, false);
  assert.throws(() => f.state.assertIdle(), { code: 'DIRECTOR_HOST_BUSY' });
  assert.throws(() => f.state.assertIdle({ allowSaving: true }), { code: 'DIRECTOR_HOST_BUSY' });
  assert.throws(() => f.state.closeChat(), { code: 'DIRECTOR_HOST_BUSY' });
  assert.equal(f.closes, 0);
});

test('save gate can only be explicitly waived, not by truthy options', async () => {
  const f = fixture({ isChatSaving: true }); await f.state.ready();
  assert.throws(() => f.state.assertIdle(), { code: 'DIRECTOR_HOST_BUSY' });
  assert.throws(() => f.state.assertIdle({ allowSaving: 1 }), { code: 'DIRECTOR_HOST_BUSY' });
  assert.equal(f.state.assertIdle({ allowSaving: true }).saving, true);
  assert.throws(() => f.state.closeChat(), { code: 'DIRECTOR_HOST_BUSY' });
});

for (const isFinished of [false, true]) test(`live stream remains busy through native save tail (finished=${isFinished})`, async () => {
  const f = fixture({ streamingProcessor: { isStopped: false, isFinished } }); await f.state.ready();
  assert.equal(f.state.read().streaming, true); assert.equal(f.state.read().idle, false);
  assert.throws(() => f.state.assertIdle({ allowSaving: true }), { code: 'DIRECTOR_HOST_BUSY' });
  f.host.streamingProcessor = null;
  assert.equal(f.state.assertIdle().idle, true);
});

test('explicit stop still waits for native tail, not merely isFinished', async () => {
  const processor = { isStopped: false, isFinished: false };
  const f = fixture({ streamingProcessor: processor }); await f.state.ready();
  processor.isFinished = true;
  assert.throws(() => f.state.assertIdle(), { code: 'DIRECTOR_HOST_BUSY' });
  f.host.isChatSaving = true; f.host.streamingProcessor = null;
  assert.throws(() => f.state.assertIdle(), { code: 'DIRECTOR_HOST_BUSY' });
  f.host.isChatSaving = false;
  assert.equal(f.state.assertIdle().idle, true);
});

test('failed stream residue does not permanently disable manual Q, and remains visible to auto policy', async () => {
  const f = fixture({ streamingProcessor: { isStopped: true, isFinished: false } }); await f.state.ready();
  const state = f.state.assertIdle();
  assert.equal(state.streaming, false); assert.equal(state.streamingStopped, true); assert.equal(state.idle, true);
  f.host.isChatSaving = true;
  assert.throws(() => f.state.assertIdle(), { code: 'DIRECTOR_HOST_BUSY' });
});

test('native close begins synchronously with no hidden import or timer and returns native result', async () => {
  const f = fixture(); await f.state.ready();
  const result = f.state.closeChat();
  assert.equal(f.closes, 1); assert.equal(f.loads, 1); assert.equal(await result, true);
});

test('native close false and rejection are passed through, never retried', async () => {
  let count = 0;
  const f = fixture({ closeCurrentChat: () => ++count === 1 ? Promise.resolve(false) : Promise.reject(new Error('native failure')) });
  await f.state.ready();
  assert.equal(await f.state.closeChat(), false);
  await assert.rejects(f.state.closeChat(), /native failure/); assert.equal(count, 2);
});

test('state results are immutable observations, not writable host locks', async () => {
  const f = fixture(); await f.state.ready();
  assert.throws(() => { f.state.read().saving = true; }, TypeError);
  assert.equal(f.host.isChatSaving, false);
});
