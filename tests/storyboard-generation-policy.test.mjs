import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as board from '../qianmu-storyboard.js';
import {buildStoryboardPlanContractRequest} from '../qianmu-storyboard-contract.js';
import {createStoryboardFormFixture,storyboardFunctionSource as fn} from './helpers/storyboard-form-fixture.mjs';
import * as packageAssets from '../qianmu-storyboard-package-assets.js';
import {createPackageImportFixture} from './helpers/storyboard-package-fixture.mjs';
const plain=x=>JSON.parse(JSON.stringify(x));
test('new installations get 1-3/2 and discarded shot-group fields never define the generation budget',()=>{
  assert.deepEqual(board.createStoryboardDefaults().generationPolicy,{version:1,minImages:1,maxImages:3,concurrency:2});
  for(const enabled of [false,true]){
    const state=board.normalizeStoryboardState({schemaVersion:24,routing:{enabled,maxShotsPerFloor:4,providerConcurrency:3}});
    assert.deepEqual(state.generationPolicy,{version:1,minImages:1,maxImages:3,concurrency:2});
    assert.equal(state.routing.maxShotsPerFloor,undefined);assert.equal(state.routing.providerConcurrency,undefined);
    const before=structuredClone(state.generationPolicy);board.normalizeStoryboardState(state);assert.deepEqual(state.generationPolicy,before);
  }
  const fixedLegacy=board.normalizeStoryboardState({schemaVersion:24,routing:{enabled:true,maxShotsPerFloor:4},compositionPolicy:{groupStrategy:'single'}});
  assert.deepEqual(fixedLegacy.generationPolicy,{version:1,minImages:1,maxImages:3,concurrency:2},'neither discarded routing fields nor composition strategy owns image count');
});
test('policy is canonical even if obsolete routing budget reappears and min never exceeds max',()=>{
  const state=board.normalizeStoryboardState({schemaVersion:24,generationPolicy:{minImages:4,maxImages:2,concurrency:99},routing:{enabled:true,maxShotsPerFloor:4,providerConcurrency:1}});
  assert.deepEqual(state.generationPolicy,{version:1,minImages:2,maxImages:2,concurrency:4});
  for(const value of [-100,0,NaN,Infinity,'no',undefined,null,4.8]){
    const p=board.normalizeStoryboardGenerationPolicy({minImages:value,maxImages:value,concurrency:value});
    assert.ok(p.minImages>=1&&p.minImages<=p.maxImages&&p.maxImages<=4&&p.concurrency>=1&&p.concurrency<=4);
  }
});
test('actual workbench owns one budget card and one collapsed manual variant control',()=>{
  const {content}=createStoryboardFormFixture();
  assert.equal((content.match(/data-storyboard-card="generation"/g)||[]).length,1);
  assert.equal((content.match(/data-generation-field=/g)||[]).length,3);
  assert.equal((content.match(/data-storyboard-field="count"/g)||[]).length,1);
  assert.ok(content.indexOf('data-storyboard-card="generation"')<content.indexOf('sd-storyboard-engine-modes'), 'global budget lives before engine selection, not inside either engine');
  assert.ok(content.indexOf('data-storyboard-card="generation"')<content.indexOf('data-storyboard-card="composition"'));
  assert.match(content,/<details class="sd-storyboard-variants">/);
  assert.doesNotMatch(fn('renderStoryboardRouting'),/sd-storyboard-route-(?:max|concurrency)/);
});
test('shared-frame composition does not silently cap the number of grounded, distinct scenes to one',()=>{
  const shots=['garden','river','forest'].map((scene,i)=>({id:scene,subject:scene,scene,location:scene,narrativePurpose:`establish ${scene}`,sourceParagraphIds:[`p${i}`]}));
  const result=board.prepareStoryboardShotGroup({shots,policy:{groupStrategy:'single'},maxShots:2});
  assert.equal(result.shots.length,2);assert.equal(result.skipped[0].reason,'coverage_budget');
  const duplicate=board.prepareStoryboardShotGroup({shots:[shots[0],shots[0]],maxShots:4});
  assert.equal(duplicate.shots.length,1);assert.equal(duplicate.skipped[0].reason,'duplicate_coverage');
});
test('compiler constraints use same budget without requiring a shot group; minimum is a target, supplement stays one',async()=>{
  const {captureStoryboardCompilerSources}=await import('../qianmu-storyboard-contract.js');
  const host={chatId:'policy',characterId:0,characters:[{avatar:'A.png',chat:'policy'}],chatMetadata:{story_director_liminale:{}},chat:[{mes:'garden'}]};
  const compilerSources=await captureStoryboardCompilerSources({floor:0,referenceFloors:0,getContext:()=>host,epoch:()=>0,isCurrent:()=>true,
    resolveNamespace:async()=> 'st-user:policy',readText:message=>message.mes,readParagraphs:message=>[{id:'P1',text:message.mes}]});
  const state=board.createStoryboardDefaults();state.generationPolicy={minImages:2,maxImages:4,concurrency:2};
  const context=vm.createContext({...board});vm.runInContext(fn('storyboardCompilerRequestConfig'),context);
  for(const enabled of [false,true]){
    state.routing.enabled=enabled;
    const config=context.storyboardCompilerRequestConfig(state,{model:'nai-diffusion-5-full'});
    assert.equal(config.minShots,2);assert.equal(config.maxShots,4);
    assert.equal(Object.hasOwn(config,'groupInstruction'),false,'retired templates never enter extraction');
    for(const manualSupplement of [false,true]){
      assert.equal(config.focused,true);
      const request=buildStoryboardPlanContractRequest({floor:0,paragraphs:['garden'],compilerSources},{...config,manualSupplement});
      const constraints=JSON.parse(request.messages[1].content).constraints;
      assert.equal(constraints.max_shots,manualSupplement?1:4);assert.equal(constraints.min_shots_target,manualSupplement?1:2);
    }
  }
  compilerSources.close();
});
test('real policy handlers keep min/max coherent and reject detached old-page edits',async()=>{
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
  const start=source.indexOf("  root.querySelectorAll('[data-generation-field]')");
  const end=source.indexOf("  root.querySelector('.sd-storyboard-use-floor')",start);
  assert.ok(start>0&&end>start);
  const state=board.createStoryboardDefaults(),callbacks={};
  const fields=['minImages','maxImages','concurrency'].map(key=>({dataset:{generationField:key},value:'',addEventListener:(_name,cb)=>callbacks[key]=cb}));
  const root={isConnected:true,querySelectorAll:()=>fields};let saves=0,pumps=0;
  const context=vm.createContext({...board,state,root,storyboardState:()=>state,saveSettings:()=>saves++,renderModal:()=>{},storyboardQueue:[{}],storyboardPumpQueue:()=>pumps++});
  vm.runInContext(source.slice(start,end),context);
  fields[0].value='4';callbacks.minImages();assert.deepEqual(plain(state.generationPolicy),{version:1,minImages:4,maxImages:4,concurrency:2});
  fields[1].value='2';callbacks.maxImages();assert.equal(state.generationPolicy.minImages,2);
  fields[2].value='3';callbacks.concurrency();assert.equal(pumps,1);
  root.isConnected=false;fields[1].value='4';callbacks.maxImages();assert.equal(saves,3);assert.equal(state.generationPolicy.maxImages,2);
});
test('actual queue reads only the unified concurrency and keeps NAI globally serial within this page',()=>{
  const state=board.createStoryboardDefaults();state.generationPolicy.concurrency=3;state.routing.providerConcurrency=1;
  const queue=[{id:'n1',source:'novel'},{id:'n2',source:'novel'},{id:'a',source:'openai'},{id:'b',source:'banana'}],active=new Map(),started=[];
  const context=vm.createContext({...board,storyboardState:()=>state,storyboardQueue:queue,storyboardActiveJobs:active,storyboardBusy:false,renderModal:()=>{},storyboardRunQueuedJob:job=>started.push(job.id)});
  vm.runInContext(fn('storyboardPumpQueue'),context);context.storyboardPumpQueue();
  assert.deepEqual(started,['n1','a','b']);assert.equal(queue[0].id,'n2');
  state.generationPolicy.concurrency=1;active.delete('n1');context.storyboardPumpQueue();assert.equal(started.length,3);
  active.clear();context.storyboardPumpQueue();assert.equal(started.at(-1),'n2');
});

