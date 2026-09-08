import test from 'node:test';
import assert from 'node:assert/strict';
import { openStoryboardBundleRestoreRuntime, closeStoryboardBundleRestoreRuntime } from '../qianmu-storyboard-bundle-restore-runtime.js';
import { renderStoryboardBundleReview } from '../qianmu-storyboard-bundle-view.js';
import { createStoryboardEnvironmentReview } from '../qianmu-storyboard-environment-map.js';
import { randomUUID, createHash } from 'node:crypto';
import {aliasFixture} from './fixtures/storyboard-user-aliases.mjs';
import {captureStoryboardSubjectEvidence,storyboardSubjectTargets} from '../qianmu-storyboard-subject-evidence.js';
import {planBundleUserAliases,bundleUserAliasPage,bundleUserAliasSummary} from '../qianmu-bundle-user-alias.js';
const namespace = 'st-user:test', sourceDigest = 'a'.repeat(64), chatHash = 'b'.repeat(64);
const view = () => ({ namespace, sourceDigest, chatHash, ready: false, planDigest: '', conflicts: [], images: [], bindingReview: [],
  summary: { images: 1, vibeFiles: 0, workflows: { count: 1, versions: 2 }, pools: { count: 0 }, characters: { count: 0 } }, characterSummary: { added: 0, replaced: 0, kept: 0 } });
const gate = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
async function environmentReview(){const source={ok:true,version:1,state:'ready',expectedAccount:'st-user:'+createHash('sha256').update('test').digest('hex'),instanceId:randomUUID(),accountId:randomUUID(),proof:'installation-labels',automaticRebinding:false};return createStoryboardEnvironmentReview({namespace,sourceDigest,chatHash,source,target:{...source,instanceId:randomUUID()}});}
test('mapped environment UI has explicit source/target labels and a distinct resettable consent gate',async()=>{
  const review=await environmentReview(),preview={...view(),ready:true,planDigest:'c'.repeat(64),environmentReview:review,sourceLabelsMatched:false};
  const input={preview,page:0,environmentReviewed:true};let markup=renderStoryboardBundleReview(input);
  assert.match(markup,/data-bundle-mapping/);assert.match(markup,/data-bundle-action="restore" disabled/);assert.match(markup,new RegExp(review.source.instanceId));assert.match(markup,new RegExp(review.target.instanceId));
  assert.doesNotMatch(markup,/此包无 ST 来源标识/);assert.doesNotMatch(renderStoryboardBundleReview({...input,environmentMapped:true}),/data-bundle-action="restore" disabled/);
});
class FakeWorker {
  static last; static flow;
  constructor() { FakeWorker.last = this; this.listeners = {}; this.sent = []; this.pending = new Map(); this.request = 0; this.closed = false; }
  addEventListener(type, run) { this.listeners[type] = run; }
  terminate() { this.closed = true; }
  emit(value) { this.listeners.message({ data: value }); }
  postMessage(message) {
    this.sent.push(structuredClone(message));
    if (message.type === 'rpc') { this.pending.get(message.request)?.(message); this.pending.delete(message.request); return; }
    if (message.type === 'command') void Promise.resolve().then(() => FakeWorker.flow(this, message));
  }
  reply(command, result) { this.emit({ id: command.id, operation: command.operation, action: command.action, type: 'result', sourceDigest, result }); }
  rpc(command, kind, payload) { return new Promise(resolve => { const request = ++this.request; this.pending.set(request, resolve); this.emit({ id: command.id, operation: command.operation, request, kind, payload }); }); }
}
async function fixture(flow, extra = {}) {
  const e = { active: true, applied: 0, previews: 0 };
  FakeWorker.flow = async (worker, command) => {
    if (command.action === 'open') { await worker.rpc(command, 'guard'); worker.reply(command, { sourceDigest }); }
    else if (flow) await flow(worker, command, e);
    else worker.reply(command, view());
  };
  const options = { namespace, chatKey: 'chat', guard: async () => { if (!e.active) throw Error('scope changed'); },
    headers: () => ({ 'X-CSRF-Token': 'only-csrf', Authorization: 'not-forwarded' }), WorkerClass: FakeWorker,
    configuration: { preview: async () => { e.previews++; return { digest: 'c'.repeat(64) }; }, apply: async () => { e.applied++; return {}; } }, ...extra };
  const client = await openStoryboardBundleRestoreRuntime(new Blob(['synthetic']), options);
  return { e, client, worker: FakeWorker.last, options };
}

