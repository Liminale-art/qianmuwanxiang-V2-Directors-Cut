import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  STORYBOARD_SCHEMA_VERSION,
  createStoryboardDefaults,
  createStoryboardTaskState,
  normalizeStoryboardState,
  transitionStoryboardTaskState,
} from '../qianmu-storyboard.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

assert.equal(STORYBOARD_SCHEMA_VERSION, 21);
assert.deepEqual(createStoryboardDefaults().taskStates, []);

const queued = createStoryboardTaskState({
  id: 'job-a', planId: 'plan-a', shotId: 'shot-a', logId: 'log-a', chatKey: 'chat-a', floor: 8,
  uiVisible: true, paragraphSelection: { indexes: [1, 2], insertAfterIndex: 2 }, now: 100,
});
assert.equal(queued.status, 'queued');
assert.equal(queued.stage, 'queue');
assert.equal(queued.progress, 0.2);
assert.equal(queued.floor, 8);
assert.equal(queued.uiVisible, true);
assert.equal(createStoryboardTaskState({ id: 'gallery-job', now: 100 }).floor, null, 'gallery tasks must not attach to floor zero');

const persisting = transitionStoryboardTaskState(queued, 'generating', { stage: 'persistence', progress: 0.8, now: 200 });
assert.equal(persisting.id, queued.id, 'a task keeps the same identity across stages');
assert.equal(persisting.status, 'generating');
assert.equal(persisting.stage, 'persistence');
assert.equal(persisting.progress, 0.8);
assert.equal(persisting.startedAt, 200);

const completed = transitionStoryboardTaskState(persisting, 'completed', { resultIds: ['image-a'], now: 300 });
assert.equal(completed.status, 'completed');
assert.equal(completed.progress, 1);
assert.equal(completed.finishedAt, 300);
assert.deepEqual(completed.resultIds, ['image-a']);

const normalized = normalizeStoryboardState({
  schemaVersion: 20,
  taskStates: [completed, { ...completed, id: 'job-b', status: 'failed', error: 'provider error', updatedAt: 400 }],
});
assert.equal(normalized.schemaVersion, 21);
assert.deepEqual(normalized.taskStates.map((task) => task.id), ['job-b', 'job-a']);
assert.equal(normalized.taskStates[0].error, 'provider error');

// Queue and provider lifecycle use the persistent task id, while automatic work stays visually silent.
assert.match(source, /function storyboardSyncTaskState[\s\S]*id: job\.id[\s\S]*state\.taskStates = \[next/);
assert.match(source, /storyboardQueue\.push\(job\);[\s\S]*storyboardSetPlanStatus\(storyboardPlanForJob\(job\), 'queued'/);
assert.match(source, /stage: 'provider'[\s\S]*stage: 'persistence'[\s\S]*stage: 'attachment'[\s\S]*stage: 'complete'/);
assert.match(source, /uiVisible: current\?\.uiVisible \?\? plan\?\.origin === 'manual_supplement'/);
assert.match(source, /data-storyboard-task=/);
assert.match(source, /id: uid\('shot'\), taskId: job\.id, groupId: job\.id/);

// A completed task only rebuilds its target floor; simultaneous floors are coalesced without a full chat redraw.
assert.match(source, /function storyboardRenderInlineImages\(targetFloor = null\)/);
assert.match(source, /sd-storyboard-inline\[data-storyboard-floor=/);
assert.match(source, /const storyboardInlinePendingFloors = new Set\(\)/);
assert.match(source, /floors\.forEach\(\(target\) => storyboardRenderInlineImages\(target\)\)/);
assert.match(source, /storyboardSetPlanStatus\(plan, 'completed',[\s\S]*floor: anchorState\.floor/);

const queueBlock = source.slice(source.indexOf('function storyboardQueueJob'), source.indexOf('function storyboardSafePromptFallback'));
assert.doesNotMatch(queueBlock, /is_send_press|generation_started|streamingProcessor/, 'storyboard jobs must not depend on the ST reply generation lock');

console.log('Storyboard persistent task lifecycle contract OK');