test('mixed storyboard queue waits for the same Comfy origin without blocking NAI, another instance or a closed-model shot',()=>{
  const state=board.createStoryboardDefaults();state.generationPolicy.concurrency=4;
  const comfy=(id,baseUrl,credentialId)=>({id,source:'comfy',connection:{baseUrl,credentialId},planShotId:id,profile:{workflow:'unchanged'},comfySceneOrigin:{candidateId:'fixed'}});
  const queue=[comfy('c1','https://cloud.comfy.org','key-a'),comfy('c2','https://CLOUD.comfy.org:443/api/v2/','alias-key'),
    {id:'n1',source:'novel'},{id:'n2',source:'novel'},comfy('l1','http://127.0.0.1:8188','local'),
    comfy('l2','http://127.0.0.1:8188/api','local-alias'),{id:'b',source:'banana'}];
  const originals=new Map(queue.map(job=>[job.id,JSON.stringify(job)])),active=new Map(),started=[];
  const context=vm.createContext({...board,storyboardState:()=>state,storyboardQueue:queue,storyboardActiveJobs:active,storyboardBusy:false,renderModal:()=>{},
    storyboardRunQueuedJob:job=>{assert.equal(JSON.stringify(job),originals.get(job.id),'scheduling does not rewrite shot order, route or scene lock');started.push(job.id);}});
  vm.runInContext(fn('storyboardPumpQueue'),context);context.storyboardPumpQueue();
  assert.deepEqual(started,['c1','n1','l1','b']);assert.deepEqual(queue.map(job=>job.id),['c2','n2','l2']);
  active.delete('l1');context.storyboardPumpQueue();assert.equal(started.at(-1),'l2');
  active.delete('c1');context.storyboardPumpQueue();assert.equal(started.at(-1),'c2');
  active.delete('n1');context.storyboardPumpQueue();assert.equal(started.at(-1),'n2');assert.equal(queue.length,0);
});

