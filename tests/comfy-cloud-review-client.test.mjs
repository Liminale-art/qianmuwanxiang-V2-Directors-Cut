import test from 'node:test';
import assert from 'node:assert/strict';
import { createComfyRecoveryClient } from '../qianmu-comfy-recovery-client.js';
import { mountComfyInbox } from '../qianmu-comfy-inbox-view.js';
import { imageServiceAccount } from '../qianmu-image-service-access.js';

const channelKey = 'a'.repeat(64), confirmation = 'b'.repeat(64);
const namespace = 'st-user:alice';
const expectedAccount = imageServiceAccount({ user: { profile: { handle: 'alice', enabled: true } } }).namespace;
const cloudConnection = { version: 1, provider: 'runninghub', protocol: 'runninghub-workflow-v1', origin: 'https://www.runninghub.cn' };
const unknown = { attemptId: 'original', createdAt: 1, status: 'uncertain', taskLocator: { version: 1, channelKey },
  task: null, canReview: true, reviewed: false, cloudConnection, live: false, resultAvailable: false, archiveState: null };
const capability = { ok: true, version: 1, accountBindingVersion: 1, catalogVersion: 1, expectedAccount, manualReview: true,
  submission: true, cancellation: true, referenceUpload: true, resultRetrieval: true, archiveConfirmation: true, automaticReplay: false,
  queryProviders: ['runninghub'], resultProviders: ['runninghub'], submissionProviders: ['runninghub'] };
const packet = (patch = {}) => ({ ok: true, version: 1, channelKey, attemptId: 'original', status: 'uncertain', canReview: true,
  reviewed: false, confirmation, resultAvailable: false, message: '原结果及费用仍未知', ...patch });
const acknowledged = () => packet({ status: 'acknowledged', canReview: false, reviewed: true, confirmation: '' });
const json = data => new Response(JSON.stringify(data));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function inboxHost() {
  const events = {}, ready = deferred(); let html = '';
  const host = { isConnected: true, contains: () => true, get innerHTML() { return html; },
    set innerHTML(value) { html = value; if (value.includes('aria-busy="false"')) ready.resolve(); },
    addEventListener: (name, cb) => { events[name] = cb; }, removeEventListener: name => { delete events[name]; } };
  return { events, host, ready: ready.promise };
}
function fixture(t, options = {}) {
  let currentAccount = namespace, row = structuredClone(unknown), current = true;
  const calls = [], prompts = [];
  const client = createComfyRecoveryClient({ origin: 'https://st.test', account: async () => currentAccount,
    store: { close() {}, list: async () => [], get: async () => assert.fail('review does not read a fabricated delivery checkpoint'),
      put: async () => assert.fail('review must not write local delivery records') },
    confirm: async message => { prompts.push(message); return options.confirm ? options.confirm(message) : true; },
    fetchImpl: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : {};
      calls.push({ url, body, method: init.method });
      assert.match(url, /^\/api\/plugins\/qianmu-tts\/image\/comfy\//);
      assert.doesNotMatch(JSON.stringify(body), /apiKey|prompt|workflow|cloudConnection/);
      if (url.endsWith('/capabilities')) return json({ ...capability, ...options.capability });
      if (url.endsWith('/catalog')) return json({ ok: true, catalogVersion: 1, storageReadable: true, originals: [],
        tasks: url.includes('/cloud/') ? [row] : [], totals: { count: 0, imageBytes: 0, metadataBytes: 0, temporaryBytes: 0, reservedBytes: 0, tasks: 1 } });
      if (url.endsWith('/confirmReview')) {
        assert.deepEqual(body, { version: 1, expectedAccount, channelKey, attemptId: 'original', confirmation, confirmed: true, possibleCharge: true });
        if (options.confirmResponse) return options.confirmResponse(body);
        row = { ...row, status: 'acknowledged', canReview: false, reviewed: true }; return json(acknowledged());
      }
      if (url.endsWith('/review')) {
        assert.deepEqual(body, { version: 1, expectedAccount, channelKey, attemptId: 'original' });
        return options.review ? options.review(body) : json(row.reviewed ? acknowledged() : packet());
      }
      assert.fail(`unexpected operation: ${url}`);
    } });
  t.after(() => client.close());
  return { client, calls, prompts, select: async () => (await client.catalogAll()).originals[0],
    valid: () => current, leave: () => { current = false; }, switchAccount: () => { currentAccount = 'st-user:bob'; },
    setRow: value => { row = { ...row, ...value }; } };
}

