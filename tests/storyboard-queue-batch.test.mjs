import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryboardQueueWindow } from '../qianmu-storyboard-queue-window.js';
import { startStoryboardQueueWindowBatch } from '../qianmu-storyboard-queue-batch.js';

const jobs = count => Array.from({ length: count }, (_, index) => ({ id: `S${index + 1}` }));
const bounded = promise => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('batch did not settle')), 1000);
  Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

test('synchronous registration drains 21 narrative shots through eight occupied slots', async () => {
  const queue = [], order = [];
  let peak = 0;
  const window = createStoryboardQueueWindow({ occupied: () => queue.length });
  try {
    const handle = startStoryboardQueueWindowBatch(window, {
      jobs: jobs(21),
      enqueue: async (job, permit) => {
        assert.equal(window.has(permit), true);
        queue.push(job);
        job.queueAccepted = true;
        peak = Math.max(peak, queue.length);
        if (queue.length === 8) queueMicrotask(() => { queue.shift(); window.notify(); });
        return true;
      },
      onAccepted: job => order.push(job.id),
    });
    assert.equal(handle.pendingCount, 21, 'registration returns before producer work begins');
    assert.equal(handle.acceptedCount, 0);
    assert.ok(handle.batch);
    const result = await bounded(handle.done);
    assert.deepEqual(order, jobs(21).map(job => job.id));
    assert.equal(result.acceptedCount, 21);
    assert.equal(result.failedCount, 0);
    assert.equal(result.pendingCount, 0);
    assert.equal(result.stopped, false);
    assert.equal(peak, 8);
    assert.equal(window.reservedCount, 0);
    assert.equal(window.waitingCount, 0);
  } finally { window.close(); }
});

test('two batches compete FIFO for the next vacant slot', async () => {
  let occupied = 1;
  const seen = [];
  const window = createStoryboardQueueWindow({ limit: 1, occupied: () => occupied, pollMs: 5 });
  try {
    const first = startStoryboardQueueWindowBatch(window, { jobs: [{ id: 'A' }],
      enqueue: async job => { seen.push(job.id); occupied = 1; return true; } });
    const second = startStoryboardQueueWindowBatch(window, { jobs: [{ id: 'B' }],
      enqueue: async job => { seen.push(job.id); occupied = 1; return true; } });
    await Promise.resolve();
    assert.equal(window.waitingCount, 2);
    occupied = 0;
    window.notify();
    await bounded(first.done);
    assert.deepEqual(seen, ['A']);
    assert.equal(window.waitingCount, 1);
    occupied = 0;
    window.notify();
    await bounded(second.done);
    assert.deepEqual(seen, ['A', 'B']);
  } finally { window.close(); }
});

test('stop immediately cancels waiting shots and reports every unsubmitted job', async () => {
  const window = createStoryboardQueueWindow({ limit: 1, occupied: () => 1, pollMs: 5 });
  const stopped = [];
  let enqueues = 0;
  try {
    const handle = startStoryboardQueueWindowBatch(window, { jobs: jobs(3),
      enqueue: async () => { enqueues++; return true; }, onStop: result => stopped.push(result) });
    await Promise.resolve();
    assert.equal(window.waitingCount, 1);
    assert.equal(handle.stop('用户取消'), true);
    const result = await bounded(handle.done);
    assert.equal(result.stopped, true);
    assert.match(result.reason.message, /用户取消/);
    assert.deepEqual(result.remainingJobs.map(job => job.id), ['S1', 'S2', 'S3']);
    assert.equal(result.pendingCount, 3);
    assert.equal(stopped.length, 1);
    assert.equal(enqueues, 0);
    assert.equal(window.waitingCount, 0);
    assert.equal(handle.stop('again'), false);
  } finally { window.close(); }
});

