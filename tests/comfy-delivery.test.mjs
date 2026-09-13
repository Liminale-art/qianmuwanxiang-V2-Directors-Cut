import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createComfyRecoveryClient } from '../qianmu-comfy-recovery-client.js';
import { receiveComfyImage, resolveComfyRecoveryKey } from '../qianmu-comfy-recovery-action.js';
import { normalizeComfyDelivery, assertComfyDeliveryUpdate, createComfyDeliveryStore } from '../qianmu-comfy-delivery-store.js';
import { bindComfyCloudProtocol, bindComfyCloudTask } from '../qianmu-comfy-cloud-protocol.js';
import { comfyArchiveFilename } from '../qianmu-comfy-submission.js';
import { sanitizeStoryboardSnapshot, getStoryboardComfyTransport } from '../qianmu-storyboard.js';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';

const origin = 'https://st.test', receipt = 'a'.repeat(64);
const job = (extra = {}) => ({ id: 'attempt-a', source: 'comfy', logId: 'log-a', chatKey: 'chat-a', automatic: true, profile: { model: 'workflow' },
  connection: { baseUrl: 'https://comfy.test/api', credentialId: 'original-key', allowPrivateNetwork: false, options: { comfyTransport: 'gateway' } },
  imageAdmission: { version: 1, namespace: 'st-user:alice', attemptId: 'attempt-a' }, ...extra });
const result = (count = 2) => ({ ok: true, status: 'ready', images: Array.from({ length: count }, () => ({ data: 'aW1hZ2U=', mime: 'image/png' })), comfyTask: { version: 1, attemptId: 'attempt-a', resultStored: true, receipt } });
const json = body => new Response(JSON.stringify(body));
const deferred = () => { let resolve; const promise = new Promise(yes => resolve = yes); return { promise, resolve }; };
function setup(options = {}) {
  const rows = new Map(), calls = []; let namespace = 'st-user:alice', held = false;
  const store = { get: async (ns, id) => structuredClone(rows.get(`${ns}/${id}`) || null), put: async row => { rows.set(`${row.namespace}/${row.attemptId}`, structuredClone(row)); }, close() {} };
  const locks = { request: async (_key, _opts, work) => { if (held) return work(null); held = true; try { return await work({}); } finally { held = false; } } };
  const configuration = { origin, store, locks, account: async () => namespace, headers: () => ({ 'Content-Type': 'application/json' }),
    fetchImpl: async (url, init) => { const action = url.split('/').at(-1), body = JSON.parse(init.body); calls.push({ action, body, init, url });
      assert.ok(['query','result','acknowledge'].includes(action));
      return options.respond ? options.respond(action, body) : json(action === 'query' ? { ok: true, task: { resultStored: true, live: false } } : action === 'result' ? result() : { ok: true }); }, ...options.configuration };
  return { rows, calls, configuration, client: createComfyRecoveryClient(configuration), switchAccount: value => { namespace = value; } };
}
const callback = async (data, files, checkpoint, guard) => { await guard(); await checkpoint(data.images.map((_, index) => ({ url: files[index]?.url || `/user/images/${index}.png`, prompt: 'must not persist' }))); return true; };

test('recovery activity covers delivery and acknowledgement after the image request has finished', async () => {
  const entered = deferred(), release = deferred(), ackEntered = deferred(), ackRelease = deferred();
  const s = setup({ respond: async action => {
    if (action === 'acknowledge') { ackEntered.resolve(); await ackRelease.promise; return json({ ok: true }); }
    return json(action === 'query' ? { ok: true, task: { resultStored: true, live: false } } : result());
  } });
  assert.equal(s.client.busy, false);
  const running = s.client.retrieve(job(), { deliver: async (...args) => {
    entered.resolve(); await release.promise; return callback(...args);
  } });
  assert.equal(s.client.busy, true, 'block restoration before the first async boundary');
  await entered.promise;
  assert.equal(s.client.busy, true, 'the image response is not the end of archival');
  release.resolve(); await ackEntered.promise;
  assert.equal(s.client.busy, true, 'server acknowledgement is still part of the original operation');
  ackRelease.resolve(); assert.equal((await running).archived, true);
  assert.equal(s.client.busy, false);
  assert.deepEqual(s.calls.map(call => call.action), ['query', 'result', 'acknowledge']);
});

