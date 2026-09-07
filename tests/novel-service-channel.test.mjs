import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createNovelServiceChannel} from '../qianmu-novel-service-channel.js';
import {normalizeNovelServiceChannel} from '../qianmu-novel-service-channel-state.js';
import {createImageServiceStore} from '../qianmu-image-service-store.js';
import {createImageService} from '../qianmu-image-service.js';
import {createVibeEncodingService} from '../qianmu-vibe-service.js';
import {imageServiceChannelKey} from '../qianmu-image-service-queue.js';
import {imageServiceAccount} from '../qianmu-image-service-access.js';
import {encodeNovelVibe,prepareNovelVibeEncoding} from '../qianmu-vibe-encoding.js';
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const actor=(handle='alice')=>({user:{profile:{handle,enabled:true}}});
const key='isolated-channel-key',namespace=imageServiceAccount(actor()).namespace;
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const lease=(attemptId,extra={})=>({apiKey:key,namespace,kind:'vibe',attemptId,requestDigest:imageServiceChannelKey(attemptId),...extra});
const identity=input=>({namespace:input.namespace,kind:input.kind,attemptId:input.attemptId,requestDigest:input.requestDigest});
const imageInput=(attemptId,apiKey=key)=>({schemaVersion:1,attemptId,automatic:true,request:{provider:'novel',model:'nai-diffusion-4-5-full',prompt:'lake',apiKey}});
async function vibeInput(information=0,apiKey=key,req=actor()){
  const request={version:1,provider:'novel',baseUrl:'https://relay.example',model:'nai-diffusion-4-5-full',image:PNG,information,apiKey};
  return {version:1,expectedAccount:imageServiceAccount(req).namespace,cacheKey:(await prepareNovelVibeEncoding(request)).cacheKey,request,confirmed:true};
}
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'qianmu-novel-channel-')),handles=[],unblock=[];
  const register=value=>{handles.push(value);return value;};
  const channel=(extra={})=>register(createNovelServiceChannel({dataRoot:root,waitTimeoutMs:5000,pollMs:10,...extra}));
  const store=register(createImageServiceStore({dataRoot:root,scope:'novel-channel'}));
  t.after(async()=>{unblock.forEach(fn=>fn());await Promise.allSettled(handles.map(value=>value.close()));const resolved=await fs.realpath(root);
    assert.equal(path.dirname(resolved),await fs.realpath(os.tmpdir()));assert.match(path.basename(resolved),/^qianmu-novel-channel-/);await fs.rm(resolved,{recursive:true});});
  return {root,register,channel,store,unblock,
    image:fetchImpl=>register(createImageService({dataRoot:root,channel:channel(),gatewayOptions:{resolveHost:async()=>[{address:'8.8.8.8',family:4}],fetchImpl}})),
    vibe:fetchImpl=>register(createVibeEncodingService({dataRoot:root,channel:channel(),encode:(input,hooks)=>encodeNovelVibe(input,{...hooks,fetchImpl})})),
  };
}
const imageResponse=()=>Response.json({data:[{b64_json:PNG}]});
const vibeResponse=()=>new Response('opaque-fixture-binary',{headers:{'content-type':'application/binary'}});
test('occupancy uses its own bounded schema, is lazy and does not accept fee ledgers or unknown fields',async t=>{
  const e=await fixture(t),gate=e.channel();assert.deepEqual(await fs.readdir(e.root),[]);
  await assert.rejects(()=>gate.run(lease('one',{kind:'comfy'}),()=>assert.fail('invalid kind')));assert.deepEqual(await fs.readdir(e.root),[]);
  assert.throws(()=>normalizeNovelServiceChannel({schema:'qianmu.image-service-channel.v1',channelKey:imageServiceChannelKey(key),entries:[]},imageServiceChannelKey(key)));
  await gate.run(lease('one'),async ticket=>ticket.beforeSubmit());const state=await e.store.inspectChannel(imageServiceChannelKey(key));assert.equal(state.entries[0].status,'released');
  assert.throws(()=>normalizeNovelServiceChannel({...state,unexpected:true},state.channelKey));assert.equal(JSON.stringify(state).includes(key),false);
});
test('actual Vibe and image services across separate instances/accounts share one upstream slot for the same Key',async t=>{
  const e=await fixture(t),began=deferred(),release=deferred(),events=[];e.unblock.push(release.resolve);let active=0,max=0;
  const vibe=e.vibe(async()=>{events.push('vibe');max=Math.max(max,++active);began.resolve();await release.promise;active--;return vibeResponse();});
  const image=e.image(async()=>{events.push('image');max=Math.max(max,++active);active--;return imageResponse();});
  const first=vibe.submit(actor(),await vibeInput());await began.promise;const second=image.submit(actor('bob'),imageInput('image-after-vibe'));
  await pause(50);assert.deepEqual(events,['vibe']);release.resolve();await Promise.all([first,second]);assert.deepEqual(events,['vibe','image']);assert.equal(max,1);
});
test('different Vibe fingerprints sharing a Key wait in order; different Keys remain independent',async t=>{
  for(const independent of [false,true]){
    const e=await fixture(t),began=deferred(),secondBegan=deferred(),release=deferred();e.unblock.push(release.resolve);let posts=0;
    const first=e.vibe(async()=>{posts++;began.resolve();await release.promise;return vibeResponse();});
    const second=e.vibe(async()=>{posts++;secondBegan.resolve();return vibeResponse();});
    const one=first.submit(actor(),await vibeInput());await began.promise;const two=second.submit(actor(),await vibeInput(.8,independent?'different-key':key));
    if(independent)await secondBegan.promise;else await pause(70);assert.equal(posts,independent?2:1);release.resolve();await Promise.all([one,two]);assert.equal(posts,2);
  }
});
test('cancelled waiting image leaves the active encoding alone and sends no image request',async t=>{
  const e=await fixture(t),began=deferred(),release=deferred(),abort=new AbortController();e.unblock.push(release.resolve);let images=0;
  const vibe=e.vibe(async()=>{began.resolve();await release.promise;return vibeResponse();}),image=e.image(async()=>{images++;return imageResponse();});
  const first=vibe.submit(actor(),await vibeInput());await began.promise;const second=image.submit(actor(),imageInput('cancelled'),{signal:abort.signal});
  await pause(40);abort.abort();await assert.rejects(second,{submissionState:'not_submitted'});assert.equal(images,0);
  assert.equal((await e.store.inspectChannel(imageServiceChannelKey(key))).entries[0].kind,'vibe');release.resolve();await first;
  await image.submit(actor(),imageInput('next'));assert.equal(images,1);
});
test('unknown encoding fences later images and other Vibes across service restarts without replay or time-based unlock',async t=>{
  const e=await fixture(t);let encodes=0,images=0;
  const first=e.vibe(async()=>{encodes++;throw new TypeError('lost response');});await assert.rejects(()=>vibeInput().then(input=>first.submit(actor(),input)));await first.close();
  const image=e.image(async()=>{images++;return imageResponse();}),second=e.vibe(async()=>{encodes++;return vibeResponse();});
  await assert.rejects(()=>image.submit(actor(),imageInput('blocked')),{code:'image_service_channel_uncertain',submissionState:'not_submitted'});
  await assert.rejects(()=>vibeInput(.8).then(input=>second.submit(actor(),input)),{submissionState:'not_submitted'});assert.equal(encodes,1);assert.equal(images,0);
  await image.submit(actor(),imageInput('other-channel','other-key'));assert.equal(images,1);
});
test('a definitive rejection releases only occupancy, keeping the original encoding fee record and allowing a subsequent image',async t=>{
  const e=await fixture(t);let images=0;const vibe=e.vibe(async()=>new Response('',{status:429})),input=await vibeInput();
  await assert.rejects(()=>vibe.submit(actor(),input),{submissionState:'rejected'});assert.equal((await vibe.query(actor(),input)).task.status,'rejected');
  await e.image(async()=>{images++;return imageResponse();}).submit(actor(),imageInput('after-rejection'));assert.equal(images,1);
  assert.equal((await vibe.query(actor(),input)).task.status,'rejected');assert.equal((await e.store.inspectChannel(imageServiceChannelKey(key))).entries.length,1);
});
test('exact cached Vibe success can release a stale occupancy without the Key; another account cannot do so',async t=>{
  const e=await fixture(t),service=e.vibe(vibeResponse),input=await vibeInput();await service.submit(actor(),input);const channelKey=imageServiceChannelKey(key);
  await e.store.transaction(channelKey,state=>{state.entries[0].status='uncertain';return {state};});
  const query={version:1,expectedAccount:input.expectedAccount,cacheKey:input.cacheKey};await assert.rejects(()=>service.result(actor('bob'),query));
  assert.equal((await e.store.inspectChannel(channelKey)).entries[0].status,'uncertain');await service.result(actor(),query);
  assert.equal((await e.store.inspectChannel(channelKey)).entries[0].status,'released');await e.image(imageResponse).submit(actor(),imageInput('after-retrieval'));
});
test('exact cached image success also releases stale occupancy without replaying an image or changing its original receipt',async t=>{
  const e=await fixture(t),service=e.image(imageResponse),created=await service.submit(actor(),imageInput('cached-image')),channelKey=imageServiceChannelKey(key);
  await e.store.transaction(channelKey,state=>{state.entries[0].status='submitting';return {state};});
  const result=await service.result(actor(),{schemaVersion:1,attemptId:'cached-image',taskLocator:{version:1,channelKey}});
  assert.equal(result.serviceTask.receipt,created.serviceTask.receipt);assert.equal((await e.store.inspectChannel(channelKey)).entries[0].status,'released');
});
test('late completion cannot release a newer operation and a ticket cannot authorize a second POST',async t=>{
  const e=await fixture(t),gate=e.channel(),release=deferred(),began=deferred();e.unblock.push(release.resolve);
  const original=lease('original'),later=lease('later');const first=gate.run(original,async ticket=>{await ticket.beforeSubmit();began.resolve();await release.promise;return 'already received';});
  await began.promise;await gate.completeFromCache(identity(original));const secondBegan=deferred(),secondRelease=deferred();e.unblock.push(secondRelease.resolve);
  const second=gate.run(later,async ticket=>{await ticket.beforeSubmit();secondBegan.resolve();await secondRelease.promise;});await secondBegan.promise;
  release.resolve();await first;assert.equal((await e.store.inspectChannel(imageServiceChannelKey(key))).entries[0].attemptId,'later');secondRelease.resolve();await second;
  await assert.rejects(()=>gate.run(lease('duplicate'),async ticket=>{await ticket.beforeSubmit();await ticket.beforeSubmit();}),{submissionState:'unknown'});
  assert.equal((await e.store.inspectChannel(imageServiceChannelKey(key))).entries[0].status,'uncertain');
});
test('bounded waiting and close never steal an occupied channel or clear the current owner',async t=>{
  const e=await fixture(t),hold=e.channel(),wait=e.channel({waitTimeoutMs:100}),began=deferred(),release=deferred();e.unblock.push(release.resolve);
  const first=hold.run(lease('held'),async ticket=>{await ticket.beforeSubmit();began.resolve();await release.promise;});await began.promise;
  await assert.rejects(()=>wait.run(lease('timed-out'),()=>assert.fail('must wait')),{code:'image_service_channel_busy'});
  const pending=wait.run(lease('closed'),()=>assert.fail('closed'));const rejection=assert.rejects(pending,{code:'image_service_channel_cancelled'});await wait.close();await rejection;
  assert.equal((await e.store.inspectChannel(imageServiceChannelKey(key))).entries[0].attemptId,'held');release.resolve();await first;
});
test('concurrent authorization callbacks cannot release occupancy before the first durable authorization finishes',async t=>{
  const e=await fixture(t),gate=e.channel();
  await assert.rejects(()=>gate.run(lease('concurrent-authorize'),async ticket=>Promise.all([ticket.beforeSubmit(),ticket.beforeSubmit()])),{code:'image_service_channel_already_submitted',submissionState:'unknown'});
  assert.equal((await e.store.inspectChannel(imageServiceChannelKey(key))).entries[0].status,'uncertain');
  await assert.rejects(()=>e.channel().run(lease('next'),()=>assert.fail('previous outcome is unknown')),{code:'image_service_channel_uncertain'});
});
test('corrupt occupancy never becomes an empty channel and does not damage original fee ledgers',async t=>{
  const e=await fixture(t),gate=e.channel();await gate.run(lease('valid'),async ticket=>ticket.beforeSubmit());
  const file=path.join(e.root,'.qianmu-service','novel-channel-v1',`${imageServiceChannelKey(key)}.json`);await fs.writeFile(file,'corrupted test fixture');
  await assert.rejects(()=>e.channel().run(lease('blocked'),()=>assert.fail('no authorization')),{code:'image_service_storage_corrupt'});
  assert.equal(await fs.readFile(file,'utf8'),'corrupted test fixture');
});
test('a different real Node process holds the same persistent channel until its operation finishes',async t=>{
  const e=await fixture(t),gate=e.channel(),module=new URL('../qianmu-novel-service-channel.js',import.meta.url).href;
  const script=`import {createNovelServiceChannel} from ${JSON.stringify(module)};const channel=createNovelServiceChannel({dataRoot:${JSON.stringify(e.root)}});await channel.run(${JSON.stringify(lease('child'))},async ticket=>{await ticket.beforeSubmit();process.send('ready');await new Promise(resolve=>process.once('message',resolve));});await channel.close();process.send('done');process.disconnect();`;
  const child=spawn(process.execPath,['--input-type=module'],{stdio:['pipe','pipe','pipe','ipc']});let errors='';child.stderr.on('data',chunk=>errors+=chunk);
  const exited=new Promise(resolve=>child.once('exit',code=>resolve(code)));t.after(()=>{if(child.exitCode===null)child.kill();});
  const ready=new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',code=>reject(Error(`child ended ${code}: ${errors}`)));});child.stdin.end(script);assert.equal(await ready,'ready');
  let entered=false;const second=gate.run(lease('parent'),async ticket=>{await ticket.beforeSubmit();entered=true;});await pause(40);assert.equal(entered,false);
  child.send('finish');await second;assert.equal(entered,true);assert.equal(await exited,0);assert.equal(errors,'');
});
test('a real process exit after authorization leaves occupancy fenced; death and waiting do not prove the upstream stopped',async t=>{
  const e=await fixture(t),module=new URL('../qianmu-novel-service-channel.js',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module'],{stdio:['pipe','pipe','pipe']});let errors='';child.stderr.on('data',chunk=>errors+=chunk);
  const exited=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});t.after(()=>{if(child.exitCode===null)child.kill();});
  child.stdin.end(`import {createNovelServiceChannel} from ${JSON.stringify(module)};const c=createNovelServiceChannel({dataRoot:${JSON.stringify(e.root)}});await c.run(${JSON.stringify(lease('crashed'))},async t=>{await t.beforeSubmit();process.exit(0);});`);
  assert.equal(await exited,0);assert.equal(errors,'');const gate=e.channel({waitTimeoutMs:100});
  await assert.rejects(()=>gate.run(lease('no-steal'),()=>assert.fail('cannot authorize')),{code:'image_service_channel_busy'});
  const row=(await e.store.inspectChannel(imageServiceChannelKey(key))).entries[0];assert.equal(row.attemptId,'crashed');assert.equal(row.status,'submitting');
});
test('bounded metadata-lock waiting acquires after release without rerunning a reducer or stealing the file',async t=>{
  const e=await fixture(t),held=deferred(),release=deferred();e.unblock.push(release.resolve);
  const blocking=e.store.exclusive(async()=>{held.resolve();await release.promise;});await held.promise;
  const waiting=e.register(createImageServiceStore({dataRoot:e.root,scope:'novel-channel',lockWaitMs:1000}));let reductions=0;
  const work=waiting.transaction(imageServiceChannelKey(key),state=>{reductions++;return {state:normalizeNovelServiceChannel(state,imageServiceChannelKey(key))};});
  await pause(30);assert.equal(reductions,0);release.resolve();await Promise.all([work,blocking]);assert.equal(reductions,1);
});
test('an ambiguous write is never retried even when a lock-wait-enabled store receives EEXIST after rename',async t=>{
  const e=await fixture(t);let reductions=0,renames=0;
  const store=e.register(createImageServiceStore({dataRoot:e.root,scope:'novel-channel',lockWaitMs:1000,fileSystem:{...fs,rename:async(...args)=>{
    renames++;await fs.rename(...args);throw Object.assign(Error('injected after commit'),{code:'EEXIST'});
  }}}));
  await assert.rejects(()=>store.transaction(imageServiceChannelKey(key),raw=>{reductions++;return {state:normalizeNovelServiceChannel(raw,imageServiceChannelKey(key))};}));
  assert.equal(reductions,1);assert.equal(renames,1);assert.deepEqual((await e.store.inspectChannel(imageServiceChannelKey(key))).entries,[]);
});