async function aliasView(){const library={...aliasFixture(),namespace},evidence=await captureStoryboardSubjectEvidence(storyboardSubjectTargets(library.bindings).map(row=>({...row,state:'present',profile:{name:'Player',description:'source'}})));
  const plan=await planBundleUserAliases({library,evidence,sourceDigest});return {page:bundleUserAliasPage(plan),preview:{...view(),sourceAliases:bundleUserAliasSummary(plan),sourceAliasChoices:{}}};}
test('source alias pages are typed, source/offset-bound and cannot obtain a configuration write',async()=>{
  const {page,preview}=await aliasView(),{client,e}=await fixture(async(w,c)=>{if(c.action==='aliases'){const answer=await w.rpc(c,'configuration-apply',{fingerprint:sourceDigest,settings:{},chat:{},imageUrls:{},expectedDigest:'c'.repeat(64)});assert.ok(answer.error);w.reply(c,page);}else w.reply(c,preview);});
  assert.deepEqual(await client.preview(),preview);assert.deepEqual(await client.aliases({choices:{},offset:0}),page);assert.equal(e.applied,0);client.close();
  for(const bad of [{...page,sourceDigest:'b'.repeat(64)},{...page,offset:24},{...page,rows:[{...page.rows[0],secret:'private'}]}]){
    const f=await fixture(async(w,c)=>w.reply(c,bad));await assert.rejects(f.client.aliases({choices:{},offset:0}),/结果与当前原包不符/);assert.equal(f.worker.closed,true);
  }
});
test('source resolution has its own runtime and UI consent and malformed source summaries close the worker',async()=>{
  const {preview}=await aliasView(),{client,worker}=await fixture();const before=worker.sent.length;
  await assert.rejects(client.restore(preview,{confirmed:true,environmentReviewed:true,subjectsMapped:true}),/单独确认原包USER/);assert.equal(worker.sent.length,before);client.close();
  const rendered=renderStoryboardBundleReview({preview:{...preview,ready:true,planDigest:'c'.repeat(64)},page:0,environmentReviewed:true});assert.match(rendered,/data-bundle-source-reviewed/);assert.match(rendered,/data-bundle-action="restore" disabled/);
  const bad={...preview,sourceAliases:{...preview.sourceAliases,ready:true}},f=await fixture(async(w,c)=>w.reply(c,bad));await assert.rejects(f.client.preview(),/结果与当前原包不符/);assert.equal(f.worker.closed,true);
});
test('runtime rejects unconfirmed environment mapping before dispatch and accepts source-bound mapped views',async t=>{
  const review=await environmentReview(),prepared={...view(),environmentReview:review,sourceLabelsMatched:false};
  const {client,worker}=await fixture(async(w,c)=>w.reply(c,prepared));t.after(()=>client.close());
  assert.deepEqual((await client.preview()).environmentReview,review);const count=worker.sent.length;
  await assert.rejects(client.restore(prepared,{confirmed:true,environmentReviewed:true}),/单独确认/);assert.equal(worker.sent.length,count);
});
test('runtime refuses malformed or cross-source environment views and false matched-label claims',async()=>{
  const review=await environmentReview();
  for(const bad of [{...review,sourceDigest:'d'.repeat(64)},{...review,chatHash:'e'.repeat(64)},{...review,credential:'private'},{...review,state:'matched'}]){
    const {client,worker}=await fixture(async(w,c)=>w.reply(c,{...view(),environmentReview:bad,sourceLabelsMatched:false}));await assert.rejects(client.preview(),/结果与当前原包不符/);assert.equal(worker.closed,true);
  }
  const {client}=await fixture(async(w,c)=>w.reply(c,{...view(),environmentReview:review,sourceLabelsMatched:true}));await assert.rejects(client.preview(),/结果与当前原包不符/);
});

test('one persistent worker binds each command and configuration RPC to the source; headers only contain CSRF', async t => {
  const { e, client, worker } = await fixture(async (worker, command) => {
    const ack = await worker.rpc(command, 'configuration-preview', { fingerprint: sourceDigest, settings: {}, chat: {}, imageUrls: {} });
    assert.equal(ack.error, undefined); worker.reply(command, view());
  }); t.after(() => client.close());
  await client.preview(); await client.preview(); assert.equal(e.previews, 2); assert.equal(e.applied, 0);
  const commands = worker.sent.filter(row => row.type === 'command'); assert.deepEqual(commands.map(row => row.operation), [1,2,3]);
  assert.equal(commands[0].payload.csrf, 'only-csrf'); assert.equal(JSON.stringify(commands).includes('not-forwarded'), false);
  assert.ok(commands.slice(1).every(row => row.sourceDigest === sourceDigest));
});