test('one rejected concurrent operation must not unlock restoration while another delivery is pending', async () => {
  const entered = deferred(), release = deferred(), s = setup();
  const running = s.client.deliver(job(), result(), async (...args) => {
    entered.resolve(); await release.promise; return callback(...args);
  });
  await entered.promise;
  await assert.rejects(s.client.retrieve(job(), { deliver: callback }), { code: 'comfy_delivery_busy' });
  assert.equal(s.client.busy, true);
  release.resolve(); await running; assert.equal(s.client.busy, false);
  await assert.rejects(s.client.discard([]), { code: 'comfy_delivery_selection' });
  assert.equal(s.client.busy, false, 'validation failure must release only its own activity');
});

test('closing recovery does not fake idle while a previously entered delivery is still settling', async () => {
  const entered = deferred(), release = deferred(), s = setup();
  const running = s.client.deliver(job(), result(), async (...args) => {
    entered.resolve(); await release.promise; return callback(...args);
  });
  await entered.promise; s.client.close();
  assert.equal(s.client.busy, true);
  release.resolve(); await assert.rejects(running, { code: 'comfy_delivery_closed' });
  assert.equal(s.client.busy, false);
  assert.equal(s.calls.length, 0, 'closing must not acknowledge an unfinished archive');
});

test('Comfy preparation is lazy, bounded to an identity and strips all recipe and credentials', async () => {
  const s = setup(); assert.equal(s.rows.size, 0); assert.equal(s.calls.length, 0);
  const binding = await s.client.prepare({ ...job(), workflow: 'large-workflow', apiKey: 'test-secret', prompt: 'garden' });
  assert.match(binding.expectedAccount, /^st-user:[a-f0-9]{64}$/); assert.equal(s.calls.length, 0);
  const row = [...s.rows.values()][0]; assert.equal(row.status, 'prepared'); assert.ok(JSON.stringify(row).length < 1024);
  for (const field of ['workflow','prompt','apiKey','profile','imageAdmission']) assert.equal(row[field], undefined);
});
test('normal delivery and repeated manual recovery share file checkpoints and never regenerate', async () => {
  const s = setup(); await s.client.prepare(job());
  assert.equal((await s.client.deliver(job(), result(), callback)).archived, true);
  assert.equal([...s.rows.values()][0].status, 'confirmed');
  assert.equal((await s.client.retrieve(job(), { deliver: () => assert.fail('already archived') })).archived, true);
  assert.deepEqual(s.calls.map(call => call.action), ['acknowledge']);
  const row = [...s.rows.values()][0]; assert.equal(row.files.length, 2); assert.equal(row.files[0].prompt, undefined);
});
test('interruption after one file resumes that checkpoint without uploading it again', async () => {
  const s = setup(); await s.client.prepare(job());
  await assert.rejects(s.client.deliver(job(), result(), async (_data, _files, checkpoint) => { await checkpoint([{ url: '/user/images/0.png' }]); throw Error('second file failed'); }), /second file/);
  assert.equal(s.calls.length, 0);
  const restarted = createComfyRecoveryClient(s.configuration);
  const received = await restarted.retrieve({ ...job(), automatic: false }, { apiKey: 'not-needed-cached-secret', deliver: async (data, files, checkpoint, guard) => {
    assert.deepEqual(files, [{ imageIndex: 0, url: '/user/images/0.png' }]); return callback(data, files, checkpoint, guard);
  } });
  assert.equal(received.archived, true); assert.deepEqual(s.calls.map(call => call.action), ['query','result','acknowledge']);
  assert.ok(!JSON.stringify(s.calls).includes('not-needed-cached-secret'));
});
test('lost acknowledgement retries only acknowledgement, not downloads or archival', async () => {
  let acks = 0;
  const s = setup({ respond: action => { assert.equal(action, 'acknowledge'); if (++acks === 1) throw Error('connection lost'); return json({ ok: true }); } });
  assert.ok((await s.client.deliver(job(), result(), callback)).warning);
  assert.equal([...s.rows.values()][0].status, 'archived');
  assert.equal((await s.client.retrieve(job(), { deliver: () => assert.fail('duplicate') })).archived, true);
  assert.equal([...s.rows.values()][0].status, 'confirmed'); assert.equal(acks, 2);
});
test('two clients cannot archive simultaneously and unsupported locks block before generation', async () => {
  const s = setup(), entered = deferred(), release = deferred();
  const running = s.client.deliver(job(), result(), async (...args) => { entered.resolve(); await release.promise; return callback(...args); });
  await entered.promise;
  const other = createComfyRecoveryClient(s.configuration);
  await assert.rejects(other.retrieve(job(), { deliver: callback }), { code: 'comfy_delivery_busy' });
  release.resolve(); await running;
  await assert.rejects(createComfyRecoveryClient({ ...s.configuration, locks: null }).prepare(job()), { code: 'comfy_delivery_lock', submissionState: 'not_submitted' });
});
test('account changes, connection replacement and hot teardown never authorize cleanup', async () => {
  for (const mode of ['account', 'close']) {
    const s = setup();
    await assert.rejects(s.client.deliver(job(), result(), async (_data, _files, checkpoint, guard) => {
      await checkpoint([{ url: '/user/images/0.png' }]); mode === 'account' ? s.switchAccount('st-user:bob') : s.client.close(); await guard(); return true;
    })); assert.equal(s.calls.length, 0);
  }
  const s = setup(); await s.client.prepare(job());
  await assert.rejects(s.client.retrieve(job({ connection: { ...job().connection, baseUrl: 'https://different.test' } }), { deliver: callback }), { code: 'comfy_delivery_identity' });
  assert.equal(s.calls.length, 0);
});
test('queued/running/missing history are status reports, not generation or cache cleanup', async () => {
  for (const status of ['queued','running','collecting','unavailable']) {
    const s = setup({ respond: action => json(action === 'query' ? { ok: true, task: { live: false, resultStored: false } } : { ok: true, status }) });
    const received = await s.client.retrieve(job(), { apiKey: 'original-test-secret', deliver: () => assert.fail('no image') });
    assert.equal(received.archived, false); assert.ok(received.warning);
    assert.deepEqual(s.calls.map(call => call.action), ['query','result']); assert.equal(s.calls[0].body.apiKey, undefined); assert.equal(s.calls[1].body.apiKey, 'original-test-secret');
  }
});
test('incomplete saves, foreign files and changed result identities retain server originals', async () => {
  const s = setup(); assert.equal((await s.client.deliver(job(), result(), async () => false)).archived, false);
  await assert.rejects(s.client.deliver(job(), result(), async (_data, _files, checkpoint) => { await checkpoint([{ url: 'https://elsewhere.test/x.png' }]); return true; }));
  await assert.rejects(s.client.deliver(job(), { ...result(), comfyTask: { ...result().comfyTask, receipt: 'b'.repeat(64) } }, callback), { code: 'comfy_delivery_identity' });
  await assert.rejects(s.client.deliver(job(), result(), async () => true), /检查点未完成/);
  assert.equal(s.calls.length, 0);
});
test('journal validates bounded metadata and requires actual browser persistence', async () => {
  const s = setup(); await s.client.prepare(job()); const row = [...s.rows.values()][0];
  const projected = normalizeComfyDelivery({ ...row, workflow: {}, apiKey: 'secret' }, origin); assert.equal(projected.apiKey, undefined);
  for (const change of [{ version: 2 }, { baseUrl: 'https://user:secret@test/' }, { imageCount: 9 }, { status: 'confirmed' }, { chatKey: 'a'.repeat(4097) }]) assert.throws(() => normalizeComfyDelivery({ ...row, ...change }, origin));
  const missing = createComfyDeliveryStore({ indexedDB: undefined, origin }); await assert.rejects(missing.put(row), /无法保存/); missing.close(); await assert.rejects(missing.get(row.namespace, row.attemptId), /会话已结束/);
});
test('cloud journal checkpoints use a separate version and preserve original platform identity without storing payloads or keys', async () => {
  const s = setup(); await s.client.prepare(job()); const native = [...s.rows.values()][0];
  const connection = bindComfyCloudProtocol('https://cloud.comfy.org', 'comfy-cloud-v2');
  const prepared = normalizeComfyDelivery({ ...native, version: 3, baseUrl: connection.origin, cloudConnection: connection, apiKey: 'never-store', workflow: {} }, origin);
  assert.equal(normalizeComfyDelivery({ ...prepared, baseUrl: `${connection.origin}/api/v2` }, origin).baseUrl, connection.origin);
  assert.equal(prepared.cloudTask, null); assert.equal(prepared.taskLocator, null); assert.equal(prepared.apiKey, undefined); assert.equal(prepared.workflow, undefined);
  const task = bindComfyCloudTask(connection, 'original', { self: '/api/v2/jobs/original', cancel: '/api/v2/jobs/original/cancel' });
  const accepted = normalizeComfyDelivery({ ...prepared, cloudTask: task, taskLocator: { version: 1, channelKey: 'b'.repeat(64) } }, origin);
  assert.doesNotThrow(() => assertComfyDeliveryUpdate(prepared, accepted));
  const available = normalizeComfyDelivery({ ...accepted, status: 'available', receipt, imageCount: 2 }, origin);
  const partial = normalizeComfyDelivery({ ...available, files: [{ imageIndex: 0, url: '/user/images/first.png' }] }, origin);
  const archived = normalizeComfyDelivery({ ...partial, status: 'archived', files: [...partial.files, { imageIndex: 1, url: '/user/images/second.png' }] }, origin);
  for (const [before, after] of [[accepted, available], [available, partial], [partial, archived]]) assert.doesNotThrow(() => assertComfyDeliveryUpdate(before, after));
  for (const invalid of [{ cloudTask: null, taskLocator: null }, { taskLocator: { version: 1, channelKey: 'c'.repeat(64) } },
    { cloudTask: bindComfyCloudTask(connection, 'other', { self: '/api/v2/jobs/other', cancel: '/api/v2/jobs/other/cancel' }) }]) {
    const next = normalizeComfyDelivery({ ...accepted, ...invalid }, origin);
    assert.throws(() => assertComfyDeliveryUpdate(accepted, next));
  }
  assert.throws(() => assertComfyDeliveryUpdate(native, prepared));
  assert.throws(() => assertComfyDeliveryUpdate(prepared, native));
  assert.throws(() => assertComfyDeliveryUpdate(archived, partial));
  assert.deepEqual(normalizeComfyDelivery(native, origin), native, 'legacy native metadata keeps its original representation');
  s.rows.set(`${accepted.namespace}/${accepted.attemptId}`, accepted);
  await assert.rejects(s.client.retrieveOriginal({ namespace: accepted.namespace, attemptId: accepted.attemptId }, { chatKey: accepted.chatKey, deliver: callback }), { code: 'comfy_delivery_engine' });
  assert.equal(s.calls.length, 0, 'an entry without explicit cloud identity cannot query the native endpoint for a cloud record');
});

