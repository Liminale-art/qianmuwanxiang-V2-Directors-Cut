import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {prepareStoryboardVibes,confirmVibeEncoding} from '../qianmu-vibe-prepare.js';
import {encodeNovelVibe} from '../qianmu-vibe-encoding.js';
import {generateDirectImage,isDirectImageTransportError} from '../qianmu-image-direct.js';
import {createVibeAssetOperations} from '../qianmu-vibe-assets-worker.js';
import {parseNovelVibeFile,vibeDigest} from '../qianmu-vibe-file.js';
import {resolveStoryboardVibeRecipe,sanitizeStoryboardSnapshot} from '../qianmu-storyboard.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const namespace='st-user:one',model={remoteModelId:'relay/model',capabilityModelId:'nai-diffusion-4-5-full'};
const connection={baseUrl:'https://relay.example',protocol:'novelai'};
const row=(id='one',information=0)=>({id,name:id,previewUrl:`/images/${id}.png`,information,strength:0});
const payload=(items=[row()])=>({selectedVibeIds:items.map(row=>row.id),vibeRecipe:{version:items.some(row=>row.assetRef)?2:1,items}});
function setup(){
  const files=new Map(),receipts=new Map(),events=[],saved=[];let live=true,posts=0,confirmations=0;
  const store={load:async(ns,id)=>files.get(`${ns}:${id}`),putFile:async(ns,text)=>{
    const assets=await parseNovelVibeFile(text);for(const asset of assets)files.set(`${ns}:${asset.assetId}`,asset);return assets;
  }};
  const encodings={get:async(ns,key)=>structuredClone(receipts.get(`${ns}:${key}`)||null),reserve:async(ns,key,identity,attemptId,{retryAttemptId})=>{
    const id=`${ns}:${key}`,old=receipts.get(id);if(old&&(old.status!=='rejected'||old.attemptId!==retryAttemptId))return {owned:false,receipt:structuredClone(old)};
    const receipt={status:'reserved',identity,attemptId,cacheKey:key};receipts.set(id,receipt);return {owned:true,receipt};
  },transition:async(ns,key,attemptId,status,{assetRef})=>{
    const receipt=receipts.get(`${ns}:${key}`);assert.equal(receipt.attemptId,attemptId);assert.ok(['reserved','submitting'].includes(receipt.status));
    Object.assign(receipt,{status,...(assetRef?{assetRef}:{})});return structuredClone(receipt);
  }};
  const operations=createVibeAssetOperations(store,{encodings}),options={namespace,model,connection,apiKey:'test-secret',
    guard:async()=>{if(!live)throw Error('context changed');},readImage:async()=>({data:image}),
    checkpoint:async recipe=>{events.push('checkpoint');saved.push(structuredClone(recipe));},
    call:async(type,args)=>{events.push(type);return operations({type,...args});},
    confirm:async()=>{events.push('confirm');confirmations++;return true;},
    encode:(input,hooks)=>encodeNovelVibe(input,{...hooks,fetchImpl:async()=>{
      events.push('POST');posts++;assert.equal([...receipts.values()].at(-1).status,'submitting');
      return new Response('opaque-binary-test',{status:201,headers:{'content-type':'application/binary'}});
    }}),
  };
  return {options,files,receipts,events,saved,operations,store,posts:()=>posts,confirmations:()=>confirmations,setLive:value=>live=value};
}

