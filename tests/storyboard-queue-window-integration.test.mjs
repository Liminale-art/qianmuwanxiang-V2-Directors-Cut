import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createStoryboardQueueWindow } from '../qianmu-storyboard-queue-window.js';
import { startStoryboardQueueWindowBatch } from '../qianmu-storyboard-queue-batch.js';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');

function fixture({ activeCount = 0, admit = async () => {} } = {}) {
  const state = { enabled: true, logs: [] };
  const queue = [];
  const active = new Map(Array.from({ length: activeCount }, (_, index) => [`active-${index}`, {}]));
  const notices = [];
  let logId = 0;
  const window = createStoryboardQueueWindow({ limit: 8, occupied: () => queue.length + active.size, pollMs: 5 });
  const context = vm.createContext({
    STORYBOARD_QUEUE_LIMIT: 8, storyboardQueue: queue, storyboardActiveJobs: active,
    storyboardQueueWindow: window, storyboardQueueSettling: 0, storyboardState: () => state, getChatKey: () => 'chat-a',
    applyStoryboardFloorTakeToJob() {}, resolveStoryboardJobModelIdentity: () => ({ providerId: 'openai', model: 'image-model' }),
    storyboardAutomaticJobEnabled: () => true, storyboardValidatedAnchor: () => ({ valid: true }),
    storyboardImageAdmissionRuntime: async () => ({ admit }),
    getStoryboardGenerationPolicy: () => ({ maxImages: 21 }), storyboardGalleryRecords: () => [],
    storyboardStartLog: () => { const log = { id: `log-${++logId}` }; state.logs.push(log); return log; },
    storyboardPlanForJob: () => null, storyboardSetPlanStatus() {}, storyboardPumpQueue() {},
    storyboardSettleImageAdmission: async () => {}, saveSettings() {}, renderModal() {},
    toast: message => notices.push(message),
  });
  vm.runInContext(storyboardFunctionSource('storyboardQueueJob'), context);
  const job = id => ({ id, source: 'openai', target: 'gallery', profile: { model: 'image-model' },
    connection: { baseUrl: 'https://image.invalid/api' }, payload: { prompt: 'A narrative still', parameters: {} } });
  return { context, state, queue, active, window, notices, job };
}

test('index initializes the window against the actual queue and active jobs', async () => {
  const declaration = indexSource.match(/(?:const|let)\s+storyboardQueueWindow\s*=\s*createStoryboardQueueWindow\(\{[^\n]*\}\);/);
  assert.ok(declaration, 'index must install one window against its live eight-slot queue');
  const context = vm.createContext({ createStoryboardQueueWindow, STORYBOARD_QUEUE_LIMIT: 8,
    storyboardQueue: [], storyboardActiveJobs: new Map(), storyboardQueueSettling: 0 });
  vm.runInContext(declaration[0].replace(/^(?:const|let)/, 'var'), context);
  try {
    context.storyboardQueue.push({});
    const permits = await Promise.all(Array.from({ length: 7 }, () => context.storyboardQueueWindow.acquire()));
    const next = context.storyboardQueueWindow.acquire();
    assert.equal(context.storyboardQueueWindow.waitingCount, 1);
    context.storyboardQueue.pop();
    context.storyboardQueueWindow.notify();
    const eighth = await next;
    for (const permit of [...permits, eighth]) permit.release();
    assert.equal(context.storyboardQueueWindow.reservedCount, 0);
  } finally { context.storyboardQueueWindow.close(); }
});

test('the eighth shot can enter with its own permit while seven slots are occupied', async () => {
  const f = fixture({ activeCount: 7 });
  try {
    const permit = await f.window.acquire();
    assert.equal(f.active.size + f.window.reservedCount, 8);
    try { assert.equal(await f.context.storyboardQueueJob(f.job('shot-8'), () => true, () => {}, permit), true); }
    finally { permit.release(); }
    assert.equal(f.queue.length, 1);
    assert.equal(f.active.size + f.queue.length, 8);
  } finally { f.window.close(); }
});

test('eight asynchronous admissions reserve their slots against a competing direct request', async () => {
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const admitted = [];
  const f = fixture({ admit: async job => { admitted.push(job.id); if (job.id !== 'manual') await gate; } });
  const permits = await Promise.all(Array.from({ length: 8 }, () => f.window.acquire()));
  const pending = permits.map((permit, index) => f.context.storyboardQueueJob(f.job(`shot-${index + 1}`), () => true, () => {}, permit)
    .finally(() => permit.release()));
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(admitted.length, 8);
    assert.equal(f.window.reservedCount, 8);
    assert.equal(await f.context.storyboardQueueJob(f.job('manual')), false);
    assert.equal(admitted.length, 8, 'direct requests must not enter admission while all slots are reserved');
  } finally {
    resume();
    await Promise.allSettled(pending);
    f.window.close();
  }
  assert.equal(f.queue.length, 8);
  assert.equal(f.window.reservedCount, 0);
});

test('cancelled or stale waiting batches never reach durable admission', async () => {
  let admits = 0;
  const f = fixture({ activeCount: 8, admit: async () => { admits++; } });
  try {
    const controller = new AbortController();
    const cancelled = f.window.acquire({ batch: 'cancel', signal: controller.signal })
      .then(permit => f.context.storyboardQueueJob(f.job('cancelled'), () => true, () => {}, permit)
        .finally(() => permit.release()));
    controller.abort();
    await assert.rejects(cancelled, { code: 'storyboard_queue_window_cancelled' });

    let current = true;
    const stale = f.window.acquire({ batch: 'stale', isCurrent: () => current })
      .then(permit => f.context.storyboardQueueJob(f.job('stale'), () => current, () => {}, permit)
        .finally(() => permit.release()));
    current = false;
    await assert.rejects(stale, { code: 'storyboard_queue_window_stale' });
    assert.equal(admits, 0);
    assert.equal(f.queue.length, 0);
    assert.equal(f.window.waitingCount, 0);
  } finally { f.window.close(); }
});

test('real queue admission drains 21 jobs without exceeding eight accepted slots', async () => {
  let admits = 0, peak = 0;
  const f = fixture({ admit: async () => { admits++; } });
  const order = [];
  try {
    const handle = startStoryboardQueueWindowBatch(f.window, {
      jobs: Array.from({ length: 21 }, (_, index) => f.job(`S${index + 1}`)),
      enqueue: (job, permit, current) => f.context.storyboardQueueJob(job, current, () => {}, permit),
      onAccepted: job => {
        order.push(job.id);
        peak = Math.max(peak, f.queue.length);
        if (f.queue.length === 8) queueMicrotask(() => { f.queue.shift(); f.window.notify(); });
      },
    });
    const result = await handle.done;
    assert.equal(result.stopped, false, result.reason?.message);
    assert.equal(result.acceptedCount, 21);
    assert.equal(result.failedCount, 0);
    assert.equal(admits, 21);
    assert.equal(peak, 8);
    assert.deepEqual(order, Array.from({ length: 21 }, (_, index) => `S${index + 1}`));
    assert.equal(f.state.logs.length, 21);
    assert.equal(f.window.reservedCount, 0);
  } finally { f.window.close(); }
});
