import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { imageChannelKey, createBrowserImageChannel } from '../qianmu-image-channel.js';

const args = (extra = {}) => ({ apiKey: 'mock-test-key', namespace: 'account-a', attemptId: 'job-a', automatic: true, ...extra });
const neverWork = () => assert.fail('no provider work is authorized');
function readOnlyFixture(record) {
  let writes=0;
  return {writes:()=>writes,indexedDB:{open(){const opening={};queueMicrotask(()=>{opening.result={close(){},transaction(){
    const tx={objectStore:()=>({get(){const reading={};queueMicrotask(()=>{reading.result=structuredClone(record);reading.onsuccess();queueMicrotask(()=>tx.oncomplete?.());});return reading;},
      put(){writes++;throw Error('unexpected mutation');},delete(){writes++;throw Error('unexpected deletion');}}),abort(){queueMicrotask(()=>tx.onabort?.());}};return tx;
  }};opening.onsuccess();});return opening;}}};
}
function waitingLocks() {
  const calls = [];
  return { calls, request(name, options) {
    calls.push({ name, mode: options.mode });
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('cancelled', 'AbortError'));
      if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
    });
  } };
}

test('channel modules and construction are lazy and use no timers or storage before work', () => {
  const channel = createBrowserImageChannel({ indexedDB: { open: neverWork }, locks: { request: neverWork } });
  channel.close();
});

test('channel fingerprint shares the same trimmed key across aliases without exposing a credential', async () => {
  const a = await imageChannelKey(' mock-test-key '), b = await imageChannelKey('mock-test-key');
  assert.equal(a, b); assert.match(a, /^[0-9a-f]{64}$/); assert.notEqual(await imageChannelKey('other-key'), a);
  for (const value of ['', ' ', 'a\nb', 'a'.repeat(2049)]) await assert.rejects(imageChannelKey(value), { code: 'image_channel_identity', submissionState: 'not_submitted' });
});

test('missing browser coordination refuses a paid operation instead of silently becoming page-local', async () => {
  const channel = createBrowserImageChannel({ locks: null, indexedDB: { open: neverWork } });
  await assert.rejects(channel.run(args(), neverWork), { code: 'image_channel_unavailable', submissionState: 'not_submitted' });
  channel.close();
});

test('missing account/request identity is rejected before locks or storage', async () => {
  const channel = createBrowserImageChannel({ locks: { request: neverWork }, indexedDB: { open: neverWork } });
  for (const patch of [{ namespace: '' }, { attemptId: '' }]) await assert.rejects(channel.run(args(patch), neverWork), { code: 'image_channel_identity' });
  channel.close();
});

test('closing while fingerprinting never acquires a late lock or opens storage', async () => {
  const channel = createBrowserImageChannel({ locks: { request: neverWork }, indexedDB: { open: neverWork } });
  const task = channel.run(args(), neverWork); channel.close();
  await assert.rejects(task, { code: 'image_channel_closed', submissionState: 'not_submitted' });
});

test('invalid or unbounded prior consent cannot enter the channel', async () => {
  const channel = createBrowserImageChannel({ locks: { request: neverWork }, indexedDB: { open: neverWork } });
  for (const confirmedAttempts of [null, {}, [''], Array(257).fill('old-job')]) {
    await assert.rejects(channel.run(args({ confirmedAttempts }), neverWork), { code: 'image_channel_identity' });
  }
  channel.close();
});

test('a shared NAI Key cannot acknowledge another ST account unresolved attempt, even with matching prior consent',async()=>{
  const key=await imageChannelKey('mock-test-key');
  for(const status of ['submitting','uncertain'])for(const serviceReviewRequired of [false,true]){
    const record={version:1,key,namespace:'account-other',attemptId:'original-attempt',ownerId:'old-page',fence:'original-fence',status,updatedAt:1},fixture=readOnlyFixture(record);
    const channel=createBrowserImageChannel({indexedDB:fixture.indexedDB,locks:{request:async(_key,_options,work)=>work({})}});
    await assert.rejects(()=>channel.run(args({automatic:false,serviceReviewRequired,confirmedAttempts:[record.attemptId],confirm:neverWork}),neverWork),{code:'image_channel_other_account',submissionState:'not_submitted'});
    assert.equal(fixture.writes(),0);channel.close();
  }
});