test('cloud journal rejects incomplete acceptance, cross-platform tasks, private permission and premature archive evidence', async () => {
  const s = setup(); await s.client.prepare(job()); const native = [...s.rows.values()][0];
  const connection = bindComfyCloudProtocol('https://cloud.comfy.org', 'comfy-cloud-v2');
  const row = { ...native, version: 3, baseUrl: connection.origin, cloudConnection: connection };
  const task = bindComfyCloudTask(connection, 'original', { self: '/api/v2/jobs/original', cancel: '/api/v2/jobs/original/cancel' });
  for (const change of [{ cloudTask: task }, { taskLocator: { version: 1, channelKey: 'b'.repeat(64) } }, { allowPrivateNetwork: true },
    { baseUrl: 'https://untrusted.test' }, { originalOnly: true }, { status: 'available', imageCount: 1, receipt }, { receipt },
    { cloudConnection: { ...connection, apiKey: 'secret' } },
    { cloudTask: bindComfyCloudTask(bindComfyCloudProtocol('https://www.runninghub.cn', 'runninghub-workflow-v1'), '123'), taskLocator: { version: 1, channelKey: 'b'.repeat(64) } }]) {
    assert.throws(() => normalizeComfyDelivery({ ...row, ...change }, origin));
  }
});

function cloudSetup(options = {}) {
  const connection = bindComfyCloudProtocol('https://cloud.comfy.org', 'comfy-cloud-v2');
  const task = bindComfyCloudTask(connection, 'original', { self: '/api/v2/jobs/original', cancel: '/api/v2/jobs/original/cancel' });
  const row = normalizeComfyDelivery({ version: 3, namespace: 'st-user:alice', attemptId: 'cloud-a', baseUrl: connection.origin,
    cloudConnection: connection, cloudTask: task, taskLocator: { version: 1, channelKey: 'b'.repeat(64) },
    chatKey: 'chat-a', createdAt: 1, originalOnly: true, status: 'prepared', imageCount: 0, files: [] }, origin);
  const delivery = { schema: 'qianmu.comfy-cloud-delivery.v1', state: 'stored', cacheReceipt: receipt, bytes: 10, imageCount: 2, storedAt: 1 };
  const packet = { ok: true, version: 1, status: 'ready', task, provider: 'comfy-cloud', upstreamId: task.taskId, model: 'workflow',
    images: result().images, receipt, delivery, locator: { version: 1, channelKey: row.taskLocator.channelKey, attemptId: row.attemptId } };
  const ack = { ok: true, version: 1, status: 'archived', task, delivery: { ...delivery, state: 'archived', archivedAt: 2 }, cleanup: 'complete' };
  const s = setup({ configuration: { confirm: async () => true, ...options.configuration }, respond: (action, body) => {
    assert.ok(['result','acknowledge'].includes(action), 'original cloud recovery never submits, cancels or queries native tasks');
    return options.respond ? options.respond(action, body, { packet, ack }) : json(action === 'result' ? packet : ack);
  } });
  s.rows.set(`${row.namespace}/${row.attemptId}`, row);
  return { ...s, row, packet, ack, read: () => s.rows.get(`${row.namespace}/${row.attemptId}`),
    retrieve: (overrides = {}) => s.client.retrieveCloudOriginal(row, { chatKey: 'chat-a', apiKey: 'synthetic-key', deliver: (_job, ...args) => callback(...args), ...overrides }) };
}