test('a stale guard preserves accepted shots and stops only the unsubmitted remainder', async () => {
  const queue = [];
  let current = true, enqueues = 0;
  const stopped = [];
  const window = createStoryboardQueueWindow({ limit: 1, occupied: () => queue.length, pollMs: 5 });
  try {
    const handle = startStoryboardQueueWindowBatch(window, { jobs: jobs(3), isCurrent: () => current,
      enqueue: async job => { enqueues++; queue.push(job); job.queueAccepted = true; return true; },
      onStop: result => stopped.push(result) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(handle.acceptedCount, 1);
    assert.equal(window.waitingCount, 1);
    current = false;
    const result = await bounded(handle.done);
    assert.equal(result.acceptedCount, 1);
    assert.equal(result.stopped, true);
    assert.deepEqual(result.remainingJobs.map(job => job.id), ['S2', 'S3']);
    assert.equal(stopped.length, 1);
    assert.equal(enqueues, 1);
    assert.deepEqual(queue.map(job => job.id), ['S1']);
  } finally { window.close(); }
});

test('stop during preparation releases the permit and never calls enqueue', async () => {
  let releasePrepare;
  const pendingPrepare = new Promise(resolve => { releasePrepare = resolve; });
  const window = createStoryboardQueueWindow({ limit: 1, occupied: () => 0 });
  let enqueues = 0;
  try {
    const handle = startStoryboardQueueWindowBatch(window, { jobs: jobs(2),
      prepare: () => pendingPrepare,
      enqueue: async () => { enqueues++; return true; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(window.reservedCount, 1);
    handle.stop('准备已取消');
    const result = await bounded(handle.done);
    assert.equal(result.stopped, true);
    assert.equal(result.pendingCount, 2);
    assert.equal(enqueues, 0);
    assert.equal(window.reservedCount, 0);
    releasePrepare();
  } finally { window.close(); }
});

test('an already accepted job survives enqueue bookkeeping failure; remaining jobs stop', async () => {
  const window = createStoryboardQueueWindow({ limit: 1, occupied: () => 0 });
  const accepted = [], stopped = [];
  try {
    const handle = startStoryboardQueueWindowBatch(window, { jobs: jobs(2),
      enqueue: async job => { job.queueAccepted = true; throw new Error('save failed after queue acceptance'); },
      onAccepted: job => { accepted.push(job.id); throw new Error('accepted reporter failed'); },
      onStop: result => stopped.push(result) });
    const result = await bounded(handle.done);
    assert.deepEqual(accepted, ['S1']);
    assert.equal(result.acceptedCount, 1);
    assert.deepEqual(result.remainingJobs.map(job => job.id), ['S2']);
    assert.match(result.reason.message, /save failed/);
    assert.deepEqual(result.reportingErrors.map(error => error.message), ['accepted reporter failed']);
    assert.equal(stopped.length, 1);
    assert.equal(window.reservedCount, 0);
  } finally { window.close(); }
});

test('a refused shot is reported once and does not block later shots', async () => {
  const window = createStoryboardQueueWindow({ limit: 1, occupied: () => 0 });
  const refused = [];
  try {
    const handle = startStoryboardQueueWindowBatch(window, { jobs: jobs(2),
      enqueue: async job => job.id !== 'S1', onRefused: job => refused.push(job.id) });
    const result = await bounded(handle.done);
    assert.deepEqual(refused, ['S1']);
    assert.equal(result.acceptedCount, 1);
    assert.equal(result.failedCount, 1);
    assert.equal(result.pendingCount, 0);
    assert.equal(result.stopped, false);
  } finally { window.close(); }
});

test('reporting callback errors remain visible in the resolved completion', async () => {
  const window = createStoryboardQueueWindow({ limit: 1, occupied: () => 1 });
  try {
    const handle = startStoryboardQueueWindowBatch(window, { jobs: jobs(1), enqueue: async () => true,
      onStop: () => { throw new Error('stop reporter failed'); },
      onFinish: () => { throw new Error('finish reporter failed'); } });
    handle.stop('stopped');
    const result = await bounded(handle.done);
    assert.deepEqual(result.reportingErrors.map(error => error.message), ['stop reporter failed', 'finish reporter failed']);
    assert.equal(result.pendingCount, 1);
  } finally { window.close(); }
});
