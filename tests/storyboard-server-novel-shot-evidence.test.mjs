import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectStoryboardNovelShotLedger } from '../qianmu-storyboard-server-novel-shot-evidence.js';
import { createImageService } from '../qianmu-image-service.js';
import { createImageServiceStore } from '../qianmu-image-service-store.js';
import { imageServiceAccount } from '../qianmu-image-service-access.js';
import { sealStoryboardNovelShotInput } from '../qianmu-storyboard-server-shot-input-contract.js';

const actor = (handle = 'alice') => ({ user: { profile: { handle, enabled: true } } });
const attemptId = 'shotjob-abc-1-12345678';
const key = 'a'.repeat(64), digest = 'b'.repeat(64);
const identity = (request = actor(), extra = {}) => ({ expectedAccount: imageServiceAccount(request).namespace,
  channelKey: key, attemptId, requestDigest: digest, ...extra });
const row = (request = actor(), status = 'submitting', extra = {}) => ({
  namespace: imageServiceAccount(request).namespace, attemptId, requestDigest: digest,
  ownerId: 'service-owner', fence: 'original-fence', status, automatic: true,
  createdAt: 1, updatedAt: 2, ...extra,
});
const state = (...entries) => ({ schema: 'qianmu.image-service-channel.v1', channelKey: key, entries });
const inspect = (request, sealedIdentity, value) => inspectStoryboardNovelShotLedger(request, sealedIdentity, {
  store: { inspectChannel: async () => value, transaction: () => assert.fail('read must not write') },
});

test('each historical NAI status is only a ledger observation, never replay or cache permission', async () => {
  const expected = { reserved: 'reserved_record', submitting: 'acceptance_unknown', uncertain: 'acceptance_unknown',
    acknowledged: 'needs_review', succeeded: 'callback_completed', failed: 'needs_review',
    rejected: 'settled_unverified', released: 'settled_unverified' };
  for (const [status, observation] of Object.entries(expected)) {
    const result = await inspect(actor(), identity(), state(row(actor(), status)));
    assert.deepEqual(result, { schema: 'qianmu.storyboard-novel-shot-evidence.v1', scope: 'ledger_only', observation, ledgerStatus: status });
    for (const forbidden of ['canSubmit', 'retryable', 'resultAvailable', 'cached', 'submitted', 'safeToRetry']) {
      assert.equal(Object.hasOwn(result, forbidden), false);
    }
  }
});

test('no owned row is indistinguishable from another account on the same connection', async () => {
  const absent = await inspect(actor(), identity(), undefined);
  assert.deepEqual(absent, await inspect(actor(), identity(), state(row(actor('bob')))));
  assert.equal(absent.observation, 'no_owned_record');
  assert.equal(Object.hasOwn(absent, 'ledgerStatus'), false);
});

test('same owner and attempt with a changed request digest cannot inherit old ledger status', async () => {
  const result = await inspect(actor(), identity(), state(row(actor(), 'succeeded', { requestDigest: 'c'.repeat(64) })));
  assert.deepEqual(result, { schema: 'qianmu.storyboard-novel-shot-evidence.v1', scope: 'ledger_only', observation: 'needs_review' });
});

test('the sealed locator is captured before asynchronous ledger IO and any caller mutation needs review', async () => {
  const request = actor(), sealed = identity(request);
  const result = await inspectStoryboardNovelShotLedger(request, sealed, { store: {
    inspectChannel: async channelKey => {
      assert.equal(channelKey, key);
      sealed.attemptId = 'shotjob-abc-2-12345678';
      sealed.requestDigest = 'c'.repeat(64);
      sealed.channelKey = 'd'.repeat(64);
      return state(row(request, 'succeeded'));
    },
  } });
  assert.equal(result.observation, 'needs_review');
  assert.equal(Object.hasOwn(result, 'ledgerStatus'), false);
});

test('malformed or unavailable channel record is uniformly review-needed without leaking an IO error', async () => {
  const malformed = await inspect(actor(), identity(), state({ ...row(), status: 'made-up' }));
  const unavailable = await inspectStoryboardNovelShotLedger(actor(), identity(), { store: {
    inspectChannel: async () => { throw new Error('private disk path and secret'); },
  } });
  assert.deepEqual(malformed, unavailable);
  assert.equal(unavailable.observation, 'needs_review');
  assert.equal(JSON.stringify(unavailable).includes('private'), false);
});