test('cloud original images share archive checkpoints and keyless ACK, with no native or paid route', async () => {
  const s = cloudSetup();
  assert.equal((await s.retrieve()).archived, true); assert.equal(s.read().status, 'confirmed');
  assert.deepEqual(s.calls.map(call => call.action), ['result','acknowledge']);
  for (const call of s.calls) {
    assert.ok(call.url.startsWith('/api/plugins/qianmu-tts/image/comfy/cloud/tasks/'));
    assert.equal(call.body.attemptId, s.row.attemptId); assert.deepEqual(call.body.task, s.row.cloudTask);
    assert.equal(call.body.channelKey, s.row.taskLocator.channelKey); assert.equal(call.init.credentials, 'same-origin');
  }
  assert.equal(s.calls[0].body.apiKey, 'synthetic-key'); assert.equal(s.calls[1].body.apiKey, undefined);
  assert.doesNotMatch(JSON.stringify(s.read()), /synthetic-key|aW1hZ2U|prompt/);
  assert.equal((await s.retrieve({ apiKey: '' })).alreadyArchived, true); assert.equal(s.calls.length, 2);
});

const recipeForCloud = row => ({ id:row.attemptId,source:'comfy',chatKey:row.chatKey,logId:row.logId,automatic:row.automatic,
  imageAdmission:{version:1,namespace:row.namespace,attemptId:row.attemptId},connection:{baseUrl:row.baseUrl,credentialId:row.credentialId},
  payload:{prompt:'original narrative',parameters:{workflow:{fixed:'original graph'}}},prompt:'original narrative',negative:'original negative',
  messageRef:{messageKey:'original-message'},paragraphAnchor:{index:3},inlineOrder:{shot:2},profile:{model:'original-model'},inlineByDefault:true });