test('preview cannot request a live configuration write, and cross-source or oversized-field RPCs are rejected', async t => {
  const { e, client } = await fixture(async (worker, command) => {
    for (const [kind, payload] of [['configuration-apply', { fingerprint: sourceDigest }], ['configuration-preview', { fingerprint: 'd'.repeat(64) }], ['configuration-preview', { fingerprint: sourceDigest, media: ['not metadata'] }]]) {
      const ack = await worker.rpc(command, kind, payload); assert.ok(ack.error);
    }
    worker.reply(command, view());
  }); t.after(() => client.close()); await client.preview(); assert.equal(e.applied, 0); assert.equal(e.previews, 0);
});

test('subject evidence RPC remains read-only, source-bound and separate from the live settings payload', async t => {
  let calls=0;
  const { client }=await fixture(async(worker,command)=>{
    const value={fingerprint:sourceDigest,subjectEvidence:{schema:'synthetic'},subjectBindings:[]};
    assert.equal((await worker.rpc(command,'configuration-subjects',value)).error,undefined);
    assert.ok((await worker.rpc(command,'configuration-subjects',{...value,settings:{}})).error);
    assert.ok((await worker.rpc(command,'configuration-subjects',{...value,fingerprint:'d'.repeat(64)})).error);
    worker.reply(command,view());
  },{configuration:{preview:async()=>{},apply:async()=>assert.fail('no writes'),subjects:async()=>{calls++;return {digest:'e'.repeat(64),rows:[],ready:true};}}});
  t.after(()=>client.close());await client.preview();assert.equal(calls,1);
});
test('target catalogue RPC is read-only, tied to the requested page and cannot call preview/apply or carry profile data',async t=>{
  const page={category:'char',query:'Alice',offset:0,total:1,rows:[{category:'char',subjectKey:'char:alice.png',name:'Alice'}]};let called=0;
  const {client,e}=await fixture(async(w,c)=>{
    assert.equal((await w.rpc(c,'configuration-targets',{fingerprint:sourceDigest,category:'char',query:'Alice',offset:0})).error,undefined);
    assert.ok((await w.rpc(c,'configuration-preview',{fingerprint:sourceDigest,settings:{}})).error);assert.ok((await w.rpc(c,'configuration-apply',{fingerprint:sourceDigest})).error);
    assert.ok((await w.rpc(c,'configuration-targets',{fingerprint:sourceDigest,category:'char',query:'Alice',offset:0,settings:{}})).error);
    w.reply(c,{...page,sourceDigest});
  },{configuration:{targets:async()=>{called++;return page;},preview:async()=>assert.fail('no preview'),apply:async()=>assert.fail('no apply')}});t.after(()=>client.close());
  assert.equal((await client.targets({category:'char',query:'Alice',offset:0})).rows[0].name,'Alice');assert.equal(called,1);assert.equal(e.applied,0);
});
test('target picker rejects swapped pages and over-broad rows, and subject mapping needs its own runtime consent',async()=>{
  const page={category:'char',query:'',offset:0,total:1,rows:[{category:'char',subjectKey:'char:alice.png',name:'Alice'}],sourceDigest};
  for(const wrong of [{...page,offset:24},{...page,query:'other'},{...page,rows:[{...page.rows[0],profile:{description:'private'}}]}]){
    const {client}=await fixture(async(w,c)=>w.reply(c,wrong));await assert.rejects(client.targets({category:'char',query:'',offset:0}),/结果与当前原包不符/);
  }
  const {client,worker}=await fixture();const count=worker.sent.length;
  await assert.rejects(client.restore({...view(),subjectMappings:[{category:'char',sourceKey:'char:old.png',targetKey:'char:alice.png'}]},{confirmed:true,environmentReviewed:true}),/单独确认/);assert.equal(worker.sent.length,count);client.close();
});
test('subject mapped review shows original and target identifiers, escaped picker choices and distinct confirmation',()=>{
  const preview={...view(),ready:true,planDigest:'c'.repeat(64),subjectReview:[{category:'char',subjectKey:'char:old.png',targetKey:'char:new.png',required:true,state:'changed'}],subjectMappings:[{category:'char',sourceKey:'char:old.png',targetKey:'char:new.png'}]};
  const base={preview,page:0,environmentReviewed:true,subjectsReviewed:true,targetPicker:{category:'char',query:'<query>',offset:0,total:1,rows:[{category:'char',subjectKey:'char:new.png',name:'<Alice>'}]}};
  const markup=renderStoryboardBundleReview(base);assert.match(markup,/→ char:new.png/);assert.match(markup,/&lt;Alice&gt;/);assert.doesNotMatch(markup,/<Alice>/);assert.match(markup,/data-bundle-subject-mapping/);assert.match(markup,/data-bundle-action="restore" disabled/);
  assert.doesNotMatch(renderStoryboardBundleReview({...base,subjectsMapped:true}),/data-bundle-action="restore" disabled/);
});

