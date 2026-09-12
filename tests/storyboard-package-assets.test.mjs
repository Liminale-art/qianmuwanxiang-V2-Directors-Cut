import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as pack from '../qianmu-storyboard-package-assets.js';
import * as board from '../qianmu-storyboard.js';
import {parseNovelVibeFile,vibeDigest} from '../qianmu-vibe-file.js';
import {exportStoryboardPackageAssets,closeStoryboardPackageRuntime} from '../qianmu-storyboard-package-runtime.js';
import {storyboardFunctionSource as fn} from './helpers/storyboard-form-fixture.mjs';
import {createPackageImportFixture} from './helpers/storyboard-package-fixture.mjs';
const namespace='st-user:pack',otherAccount='st-user:target';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const reference=id=>({version:1,namespace,id}),item=(id,ref)=>({id,name:id,previewUrl:ref?'':'https://legacy.example/image.png',strength:0,information:0,...(ref?{assetRef:ref}:{})});
const recipe=items=>({version:items.some(i=>i.assetRef)?2:1,items});
const payload=()=>({type:'qianmu-storyboard',version:6,credentialsIncluded:false,settings:{vibeLibrary:[],logs:[],pipelineLogs:[],shotPlans:[],taskStates:[]},chat:{images:[],collections:[]},media:[]});
async function asset(name){const encoding=btoa('encoded-'+name),doc={identifier:'novelai-vibe-transfer',version:1,type:'image',id:await vibeDigest(png),image:png,name,thumbnail:`data:image/png;base64,${png}`,createdAt:1,
  encodings:{futuremodel:{custom:{encoding,params:{information_extracted:0,focus_seed:0}}},v4full:{first:{encoding,params:{information_extracted:1}}}},importInfo:{strength:0,information_extracted:0}};return (await parseNovelVibeFile(JSON.stringify(doc)))[0];}

test('dependency census includes library, profile/history/plan/task/gallery recipes while leaving other resource refs alone',()=>{
  const data=payload(),a=reference('a'.repeat(64)),b=reference('b'.repeat(64));data.settings.vibeLibrary=[item('active',a),item('unselected',b),item('legacy')];
  for(const path of ['logs','pipelineLogs','shotPlans','taskStates'])data.settings[path].push({snapshot:{payload:{selectedVibeIds:['original'],vibeRecipe:recipe([item('original',b)])}}});
  data.chat.images.push({snapshot:{payload:{vibeRecipe:recipe([item('history',a)])}},assetRef:{version:1,namespace:'foreign',id:'comfy-image'}});
  data.settings.modelProfiles={novel:{old:{vibeRecipe:recipe([item('profile',b)])}}};
  const census=pack.collectStoryboardVibeDependencies(data,{namespace});assert.equal(census.refs.length,2);assert.equal(census.refs[0].uses.length,2);assert.equal(census.refs[1].uses.length,6);
  assert.equal(census.legacyUrls.length,1);assert.ok(census.refs[1].uses.some(path=>path.includes('taskStates')));assert.ok(census.refs[1].uses.some(path=>path.includes('modelProfiles')));
});

test('malformed/cross-account references and mismatched selection fail before accepting a partial manifest',()=>{
  for(const bad of [{version:1,invalid:true},{version:1,namespace:otherAccount,id:'a'.repeat(64)},{version:1,namespace,id:'bad'}]){
    const data=payload();data.settings.vibeLibrary=[item('bad',bad)];assert.throws(()=>pack.collectStoryboardVibeDependencies(data,{namespace}));
  }
  const data=payload();data.chat.images=[{vibeRecipe:{version:1,invalid:true}}];assert.throws(()=>pack.collectStoryboardVibeDependencies(data),/不完整/);
  data.chat.images=[{selectedVibeIds:['other'],vibeRecipe:recipe([item('legacy')])}];assert.throws(()=>pack.collectStoryboardVibeDependencies(data),/不符/);
});

test('a DAG preserves each location, but cycles, unsafe keys and excessive depth stop instead of truncating refs',()=>{
  const data=payload(),shared={vibeRecipe:recipe([item('same',reference('a'.repeat(64)))])};data.settings.logs=[shared,shared];assert.equal(pack.collectStoryboardVibeDependencies(data).refs[0].uses.length,2);
  shared.loop=shared;assert.throws(()=>pack.collectStoryboardVibeDependencies(data),/循环/);delete shared.loop;
  data.settings.logs=[JSON.parse('{"constructor":{}}')];assert.throws(()=>pack.collectStoryboardVibeDependencies(data),/不安全/);
  let deep={vibeRecipe:recipe([item('legacy')])};for(let i=0;i<42;i++)deep={nested:deep};data.settings.logs=[deep];assert.throws(()=>pack.collectStoryboardVibeDependencies(data),/层级/);
});