test('normal cloud delivery preserves an isolated full shot recipe and original prose anchor, without writing it into the small journal',async()=>{
  const s=cloudSetup(),row={...s.row,originalOnly:false};s.rows.set(`${row.namespace}/${row.attemptId}`,row);
  const recipe=recipeForCloud(row),original=structuredClone(recipe);let delivered;
  const work=s.client.retrieveCloudJob(recipe,row,{apiKey:'synthetic-key',deliver:async(job,...args)=>{delivered=job;return callback(...args);}});
  recipe.payload.prompt='new selected settings';recipe.paragraphAnchor.index=99;
  assert.equal((await work).archived,true);assert.deepEqual(delivered,original);assert.equal(delivered.originalOnly,undefined);
  assert.equal(s.read().status,'confirmed');assert.doesNotMatch(JSON.stringify(s.read()),/original narrative|original graph|original-message|synthetic-key/);
});

test('an absent or mismatched recipe cannot be silently attached to cloud originals or recreate missing preparation',async()=>{
  for(const mode of ['empty','recipe','id','chat','namespace','key','platform','log','original-only','missing']){
    const s=cloudSetup(),row={...s.row,originalOnly:mode==='original-only'};s.rows.set(`${row.namespace}/${row.attemptId}`,row);
    let recipe=recipeForCloud(row);
    if(mode==='recipe')delete recipe.payload;
    if(mode==='empty')recipe=null;if(mode==='id')recipe.id='other';if(mode==='chat')recipe.chatKey='other';
    if(mode==='namespace')recipe.imageAdmission.namespace='st-user:bob';if(mode==='key')recipe.connection.credentialId='other';
    if(mode==='platform')recipe.connection.baseUrl='https://www.runninghub.cn';if(mode==='log')recipe.logId='other';if(mode==='missing')s.rows.clear();
    await assert.rejects(s.client.retrieveCloudJob(recipe,row,{apiKey:'synthetic-key',deliver:()=>assert.fail('no foreign recipe may be delivered')}));
    assert.equal(s.calls.length,0);if(mode==='missing')assert.equal(s.rows.size,0);
  }
});