test('Comfy origin ordering is credential-independent and cannot be bypassed by an unknown URL; it is not a network grant',()=>{
  const job=url=>({source:'comfy',connection:{baseUrl:url}});
  assert.equal(board.canRunStoryboardComfyJob(job('https://www.runninghub.cn/openapi/v2'),[job('https://www.runninghub.cn/task/openapi/')]),false);
  assert.equal(board.canRunStoryboardComfyJob(job('http://127.0.0.1:8189'),[job('http://127.0.0.1:8188')]),true);
  assert.equal(board.canRunStoryboardComfyJob(job('https://one.run.comfy.app'),[job('https://two.run.comfy.app')]),true);
  for(const invalid of ['',undefined,'not a URL','file:///tmp','https://secret@cloud.comfy.org']){
    assert.equal(board.canRunStoryboardComfyJob(job(invalid),[job('https://cloud.comfy.org')]),false);
    assert.equal(board.canRunStoryboardComfyJob(job('https://cloud.comfy.org'),[job(invalid)]),false);
    assert.equal(board.canRunStoryboardComfyJob(job(invalid),[]),true,'normal submission validation must report malformed connections, not stall the page forever');
  }
  assert.equal(board.canRunStoryboardComfyJob({source:'novel'},[job('https://cloud.comfy.org')]),true);
});

for(const policy of [{version:1,minImages:2,maxImages:4,concurrency:3},{version:2,minImages:3,maxImages:6,concurrency:2}])test(`actual portable export/import preserves explicit policy v${policy.version} and absent policy never transfers old routing counts`,async()=>{
  const state=board.createStoryboardDefaults(),store={};state.generationPolicy={...policy};
  let exported=null;const noop=()=>{};
  const context=vm.createContext({...board,Blob,clone:structuredClone,storyboardState:()=>state,STORYBOARD_SOURCES:board.STORYBOARD_PROVIDER_REGISTRY,
    storyboardAdmissionEpoch:1,featureRuntime:{load:async name=>name==='storyboardPackageAssets'?packageAssets:{resolveImageAccountNamespace:async()=> 'st-user:fixture'}},
    isPlainObject:v=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)),confirmDialog:async()=>true,getChatKey:()=> 'chat-a',getChatStore:()=>store,
    storyboardHydratePipelineArchive:noop,storyboardPlansForPortableExport:async x=>x,
    storyboardGalleryRecords:()=>[],storyboardGalleryCollections:()=>[],storyboardUtilsModule:async()=>({}),
    saveSettings:noop,saveMetadata:noop,storyboardSchedulePlanArchive:noop,storyboardArchiveGallerySnapshots:noop,
    storyboardScheduleInlineRender:noop,renderModal:noop,toast:noop,fileStamp:()=> 'test',
    URL:{createObjectURL:blob=>{exported=blob;return 'blob:test';},revokeObjectURL:noop},
    document:{createElement:()=>({click:noop,remove:noop}),body:{appendChild:noop}},
  });
  Object.assign(context,{MODAL_ID:'fixture',createStorageBackupCheck:()=>{const check=()=>{};check.release=()=>{};return check;}});context.document.getElementById=()=>({});
  context.setTimeout=noop;
  vm.runInContext(fn('ttsDownloadBlob')+'\n'+fn('storyboardPackageContext')+'\n'+fn('storyboardExportPackage'),context);
  await context.storyboardExportPackage({originals:false});const text=await exported.text();
  assert.deepEqual(JSON.parse(text).settings.generationPolicy,policy);
  const importer=createPackageImportFixture();importer.e.state.generationPolicy={version:1,minImages:1,maxImages:1,concurrency:1};
  await importer.import(new Blob([text]));
  assert.deepEqual(plain(importer.e.state.generationPolicy),policy);
  importer.e.choice='3';await importer.recover();
  const modern=JSON.parse(text);delete modern.settings.generationPolicy;modern.settings.routing={rules:[]};
  await importer.import(new Blob([JSON.stringify(modern)]));
  assert.ok(importer.e.pending,JSON.stringify(importer.e.notices));
  assert.deepEqual(plain(importer.e.state.generationPolicy),policy);await importer.recover();
  for(const enabled of [false,true]){
    const legacy=JSON.parse(text);legacy.settings.schemaVersion=2;delete legacy.settings.generationPolicy;legacy.settings.routing={enabled,maxShotsPerFloor:2,providerConcurrency:1};
    await importer.import(new Blob([JSON.stringify(legacy)]));
    assert.ok(importer.e.pending,JSON.stringify(importer.e.notices));
    assert.deepEqual(plain(importer.e.state.generationPolicy),policy,'without an explicit imported policy the existing local budget remains unchanged');
    await importer.recover();
  }
});