test('package builder supports more than 16 referenced originals, loading each exactly once and preserving every encoding',async()=>{
  const data=payload(),assets=[];for(let i=0;i<20;i++)assets.push(await asset(`original-${i}`));
  data.settings.vibeLibrary=assets.map(a=>item(a.document.name,reference(a.assetId)));data.chat.images=[{snapshot:{vibeRecipe:recipe([item('old',reference(assets[0].assetId))])}}];
  const calls=[];let inFlight=0,peak=0;const result=await pack.buildStoryboardVibePackage(data,{namespace,load:async(ns,id)=>{assert.equal(ns,namespace);inFlight++;peak=Math.max(peak,inFlight);await Promise.resolve();inFlight--;calls.push(id);return assets.find(a=>a.assetId===id);}});
  assert.equal(calls.length,20);assert.equal(new Set(calls).size,20);assert.equal(peak,1);assert.equal(result.manifest.vibeUses,21);assert.equal(result.manifest.vibeFiles,20);
  const document=JSON.parse(await result.file.text());assert.equal(document.version,7);assert.equal(document.vibeAssets.length,20);assert.equal(document.vibeAccount,namespace);
  const inspected=await pack.inspectStoryboardVibePackage(document);assert.deepEqual(inspected.assets.map(a=>a.assetId),assets.map(a=>a.assetId));
  assert.deepEqual(inspected.assets.map(a=>a.document.encodings),assets.map(a=>a.document.encodings));assert.equal(inspected.assets[0].document.importInfo.strength,0);
  assert.equal(data.version,6);assert.equal(data.vibeAssets,undefined,'source metadata untouched');
});

test('missing or tampered original stops building rather than returning a references-only success',async()=>{
  const good=await asset('first'),data=payload();data.settings.vibeLibrary=[item('first',reference(good.assetId)),item('missing',reference('b'.repeat(64)))];
  await assert.rejects(()=>pack.buildStoryboardVibePackage(data,{namespace,load:async(ns,id)=>id===good.assetId?good:null}),/缺少/);
  data.settings.vibeLibrary=[item('first',reference(good.assetId))];await assert.rejects(()=>pack.buildStoryboardVibePackage(data,{namespace,load:async()=>({...good,serialized:good.serialized.replace('first','other')})}),/不符/);
});

test('legacy URL entries remain explicit dependencies, not fabricated cached originals or hidden network reads',async()=>{
  const data=payload();data.settings.vibeLibrary=[item('legacy')];data.settings.logs=[{vibeRecipe:recipe([item('same-url')])}];
  const result=await pack.buildStoryboardVibePackage(data,{namespace,load:()=>assert.fail('no local asset dependency')});assert.equal(result.manifest.legacyVibeUrls,1);assert.equal(result.manifest.vibeFiles,0);
  const inspect=await pack.inspectStoryboardVibePackage(JSON.parse(await result.file.text()));assert.equal(inspect.census.legacyUrls[0].uses.length,2);
});

test('inspection rejects missing, extra, duplicate, foreign and byte-inconsistent assets before any restore',async()=>{
  const a=await asset('first'),data=payload();data.settings.vibeLibrary=[item('first',reference(a.assetId))];const file=await pack.buildStoryboardVibePackage(data,{namespace,load:async()=>a}),document=JSON.parse(await file.file.text());
  for(const mutate of [d=>d.vibeAssets=[],d=>d.vibeAssets.push(d.vibeAssets[0]),d=>d.vibeAssets[0].namespace=otherAccount,d=>d.vibeAssets[0].id='b'.repeat(64),
    d=>d.vibeAssets[0].bytes++,d=>d.vibeAssets[0].document.name='changed',d=>d.vibeAssets[0].extra='unknown',d=>d.version=6,d=>d.settings.vibeLibrary=[],
    d=>d.vibeAssets[0].document={identifier:'novelai-vibe-transfer-bundle',version:1,vibes:[d.vibeAssets[0].document]},
    d=>d.vibeAssets[0].document={identifier:'novelai-vibe-transfer-bundle',version:1,vibes:[d.vibeAssets[0].document,d.vibeAssets[0].document]}]){
    const altered=structuredClone(document);mutate(altered);await assert.rejects(()=>pack.inspectStoryboardVibePackage(altered));
  }
});