test('cloud pending status is returned for bounded scheduling without declaring completion or fetching new work',async()=>{
  const s=cloudSetup({respond:(action,_body,{packet})=>{assert.equal(action,'result');return json({...packet,status:'running',images:undefined});}});
  const row={...s.row,originalOnly:false};s.rows.set(`${row.namespace}/${row.attemptId}`,row);
  const result=await s.client.retrieveCloudJob(recipeForCloud(row),row,{apiKey:'synthetic-key',deliver:()=>assert.fail('not a completed image')});
  assert.equal(result.status,'running');assert.equal(result.archived,false);assert.equal(s.read().status,'prepared');assert.equal(s.calls.length,1);
});

test('partial cloud archives survive failed save and cleanup pending does not count as confirmed', async () => {
  let cleanup = 'pending';
  const s = cloudSetup({ respond: (action, _body, { packet, ack }) => json(action === 'result' ? packet : { ...ack, cleanup }) });
  await assert.rejects(s.retrieve({ deliver: async (_job, _data, _files, checkpoint) => {
    await checkpoint([{ url: '/user/images/0.png' }]); throw Error('simulated storage interruption');
  } }), /storage interruption/);
  assert.equal(s.read().files.length, 1); assert.equal(s.read().status, 'available'); assert.equal(s.calls.length, 1);
  const resumed = await s.retrieve({ deliver: async (_job, ...args) => { assert.equal(args[1].length, 1); return callback(...args); } });
  assert.equal(resumed.archived, true); assert.match(resumed.warning, /尚未清理完/); assert.equal(s.read().status, 'archived');
  cleanup = 'complete'; await s.retrieve({ apiKey: '', deliver: () => assert.fail('must not save images again') });
  assert.equal(s.read().status, 'confirmed'); assert.deepEqual(s.calls.map(call => call.action), ['result','result','acknowledge','acknowledge']);
});

test('cloud result and ACK identity mismatches never clear local recovery evidence', async () => {
  for (const change of [data => ({ ...data, task: { ...data.task, taskId: 'other' } }), data => ({ ...data, upstreamId: 'other' }),
    data => ({ ...data, locator: { ...data.locator, channelKey: 'c'.repeat(64) } }), data => ({ ...data, delivery: { ...data.delivery, imageCount: 1 } })]) {
    const s = cloudSetup({ respond: (_action, _body, { packet }) => json(change(packet)) });
    await assert.rejects(s.retrieve({ deliver: () => assert.fail('mismatched images must not archive') }), { code: 'comfy_delivery_identity' });
    assert.equal(s.read().status, 'prepared'); assert.equal(s.calls.length, 1);
  }
  for (const change of [ack => ({ ...ack, cleanup: undefined }), ack => ({ ...ack, delivery: { ...ack.delivery, cacheReceipt: 'c'.repeat(64) } })]) {
    const s = cloudSetup({ respond: (action, _body, { packet, ack }) => json(action === 'result' ? packet : change(ack)) });
    assert.match((await s.retrieve()).warning, /确认尚未完成/); assert.equal(s.read().status, 'archived');
  }
});

test('cloud route checks account, chat, explicit engine and original locator before delivering', async () => {
  const s = cloudSetup();
  await assert.rejects(s.retrieve({ chatKey: 'other-chat' }), { code: 'comfy_delivery_chat' });
  await assert.rejects(s.client.retrieveCloudOriginal({ ...s.row, version: 1 }), { code: 'comfy_delivery_engine' });
  await assert.rejects(s.client.retrieveCloudOriginal({ ...s.row, taskLocator: { version: 1, channelKey: 'c'.repeat(64) } }), { code: 'comfy_delivery_identity' });
  s.switchAccount('st-user:bob'); await assert.rejects(s.retrieve(), { code: 'comfy_delivery_account' }); assert.equal(s.calls.length, 0);
});

