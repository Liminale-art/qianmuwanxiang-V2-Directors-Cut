import assert from 'node:assert/strict';
import test from 'node:test';
import { runStorageInventoryJobs } from '../qianmu-storage-backup-view.js';

test('inventory scan limits concurrent jobs and reports completed steps in order', async () => {
  let active = 0;
  let peak = 0;
  const progress = [];
  const jobs = Array.from({ length: 9 }, (_, index) => async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 4));
    active--;
    return index;
  });
  const values = await runStorageInventoryJobs(jobs, (done, total) => progress.push([done, total]), () => true);
  assert.deepEqual(values, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(peak, 4);
  assert.deepEqual(progress, Array.from({ length: 10 }, (_, done) => [done, 10]));
});

test('inventory scan rejects when the account changes and does not start remaining jobs', async () => {
  let current = true;
  let started = 0;
  const jobs = Array.from({ length: 8 }, () => async () => {
    started++;
    current = false;
    return started;
  });
  await assert.rejects(runStorageInventoryJobs(jobs, () => {}, () => current), /页面已变化/);
  assert.equal(started, 1);
});

test('progress presentation errors do not fail a completed inventory', async () => {
  const values = await runStorageInventoryJobs([async () => 'done'], () => { throw new Error('view detached'); }, () => true);
  assert.deepEqual(values, ['done']);
});