test('real catalog keeps receipt-less unknown and acknowledged rows without fabricating tasks or images', async t => {
  const f = fixture(t), selected = await f.select();
  assert.equal(selected.attemptId, 'original'); assert.equal(selected.canReview, true);
  assert.equal(selected.task, null); assert.equal(selected.cloudRecord, null); assert.equal(selected.resultAvailable, false);
  assert.deepEqual(selected.cloudConnection, cloudConnection); assert.equal(selected.canDiscard, false);
  f.setRow({ status: 'acknowledged', canReview: false, reviewed: true });
  const reviewed = await f.select(); assert.equal(reviewed.reviewed, true); assert.equal(reviewed.canReview, false);
  assert.ok(f.calls.every(call => /\/(catalog|capabilities)$/.test(call.url)));
});

test('manual review is capability-gated on old hosts without hiding their unknown records', async t => {
  for (const manualReview of [undefined, false, 'true']) {
    const f = fixture(t, { capability: { manualReview } });
    if (manualReview === 'true') {
      await assert.rejects(f.client.cloudCapabilities(), { code: 'comfy_delivery_capabilities' }); continue;
    }
    const selected = await f.select(); assert.equal(selected.canReview, false);
    await assert.rejects(f.client.reviewCloudOriginal(selected), /尚未支持原请求核查/);
    assert.equal(f.prompts.length, 0); assert.ok(!f.calls.some(call => call.url.endsWith('/review')));
  }
});