test('subject differences require their own explicit checkbox even when the environment and binding labels were reviewed',()=>{
  const preview={...view(),ready:true,planDigest:'c'.repeat(64),subjectReview:[{category:'char',subjectKey:'char:alice.png',state:'changed',required:true}]};
  const input={preview,page:0,fileName:'source',environmentReviewed:true,bindingsReviewed:true};
  const markup=renderStoryboardBundleReview(input);assert.match(markup,/内容有变化/);assert.match(markup,/data-bundle-subjects/);assert.match(markup,/data-bundle-action="restore" disabled/);
  assert.doesNotMatch(renderStoryboardBundleReview({...input,subjectsReviewed:true}),/data-bundle-action="restore" disabled/);
});

test('connection differences are paged, escaped and need separate consent rather than an environment checkbox',()=>{
  const rows=Array.from({length:26},(_,i)=>({providerId:'openai',presetId:`id-${i}`,name:`<name-${i}>`,state:'changed',credential:'required',active:i===0,differences:['headers']}));
  const preview={...view(),ready:true,planDigest:'c'.repeat(64),configuration:{connections:rows}}, input={preview,page:0,environmentReviewed:true,subjectsReviewed:true};
  let markup=renderStoryboardBundleReview(input);assert.match(markup,/自定义请求头/);assert.match(markup,/当前选择的同编号/);assert.match(markup,/&lt;name-0&gt;/);assert.doesNotMatch(markup,/<name-0>/);
  assert.doesNotMatch(markup,/&lt;name-24&gt;/);assert.match(markup,/1 \/ 2/);assert.match(markup,/data-bundle-action="restore" disabled/);
  markup=renderStoryboardBundleReview({...input,page:1,connectionsReviewed:true});assert.match(markup,/&lt;name-24&gt;/);assert.doesNotMatch(markup,/&lt;name-0&gt;/);assert.doesNotMatch(markup,/data-bundle-action="restore" disabled/);
  assert.match(renderStoryboardBundleReview({...input,connectionsReviewed:true,preview:{...preview,needsRecheck:true}}),/data-bundle-action="restore" disabled/);
});

test('connection view protocol refuses injected credential fields or impossible retained authorization',async()=>{
  const row={providerId:'openai',presetId:'one',name:'Relay',state:'same',credential:'retained',active:false,differences:[]};
  for(const invalid of [{...row,credentialId:'private'},{...row,state:'changed'},{...row,differences:['unknown']},{...row,options:{api_key:'private'}}]){
    const {client,worker}=await fixture(async(worker,command)=>worker.reply(command,{...view(),configuration:{connections:[invalid]}}));
    await assert.rejects(client.preview(),/结果与当前原包不符/);assert.equal(worker.closed,true);
  }
});

test('resource paging cannot obtain configuration writes and binds the returned page to its requested offset/filter',async()=>{
  const item={kind:'comfy-file',state:'external',at:'workflows$["old"]',label:'LoRA',target:'old.safetensors'};
  const {client,e}=await fixture(async(worker,command)=>{
    const ack=await worker.rpc(command,'configuration-apply',{fingerprint:sourceDigest});assert.ok(ack.error);
    worker.reply(command,{sourceDigest,digest:'e'.repeat(64),offset:0,filter:'external',total:1,rows:[item]});
  });
  const result=await client.resources({filter:'external',offset:0});assert.equal(result.rows.length,1);assert.equal(e.applied,0);client.close();
  for(const row of [{offset:24,filter:'all',total:25,rows:[item]},{offset:0,filter:'external',total:1,rows:[item]},{offset:0,filter:'all',total:1,rows:[{...item,headers:{secret:'not-allowed'}}]}]){
    const f=await fixture(async(worker,command)=>worker.reply(command,{sourceDigest,digest:'e'.repeat(64),...row}));
    await assert.rejects(f.client.resources(),/结果与当前原包不符/);assert.equal(f.worker.closed,true);
  }
});