test('account change during cloud ACK preserves archived checkpoint and rejects stale completion', async () => {
  const s = cloudSetup({ respond: (action, _body, { packet, ack }) => {
    if (action === 'acknowledge') s.switchAccount('st-user:bob');
    return json(action === 'result' ? packet : ack);
  } });
  await assert.rejects(s.retrieve(), { code: 'comfy_delivery_account' }); assert.equal(s.read().status, 'archived');
  s.switchAccount('st-user:alice');
  const resumed = createComfyRecoveryClient({ ...s.configuration, fetchImpl: async (url, init) => {
    assert.ok(url.endsWith('/cloud/tasks/acknowledge')); assert.equal(JSON.parse(init.body).apiKey, undefined); return json(s.ack);
  } });
  assert.equal((await resumed.retrieveCloudOriginal(s.row, { chatKey: 'chat-a' })).warning, ''); assert.equal(s.read().status, 'confirmed');
});

test('missing cloud journal requires consent and cannot inherit unverified archival files', async () => {
  const s = cloudSetup({ configuration: { confirm: async () => false } }); s.rows.clear();
  assert.equal((await s.retrieve()).cancelled, true); assert.equal(s.calls.length, 0); assert.equal(s.rows.size, 0);
  const approved = createComfyRecoveryClient({ ...s.configuration, confirm: async () => true });
  await approved.retrieveCloudOriginal({ ...s.row, status: 'confirmed', imageCount: 2, receipt,
    files: [{ imageIndex: 0, url: '/user/images/stale1.png' }, { imageIndex: 1, url: '/user/images/stale2.png' }] },
  { chatKey: 'chat-a', apiKey: 'synthetic-key', deliver: async (_job, ...args) => { assert.deepEqual(args[1], []); return callback(...args); } });
  assert.equal(s.read().status, 'confirmed'); assert.equal(s.read().files[0].url, '/user/images/0.png');
});

test('archive filenames are stable per original account and attempt, independent of current character and time', async () => {
  const first = await comfyArchiveFilename(job(), 0);
  assert.equal(await comfyArchiveFilename(job(), 0), first); assert.match(first, /^qianmu_comfy_[a-f0-9]{64}_1$/);
  assert.notEqual(await comfyArchiveFilename(job(), 1), first);
  assert.notEqual(await comfyArchiveFilename(job({ imageAdmission: { ...job().imageAdmission, namespace: 'st-user:bob' } }), 0), first);
});
test('production log gate distinguishes gateway, legacy gateway evidence, browser-only and unrelated providers', () => {
  const context = vm.createContext({ getStoryboardComfyTransport }); vm.runInContext(storyboardFunctionSource('storyboardCanReceiveComfyLog'), context);
  assert.equal(context.storyboardCanReceiveComfyLog({ snapshot: job() }), true);
  assert.equal(context.storyboardCanReceiveComfyLog({ snapshot: job({ connection: { options: { comfyTransport: 'browser' } } }) }), false);
  assert.equal(context.storyboardCanReceiveComfyLog({ snapshot: job({ connection: {}, comfyServiceTask: { version: 1 } }) }), true);
  assert.equal(context.storyboardCanReceiveComfyLog({ snapshot: job({ source: 'novel' }) }), false);
  assert.equal(sanitizeStoryboardSnapshot({ ...job(), comfyServiceTask: { version: 1, attemptId: job().id } }).comfyServiceTask.attemptId, job().id);
});
test('production normal and manual UI are wired to the same client and preserve original credentials', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /sd-storyboard-receive-comfy/); assert.match(source, /storyboardComfyRecovery\?\.close\(\)/);
  const receive = storyboardFunctionSource('storyboardReceiveComfyImage');
  const action = await readFile(new URL('../qianmu-comfy-recovery-action.js', import.meta.url), 'utf8');
  assert.match(storyboardFunctionSource('storyboardResolveComfyRecoveryKey'), /exact:\s*true/);
  assert.match(receive, /resolveKey:storyboardResolveComfyRecoveryKey,deliver:storyboardDeliverGatewayResult/);
  assert.match(action, /archiveFiles, checkpoint,/); assert.doesNotMatch(receive + action, /storyboardRetryLog|generateImage/);
});