test('namespace remap changes only typed references in a detached staging copy, not assets, jobs or originals',async()=>{
  const a=await asset('first'),data=payload();data.settings.vibeLibrary=[item('first',reference(a.assetId))];
  const shared={payload:{selectedVibeIds:['frozen'],vibeRecipe:recipe([item('frozen',reference(a.assetId))])}},comfy={version:1,namespace,id:'workflow'};
  data.settings.logs=[shared,shared];data.settings.comfy=structuredClone(comfy);data.settings.taskStates=[{status:'generating',delivery:{namespace}}];
  const result=await pack.buildStoryboardVibePackage(data,{namespace,load:async()=>a}),parsed=JSON.parse(await result.file.text()),original=JSON.stringify(parsed),mapped=pack.remapStoryboardVibeReferences(parsed,otherAccount);
  assert.equal(mapped.settings.vibeLibrary[0].assetRef.namespace,otherAccount);assert.equal(mapped.settings.logs[1].payload.vibeRecipe.items[0].assetRef.namespace,otherAccount);
  assert.equal(mapped.settings.vibeLibrary[0].assetRef.id,a.assetId);assert.equal(mapped.vibeAssets,parsed.vibeAssets);assert.equal(mapped.media,parsed.media);
  assert.deepEqual(mapped.settings.comfy,comfy);assert.equal(mapped.settings.taskStates[0].delivery.namespace,namespace);assert.equal(JSON.stringify(parsed),original);
  assert.throws(()=>pack.remapStoryboardVibeReferences(parsed,'bad'));
});

test('count and metadata limits stop oversized packets without silently clipping library/media lists',async()=>{
  const data=payload();data.media=Array(401).fill({id:'one'});await assert.rejects(()=>pack.buildStoryboardVibePackage(data,{namespace,load:()=>assert.fail('too large')}),/400/);
  data.media=[];data.settings.large='x'.repeat(pack.STORYBOARD_PACKAGE_LIMITS.metadata);await assert.rejects(()=>pack.buildStoryboardVibePackage(data,{namespace,load:()=>assert.fail('too large')}),/32 MiB/);
  delete data.settings.large;data.media=[undefined];await assert.rejects(()=>pack.buildStoryboardVibePackage(data,{namespace,load:()=>assert.fail('invalid')}),/无效/);
});