test('resource use review explains external dependencies, escapes filenames and requires its own confirmation',()=>{
  const summary={recorded:false,digest:'e'.repeat(64),total:1,included:0,external:1,dynamic:0,unresolved:0,review:0};
  const preview={...view(),ready:true,planDigest:'c'.repeat(64),summary:{...view().summary,resourceOrigins:summary}};
  const input={preview,page:0,environmentReviewed:true,resourcePage:{offset:0,filter:'all',total:1,rows:[{kind:'comfy-file',state:'external',at:'workflow$["x"]',label:'LoRA',target:'<model>.safetensors'}]}};
  const html=renderStoryboardBundleReview(input);assert.match(html,/旧包未记录/);assert.match(html,/&lt;model&gt;/);assert.doesNotMatch(html,/<model>/);assert.match(html,/data-bundle-action="restore" disabled/);
  assert.doesNotMatch(renderStoryboardBundleReview({...input,resourcesReviewed:true}),/data-bundle-action="restore" disabled/);
});

test('late operations and another session are ignored, while a repeated active RPC terminates the session', async () => {
  const { e, client, worker } = await fixture(async (worker, command) => {
    worker.emit({ id: command.id, operation: command.operation-1, request: 11, kind: 'configuration-apply', payload: { fingerprint: sourceDigest } });
    worker.emit({ id: 'other', operation: command.operation, request: 11, kind: 'configuration-apply', payload: { fingerprint: sourceDigest } });
    const request = { id: command.id, operation: command.operation, request: 12, kind: 'guard' }; worker.emit(request); worker.emit(request);
  });
  await assert.rejects(client.preview(), /消息不符/); assert.equal(worker.closed, true); assert.equal(e.applied, 0);
});

test('overlapping operations are refused and closing a busy restore rejects with partial-save guidance', async () => {
  const started = gate(), { client, worker } = await fixture(async () => { started.resolve(); });
  const pending = client.preview(); await started.promise;
  await assert.rejects(client.choose({}), /正在执行/); client.close();
  await assert.rejects(pending, /部分原件或配置可能已保存/); assert.equal(worker.closed, true); assert.equal(client.isOpen, false);
});

test('a scope change closes the worker before the next command can be dispatched', async () => {
  const { e, client, worker } = await fixture(); e.active = false;
  await assert.rejects(client.preview(), /scope changed/); assert.equal(worker.sent.filter(row => row.type === 'command').length, 1); assert.equal(worker.closed, true);
});

test('timeout and abort terminate the worker without synchronous fallback or replay', async () => {
  const timed = await fixture(async () => {}, { timeoutMs: 100 }); await assert.rejects(timed.client.preview(), /超时/); assert.equal(timed.worker.closed, true);
  const signal = new AbortController(), aborted = await fixture(async () => {}, { signal: signal.signal });
  const pending = aborted.client.preview(); await new Promise(resolve => setTimeout(resolve, 0)); signal.abort();
  await assert.rejects(pending, /中断/); assert.equal(aborted.worker.closed, true);
});

test('global session exclusion and cleanup prevent two simultaneous bundle restorers', async () => {
  const first = await fixture(); await assert.rejects(openStoryboardBundleRestoreRuntime(new Blob(['x']), first.options), /已有整包恢复/);
  closeStoryboardBundleRestoreRuntime(); assert.equal(first.client.isOpen, false); const second = await fixture(); second.client.close();
});

test('a worker cannot claim durable settings verification as the result of applying a bundle', async () => {
  const { client } = await fixture(async (worker, command) => worker.reply(command, { resourcesVerified: true, settingsVerified: true }));
  await assert.rejects(client.restore({ sourceDigest }, { confirmed: true, environmentReviewed: true }), /结果与当前原包不符/);
});

test('a malformed worker preview is rejected before it can crash the review renderer', async () => {
  const { client, worker } = await fixture(async (worker, command) => worker.reply(command, { sourceDigest }));
  await assert.rejects(client.preview(), /结果与当前原包不符/); assert.equal(worker.closed, true);
});

test('review markup escapes filenames and role fields, pages conflicts and requires explicit environment consent', () => {
  const p = view(); p.conflicts = Array.from({ length: 50 }, (_, i) => ({ key: `archive:${i}`, kind: 'archive', localName: '<script>local</script>', incomingName: 'incoming', localVersion: 1, incomingVersion: 2, choice: '' }));
  let html = renderStoryboardBundleReview({ preview: p, fileName: '<img onerror=alert(1)>', page: 1, busy: false });
  assert.equal((html.match(/data-bundle-choice=/g) || []).length, 24); assert.ok(html.includes('data-bundle-choice="24"')); assert.ok(html.includes('&lt;script&gt;')); assert.equal(html.includes('<img onerror'), false);
  assert.match(html, /data-bundle-action="restore" disabled/);
  p.ready = true; p.planDigest = 'f'.repeat(64); html = renderStoryboardBundleReview({ preview: p, page: 0, busy: false, environmentReviewed: true });
  assert.doesNotMatch(html, /data-bundle-action="restore" disabled/);
});