test('explicit v2 range permits six shots without upgrading any old spending limit or concurrency',()=>{
  for(const version of [undefined,1,3])for(const maxImages of [5,6,99]){
    const policy=board.normalizeStoryboardGenerationPolicy({version,minImages:6,maxImages,concurrency:9});
    assert.deepEqual(policy,{version:1,minImages:4,maxImages:4,concurrency:4});
  }
  const policy={version:2,minImages:3,maxImages:6,concurrency:2};
  assert.deepEqual(board.normalizeStoryboardGenerationPolicy(policy),policy);
  assert.deepEqual(board.normalizeStoryboardState({generationPolicy:policy}).generationPolicy,policy);
  assert.deepEqual(board.normalizeStoryboardGenerationPolicy({version:2,minImages:99,maxImages:99,concurrency:99}),{version:2,minImages:6,maxImages:6,concurrency:4});
  assert.deepEqual(board.normalizeStoryboardGenerationPolicy(null),{version:1,minImages:1,maxImages:3,concurrency:2});
  assert.deepEqual(board.normalizeStoryboardGenerationPolicy({enabled:true,maxShotsPerFloor:6,providerConcurrency:4}),{version:1,minImages:1,maxImages:3,concurrency:2},'discarded route fields cannot authorize extra paid work');
});

test('actual form and handler distinguish six floor shots from four-way concurrency',async()=>{
  const {content}=createStoryboardFormFixture();
  for(const key of ['minImages','maxImages'])assert.match(content,new RegExp(`data-generation-field="${key}"[^>]*max="6"`));
  assert.match(content,/data-generation-field="concurrency"[^>]*max="4"/);
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8'),start=source.indexOf("  root.querySelectorAll('[data-generation-field]')"),end=source.indexOf("  root.querySelector('.sd-storyboard-use-floor')",start);
  const state=board.createStoryboardDefaults(),callbacks={};let saves=0;
  const fields=['minImages','maxImages','concurrency'].map(key=>({dataset:{generationField:key},value:'',addEventListener:(_event,callback)=>callbacks[key]=callback}));
  const root={isConnected:true,querySelectorAll:()=>fields};
  const context=vm.createContext({...board,state,root,storyboardState:()=>state,saveSettings:()=>saves++,renderModal(){},storyboardQueue:[]});
  vm.runInContext(source.slice(start,end),context);
  fields[1].value='6';callbacks.maxImages();assert.deepEqual(plain(state.generationPolicy),{version:2,minImages:1,maxImages:6,concurrency:2});
  fields[0].value='6';callbacks.minImages();assert.equal(state.generationPolicy.minImages,6);
  fields[2].value='6';callbacks.concurrency();assert.equal(state.generationPolicy.concurrency,4);
  fields[1].value='3';callbacks.maxImages();assert.equal(state.generationPolicy.minImages,3);assert.equal(state.generationPolicy.maxImages,3);
  assert.equal(saves,4);
});
