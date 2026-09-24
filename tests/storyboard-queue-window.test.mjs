import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryboardQueueWindow } from '../qianmu-storyboard-queue-window.js';

test('the eight-slot window includes accepted jobs and in-flight permits without raising execution concurrency', async () => {
  let accepted = 0;
  const window = createStoryboardQueueWindow({ occupied: () => accepted });
  try {
    const permits = await Promise.all(Array.from({ length: 8 }, () => window.acquire()));
    assert.equal(window.reservedCount, 8);
    assert.equal(window.waitingCount, 0);
    assert.ok(permits.every(permit => window.has(permit)));
    assert.equal(accepted + window.reservedCount, 8);

    const next = window.acquire();
    assert.equal(window.waitingCount, 1);
    accepted++;
    permits[0].release();
    assert.equal(window.reservedCount, 7);
    assert.equal(window.waitingCount, 1, 'accepted work still occupies the released permit');
    accepted--;
    window.notify();
    const ninth = await next;
    assert.equal(window.waitingCount, 0);
    assert.equal(accepted + window.reservedCount, 8);
    for (const permit of [...permits.slice(1), ninth]) permit.release();
    assert.equal(window.reservedCount, 0);
  } finally { window.close(); }
});

test('competing batches receive the next vacant slot in FIFO order', async () => {
  let accepted = 1;
  const window = createStoryboardQueueWindow({ limit: 1, occupied: () => accepted });
  const firstBatch = {}, secondBatch = {};
  try {
    const seen = [];
    const first = window.acquire({ batch: firstBatch }).then(permit => { seen.push('first'); return permit; });
    const second = window.acquire({ batch: secondBatch }).then(permit => { seen.push('second'); return permit; });
    assert.equal(window.waitingCount, 2);
    accepted = 0;
    window.notify();
    const firstPermit = await first;
    assert.deepEqual(seen, ['first']);
    assert.equal(window.waitingCount, 1);
    accepted = 1;
    firstPermit.release();
    assert.equal(window.waitingCount, 1);
    accepted = 0;
    window.notify();
    const secondPermit = await second;
    assert.deepEqual(seen, ['first', 'second']);
    secondPermit.release();
  } finally { window.close(); }
});

test('a 21-shot producer drains through the same eight slots in narrative order', async () => {
  let accepted = 0, peak = 0;
  const window = createStoryboardQueueWindow({ occupied: () => accepted });
  try {
    const order = [];
    const jobs = Array.from({ length: 21 }, (_, index) => window.acquire({ batch: 'floor-1' }).then(permit => {
      order.push(index + 1);
      accepted++;
      // The just-accepted job and its still-held permit are the same slot until
      // the producer's finally releases that permit.
      peak = Math.max(peak, accepted + window.reservedCount - 1);
      permit.release();
      peak = Math.max(peak, accepted + window.reservedCount);
      queueMicrotask(() => { accepted--; window.notify(); });
    }));
    await Promise.all(jobs);
    assert.deepEqual(order, Array.from({ length: 21 }, (_, index) => index + 1));
    assert.equal(peak, 8);
    assert.equal(window.reservedCount, 0);
    assert.equal(window.waitingCount, 0);
  } finally { window.close(); }
});

test('abort, batch cancellation, and an invalid current guard promptly remove waiting producers', async () => {
  const window = createStoryboardQueueWindow({ limit: 1, occupied: () => 1, pollMs: 5 });
  try {
    const controller = new AbortController();
    const aborted = window.acquire({ signal: controller.signal });
    controller.abort();
    await assert.rejects(aborted, { code: 'storyboard_queue_window_cancelled' });
    assert.equal(window.waitingCount, 0);

    const batch = {};
    const cancelled = window.acquire({ batch });
    assert.equal(window.cancel(batch), 1);
    await assert.rejects(cancelled, { code: 'storyboard_queue_window_cancelled' });
    assert.equal(window.waitingCount, 0);

    let valid = true;
    const stale = window.acquire({ isCurrent: () => valid });
    valid = false;
    await assert.rejects(stale, { code: 'storyboard_queue_window_stale' });
    assert.equal(window.waitingCount, 0);
  } finally { window.close(); }
});

test('a permit is released once in finally and close clears waiters, permits, and polling', async () => {
  const window = createStoryboardQueueWindow({ limit: 1, occupied: () => 0 });
  const permit = await window.acquire();
  const pending = window.acquire();
  assert.equal(window.waitingCount, 1);
  assert.equal(window.reservedCount, 1);
  try { throw new Error('queue admission failed'); }
  catch (error) { assert.match(error.message, /admission failed/); }
  finally { permit.release(); }
  const second = await pending;
  permit.release();
  assert.equal(window.reservedCount, 1, 'releasing an old permit twice cannot free another job slot');
  const last = window.acquire();
  window.close();
  await assert.rejects(last, { code: 'storyboard_queue_window_cancelled' });
  assert.equal(window.reservedCount, 0);
  assert.equal(window.waitingCount, 0);
  assert.equal(window.has(second), false);
  second.release();
  await assert.rejects(window.acquire(), { code: 'storyboard_queue_window_cancelled' });
});

test('invalid occupancy and excess waiting producers fail closed with a bounded backlog', async () => {
  const bad = createStoryboardQueueWindow({ occupied: () => NaN });
  try { await assert.rejects(bad.acquire(), { code: 'storyboard_queue_window_occupancy' }); }
  finally { bad.close(); }

  const window = createStoryboardQueueWindow({ limit: 1, occupied: () => 1, maxWaiters: 1 });
  try {
    const first = window.acquire();
    await assert.rejects(window.acquire(), { code: 'storyboard_queue_window_full' });
    window.close();
    await assert.rejects(first, { code: 'storyboard_queue_window_cancelled' });
  } finally { window.close(); }
});