test('keyless explicit review freezes original identity, confirms exact proof once and preserves the original log', async t => {
  let selected;
  const f = fixture(t, { confirm: message => {
    assert.match(message, /原结果及费用仍未知/); assert.match(message, /不会取消平台任务、退款或生成新图/); assert.match(message, /重复计费/);
    selected.attemptId = 'modified-after-open'; selected.taskLocator.channelKey = 'c'.repeat(64); return true;
  } });
  selected = await f.select(); const log = { status: 'unknown', attemptId: 'original' }, savedLog = JSON.stringify(log);
  const result = await f.client.reviewCloudOriginal(selected, { valid: f.valid });
  assert.equal(result.reviewed, true); assert.match(result.warning, /费用仍未知.*未重新生成/);
  assert.equal(f.prompts.length, 1); assert.equal(JSON.stringify(log), savedLog);
  assert.equal(f.calls.filter(call => call.url.endsWith('/review')).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/confirmReview')).length, 1);
  assert.ok(f.calls.every(call => /\/(catalog|capabilities|review|confirmReview)$/.test(call.url)));
});

test('canceling the existing confirmation performs only read-only review, no confirm or local write', async t => {
  const f = fixture(t, { confirm: async () => false }), selected = await f.select();
  assert.equal((await f.client.reviewCloudOriginal(selected)).cancelled, true);
  assert.equal(f.calls.filter(call => call.url.endsWith('/review')).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/confirmReview')).length, 0);
});

test('stale page, account or closed client at read/consent/receipt rejects late results', async t => {
  for (const stage of ['read', 'consent', 'receipt']) for (const kind of ['page', 'account', 'closed']) {
    let f; const change = () => kind === 'page' ? f.leave() : kind === 'account' ? f.switchAccount() : f.client.close();
    f = fixture(t, { review: () => { if (stage === 'read') change(); return json(packet()); },
      confirm: () => { if (stage === 'consent') change(); return true; },
      confirmResponse: () => { if (stage === 'receipt') change(); return json(acknowledged()); } });
    const selected = await f.select(); await assert.rejects(f.client.reviewCloudOriginal(selected, { valid: f.valid }), /账户已变化|页面已变化|会话已结束/);
    assert.equal(f.calls.filter(call => call.url.endsWith('/confirmReview')).length, stage === 'receipt' ? 1 : 0);
  }
});

test('wrong identity or contradictory read state cannot open confirmation', async t => {
  for (const patch of [{ channelKey: 'c'.repeat(64) }, { attemptId: 'other' }, { version: 2 }, { status: 'acknowledged' },
    { reviewed: true }, { resultAvailable: true }, { confirmation: '' }, { canReview: 'true' }]) {
    const f = fixture(t, { review: () => json(packet(patch)) });
    await assert.rejects(f.client.reviewCloudOriginal(await f.select()), { code: 'comfy_delivery_identity' });
    assert.equal(f.prompts.length, 0); assert.equal(f.calls.filter(call => call.url.endsWith('/confirmReview')).length, 0);
  }
});

test('lost, stale or invalid confirmation response remains unconfirmed with no automatic confirm retry or generation', async t => {
  for (const respond of [() => { throw Error('lost connection'); }, () => new Response(JSON.stringify({ ok: false, message: '原请求已变化' }), { status: 409 }),
    () => json({ ...acknowledged(), attemptId: 'wrong' }), () => json(packet())]) {
    const f = fixture(t, { confirmResponse: respond });
    await assert.rejects(f.client.reviewCloudOriginal(await f.select()), { code: 'comfy_delivery_review_confirmation' });
    assert.equal(f.calls.filter(call => call.url.endsWith('/confirmReview')).length, 1);
    assert.equal(f.calls.filter(call => call.url.endsWith('/review')).length, 1);
    assert.ok(f.calls.every(call => /\/(catalog|capabilities|review|confirmReview)$/.test(call.url)));
  }
});

test('an already reviewed read or newly available result does not require another confirmation', async t => {
  for (const data of [acknowledged(), packet({ status: 'succeeded', canReview: false, confirmation: '', resultAvailable: true })]) {
    const f = fixture(t, { review: () => json(data) }), result = await f.client.reviewCloudOriginal(await f.select());
    assert.equal(result.reviewed, data.reviewed); assert.equal(f.prompts.length, 0);
    assert.equal(f.calls.filter(call => call.url.endsWith('/confirmReview')).length, 0);
  }
});

test('overlapping review clicks cannot issue duplicate read or confirm requests', async t => {
  const enter = deferred(), hold = deferred(), f = fixture(t, { confirm: async () => { enter.resolve(); await hold.promise; return true; } });
  const selected = await f.select(), first = f.client.reviewCloudOriginal(selected); await enter.promise;
  await assert.rejects(f.client.reviewCloudOriginal(selected), { code: 'comfy_delivery_busy' }); hold.resolve(); await first;
  assert.equal(f.calls.filter(call => call.url.endsWith('/review')).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/confirmReview')).length, 1);
});

test('inbox shows the real unknown row, refreshes reviewed state, and never falls through to receiving or generation', async t => {
  const f = fixture(t), { events, host, ready } = inboxHost();
  const actions = [];
  const dispose = mountComfyInbox(host, { service: f.client, isCurrent: f.valid, receive: (row, mode, action) => {
    actions.push(action); assert.equal(action, 'review'); assert.equal(mode, 'server'); return f.client.reviewCloudOriginal(row, { valid: f.valid });
  } }); t.after(dispose); await ready;
  assert.match(host.innerHTML, /RunningHub · 待核查/); assert.match(host.innerHTML, /核查原请求/);
  assert.match(host.innerHTML, /请勿重复生成，以免重复付费/); assert.doesNotMatch(host.innerHTML, /data-receive|暂无待领取/);
  const button = { dataset: { review: '0' }, disabled: false }; await events.click({ target: { closest: () => button } });
  assert.deepEqual(actions, ['review']); assert.match(host.innerHTML, /已核查 · 费用未知/);
  assert.doesNotMatch(host.innerHTML, /data-review|暂无待领取/); assert.match(host.innerHTML, /再次生成可能重复计费/);
  assert.equal(f.calls.filter(call => call.url.endsWith('/confirmReview')).length, 1);
});

test('inbox refresh after a lost confirmation reveals the durable reviewed row without resending', async t => {
  let f; f = fixture(t, { confirmResponse: () => { f.setRow({ status: 'acknowledged', reviewed: true, canReview: false }); throw Error('lost'); } });
  const { events, host, ready } = inboxHost();
  t.after(mountComfyInbox(host, { service: f.client, receive: row => f.client.reviewCloudOriginal(row) })); await ready;
  const button = { dataset: { review: '0' }, disabled: false }; await events.click({ target: { closest: () => button } });
  assert.match(host.innerHTML, /已核查 · 费用未知/); assert.match(host.innerHTML, /核查结果尚未确认，请刷新原记录核对/);
  assert.equal(f.calls.filter(call => call.url.endsWith('/confirmReview')).length, 1);
});
