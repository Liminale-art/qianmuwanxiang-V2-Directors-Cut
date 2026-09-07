import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createImageServiceStore} from '../qianmu-image-service-store.js';
import {inspectImageServiceRecovery as inspect,recoverImageServiceRecords as recover,restoreInterruptedImageRecovery as restore} from '../qianmu-image-service-recovery.js';
import {createImageService} from '../qianmu-image-service.js';
import {createVibeEncodingService} from '../qianmu-vibe-service.js';
import {prepareNovelVibeEncoding} from '../qianmu-vibe-encoding.js';
import {imageServiceAccount} from '../qianmu-image-service-access.js';
import {imageServiceChannelKey as keyOf} from '../qianmu-image-service-queue.js';
const actor={user:{profile:{handle:'one',enabled:true}}},namespace=imageServiceAccount(actor).namespace,key='a'.repeat(64);
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const names={image:['novel','image-queue-v1'],vibe:['vibe','vibe-queue-v1'],native:['novel-channel','novel-channel-v1']};
function state(scope,status,channelKey=key){
  const row={namespace,attemptId:`original-${scope}`,requestDigest:'b'.repeat(64),ownerId:'old-service',fence:'old-fence',status,createdAt:1,updatedAt:2};
  return scope==='native'?{schema:'qianmu.novel-occupancy.v1',channelKey,entries:[{...row,kind:'vibe'}]}
    :{schema:'qianmu.image-service-channel.v1',channelKey,entries:[{...row,automatic:false}]};
}
async function fixture(t){
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'qianmu-native-offline-')),closing=[];
  t.after(async()=>{for(const item of closing.reverse())await item.close();const resolved=await fs.realpath(root);assert.equal(path.dirname(resolved),parent);assert.match(path.basename(resolved),/^qianmu-native-offline-/);await fs.rm(resolved,{recursive:true});});
  const stores=Object.fromEntries(Object.entries(names).map(([name,[scope]])=>{const store=createImageServiceStore({dataRoot:root,scope});closing.push(store);return [name,store];}));
  return {root,stores,closing,active:scope=>path.join(root,'.qianmu-service',names[scope][1]),seed:async(scope,status='submitting',channel=key)=>stores[scope].transaction(channel,()=>({state:state(scope,status,channel)}))};
}
async function child(script){
  const task=spawn(process.execPath,['--input-type=module','-e',script],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';
  task.stdout.on('data',value=>{output+=value;});task.stderr.on('data',value=>{output+=value;});
  return new Promise((resolve,reject)=>{task.once('error',reject);task.once('close',code=>code===0?resolve(output.trim()):reject(Error(`child ${code}: ${output.slice(0,1200)}`)));});
}

test('all-scope inspection is readonly, closed to arbitrary paths, and does not create unused stores',async t=>{
  const e=await fixture(t),plan=await inspect({dataRoot:e.root,scope:'all'});
  assert.equal(plan.schemaVersion,2);assert.equal(plan.exists,false);assert.deepEqual(plan.scopes.map(row=>row.scope),['image','vibe','native']);assert.deepEqual(await fs.readdir(e.root),[]);
  for(const scope of ['../comfy','comfy','__proto__',null])await assert.rejects(inspect({dataRoot:e.root,scope}),{code:'image_service_recovery_scope'});
  await assert.rejects(recover({dataRoot:e.root,scope:'all',confirmation:plan.confirmation}),{code:'image_service_recovery_offline_required'});
});
test('Vibe and native occupancy recovery retain original evidence, release only reserved and leave submitting uncertain',async t=>{
  for(const scope of ['vibe','native']){
    const e=await fixture(t);await e.seed(scope);await e.seed(scope,'reserved','c'.repeat(64));
    const original=await fs.readFile(path.join(e.active(scope),`${key}.json`)),plan=await inspect({dataRoot:e.root,scope});
    const result=await recover({dataRoot:e.root,scope,confirmation:plan.confirmation,serverStopped:true});
    assert.equal(result.released,1);assert.equal(result.uncertain,1);assert.equal(result.automaticResubmissions,0);
    assert.equal((await e.stores[scope].inspectChannel(key)).entries[0].status,'uncertain');
    assert.equal((await e.stores[scope].inspectChannel('c'.repeat(64))).entries[0].status,'released');
    assert.deepEqual(await fs.readFile(path.join(result.backup,`${key}.json`)),original);
    assert.equal(JSON.parse(await fs.readFile(path.join(result.backup,'manifest.json'),'utf8')).scope,scope);
    await assert.rejects(restore({dataRoot:e.root,scope,backupId:path.basename(result.backup),serverStopped:true}),{code:'image_service_recovery_completed'});
  }
});
test('identical fee files in image and Vibe scopes have different confirmations and cannot share repair consent',async t=>{
  const e=await fixture(t);await e.seed('image');
  await e.stores.vibe.transaction(key,()=>({state:state('image','submitting')}));
  const one=await inspect({dataRoot:e.root}),two=await inspect({dataRoot:e.root,scope:'vibe'});assert.notEqual(one.confirmation,two.confirmation);
  await assert.rejects(recover({dataRoot:e.root,scope:'vibe',confirmation:one.confirmation,serverStopped:true}),{code:'image_service_recovery_changed'});
  assert.equal((await e.stores.vibe.inspectChannel(key)).entries[0].status,'submitting');
});
test('all-scope preflight rejects corruption or any live writer before modifying even the first fee ledger',async t=>{
  for(const kind of ['corrupt','live']){
    const e=await fixture(t);for(const scope of Object.keys(names))await e.seed(scope);
    const original=await fs.readFile(path.join(e.active('image'),`${key}.json`));
    if(kind==='corrupt'){
      const plan=await inspect({dataRoot:e.root,scope:'all'});await fs.writeFile(path.join(e.active('native'),`${key}.json`),'broken');
      await assert.rejects(recover({dataRoot:e.root,scope:'all',confirmation:plan.confirmation,serverStopped:true}));
    }else{
      await fs.writeFile(path.join(e.active('native'),'.transaction.lock'),JSON.stringify({pid:process.pid}));
      const plan=await inspect({dataRoot:e.root,scope:'all'});
      await assert.rejects(recover({dataRoot:e.root,scope:'all',confirmation:plan.confirmation,serverStopped:true}),{code:'image_service_recovery_owner'});
    }
    assert.deepEqual(await fs.readFile(path.join(e.active('image'),`${key}.json`)),original);
    assert.equal((await fs.readdir(path.join(e.root,'.qianmu-service'))).some(name=>name.endsWith('-recovery')),false);
  }
});

test('real image and Vibe process interruption can recover all stores then complete normal authenticated original review without any generation',async t=>{
  const e=await fixture(t),imageKey='fake-offline-image',vibeKey='fake-offline-vibe';
  const request={provider:'novel',protocol:'novelai',model:'nai-diffusion-4-5-full',apiKey:imageKey,prompt:'fixture'};
  const imageInput={schemaVersion:1,expectedAccount:namespace,attemptId:'original-image',automatic:false,request};
  await child(`import {createImageService} from ${JSON.stringify(new URL('../qianmu-image-service.js',import.meta.url).href)};
    const service=createImageService({dataRoot:${JSON.stringify(e.root)},generate:async(_request,hooks)=>{await hooks.beforeSubmit();process.exit(0);}});
    await service.submit(${JSON.stringify(actor)},${JSON.stringify(imageInput)});`);
  const vibeRequest={version:1,provider:'novel',protocol:'novelai',model:'nai-diffusion-4-5-full',baseUrl:'https://relay.invalid',apiKey:vibeKey,image,information:0};
  const prepared=await prepareNovelVibeEncoding(vibeRequest),vibeInput={version:1,expectedAccount:namespace,cacheKey:prepared.cacheKey,request:vibeRequest,confirmed:true,clientAttemptId:'original-browser'};
  await child(`import {createVibeEncodingService} from ${JSON.stringify(new URL('../qianmu-vibe-service.js',import.meta.url).href)};
    import {prepareNovelVibeEncoding} from ${JSON.stringify(new URL('../qianmu-vibe-encoding.js',import.meta.url).href)};
    const service=createVibeEncodingService({dataRoot:${JSON.stringify(e.root)},encode:async(request,hooks)=>{const prepared=await prepareNovelVibeEncoding(request);await hooks.authorize(prepared.identity,prepared.cacheKey);process.exit(0);}});
    await service.submit(${JSON.stringify(actor)},${JSON.stringify(vibeInput)});`);
  const plan=await inspect({dataRoot:e.root,scope:'all'});assert.equal(plan.submitting,4);
  const result=await recover({dataRoot:e.root,scope:'all',confirmation:plan.confirmation,serverStopped:true});assert.equal(result.automaticResubmissions,0);
  assert.deepEqual(result.scopes.map(row=>row.scope),['image','vibe','native']);assert.equal((await inspect({dataRoot:e.root,scope:'all'})).uncertain,4);
  const images=createImageService({dataRoot:e.root,generate:()=>assert.fail('must not generate')}),vibes=createVibeEncodingService({dataRoot:e.root,encode:()=>assert.fail('must not encode')});e.closing.push(images,vibes);
  const lookup={schemaVersion:1,expectedAccount:namespace,attemptId:imageInput.attemptId,taskLocator:{version:1,channelKey:keyOf(imageKey)}};
  const imagePlan=await images.review(actor,lookup);assert.equal(imagePlan.canReview,true);
  await images.confirmReview(actor,{...lookup,confirmation:imagePlan.confirmation,ended:true,possibleCharge:true});
  assert.equal((await e.stores.native.inspectChannel(keyOf(imageKey))).entries[0].status,'released');
  assert.equal((await e.stores.native.inspectChannel(keyOf(vibeKey))).entries[0].status,'uncertain');
  const vibeLookup={version:1,expectedAccount:namespace,cacheKey:prepared.cacheKey};
  const vibePlan=await vibes.review(actor,vibeLookup);assert.equal(vibePlan.canReview,true);
  await vibes.confirmReview(actor,{...vibeLookup,confirmation:vibePlan.confirmation,ended:true,possibleCharge:true});
  assert.equal((await e.stores.native.inspectChannel(keyOf(vibeKey))).entries[0].status,'released');
  assert.equal((await e.stores.image.inspectChannel(keyOf(imageKey))).entries[0].nativeReview.previousStatus,'uncertain');
  assert.equal((await vibes.query(actor,vibeLookup)).task.status,'reviewed');
});

test('partial all-scope repair reports completed ledgers, preserves the native fence, and restores only the interrupted scope',async t=>{
  const e=await fixture(t);for(const scope of Object.keys(names))await e.seed(scope);
  const plan=await inspect({dataRoot:e.root,scope:'all'}),recoveryUrl=new URL('../qianmu-image-service-recovery.js',import.meta.url).href;
  const output=JSON.parse(await child(`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
    const rename=fs.rename;fs.rename=async(from,to)=>{await rename(from,to);if(String(to).includes('novel-channel-v1')&&String(to).endsWith('.json'))throw Error('synthetic post-rename failure');};syncBuiltinESMExports();
    const {recoverImageServiceRecords}=await import(${JSON.stringify(recoveryUrl)});
    try{await recoverImageServiceRecords({dataRoot:${JSON.stringify(e.root)},scope:'all',confirmation:${JSON.stringify(plan.confirmation)},serverStopped:true});process.exitCode=2;}
    catch(error){process.stdout.write(JSON.stringify({code:error.code,scope:error.scope,completed:error.completedScopes,backupId:error.backupId,interrupted:error.recoveryInterrupted}));}`));
  assert.equal(output.code,'image_service_recovery_io');assert.equal(output.scope,'native');assert.equal(output.interrupted,true);assert.deepEqual(output.completed.map(row=>row.scope),['image','vibe']);
  await assert.rejects(e.stores.native.transaction(key,()=>assert.fail()),{code:'image_service_storage_maintenance'});
  const imageBytes=await fs.readFile(path.join(e.active('image'),`${key}.json`));
  await restore({dataRoot:e.root,scope:'native',backupId:output.backupId,serverStopped:true});
  assert.equal((await e.stores.native.inspectChannel(key)).entries[0].status,'submitting');assert.deepEqual(await fs.readFile(path.join(e.active('image'),`${key}.json`)),imageBytes);
  const next=await inspect({dataRoot:e.root,scope:'all'});await recover({dataRoot:e.root,scope:'all',confirmation:next.confirmation,serverStopped:true});
  assert.equal((await e.stores.native.inspectChannel(key)).entries[0].status,'uncertain');
  await assert.rejects(restore({dataRoot:e.root,scope:'image',backupId:output.backupId,serverStopped:true}));
});

test('actual offline CLI exposes explicit all-scope inspection but no HTTP recovery assertion',async t=>{
  const e=await fixture(t);await e.seed('vibe');await e.seed('native');
  const output=await child(`process.argv=['node','recover','--data-root',${JSON.stringify(e.root)},'--scope','all','--inspect'];await import(${JSON.stringify(new URL('../qianmu-image-recovery-cli.js',import.meta.url).href)});`);
  const plan=JSON.parse(output);assert.equal(plan.scope,'all');assert.equal(plan.submitting,2);
  assert.doesNotMatch(await fs.readFile(new URL('../server-plugin.js',import.meta.url),'utf8'),/recoverImageServiceRecords|restoreInterruptedImageRecovery|serverStopped/);
});