test('only exact server-held identity and unchanged live ST account may be observed', async () => {
  const request = actor(); let reads = 0;
  const store = { inspectChannel: async () => { reads++; return state(row()); } };
  await assert.rejects(inspectStoryboardNovelShotLedger({}, identity(request), { store }), error => {
    assert.equal(error.code, 'storyboard_novel_shot_evidence_authentication_required');
    assert.equal(Object.hasOwn(error, 'submissionState'), false);
    return true;
  });
  await assert.rejects(inspectStoryboardNovelShotLedger(actor('bob'), identity(request), { store }),
    { code: 'storyboard_novel_shot_evidence_account_changed' });
  await assert.rejects(inspectStoryboardNovelShotLedger(request, { ...identity(request), prompt: 'private' }, { store }),
    { code: 'storyboard_novel_shot_evidence_identity' });
  await assert.rejects(inspectStoryboardNovelShotLedger(request, { ...identity(request), requestDigest: 'bad' }, { store }),
    { code: 'storyboard_novel_shot_evidence_identity' });
  assert.equal(reads, 0);
  const changed = actor();
  await assert.rejects(inspectStoryboardNovelShotLedger(changed, identity(changed), { store: {
    inspectChannel: async () => { changed.user.profile.handle = 'bob'; return state(row()); },
  } }), { code: 'storyboard_novel_shot_evidence_account_changed' });
  try { await inspectStoryboardNovelShotLedger(actor('bob'), identity(request), { store }); }
  catch (error) { assert.equal(Object.hasOwn(error, 'submissionState'), false); }
});

test('the production service reads its existing store without creating a directory or submitting', async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'qianmu-shot-evidence-'));
  t.after(async () => {
    const real = await fs.realpath(root);
    assert.equal(path.dirname(real), parent);
    assert.match(path.basename(real), /^qianmu-shot-evidence-/);
    await fs.rm(real, { recursive: true });
  });
  const store = createImageServiceStore({ dataRoot: root });
  let providerCalls = 0;
  const service = createImageService({ dataRoot: root, store, generate: () => { providerCalls++; assert.fail('no paid submission'); } });
  t.after(() => service.close());
  const request = actor(), expectedAccount = imageServiceAccount(request).namespace;
  const { snapshot } = sealStoryboardNovelShotInput({ expectedAccount, batchId: randomUUID(), attemptId,
    request: { provider: 'novel', modelFamily: 'novel', protocol: 'novelai', apiKey: 'test-key',
      baseUrl: 'https://image.novelai.net', model: 'nai-diffusion-4-5-full',
      capabilityModelId: 'nai-diffusion-4-5-full', allowPrivateNetwork: false,
      prompt: 'quiet kitchen', negativePrompt: '', referenceImages: [], vibes: [],
      parameters: { width: 1024, height: 1024, count: 1, providerOptions: {} } } });
  const sealed = { expectedAccount: snapshot.expectedAccount, channelKey: snapshot.channelKey,
    attemptId: snapshot.attemptId, requestDigest: snapshot.requestDigest };
  assert.equal((await service.inspectStoryboardNovelShotLedger(request, sealed)).observation, 'no_owned_record');
  assert.deepEqual(await fs.readdir(root), []);

  await store.transaction(sealed.channelKey, () => ({ state: {
    schema: 'qianmu.image-service-channel.v1', channelKey: sealed.channelKey,
    entries: [{ ...row(request, 'succeeded'), requestDigest: sealed.requestDigest }],
  } }));
  const folder = path.join(root, '.qianmu-service', 'image-queue-v1');
  const target = path.join(folder, `${sealed.channelKey}.json`);
  const beforeNames = await fs.readdir(folder), beforeBody = await fs.readFile(target), beforeStat = await fs.stat(target);
  const evidence = await service.inspectStoryboardNovelShotLedger(request, sealed);
  assert.equal(evidence.observation, 'callback_completed');
  assert.deepEqual(await fs.readdir(folder), beforeNames);
  assert.deepEqual(await fs.readFile(target), beforeBody);
  assert.equal((await fs.stat(target)).mtimeMs, beforeStat.mtimeMs);
  assert.equal(providerCalls, 0);
});

test('the internal evidence module is included in the release package', async () => {
  const release = JSON.parse(await fs.readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  assert.equal(release.files.includes('qianmu-storyboard-server-novel-shot-evidence.js'), true);
});
