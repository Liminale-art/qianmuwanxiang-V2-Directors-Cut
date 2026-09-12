import test from 'node:test';
import assert from 'node:assert/strict';
import { bindComfyCloudProtocol as bind, planComfyCloudOperation as plan } from '../qianmu-comfy-cloud-protocol.js';
import { readComfyCloudAcceptance as accept, readComfyCloudTaskStatus as status } from '../qianmu-comfy-cloud-response.js';
const cloud = bind('https://dep-one.run.comfy.app', 'comfy-cloud-v2'), rh = bind('https://www.runninghub.cn', 'runninghub-workflow-v1');
const id = 'original-id', rhId = '1904152026220003329';
const urls = { self: `/deployment/dep-one/api/v2/jobs/${id}`, cancel: `/deployment/dep-one/api/v2/jobs/${id}/cancel` };
const cloudBody = { id, status: 'queued', urls }, rhBody = { code: 0, data: { taskId: rhId } };
const cloudTask = accept(cloud, cloudBody), rhTask = accept(rh, rhBody);

test('Cloud follows validated response links including the serverless mount once, not a guessed base path', () => {
  assert.equal(plan(cloud, 'query', cloudTask).url, `${cloud.origin}${urls.self}`);
  assert.equal(plan(cloud, 'cancel', cloudTask).url, `${cloud.origin}${urls.cancel}`);
  assert.deepEqual(status(cloudTask, cloudBody), { task: cloudTask, status: 'queued', terminal: false });
  assert.equal(Object.isFrozen(cloudTask.links), true);
});
test('success-shaped replies without exact IDs leave acceptance unknown and never authorize replay', () => {
  for (const body of [undefined, null, [], '```json {} ```', { prompt_id: id }, { id: 1 }, {}]) {
    assert.throws(() => accept(cloud, body), error => error.submissionState === 'unknown' && error.retryable === false);
  }
  for (const body of [{ code: 0, data: { taskId: Number(rhId) } }, { code: '0', data: { taskId: rhId } }, { code: 500, data: null }]) {
    assert.throws(() => accept(rh, body), error => error.submissionState === 'unknown' && error.retryable === false);
  }
});
test('an accepted id survives malformed or hostile links without forwarding credentials or guessing a replacement', () => {
  for (const self of [`https://evil.test${urls.self}`, `//evil.test${urls.self}`, `${urls.self}?key=secret`,
    '/api/v2/jobs/other', '/admin/../api/v2/jobs/original-id', '/deployment/dep-one/../api/v2/jobs/original-id',
    '/%61pi/v2/jobs/original-id', '/api/v2/jobs/original-id#secret', 'https://key@dep-one.run.comfy.app/api/v2/jobs/original-id']) {
    assert.throws(() => accept(cloud, { ...cloudBody, urls: { ...urls, self } }), error => error.submissionState === 'accepted' && error.upstreamId === id);
  }
  assert.throws(() => accept(cloud, { id }), { submissionState: 'accepted', upstreamId: id });
  assert.throws(() => accept(cloud, { ...cloudBody, urls: { ...urls, cancel: '/api/v2/jobs/original-id/cancel' } }), { submissionState: 'accepted' });
});
test('status reads reject another task, an unknown enum and contradictory RH errors without resetting accepted state', () => {
  for (const body of [null, { ...cloudBody, id: 'other' }, { ...cloudBody, status: 'complete' },
    { ...cloudBody, urls: { self: '/api/v2/jobs/original-id', cancel: '/api/v2/jobs/original-id/cancel' } }]) {
    assert.throws(() => status(cloudTask, body), { submissionState: 'accepted', upstreamId: id, retryable: false });
  }
  for (const body of [{ taskId: 'other', status: 'SUCCESS', errorCode: '' }, { taskId: rhId, status: 'SUCCESS', errorCode: 'error' },
    { taskId: rhId, status: 'SUCCESS' }, { taskId: rhId, status: '__proto__', errorCode: '' }]) {
    assert.throws(() => status(rhTask, body), { submissionState: 'accepted', upstreamId: rhId });
  }
});
test('canceling is nonterminal and platform success is not an output adoption or a billing receipt', () => {
  for (const state of ['queued', 'running', 'succeeded', 'canceling', 'canceled', 'failed', 'expired']) {
    const result = status(cloudTask, { ...cloudBody, status: state, apiKey: 'test-secret', outputs: [{ unsafe: true }] });
    assert.equal(result.status, state); assert.equal(result.terminal, ['succeeded', 'canceled', 'failed', 'expired'].includes(state));
    assert.deepEqual(Object.keys(result), ['task', 'status', 'terminal']); assert.equal(Object.isFrozen(result), true);
  }
  for (const [state, normalized] of Object.entries({ QUEUED: 'queued', RUNNING: 'running', SUCCESS: 'succeeded', FAILED: 'failed' })) {
    assert.equal(status(rhTask, { taskId: rhId, status: state, errorCode: state === 'FAILED' ? 'runtime' : '' }).status, normalized);
  }
});

test('validated status owns a frozen task snapshot rather than retaining the callers mutable locator', () => {
  const mutable = structuredClone(cloudTask), original = structuredClone(mutable), response = structuredClone(cloudBody);
  const result = status(mutable, response);
  mutable.taskId = 'changed'; mutable.links.self = 'https://evil.test'; response.urls.self = 'changed';
  assert.deepEqual(result.task, original); assert.equal(Object.isFrozen(result.task), true);
  assert.equal(Object.isFrozen(result.task.links), true);
});
