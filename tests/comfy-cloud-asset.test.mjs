import test from 'node:test';
import assert from 'node:assert/strict';
import { bindComfyCloudProtocol, bindComfyCloudTask } from '../qianmu-comfy-cloud-protocol.js';
import { planComfyCloudAssetMetadata as plan, matchComfyCloudAssetMetadata as match } from '../qianmu-comfy-cloud-asset.js';
const binding = bindComfyCloudProtocol('https://cloud.comfy.org', 'comfy-cloud-v2');
const task = bindComfyCloudTask(binding, 'original', { self: '/deployment/saved/api/v2/jobs/original', cancel: '/deployment/saved/api/v2/jobs/original/cancel' });
const assetId = 'aabbccdd-0000-4000-8000-000000000001', now = Date.parse('2026-09-13T00:00:00Z');
const expected = () => ({ assetId, nodeId: 'save', mime: 'image/png', sizeBytes: 100, hash: null });
const metadata = (patch = {}) => ({ id: assetId, job_id: task.taskId, content_type: 'image/png', size_bytes: 100, hash: null,
  url: 'https://files.test/image?sig=private-test-signature', url_expires_at: '2026-09-13T00:10:00Z', ...patch });
const denied = code => error => error.code === `comfy_cloud_asset_${code}` && error.submissionState === 'accepted'
  && error.upstreamId === task.taskId && error.retryable === false && !error.message.includes('private-test-signature');

test('asset metadata plans permit one official GET without guessing mount prefixes, mutations or redirects', () => {
  const p = plan(task, assetId.toUpperCase());
  assert.equal(p.url, `${binding.origin}/api/v2/assets/${assetId}`); assert.equal(p.method, 'GET');
  assert.equal(p.createsJob, false); assert.equal(p.redirect, 'error'); assert.equal(p.taskId, 'original'); assert.ok(Object.isFrozen(p));
  assert.equal(p.headers, undefined); assert.equal(p.body, undefined);
  for (const bad of ['../original', `${assetId}/content`, `${assetId}?x=1`, 123]) assert.throws(() => plan(task, bad), denied('identity'));
  const rh = bindComfyCloudTask(bindComfyCloudProtocol('https://www.runninghub.cn', 'runninghub-workflow-v1'), '123');
  assert.throws(() => plan(rh, assetId), { code: 'comfy_cloud_asset_identity' });
});

test('matching metadata freezes current evidence and permits a lazily filled hash without inventing one', () => {
  const e = expected(), m = metadata({ hash: `blake3:${'a'.repeat(64)}` }), result = match(task, e, m, { now });
  assert.equal(result.asset.hash, m.hash); assert.equal(result.source.expiresAt, now + 600000);
  e.sizeBytes = 900; m.url = 'https://changed.test'; assert.equal(result.asset.sizeBytes, 100); assert.match(result.source.url, /^https:\/\/files.test/);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.asset)); assert.ok(Object.isFrozen(result.source));
  assert.equal(match(task, expected(), metadata({ job_id: null }), { now }).asset.hash, null);
});

test('metadata cannot substitute a foreign asset, another producer, different bytes or contradictory hash', () => {
  for (const patch of [{ id: 'aabbccdd-0000-4000-8000-000000000002' }, { job_id: 'other' }]) assert.throws(() => match(task, expected(), metadata(patch), { now }), denied('identity'));
  for (const patch of [{ size_bytes: 101 }, { size_bytes: '100' }, { content_type: 'image/jpeg' }, { hash: undefined }, { hash: 'untrusted' }]) assert.throws(() => match(task, expected(), metadata(patch), { now }), denied('changed'));
  const e = { ...expected(), hash: `blake3:${'a'.repeat(64)}` };
  for (const hash of [null, `blake3:${'b'.repeat(64)}`]) assert.throws(() => match(task, e, metadata({ hash }), { now }), denied('changed'));
});

test('expired, ambiguous-time and unsafe URL metadata never produces a transient download source', () => {
  for (const url_expires_at of [undefined, '', 'tomorrow', '2026-09-13T00:00:00', '2026-09-13T00:00:00Z']) assert.throws(() => match(task, expected(), metadata({ url_expires_at }), { now }), denied('expired'));
  for (const url of ['http://files.test/a', 'file:///tmp/a', '/relative', 'https://user:private-test-signature@files.test/a', 'https://files.test:444/a', 'https://files.test/a#part', 'https://files.test/\na']) assert.throws(() => match(task, expected(), metadata({ url }), { now }), denied('url'));
  assert.throws(() => match(task, expected(), metadata(), { now: NaN }), denied('clock'));
});

test('expected output descriptors reject credentials and accessors without executing them', () => {
  for (const patch of [{ url: 'https://other.test' }, { apiKey: 'private-test-signature' }, { mime: 'image/gif' }, { sizeBytes: 0 }, { nodeId: '../save' }]) assert.throws(() => match(task, { ...expected(), ...patch }, metadata(), { now }), denied('expected'));
  const e = expected(); let reads = 0; Object.defineProperty(e, 'assetId', { get() { reads++; return assetId; }, enumerable: true });
  assert.throws(() => match(task, e, metadata(), { now }), denied('expected')); assert.equal(reads, 0);
});