test('recovery credential cannot silently fall back to a draft key for a different host', async () => {
  let reads = 0;
  const state = { connections: { comfy: { draft: { credentialId: 'original-key', baseUrl: 'https://new.test' }, presets: [] } } };
  const context = vm.createContext({ resolveComfyRecoveryKey, URL, storyboardState: () => state, storyboardResolveApiKey: async (_provider, key, options) => { reads++; assert.equal(key, 'original-key'); assert.equal(options.exact, true); return 'original-secret'; } });
  vm.runInContext(storyboardFunctionSource('storyboardResolveComfyRecoveryKey'), context);
  assert.equal(await context.storyboardResolveComfyRecoveryKey(job().connection), ''); assert.equal(reads, 0);
  state.connections.comfy.presets.push(job().connection);
  assert.equal(await context.storyboardResolveComfyRecoveryKey(job().connection), ''); assert.equal(reads, 0, 'conflicting owners of the same credential are not proof');
  state.connections.comfy.draft = job().connection;
  assert.equal(await context.storyboardResolveComfyRecoveryKey(job().connection), 'original-secret'); assert.equal(reads, 1);
});

test('recovery timing never labels offline waiting days as GPU generation time', () => {
  const log = { startedAt: 1, queuedAt: 1 }, pipeline = {};
  const context = vm.createContext({ storyboardPipelineForLog: () => pipeline, saveSettings() {}, storyboardArchivePipelineLog: async () => {} });
  vm.runInContext(storyboardFunctionSource('storyboardFinishLog'), context);
  context.storyboardFinishLog(log, 'success', { durationMs: 0 });
  assert.equal(log.durationMs, 0); assert.equal(pipeline.durationMs, 0);
  assert.match(storyboardFunctionSource('storyboardDeliverGatewayResult'), /job.recoveringOriginal \? \{ durationMs:/);
});

test('client freezes only original identity while account/storage checks are in flight', async () => {
  const gate = deferred(), entered = deferred(); let first = true;
  const s = setup({ configuration: { account: async () => { if (first) { first = false; entered.resolve(); await gate.promise; } return 'st-user:alice'; } } });
  const original = job(), preparing = s.client.prepare(original); await entered.promise;
  original.connection.baseUrl = 'https://new.test'; original.chatKey = 'new-chat'; gate.resolve(); await preparing;
  const row = [...s.rows.values()][0]; assert.equal(row.baseUrl, 'https://comfy.test/api'); assert.equal(row.chatKey, 'chat-a');
});

test('actual manual receive controller preserves original log, guards chat switches and confirms local admission only after archive', async () => {
  for (const switchChat of [false, true]) {
    const log = { id: 'log-a', snapshot: job(), error: 'old failure', durationMs: 250 }, calls = [], notices = [];
    let chat = 'chat-a';
    const context = vm.createContext({ receiveComfyImage, settings:{}, storyboardAdmissionEpoch:0, sanitizeStoryboardSnapshot, getStoryboardComfyTransport, getChatKey: () => chat,
      storyboardResolveComfyRecoveryKey: async () => 'original-test-key',
      storyboardComfyRecoveryRuntime: async () => ({ retrieve: async (frozen, options) => {
        assert.equal(frozen.id, 'attempt-a'); assert.equal(frozen.recoveringOriginal, true); assert.equal(options.apiKey, 'original-test-key');
        if (switchChat) chat = 'other-chat';
        const archived = await options.deliver(result(), [{ imageIndex: 0, url: '/user/images/0.png' }], async () => {}, async () => calls.push('account'));
        return { archived };
      } }),
      storyboardDeliverGatewayResult: async (_job, original, _data, options) => {
        assert.equal(original, log); assert.equal(options.service, true); assert.equal(options.archiveFiles.length, 1); await options.guard(); calls.push('archive'); return true;
      }, storyboardFinishLog: (original, status, details) => { assert.equal(original, log); assert.equal(status, 'success'); assert.equal(details.durationMs, 250); calls.push('finish'); },
      storyboardImageAdmissionRuntime: async () => ({ confirmResult: async admission => { assert.equal(admission.attemptId, 'attempt-a'); calls.push('admission'); } }),
      toast: message => notices.push(message), renderModal() {},
    });
    vm.runInContext(['storyboardCanReceiveComfyLog','storyboardReceiveComfyImage'].map(storyboardFunctionSource).join('\n'), context);
    await context.storyboardReceiveComfyImage(log);
    assert.deepEqual(calls, switchChat ? [] : ['account','archive','finish','admission']);
    assert.match(notices[0], switchChat ? /聊天已切换/ : /已领取并归档/);
  }
});