test('manual unknown-image consent requires true and never treats popup codes or truthy values as authorization',async()=>{
  const key=await imageChannelKey('mock-test-key');
  for(const consent of [undefined,null,false,0,1,'true','1',{}]){
    const fixture=readOnlyFixture({version:1,key,namespace:'account-a',attemptId:'original-attempt',ownerId:'old-page',fence:'original-fence',status:'uncertain',updatedAt:1});
    const channel=createBrowserImageChannel({indexedDB:fixture.indexedDB,locks:{request:async(_key,_options,work)=>work({})}});
    await assert.rejects(()=>channel.run(args({automatic:false,confirm:async(_title,message)=>{assert.match(message,/确认已结束/);return consent;}}),neverWork),{code:'image_channel_uncertain'});
    assert.equal(fixture.writes(),0);channel.close();
  }
});

test('an already closed storage connection fails promptly before provider work', async () => {
  const channel = createBrowserImageChannel({ locks: { request: (_key, _options, callback) => callback({}) }, indexedDB: {
    open: () => {
      const request = { result: { transaction() { throw new DOMException('closed', 'InvalidStateError'); }, close() {} } };
      queueMicrotask(() => request.onsuccess()); return request;
    },
  }, timeoutMs: 1000 });
  // The fake open succeeds, but a concurrent version change prevents a transaction.
  const started = performance.now();
  await assert.rejects(channel.run(args(), neverWork), { code: 'image_channel_storage', submissionState: 'not_submitted' });
  assert.ok(performance.now() - started < 750, 'does not leave the storage deadline running'); channel.close();
});

test('waiting is capped and cancellable without polling or submitting', async () => {
  const locks = waitingLocks(), channel = createBrowserImageChannel({ locks, indexedDB: { open: neverWork } });
  const tasks = Array.from({ length: 8 }, (_, index) => channel.run(args({ attemptId: `job-${index}` }), neverWork));
  const settled = Promise.allSettled(tasks);
  await assert.rejects(channel.run(args({ attemptId: 'overflow' }), neverWork), { code: 'image_channel_queue_full' });
  channel.close();
  assert.ok((await settled).every(row => row.status === 'rejected' && ['image_channel_closed', 'image_channel_cancelled'].includes(row.reason.code)));
});

test('a waiting deadline cancels authorization and does not reach IndexedDB or a provider', async () => {
  const locks = waitingLocks(), channel = createBrowserImageChannel({ locks, indexedDB: { open: neverWork }, queueTimeoutMs: 100 });
  await assert.rejects(channel.run(args(), neverWork), { code: 'image_channel_cancelled', submissionState: 'not_submitted' });
  assert.equal(locks.calls.length, 1); assert.equal(locks.calls[0].mode, 'shared'); channel.close();
});

test('browser policy errors have a concise actionable reason and no retry authority', async () => {
  for (const name of ['SecurityError', 'InvalidStateError', 'NotSupportedError']) {
    const channel = createBrowserImageChannel({ locks: { request: () => Promise.reject(new DOMException('browser rejected', name)) }, indexedDB: { open: neverWork } });
    await assert.rejects(channel.run(args(), neverWork), { code: 'image_channel_unavailable', submissionState: 'not_submitted' }); channel.close();
  }
});

test('storage management cannot delete another account or clear without browser coordination', async () => {
  const channel = createBrowserImageChannel({ locks: null, indexedDB: { open: neverWork } });
  await assert.rejects(channel.manage('', { remove: true }), { code: 'image_channel_identity' });
  await assert.rejects(channel.manage('account-a', { remove: true }), { code: 'image_channel_unavailable' }); channel.close();
});

test('actual runtime wires the same channel ticket around direct and gateway work, without persisting consent', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const run = source.slice(source.indexOf('async function storyboardRunJob('), source.indexOf('async function storyboardRunQueuedJob('));
  assert.match(run, /await channelTicket\?\.beforeSubmit\(\)/);
  assert.match(run, /if \(job\.source === 'novel'\)/);
  assert.match(run, /channel\.run\([\s\S]*channelTicket = ticket; return generateTransport\(\)/);
  assert.ok(run.indexOf("fetch('/api/plugins/qianmu-tts/image/generate'") < run.indexOf('return { data, transport };'));
  const start = source.slice(source.indexOf('function storyboardStartLog('), source.indexOf('function storyboardMarkLogGenerating('));
  assert.doesNotMatch(start, /confirmedImageAttempts/);
  assert.match(source, /storyboardImageChannel\?\.close\(\)/);
  assert.match(source, /__image_channels__/);
});