test('packet worker uses a separate asset connection and has no fee store or service dependencies',async()=>{
  const worker=await readFile(new URL('../qianmu-storyboard-package-worker.js',import.meta.url),'utf8'),shared=await readFile(new URL('../qianmu-vibe-assets-worker.js',import.meta.url),'utf8');
  assert.match(worker,/createVibeAssetStore/);assert.match(worker,/store\.close\(\);self\.close\(\)/);assert.doesNotMatch(worker,/encoding-store|fetch\(|putFile|remove\(/);assert.doesNotMatch(shared,/package-vibes-export/);
});

test('dedicated runtime guards both ends, frees its worker and never accepts an incomplete reply',async()=>{
  const workers=[];let guards=0;
  class WorkerFixture extends EventTarget {constructor(url,options){super();assert.match(String(url),/package-worker\.js$/);assert.equal(options.type,'module');workers.push(this);}postMessage(value){this.sent=value;}terminate(){this.closed=true;}reply(data){this.dispatchEvent(Object.assign(new Event('message'),{data}));}}
  const pending=exportStoryboardPackageAssets(payload(),{namespace,guard:async()=>guards++,WorkerClass:WorkerFixture});await Promise.resolve();await Promise.resolve();
  assert.equal(workers.length,1);assert.equal(workers[0].sent.namespace,namespace);const file=new Blob(['fixture']);workers[0].reply({value:{file}});assert.equal((await pending).file,file);assert.equal(guards,2);assert.equal(workers[0].closed,true);
  const bad=exportStoryboardPackageAssets(payload(),{namespace,guard:async()=>{},WorkerClass:WorkerFixture});await Promise.resolve();await Promise.resolve();workers[1].reply({value:{file:'invalid'}});await assert.rejects(()=>bad,/不完整/);assert.equal(workers[1].closed,true);
});

test('large package cancellation/timeouts stay separate from the Vibe runtime, and late account results are discarded',async()=>{
  const workers=[];class WorkerFixture extends EventTarget {constructor(){super();workers.push(this);}postMessage(){}terminate(){this.closed=true;}reply(data){this.dispatchEvent(Object.assign(new Event('message'),{data}));}}
  const options={namespace,guard:async()=>{},WorkerClass:WorkerFixture};
  const pending=exportStoryboardPackageAssets(payload(),options);await Promise.resolve();await Promise.resolve();await assert.rejects(()=>exportStoryboardPackageAssets(payload(),options),/正在处理/);closeStoryboardPackageRuntime();await assert.rejects(()=>pending,/取消/);assert.equal(workers[0].closed,true);
  const controller=new AbortController(),aborted=exportStoryboardPackageAssets(payload(),{...options,signal:controller.signal});await Promise.resolve();await Promise.resolve();controller.abort();await assert.rejects(()=>aborted,/取消/);
  await assert.rejects(()=>exportStoryboardPackageAssets(payload(),{...options,timeoutMs:100}),/超时/);
  let live=true;const late=exportStoryboardPackageAssets(payload(),{...options,guard:async()=>{if(!live)throw Error('account changed');}});await Promise.resolve();await Promise.resolve();live=false;workers.at(-1).reply({value:{file:new Blob(['late'])}});await assert.rejects(()=>late,/account changed/);assert.equal(workers.at(-1).closed,true);
});

test('package guard detects account/chat/store/epoch changes before and after asynchronous identity resolution',async()=>{
  for(const change of [scope=>scope.chatKey='other',scope=>scope.store={},scope=>scope.state={},scope=>scope.epoch++]){
    let current={state:{},store:{},chatKey:'chat',epoch:1},accountNow=namespace;const initial={...current},session=await pack.createStoryboardPackageGuard({initial,context:()=>current,resolveNamespace:async()=>accountNow});
    await session.guard();change(current);await assert.rejects(()=>session.guard(),/已变化/);
  }
  const initial={state:{},store:{},chatKey:'chat',epoch:1};let accountNow=namespace;
  const session=await pack.createStoryboardPackageGuard({initial,context:()=>initial,resolveNamespace:async()=>accountNow});accountNow=otherAccount;await assert.rejects(()=>session.guard(),/已变化/);
  let current={...initial};const delayed=await pack.createStoryboardPackageGuard({initial,context:()=>current,resolveNamespace:async()=>namespace});
  current={...initial};let onResolve=false;const late=await pack.createStoryboardPackageGuard({initial,context:()=>current,resolveNamespace:async()=>{if(onResolve)current={...current,store:{}};return namespace;}});onResolve=true;await assert.rejects(()=>late.guard(),/已变化/);
  await assert.rejects(()=>pack.createStoryboardPackageGuard({initial,context:()=>({...initial,epoch:2}),resolveNamespace:async()=>namespace}),/已变化/);
});

function indexFixture(){
  const state=board.createStoryboardDefaults(),store={},notices=[];let currentState=state,currentStore=store,chat='chat-a',owner=namespace,exported=null,images=[];
  const noop=()=>{},context=vm.createContext({...board,Blob,clone:structuredClone,storyboardAdmissionEpoch:1,featureRuntime:{load:async name=>name==='storyboardPackageAssets'?pack:{resolveImageAccountNamespace:async()=>owner}},
    storyboardState:()=>currentState,getChatStore:()=>currentStore,getChatKey:()=>chat,storyboardHydratePipelineArchive:async()=>{},storyboardHydrateGallerySnapshots:async()=>{},
    storyboardPipelineForLog:log=>state.pipelineLogs.find(p=>p.id===log.pipelineId)||null,storyboardGalleryRecords:()=>images,storyboardGalleryCollections:()=>[{id:'c',name:'Captured collection'}],
    storyboardSnapshotForRecord:record=>record.snapshot||null,storyboardPlansForPortableExport:async p=>p,storyboardSafeUrl:value=>value,fetch:async()=>({ok:true,blob:async()=>new Blob(['image'],{type:'image/png'})}),blobToBase64:async()=> 'aW1hZ2U=',
    confirmDialog:async()=>true,toast:(...args)=>notices.push(args),fileStamp:()=> 'fixture',URL:{createObjectURL:blob=>{exported=blob;return 'blob:test';},revokeObjectURL:noop},document:{createElement:()=>({click:noop,remove:noop}),body:{appendChild:noop}},
  });Object.assign(context,{MODAL_ID:'fixture',createStorageBackupCheck:()=>{const check=()=>{};check.release=()=>{};return check;}});context.document.getElementById=()=>({});
  vm.runInContext(fn('storyboardPackageContext')+'\n'+fn('storyboardExportPackage'),context);
  return {state,store,notices,context,exported:()=>exported,setImages:value=>images=value,switch:()=>{chat='chat-b';currentState=board.createStoryboardDefaults();currentStore={};owner=otherAccount;}};
}

test('actual legacy export rejects structured URL credentials without clearing the local connection',async()=>{
  const e=indexFixture();e.state.connections.novel.draft.baseUrl='https://image.example/api?api_key=private-fixture-value';const before=structuredClone(e.state);
  await e.context.storyboardExportPackage({originals:false});assert.equal(e.exported(),null);assert.deepEqual(e.state,before);assert.equal(e.context.storyboardExportPackage.busy,false);
  assert.match(e.notices.at(-1)[0],/授权查询参数/);assert.doesNotMatch(e.notices.at(-1)[0],/private-fixture-value/);
});

test('actual export checks original workbench and gallery graphs before normalizers could remove credentials or duplicate keys',async()=>{
  for(const location of ['profile','gallery'])for(const graph of ['{"node":{"inputs":{"api_key":"private-fixture-value"}}}','{"a":1,"a":2}']){
    const e=indexFixture();e.state.connections.novel.draft.credentialId='legitimate-local-reference';
    if(location==='profile')e.state.profiles.comfy.comfyWorkflow=graph;
    else e.setImages([{id:'one',source:'comfy',url:'/one.png',snapshot:{source:'comfy',profile:{comfyWorkflow:graph}}}]);
    const before=structuredClone(e.state);await e.context.storyboardExportPackage({originals:false});assert.equal(e.exported(),null);assert.deepEqual(e.state,before);assert.equal(e.context.storyboardExportPackage.busy,false);
    assert.match(e.notices.at(-1)[0],/凭据|重复字段/);assert.doesNotMatch(e.notices.at(-1)[0],/private-fixture-value/);
  }
});

test('Vibe originals with structured credentials are rejected unchanged while public unknown encodings stay supported',async()=>{
  const doc=(await asset('original')).document;doc.encodings.futuremodel.custom.params.apiToken='private-fixture-value';const [a]=await parseNovelVibeFile(JSON.stringify(doc));
  const data=payload();data.settings.vibeLibrary=[item('original',reference(a.assetId))];const before=a.serialized;
  await assert.rejects(()=>pack.buildStoryboardVibePackage(data,{namespace,load:async()=>a}),/凭据/);
  const incoming={...data,version:7,vibeAccount:namespace,vibeAssets:[{namespace,id:a.assetId,bytes:a.bytes,document:a.document}]};
  await assert.rejects(()=>pack.inspectStoryboardVibePackage(incoming),/凭据/);assert.equal(a.serialized,before);assert.equal(JSON.stringify(a.document),before);
});

test('actual export carries creative drafts and layout preferences without taking destination navigation or unfinished editors',async()=>{
  const e=indexFixture();Object.assign(e.state,{prompt:'lake',negative:'lettering',promptDraft:{compiled:'lake',negative:'lettering',userEditedCompiled:true},directorBridge:{worldSideShotsEnabled:true},
    characterArchive:{schemaVersion:1,collapsed:{char:true,user:false,other:true}},collapsedCards:{worldbook:false},tagSort:'used',view:'gallery',pendingParagraphSelection:{version:1},promptItemDraft:{instruction:'unsaved'}});
  await e.context.storyboardExportPackage({originals:false});const exported=JSON.parse(await e.exported().text());
  assert.equal(exported.vibeAccount,namespace);assert.equal(exported.settings.prompt,'lake');assert.equal(exported.settings.negative,'lettering');assert.equal(exported.settings.promptDraft.userEditedCompiled,true);
  assert.equal(exported.settings.directorBridge.worldSideShotsEnabled,true);assert.equal(exported.settings.collapsedCards.worldbook,false);assert.equal(exported.settings.tagSort,'used');
  for(const key of ['view','pendingParagraphSelection','promptItemDraft'])assert.equal(Object.hasOwn(exported.settings,key),false);
});

test('actual export refuses overlong current prompts rather than normalizing away the extra content',async()=>{
  const e=indexFixture();e.state.prompt='x'.repeat(24001);await e.context.storyboardExportPackage({originals:false});assert.equal(e.exported(),null);
  assert.match(e.notices.at(-1)[0],/prompt.*完整保留/);assert.equal(e.state.prompt.length,24001);assert.equal(e.context.storyboardExportPackage.busy,false);
});

test('actual export rejects nested preset loss before media reads instead of only counting surviving IDs',async()=>{
  for(const mutate of [state=>state.profiles.openai.futureParameter='keep',state=>state.artistPresets=[{id:'artist',name:'A',value:'x'.repeat(6001)}],state=>state.promptPresets=[{id:'p',name:'P',items:[{id:'e',name:'E',instruction:'x'.repeat(12001)}]}]]){
    const e=indexFixture();mutate(e.state);const before=structuredClone(e.state);e.context.fetch=()=>assert.fail('failure before media loading');
    await e.context.storyboardExportPackage({originals:false});assert.equal(e.exported(),null);assert.deepEqual(e.state,before);assert.match(e.notices.at(-1)[0],/无法完整保留/);
  }
});

test('actual export retains model memories and custom prompt layers while allowing graph formatting only',async()=>{
  const e=indexFixture();e.state.profiles.comfy.comfyWorkflow='{ "node": { "class_type":"Text", "inputs": { "text":"public" } } }';
  board.rememberStoryboardModelProfile(e.state.modelProfiles,'openai',{model:'saved-model',steps:'27'});e.state.promptDefaults={'saved-model':{positive:'local plus',negative:'local minus'}};const before=structuredClone(e.state);
  await e.context.storyboardExportPackage({originals:false});assert.ok(e.exported(),JSON.stringify(e.notices));const value=JSON.parse(await e.exported().text());
  assert.equal(value.settings.modelProfiles.openai['saved-model'].steps,'27');assert.deepEqual(value.settings.promptDefaults,e.state.promptDefaults);assert.deepEqual(e.state,before);
  assert.deepEqual(JSON.parse(value.settings.profiles.comfy.comfyWorkflow),JSON.parse(before.profiles.comfy.comfyWorkflow));
});

test('actual legacy export aborts on chat change during media retrieval and never downloads a mixed chat snapshot',async()=>{
  const e=indexFixture();e.setImages([{id:'one',source:'novel',url:'/one.png',snapshot:{}}]);e.context.fetch=async()=>{e.switch();return {ok:true,blob:async()=>new Blob(['image'])};};
  await e.context.storyboardExportPackage({originals:false});assert.equal(e.exported(),null);assert.ok(e.notices.some(([text,kind])=>kind==='error'&&text.includes('已变化')));
});

test('actual legacy export keeps artist pools and frozen collections, refusing a missing archived snapshot/pipeline',async()=>{
  const e=indexFixture();e.state.artistPresets=[{id:'artist',name:'A',value:'artist tags'}];e.state.artistPools=[{id:'pool',name:'Pool',members:[{artistId:'artist',weight:1}]}];
  e.context.storyboardPlansForPortableExport=async plans=>{e.context.storyboardGalleryCollections=()=>[{id:'later',name:'Later collection'}];return plans;};
  await e.context.storyboardExportPackage({originals:false});const exported=JSON.parse(await e.exported().text());assert.equal(exported.settings.artistPools[0].id,'pool');assert.deepEqual(exported.chat.collections,[{id:'c',name:'Captured collection'}]);
  for(const kind of ['snapshot','pipeline']){
    const x=indexFixture();if(kind==='snapshot')x.setImages([{id:'one',source:'novel',snapshotRef:'missing',url:'/image'}]);else{x.state.logs=[{id:'log',pipelineId:'missing'}];}
    await x.context.storyboardExportPackage();assert.equal(x.exported(),null);assert.ok(x.notices.some(([text,status])=>status==='error'&&text.includes('缺失')));
  }
});

test('strict plan export refuses lost archives while old non-strict reads remain compatible',async()=>{
  const context=vm.createContext({storyboardPlanArchiveCache:new Map(),blobStore:{blobStoreAvailable:()=>false},clone:structuredClone});vm.runInContext(fn('storyboardPlansForPortableExport'),context);
  const old=[{id:'old',archiveRef:'missing'}];assert.equal((await context.storyboardPlansForPortableExport(old))[0].id,'old');
  await assert.rejects(()=>context.storyboardPlansForPortableExport(old,{strict:true}),/缺失/);
});

test('actual export prevents duplicate heavy work and explicitly describes legacy Vibe reference-only coverage',async()=>{
  const e=indexFixture();const {information,...legacy}=item('legacy');e.state.vibeLibrary=[{...legacy,informationExtracted:information,providerIds:['novel']}];let release,started;
  const began=new Promise(resolve=>started=resolve);e.context.storyboardHydratePipelineArchive=async()=>{started();await new Promise(resolve=>release=resolve);};
  const pending=e.context.storyboardExportPackage({originals:false});await began;await e.context.storyboardExportPackage();assert.equal(e.exported(),null);release();await pending;
  assert.ok(e.exported());assert.ok(e.notices.some(([text,kind])=>kind==='info'&&text.includes('请稍候')));
  assert.ok(e.notices.some(([text,kind])=>kind==='warning'&&text.includes('原文件')));assert.equal(e.context.storyboardExportPackage.busy,false);
});

test('actual export rejects broken resource selections and truncated Tag rules before reading images',async()=>{
  for(const mutate of [s=>s.selectedVibeIds=['missing'],s=>s.promptCompiler.instructionPresetId='missing',s=>s.tagLibrary=[{id:'t',content:'x'.repeat(6001)}],s=>s.generationPolicy.maxImages=8,s=>s.routing.rules=[{id:'bad',target:{providerId:'unknown'}}]]){
    const e=indexFixture();mutate(e.state);const before=structuredClone(e.state);e.context.fetch=()=>assert.fail('must stop before media');
    await e.context.storyboardExportPackage({originals:false});assert.equal(e.exported(),null);assert.match(e.notices.at(-1)[0],/关联.*完整保留/);assert.deepEqual(e.state,before);
  }
});

test('actual export retains Tag/Vibe/preset links, zero strengths and compiler selection in one normalized package',async()=>{
  const e=indexFixture();e.state.tagLibrary=[{id:'t',content:'soft light',positive:false}];e.state.vibeLibrary=[{id:'v',name:'V',strength:0,informationExtracted:0,tags:['t']}];e.state.selectedVibeIds=['v'];
  e.state.promptPresets=[{id:'p',name:'P',tagIds:['t'],items:[{id:'entry',instruction:'frame the light'}]}];e.state.promptCompiler.instructionPresetId='p';const before=structuredClone(e.state);
  await e.context.storyboardExportPackage({originals:false});assert.ok(e.exported(),JSON.stringify(e.notices));const value=JSON.parse(await e.exported().text());
  assert.equal(value.settings.promptCompiler.instructionPresetId,'p');assert.deepEqual(value.settings.selectedVibeIds,['v']);assert.deepEqual(value.settings.vibeLibrary[0].tags,['t']);assert.equal(value.settings.vibeLibrary[0].informationExtracted,0);assert.deepEqual(e.state,before);
});

test('old importer refuses future version packets before confirmation or any settings/media/archive write',async()=>{
  const f=createPackageImportFixture(),before=JSON.stringify(f.e.state);f.e.confirm=()=>assert.fail('must not confirm unsupported import');
  for(const version of [7,99,-1,'6',null])await f.import(new Blob([JSON.stringify({...payload(),version})]));
  assert.equal(JSON.stringify(f.e.state),before);assert.equal(f.e.notices.filter(([text,kind])=>kind==='error').length,5);assert.deepEqual(f.e.events,[]);
});

test('packet codec and unified v7 stage/worker are lazy and legacy export remains explicitly available',async()=>{
  const release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url)));assert.ok(release.files.includes('qianmu-storyboard-package-assets.js'));
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8');assert.match(source,/storyboardPackageAssets: \{ label: .*load: \(\) => import/);
  assert.match(fn('storyboardExportPackage'),/version: 6/,'legacy payload remains usable');assert.match(fn('storyboardExportPackage'),/exportStoryboardPackageAssets/);assert.match(fn('storyboardImportPackage'),/stage\.stage/);
});
