import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

function section(name) {
  const found = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(found, `missing ${name}`);
  const tail = source.slice(found.index);
  const next = tail.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}

test('cancelling a plan releases queued reservations but leaves an active submission for its runner', async () => {
  const waiting = { id: 'waiting', planId: 'plan', logId: 'waiting-log', imageAdmission: { namespace: 'st-user:alice' } };
  const active = { id: 'active', planId: 'plan', logId: 'active-log', imageAdmission: { namespace: 'st-user:alice' }, submissionState: 'unknown' };
  const other = { id: 'other', planId: 'other-plan', logId: 'other-log', imageAdmission: { namespace: 'st-user:alice' } };
  const claims = new Map([['waiting', 'reserved'], ['active', 'begun'], ['other', 'reserved']]);
  const settlements = [];
  let finishSettlement;
  const wakeups = [];
  const state = { logs: [{ id: 'waiting-log' }, { id: 'active-log' }, { id: 'other-log' }] };
  const plan = { id: 'plan', floor: 2, status: 'queued', shots: [{ status: 'queued' }, { status: 'generating' }] };
  const taskChanges = [], logChanges = [];
  const stoppedBatches = [], untouchedBatches = [];
  const context = vm.createContext({
    storyboardState: () => state,
    storyboardQueue: [waiting, other],
    storyboardActiveJobs: new Map([[active.id, active]]),
    storyboardQueueSettling: 0,
    storyboardQueueBatches: new Set([
      { planId: 'plan', handle: { stop: reason => stoppedBatches.push(reason) } },
      { planId: 'other-plan', handle: { stop: reason => untouchedBatches.push(reason) } },
    ]),
    storyboardQueueWindow: { notify: () => wakeups.push(context.storyboardQueueSettling) },
    storyboardAdmission: {
      async settle(job, outcome) {
        settlements.push([job.id, outcome]);
        await new Promise(resolve => { finishSettlement = resolve; });
        claims.set(job.id, outcome);
      },
    },
    storyboardComfySceneCoordinator: null,
    storyboardFinishLog: (log, status) => logChanges.push([log?.id, status]),
    storyboardSyncTaskState: (job, status) => taskChanges.push([job.id, status]),
    saveSettings: () => {},
    storyboardSchedulePlanArchive: () => {},
    storyboardScheduleInlineRender: () => {},
    renderModal: () => {},
    toast: () => {},
    console: { warn: () => {} },
  });
  const stopBatches=section('storyboardStopQueueBatches').split(/\r?\n\}/)[0]+'\n}';
  vm.runInContext([stopBatches, section('storyboardSettleImageAdmission'), section('storyboardReleaseWaitingJob'), section('storyboardCancelPlan')].join('\n'), context);

  await context.storyboardCancelPlan(plan);
  assert.deepEqual(stoppedBatches,['用户取消补图']);
  assert.deepEqual(untouchedBatches,[]);
  assert.deepEqual(wakeups, [1], 'removing the queue entry announces a change while its claim remains occupied');
  assert.equal(context.storyboardQueueSettling, 1);
  assert.equal(claims.get('waiting'), 'reserved');
  finishSettlement();
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual([...context.storyboardQueue].map(job => job.id), ['other']);
  assert.deepEqual(settlements, [['waiting', 'not_submitted']]);
  assert.equal(claims.get('waiting'), 'not_submitted');
  assert.equal(claims.get('active'), 'begun');
  assert.equal(claims.get('other'), 'reserved');
  assert.equal(active.discardRequested, true);
  assert.equal(context.storyboardQueueSettling, 0);
  assert.deepEqual(wakeups, [1, 0], 'settlement frees the occupied slot before announcing it');
  assert.deepEqual(logChanges, [['waiting-log', 'cancelled']]);
  assert.deepEqual(taskChanges, [['waiting', 'cancelled'], ['active', 'cancelled']]);
  assert.equal(plan.status, 'cancelled');
});