test('actual coordinator freezes sources, explicitly confirms, persists receipt, encodes once and checkpoints the exact new asset',async()=>{
  const e=setup(),request=payload(),original=structuredClone(request),result=await prepareStoryboardVibes(request,e.options);
  assert.equal(e.posts(),1);assert.equal(e.confirmations(),1);assert.deepEqual(request,original);
  assert.ok(e.events.indexOf('checkpoint')<e.events.indexOf('confirm'));assert.ok(e.events.indexOf('encoding-transition')<e.events.indexOf('POST'));
  assert.equal(result[0].kind,'novelai-vibe-encoding');assert.equal(result[0].strength,0);assert.equal(result[0].information,0);
  assert.equal(e.saved.length,2);assert.notEqual(e.saved[0].items[0].assetRef.id,e.saved[1].items[0].assetRef.id);
  assert.equal(e.files.get(`${namespace}:${e.saved[0].items[0].assetRef.id}`).summary.variants.length,0);
  const receipt=[...e.receipts.values()][0];assert.equal(receipt.status,'ready');assert.deepEqual(receipt.assetRef,e.saved[1].items[0].assetRef);
  assert.equal(JSON.stringify(e.saved).includes(image),false);assert.equal(JSON.stringify(e.saved).includes('test-secret'),false);
});
test('ready cache reuses the exact model/IE without consent or POST; redraw uses immutable recipe without reading the URL',async()=>{
  const e=setup();const first=await prepareStoryboardVibes(payload(),e.options),finalRecipe=structuredClone(e.saved.at(-1));
  const second=await prepareStoryboardVibes(payload(),e.options);assert.deepEqual(second,first);assert.equal(e.posts(),1);assert.equal(e.confirmations(),1);
  e.options.readImage=async()=>{throw Error('URL must not be reread');};
  const third=await prepareStoryboardVibes({selectedVibeIds:['one'],vibeRecipe:finalRecipe},e.options);assert.deepEqual(third,first);assert.equal(e.posts(),1);
});
test('every source freezes before the first paid request; duplicate content in one image shares one encoding and preserves order/strength',async()=>{
  const e=setup();const second={...row('two'),strength:.7};const result=await prepareStoryboardVibes(payload([row(),second]),e.options);
  assert.equal(e.events.slice(0,e.events.indexOf('POST')).filter(type=>type==='freeze-original').length,2);
  assert.equal(e.posts(),1);assert.equal(e.confirmations(),1);assert.deepEqual(result.map(row=>row.strength),[0,.7]);assert.equal(result[0].data,result[1].data);
});
test('selection checks missing encodings without charging, while unsupported/pure-encoded mismatches remain errors',async()=>{
  const e=setup(),ref=await e.options.call('freeze-original',{namespace,image:{data:image},name:'image'});
  const result=await e.options.call('check',{namespace,id:ref.id,model:model.capabilityModelId,information:.7});assert.equal(result.kind,'needs-encoding');
  await assert.rejects(()=>e.options.call('check',{namespace,id:ref.id,model:'nai-diffusion-5-full',information:.7}),{code:'vibe_file_model'});
  const encoding=btoa('pure-encoding'),[only]=await e.store.putFile(namespace,JSON.stringify({identifier:'novelai-vibe-transfer',version:1,type:'encoding',id:await vibeDigest(encoding),encodings:{v4full:{unknown:{encoding}}}}));
  await assert.rejects(()=>e.options.call('check',{namespace,id:only.assetId,model:model.capabilityModelId,information:.7}),{code:'vibe_file_missing_encoding'});
  assert.equal(e.posts(),0);assert.equal(e.confirmations(),0);
});
test('a broken later asset blocks the entire generation before paying for the first original',async()=>{
  const e=setup(),items=[row(),{...row('later'),previewUrl:'',assetRef:{version:1,namespace,id:'a'.repeat(64)}}];
  await assert.rejects(()=>prepareStoryboardVibes(payload(items),e.options),{code:'vibe_file_missing'});assert.equal(e.posts(),0);assert.equal(e.confirmations(),0);
});
test('decoded transport memory is bounded at 48 MB while retaining existing files and without a new encoding request',async()=>{
  const e=setup(),data=Buffer.alloc(8*1024*1024,1).toString('base64'),items=Array.from({length:8},(_,at)=>({...row(String(at)),previewUrl:'',assetRef:{version:1,namespace,id:String(at).repeat(64)}}));let reads=0;
  e.options.call=async type=>{if(type==='check')return {kind:'novelai-vibe-encoding'};assert.equal(type,'resolve');reads++;return {data,kind:'novelai-vibe-encoding'};};
  await assert.rejects(()=>prepareStoryboardVibes(payload(items),e.options),{code:'storyboard_vibe_size',submissionState:'not_submitted'});
  assert.equal(reads,7);assert.equal(e.posts(),0);assert.equal(e.confirmations(),0);
});
test('V3 raw input is also frozen for future redraw, with no encoding receipt or fee consent',async()=>{
  const e=setup();e.options.model={remoteModelId:'nai-diffusion-3',capabilityModelId:'nai-diffusion-3'};
  const result=await prepareStoryboardVibes(payload(),e.options);assert.equal(result[0].kind,'image');assert.equal(result[0].data,image);assert.equal(e.saved.length,1);
  assert.equal(e.posts(),0);assert.equal(e.confirmations(),0);assert.equal(e.receipts.size,0);
});
test('cancel, missing service support and lost live context never submit encoding or image work',async()=>{
  for(const tweak of [e=>e.options.confirm=async()=>false,e=>e.options.confirm=async()=>({yes:true}),e=>e.options.allowEncoding=false,
    e=>e.options.confirm=async()=>{e.setLive(false);return true;},e=>e.options.checkpoint=async()=>{throw Error('cannot persist');}]){
    const e=setup();tweak(e);await assert.rejects(()=>prepareStoryboardVibes(payload(),e.options));assert.equal(e.posts(),0);assert.equal(e.receipts.size,0);
  }
});
test('unknown encoding is not an image submission and is never automatically retried, including repeated job invocation',async()=>{
  const e=setup();let posts=0;e.options.encode=(input,hooks)=>encodeNovelVibe(input,{...hooks,fetchImpl:async()=>{posts++;throw new TypeError('private backend detail');}});
  await assert.rejects(()=>prepareStoryboardVibes(payload(),e.options),{code:'storyboard_vibe_encoding',submissionState:'not_submitted',encodingState:'unknown'});
  assert.equal([...e.receipts.values()][0].status,'unknown');await assert.rejects(()=>prepareStoryboardVibes(payload(),e.options),{code:'storyboard_vibe_pending'});
  assert.equal(posts,1);assert.equal(e.confirmations(),1);
});
test('definitive rejection needs a fresh explicit consent and attempt; transport is never retried in the same call',async()=>{
  const e=setup();let posts=0;e.options.encode=(input,hooks)=>encodeNovelVibe(input,{...hooks,fetchImpl:async()=>{posts++;return new Response('',{status:429});}});
  await assert.rejects(()=>prepareStoryboardVibes(payload(),e.options),{submissionState:'not_submitted',encodingState:'rejected'});const attempt=[...e.receipts.values()][0].attemptId;
  await assert.rejects(()=>prepareStoryboardVibes(payload(),e.options));assert.equal(posts,2);assert.equal(e.confirmations(),2);assert.notEqual([...e.receipts.values()][0].attemptId,attempt);
});
test('response followed by local asset failure remains uncertain regardless of a local not_submitted label',async()=>{
  const e=setup(),call=e.options.call;e.options.call=async(type,args)=>{if(type==='attach-encoding')throw Object.assign(Error('disk full'),{submissionState:'not_submitted'});return call(type,args);};
  await assert.rejects(()=>prepareStoryboardVibes(payload(),e.options),{submissionState:'not_submitted',encodingState:'unknown'});
  assert.equal([...e.receipts.values()][0].status,'unknown');await assert.rejects(()=>prepareStoryboardVibes(payload(),e.options),{code:'storyboard_vibe_pending'});assert.equal(e.posts(),1);
});
test('successful response is retained under original account after context changes, without stale snapshot writes or image submission',async()=>{
  const e=setup(),encode=e.options.encode;e.options.encode=async(...args)=>{const result=await encode(...args);e.setLive(false);return result;};
  await assert.rejects(()=>prepareStoryboardVibes(payload(),e.options),/context changed/);
  const receipt=[...e.receipts.values()][0];assert.equal(receipt.status,'ready');assert.equal(receipt.assetRef.namespace,namespace);assert.equal(e.saved.length,1);assert.equal(e.posts(),1);
});
test('ready receipt with missing/corrupt/wrong-source asset fails without a new fee authorization',async()=>{
  for(const corrupt of [e=>e.files.delete(`${namespace}:${[...e.receipts.values()][0].assetRef.id}`),e=>{
    const value=e.files.get(`${namespace}:${[...e.receipts.values()][0].assetRef.id}`);value.document.id='f'.repeat(64);
  }]){
    const e=setup();await prepareStoryboardVibes(payload(),e.options);corrupt(e);await assert.rejects(()=>prepareStoryboardVibes(payload(),e.options));assert.equal(e.posts(),1);assert.equal(e.confirmations(),1);
  }
});
test('endpoint, remote model or IE changes do not reuse a receipt for a different request',async()=>{
  for(const tweak of [e=>e.options.connection={...connection,baseUrl:'https://other.example'},e=>e.options.model={...model,remoteModelId:'other/model'}]){
    const e=setup();await prepareStoryboardVibes(payload(),e.options);tweak(e);await prepareStoryboardVibes(payload(),e.options);assert.equal(e.posts(),2);
  }
  const e=setup();await prepareStoryboardVibes(payload(),e.options);await prepareStoryboardVibes(payload([row('one',.7)]),e.options);assert.equal(e.posts(),2);
});
test('durable ownership lost to another tab cannot submit; concurrent ready result can be reused',async()=>{
  for(const ready of [false,true]){
    const e=setup();await prepareStoryboardVibes(payload(),e.options);const receipt=structuredClone([...e.receipts.values()][0]);e.receipts.clear();const call=e.options.call;
    e.options.call=async(type,args)=>type==='encoding-reserve'?{owned:false,receipt:{...receipt,status:ready?'ready':'submitting'}}:call(type,args);
    if(ready)await prepareStoryboardVibes(payload(),e.options);else await assert.rejects(()=>prepareStoryboardVibes(payload(),e.options),{code:'storyboard_vibe_pending'});
    assert.equal(e.posts(),1);
  }
});
test('actual index preparation checkpoints into the saved log, retains source identity guards and never marks image admission submitted',async()=>{
  const e=setup(),job={source:'novel',modelIdentity:model,profile:{},connection,target:'gallery',payload:payload(),imageAdmission:{namespace}},log={snapshot:structuredClone(job)};
  const context=vm.createContext({resolveStoryboardVibeRecipe,resolveStoryboardJobModelIdentity:()=>model,storyboardAdmissionEpoch:1,storyboardState:()=>({enabled:true}),
    getStoryboardCapabilities:()=>({supportsVibe:true}),storyboardReadImageReference:e.options.readImage,clone:structuredClone,ctx:()=>({}),toast(){},saveSettings(){},
    featureRuntime:{load:async key=>key==='imageAdmission'?{resolveImageAccountNamespace:async()=>namespace}:key==='vibeAssets'?{callVibeAsset:e.options.call}:
      {confirmVibeEncoding:e.options.confirm,prepareStoryboardVibes:(payload,options)=>prepareStoryboardVibes(payload,{...options,encode:e.options.encode})}}});
  vm.runInContext(section('storyboardPrepareGatewayAssets'),context);
  const result=await context.storyboardPrepareGatewayAssets(job,{apiKey:'test-secret',log});assert.equal(result.vibes[0].kind,'novelai-vibe-encoding');
  assert.deepEqual(job.payload.vibeRecipe,log.snapshot.payload.vibeRecipe);assert.equal(job.submissionState,undefined);assert.deepEqual(job.imageAdmission,{namespace});
  const snapshot=sanitizeStoryboardSnapshot(log.snapshot);assert.deepEqual(snapshot.payload.vibeRecipe,job.payload.vibeRecipe);assert.equal(JSON.stringify(snapshot).includes('test-secret'),false);
});
test('paid consent accepts only affirmative values, escapes imported names, and never opens a second dialog on cancellation',async()=>{
  for(const result of [false,0,null,undefined,'unconfirmed','not ok','1','true',{},-1]){
    let fallback=0;assert.equal(await confirmVibeEncoding('Encode','<img src=x onerror=alert(1)>\n&',{popup:{show:{confirm:async(title,text)=>{
      assert.equal(title,'Encode');assert.equal(text,'&lt;img src=x onerror=alert(1)&gt;<br>&amp;');return result;
    }}},confirm:()=>{fallback++;return true;}}),false);assert.equal(fallback,0);
  }
  for(const result of [1,true])assert.equal(await confirmVibeEncoding('a','b',{popup:{show:{confirm:async()=>result}}}),true);
  assert.equal(await confirmVibeEncoding('a','b',{popup:{show:{confirm:async()=>{throw Error('closed');}}},confirm:()=>assert.fail('no second dialog')}),false);
  assert.equal(await confirmVibeEncoding('a','b',{confirm:async text=>text==='a\nb'}),true);
});
test('actual job runner keeps encoding consent separate from image admission and never falls back after uncertain encoding',async()=>{
  for(const unknown of [false,true]){
    const e=setup(),outcomes=[],state={enabled:true};let admissions=0,imagePosts=0,channelSubmissions=0;
    const originalEncode=e.options.encode;
    e.options.encode=async(input,hooks)=>{
      assert.equal(admissions,0);assert.equal(channelSubmissions,0);
      if(unknown)return encodeNovelVibe(input,{...hooks,fetchImpl:async()=>{throw new TypeError('response lost');}});
      return originalEncode(input,hooks);
    };
    const job={id:'job',source:'novel',target:'gallery',profile:{},connection,payload:{...payload(),prompt:'garden',parameters:{count:1}},imageAdmission:{namespace}},log={snapshot:structuredClone(job)};
    const context=vm.createContext({resolveStoryboardVibeRecipe,resolveStoryboardJobModelIdentity:()=>model,storyboardAdmissionEpoch:1,storyboardState:()=>state,
      getStoryboardCapabilities:()=>({supportsVibe:true}),storyboardReadImageReference:e.options.readImage,clone:structuredClone,ctx:()=>({}),toast(){},saveSettings(){},
      featureRuntime:{load:async key=>key==='imageAdmission'?{resolveImageAccountNamespace:async()=>namespace}:key==='vibeAssets'?{callVibeAsset:e.options.call}:
        {confirmVibeEncoding:e.options.confirm,prepareStoryboardVibes:(payload,options)=>prepareStoryboardVibes(payload,{...options,encode:e.options.encode})}},
      storyboardPlanForJob:()=>null,storyboardValidatedAnchor:()=>({valid:true}),storyboardResolveApiKey:async()=> 'test-secret',storyboardMarkLogGenerating(){},storyboardSetPlanStatus(){},storyboardPipelineStage(){},
      storyboardImageChannelRuntime:async()=>({run:async(_input,work)=>work({beforeSubmit:async()=>channelSubmissions++})}),confirmDialog:async()=>true,
      storyboardAdmission:{beforeSubmit:async()=>admissions++},storyboardSettleImageAdmission:async(_job,value)=>outcomes.push(value),
      storyboardGatewayRequest:(job,apiKey,assets)=>({provider:'novel',model:model.remoteModelId,capabilityModelId:model.capabilityModelId,baseUrl:connection.baseUrl,apiKey,
        prompt:'garden',parameters:{count:1},vibes:assets.vibes,novelVibeVersion:1}),
      directImageRuntime:async()=>({isDirectImageTransportError,generateDirectImage:(input,options)=>generateDirectImage(input,{...options,fetchImpl:async(_url,init)=>{
        if(init.method==='GET')return new Response('{}');imagePosts++;return new Response(Buffer.from(image,'base64'),{headers:{'content-type':'image/png'}});
      }})}),
      storyboardConfirmGatewayModelBinding:()=>assert.fail('no fallback'),storyboardDeliverGatewayResult:async()=>true,
      storyboardFinishLog:(_log,status,details)=>Object.assign(log,{status,...details}),storyboardPipelineForLog:()=>null,MODULE_NAME:'test',console:{error(){}},
    });
    vm.runInContext(['storyboardPrepareGatewayAssets','storyboardRunJob'].map(section).join('\n'),context);await context.storyboardRunJob(job,log);
    assert.equal(imagePosts,unknown?0:1);assert.equal(admissions,unknown?0:1);assert.equal(channelSubmissions,unknown?0:1);
    assert.equal(outcomes.at(-1),unknown?'not_submitted':'succeeded');assert.equal(log.submissionState,unknown?'not_submitted':'accepted');
    if(unknown){assert.equal(log.status,'failed');assert.equal([...e.receipts.values()][0].status,'unknown');}
  }
});
