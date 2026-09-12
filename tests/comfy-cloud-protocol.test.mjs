import test from 'node:test';
import assert from 'node:assert/strict';
import { bindComfyCloudProtocol as bind, bindComfyCloudTask as task, planComfyCloudOperation as plan } from '../qianmu-comfy-cloud-protocol.js';
const cloud = bind('https://cloud.comfy.org', 'comfy-cloud-v2');
const rh = bind('https://www.runninghub.cn', 'runninghub-workflow-v1');
const id = '7f3d2c1b-9a8e-4d6f-b012-3c4d5e6f7a8b', rhId = '1904152026220003329';

test('official roots normalize without inferring an execution protocol from a URL', () => {
  for (const root of ['', '/', '/api/v2', '/api/v2/']) assert.deepEqual(bind(`https://cloud.comfy.org${root}`, cloud.protocol), cloud);
  for (const root of ['', '/', '/task/openapi/', '/openapi/v2']) assert.deepEqual(bind(`https://www.runninghub.cn${root}`, rh.protocol), rh);
  assert.equal(bind('https://dep-example.run.comfy.app', cloud.protocol).origin, 'https://dep-example.run.comfy.app');
  assert.equal(bind('https://www.runninghub.ai', rh.protocol).origin, 'https://www.runninghub.ai');
  for (const protocol of [undefined, null, '', 'comfy-workflow', 'comfy-cloud-v1', 'future', '__proto__']) {
    assert.throws(() => bind(cloud.origin, protocol), { code: 'comfy_cloud_protocol' });
  }
});

test('lookalikes, secrets, ambiguous paths and native endpoints cannot receive cloud credentials', () => {
  for (const raw of [null, {}, 'https:////cloud.comfy.org', 'http://cloud.comfy.org', ' https://cloud.comfy.org',
    'https://cloud.comfy.org\n', 'https://key@cloud.comfy.org', 'https://cloud.comfy.org?key=secret',
    'https://cloud.comfy.org#secret', 'https://cloud.comfy.org:8188', 'https://cloud.comfy.org.evil.test',
    'https://cloud.comfy.org.', 'https://cloud.comfy.org/a/../api/v2', 'https://cloud.comfy.org/%2e%2e/api/v2',
    'https://cloud.comfy.org//api/v2', 'https://cloud.comfy.org/api/v2/jobs', 'https://cloud.comfy.org\\api\\v2',
    'https://evil.test/cloud.comfy.org', 'http://127.0.0.1:8188', 'https://comfy.icu', 'https://runcomfy.com',
    'https://x.y.run.comfy.app', 'https://x.stg.run.comfy.app', 'https://-x.run.comfy.app', `https://${'a'.repeat(64)}.run.comfy.app`]) {
    assert.throws(() => bind(raw, cloud.protocol), error => /^comfy_cloud_/.test(error.code));
  }
  assert.throws(() => bind(rh.origin, cloud.protocol), { code: 'comfy_cloud_platform' });
  assert.throws(() => bind(cloud.origin, rh.protocol), { code: 'comfy_cloud_platform' });
  assert.throws(() => bind('https://runninghub.cn.evil.test', rh.protocol), { code: 'comfy_cloud_platform' });
});

test('RH POST query is read-only, cancellation is not creation, and task ids keep exact precision', () => {
  const original = task(rh, rhId), query = plan(rh, 'query', original), cancel = plan(rh, 'cancel', original);
  assert.equal(query.method, 'POST'); assert.equal(query.effect, 'read'); assert.equal(query.createsJob, false);
  assert.equal(query.url, 'https://www.runninghub.cn/openapi/v2/query'); assert.deepEqual(query.body, { taskId: rhId });
  assert.equal(cancel.method, 'POST'); assert.equal(cancel.effect, 'cancel'); assert.equal(cancel.createsJob, false);
  assert.equal(cancel.url, 'https://www.runninghub.cn/task/openapi/cancel'); assert.deepEqual(cancel.body, query.body);
  const submit = plan(rh, 'submit'); assert.equal(submit.createsJob, true); assert.equal(submit.effect, 'submit');
  assert.equal(submit.url, 'https://www.runninghub.cn/task/openapi/create'); assert.equal(Object.hasOwn(submit, 'body'), false);
  assert.throws(() => task(rh, Number(rhId)), { code: 'comfy_cloud_task' });
});

test('Cloud v2 plans keep the API version and never fall back to native prompt/history routes', () => {
  const original = task(cloud, id), query = plan(cloud, 'query', original), cancel = plan(cloud, 'cancel', original);
  assert.equal(query.url, `${cloud.origin}/api/v2/jobs/${id}`); assert.equal(query.method, 'GET');
  assert.equal(query.effect, 'read'); assert.equal(query.createsJob, false); assert.equal(Object.hasOwn(query, 'body'), false);
  assert.equal(cancel.url, `${query.url}/cancel`); assert.equal(cancel.method, 'POST'); assert.equal(cancel.createsJob, false);
  assert.equal(plan(cloud, 'submit').url, `${cloud.origin}/api/v2/jobs`);
  for (const row of [query, cancel, plan(cloud, 'submit')]) assert.equal(row.redirect, 'error');
});

test('a task cannot move to another platform, RH region or serverless deployment during recovery', () => {
  for (const other of [cloud, bind('https://www.runninghub.ai', rh.protocol)]) {
    for (const operation of ['query', 'cancel']) assert.throws(() => plan(other, operation, task(rh, rhId)), { code: 'comfy_cloud_task_binding' });
  }
  assert.throws(() => plan(bind('https://dep-example.run.comfy.app', cloud.protocol), 'query', task(cloud, id)), { code: 'comfy_cloud_task_binding' });
  assert.throws(() => plan(rh, 'submit', task(rh, rhId)), { code: 'comfy_cloud_task_replay' });
});

test('invalid identities and undeclared operations fail without claiming a remote task was rejected', () => {
  for (const bad of [undefined, null, {}, [], { ...cloud, version: 2 }, { ...cloud, provider: 'runninghub' },
    { ...cloud, origin: `${cloud.origin}/api/v2` }, { ...cloud, protocol: 'future' }]) {
    assert.throws(() => plan(bad, 'submit'), error => /^comfy_cloud_/.test(error.code) && !Object.hasOwn(error, 'submissionState'));
  }
  for (const operation of [undefined, '', 'upload', 'download', 'generate', '__proto__', 'toString']) {
    assert.throws(() => plan(cloud, operation), { code: 'comfy_cloud_operation' });
  }
  for (const bad of ['', '../job', 'a/b', 'a?x=1', 'a#x', 'a%2fb', 'a\n', 'x'.repeat(241), 1]) {
    assert.throws(() => task(cloud, bad), { code: 'comfy_cloud_task' });
  }
  assert.throws(() => plan(cloud, 'query'), { code: 'comfy_cloud_binding' });
  assert.throws(() => task(rh, id), { code: 'comfy_cloud_task' });
});

test('frozen request plans do not mutate source records or copy credentials into task metadata', () => {
  const source = { ...rh, apiKey: 'test-only-secret' }, before = JSON.stringify(source);
  const original = task(source, rhId), query = plan(source, 'query', original);
  assert.equal(JSON.stringify(source), before); assert.equal(JSON.stringify(query).includes('test-only-secret'), false);
  for (const value of [cloud, rh, original, query, query.body]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { query.body.taskId = '2'; }, TypeError);
  assert.throws(() => { original.origin = cloud.origin; }, TypeError);
});
