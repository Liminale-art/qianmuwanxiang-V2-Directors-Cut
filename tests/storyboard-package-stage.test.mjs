import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildStoryboardVibePackage} from '../qianmu-storyboard-package-assets.js';
import {parseStoryboardPackageText,inspectStoryboardPackageFile,STORYBOARD_PACKAGE_INPUT_LIMIT} from '../qianmu-storyboard-package-input.js';
import {createStoryboardPackageStage} from '../qianmu-storyboard-package-stage.js';
import {validateStoryboardPackageCheckpoint} from '../qianmu-storyboard-package-journal.js';
import {parseNovelVibeFile,vibeDigest,vibeFilePreview} from '../qianmu-vibe-file.js';
const namespace='st-user:destination',sourceNamespace='st-user:source',chatKey='chat-a';
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
async function fixture(count=3){
  const assets=[];for(let n=0;n<count;n++)assets.push((await parseNovelVibeFile(JSON.stringify({identifier:'novelai-vibe-transfer',version:1,type:'image',id:await vibeDigest(image),image,name:`Asset ${n}`,thumbnail:`data:image/png;base64,${image}`,
    encodings:{v4full:{zero:{encoding:btoa(`encoded-${n}`),params:{information_extracted:0}}},future:{advanced:{encoding:btoa(`future-${n}`),params:{information_extracted:1,focus_seed:0}}}}})))[0]);
  const payload={type:'qianmu-storyboard',version:6,credentialsIncluded:false,settings:{vibeLibrary:assets.map((a,i)=>({id:`v${i}`,name:a.summary.name,assetRef:{version:1,namespace:sourceNamespace,id:a.assetId},strength:0,informationExtracted:0})),
    taskStates:[{id:'unknown-fee',status:'generating',namespace:sourceNamespace}],shotPlans:[]},chat:{images:[],collections:[]},media:[]};
  const {file}=await buildStoryboardVibePackage(payload,{namespace:sourceNamespace,load:async(ns,id)=>assets.find(a=>a.assetId===id)});
  return {file,assets,payload};
}
function environment(initial=[]){
  const files=new Map(initial.map(a=>[a.assetId,a])),calls=[],records=new Map();let current=true,extraCount=0,extraBytes=0,locked=false;
  const options={namespace,chatKey,isCurrent:()=>current,guard:async()=>{if(!current)throw Error('account changed');}};
  const store={inventory:async ns=>{assert.equal(ns,namespace);const heads=[...files.values()].map(a=>({namespace,assetId:a.assetId,bytes:a.bytes,previewBytes:vibeFilePreview(a.document)?.size||0}));
    return {heads:[...heads,...Array.from({length:extraCount},(_,i)=>({assetId:`extra-${i}`}))],usage:{bytes:heads.reduce((n,a)=>n+a.bytes,0)+extraBytes,previewBytes:heads.reduce((n,a)=>n+a.previewBytes,0),limit:512*1048576}};},
    load:async(ns,id)=>{assert.equal(ns,namespace);calls.push(['load',id]);return files.get(id)||null;},
    putFile:async(ns,text,{isCurrent}={})=>{assert.equal(ns,namespace);assert.ok(isCurrent());calls.push(['put',text]);for(const a of await parseNovelVibeFile(text))if(!files.has(a.assetId))files.set(a.assetId,a);}};
  const journal={prepare:async descriptor=>{calls.push(['prepare']);const key=JSON.stringify([descriptor.namespace,descriptor.chatHash,descriptor.fileHash]);let row=records.get(key);
    if(!row){row=validateStoryboardPackageCheckpoint({...descriptor,key,version:1,phase:'prepared',revision:1,createdAt:1,updatedAt:1});records.set(key,structuredClone(row));}return structuredClone(row);},
    checkpoint:async(prev,phase)=>{calls.push(['checkpoint',phase]);assert.deepEqual(records.get(prev.key),prev);const row=validateStoryboardPackageCheckpoint({...prev,phase,revision:prev.revision+1});records.set(row.key,structuredClone(row));return row;}};
  const locks={request:async(name,opts,run)=>{assert.equal(name,`qianmu:package-stage:${namespace}`);assert.deepEqual(opts,{mode:'exclusive',ifAvailable:true});if(locked)return run(null);locked=true;try{return await run({name});}finally{locked=false;}}};
  const e={store,journal,options,files,records,calls,locks,change:()=>current=false,capacity:(count,bytes=0)=>{extraCount=count;extraBytes=bytes;}};e.ops=createStoryboardPackageStage(e);return e;
}

test('external package parser rejects escaped duplicate keys, unsafe fields, excessive depth, invalid numbers and trailing text',async()=>{
  const {file}=await fixture(0),text=await file.text();
  for(const broken of [text.replace('"version":7','"version":7,"\\u0076ersion":7'),text.replace('"settings":{','"settings":{"__proto__":{},'),text.replace('"settings":{','"settings":{"x":1e999,'),
    text.replace('"settings":{','"settings":{"x":'+ '['.repeat(42)+'0'+']'.repeat(42)+','),text+'{}',text.slice(0,-1),text.replace('"version":7','"version":6'),text.replace('"credentialsIncluded":false','"credentialsIncluded":true')])assert.throws(()=>parseStoryboardPackageText(broken));
  const data=parseStoryboardPackageText(text.replace('"settings":{','"settings":{"quoted":"escaped \\\" comma,:{}",'));assert.equal(data.settings.quoted,'escaped " comma,:{}');
});

test('external file gate refuses malformed UTF-8 and oversized input before reading or opening a store',async()=>{
  class Oversized extends Blob {get size(){return STORYBOARD_PACKAGE_INPUT_LIMIT+1;}arrayBuffer(){assert.fail('must not read oversized file');}}
  for(const file of [new Oversized(['x']),new Blob([Uint8Array.of(0xc3,0x28)]),new Blob([]),null,{text:async()=> '{}'}])await assert.rejects(()=>inspectStoryboardPackageFile(file));
});

test('external media validation accepts a real still and rejects duplicate, orphan, false MIME and invalid bytes',async()=>{
  const {file}=await fixture(0),data=JSON.parse(await file.text());data.chat.images=[{id:'image'}];data.media=[{id:'image',mime:'image/png',b64:image}];
  const inspect=value=>inspectStoryboardPackageFile(new Blob([JSON.stringify(value)]));assert.equal((await inspect(data)).payload.media.length,1);
  for(const change of [d=>d.chat.images.push(d.chat.images[0]),d=>d.media.push(d.media[0]),d=>d.media[0].id='unlinked',d=>d.media[0].mime='image/jpeg',d=>d.media[0].b64=btoa('not an image'),d=>d.media[0].b64='%%%%',d=>d.media[0].b64=image.slice(1)]){const bad=structuredClone(data);change(bad);await assert.rejects(()=>inspect(bad));}
});

test('preflight is read only, checks all originals and counts thumbnails without exposing image/prompt bodies',async()=>{
  const {file,assets}=await fixture(),e=environment([assets[0]]),plan=await e.ops.inspect(file,e.options);
  assert.equal(plan.missing,2);assert.equal(plan.fits,true);assert.equal(plan.rows.length,3);assert.equal(plan.sourceNamespace,sourceNamespace);assert.equal(plan.namespace,namespace);
  assert.equal(plan.neededBytes,assets.slice(1).reduce((n,a)=>n+a.bytes+vibeFilePreview(a.document).size,0));assert.equal(e.records.size,0);assert.equal(e.calls.some(([name])=>name==='put'),false);
  assert.ok(!JSON.stringify(plan).includes(image));assert.ok(!JSON.stringify(plan).includes('unknown-fee'));assert.equal(plan.chatKey,undefined);
});

test('21 originals stage sequentially beyond native Bundle limits, with a durable manifest before the first write',async()=>{
  const {file,assets,payload}=await fixture(21),e=environment([assets[0]]),plan=await e.ops.inspect(file,e.options),before=JSON.stringify(payload);
  const result=await e.ops.stage(file,plan,true,e.options);assert.equal(result.verified,21);assert.equal(result.settingsApplied,false);assert.equal(result.checkpoint.phase,'assets_ready');assert.equal(e.records.size,1);
  assert.ok(e.calls.findIndex(([name])=>name==='prepare')<e.calls.findIndex(([name])=>name==='put'));assert.equal(e.calls.filter(([name])=>name==='put').length,20);
  for(const a of assets)assert.equal(e.files.get(a.assetId).serialized,a.serialized);assert.equal(e.files.get(assets[0].assetId),assets[0]);assert.equal(JSON.stringify(payload),before);
  assert.equal(JSON.stringify(result.checkpoint).includes(image),false);assert.equal(result.checkpoint.assetIds.length,21);
});

test('a simulated crash after the second committed asset resumes only after fresh inspection and confirmation',async()=>{
  const {file,assets}=await fixture(),e=environment(),plan=await e.ops.inspect(file,e.options),put=e.store.putFile;let n=0;
  e.store.putFile=async(...args)=>{await put(...args);if(++n===2)throw Error('connection lost after commit');};
  await assert.rejects(()=>e.ops.stage(file,plan,true,e.options),error=>error.code==='storyboard_package_stage_pending'&&error.settingsApplied===false&&Boolean(error.recoveryKey));
  assert.equal(e.files.size,2);assert.equal([...e.records.values()][0].phase,'staging');const oldCalls=e.calls.length;
  e.store.putFile=put;await assert.rejects(()=>e.ops.stage(file,plan,true,e.options),/重新核对/);assert.equal(e.files.size,2);
  const fresh=await e.ops.inspect(file,e.options);await assert.rejects(()=>e.ops.stage(file,fresh,false,e.options),/明确确认/);
  const result=await e.ops.stage(file,fresh,true,e.options);assert.equal(result.verified,3);assert.equal(e.calls.slice(oldCalls).filter(([name])=>name==='put').length,1);assert.equal(e.records.size,1);
  for(const a of assets)assert.equal(e.files.get(a.assetId).serialized,a.serialized);
});

test('unconfirmed final journal write is recoverable without rewriting already committed assets',async()=>{
  const {file}=await fixture(),e=environment(),plan=await e.ops.inspect(file,e.options),save=e.journal.checkpoint;
  e.journal.checkpoint=async(row,phase)=>{const saved=await save(row,phase);if(phase==='assets_ready')throw Error('lost ack');return saved;};
  await assert.rejects(()=>e.ops.stage(file,plan,true,e.options),/可能已有/);assert.equal([...e.records.values()][0].phase,'assets_ready');assert.equal(e.files.size,3);
  e.journal.checkpoint=save;const before=e.calls.filter(([name])=>name==='put').length,result=await e.ops.stage(file,await e.ops.inspect(file,e.options),true,e.options);
  assert.equal(result.verified,3);assert.equal(e.calls.filter(([name])=>name==='put').length,before);assert.equal(e.records.size,1);
});

test('account/page changes mid-write stop later assets and leave a reviewable checkpoint, not success',async()=>{
  const {file}=await fixture(),e=environment(),plan=await e.ops.inspect(file,e.options),put=e.store.putFile;
  e.store.putFile=async(...args)=>{await put(...args);e.change();};await assert.rejects(()=>e.ops.stage(file,plan,true,e.options),/设置未应用/);assert.equal(e.files.size,1);assert.equal([...e.records.values()][0].phase,'staging');
});

test('wrong chat/account, changed file and missing explicit confirmation cause no checkpoint or writes',async()=>{
  const {file}=await fixture(),other=await fixture(2),e=environment(),plan=await e.ops.inspect(file,e.options);
  for(const [input,proof,yes,options] of [[file,plan,false,e.options],[file,plan,'true',e.options],[file,{...plan,chatHash:'a'.repeat(64)},true,e.options],[file,{...plan,namespace:sourceNamespace},true,e.options],[other.file,plan,true,e.options],
    [file,plan,true,{...e.options,chatKey:'other'}],[file,plan,true,{...e.options,isCurrent:()=>false}],[file,plan,true,{...e.options,guard:null}]])await assert.rejects(()=>e.ops.stage(input,proof,yes,options));
  assert.equal(e.records.size,0);assert.equal(e.files.size,0);
});

test('capacity exhaustion including thumbnail bytes refuses the whole stage, not a clipped subset',async()=>{
  const {file}=await fixture();for(const [count,bytes] of [[1024,0],[0,512*1048576-1]]){const e=environment();e.capacity(count,bytes);const plan=await e.ops.inspect(file,e.options);assert.equal(plan.fits,false);
    await assert.rejects(()=>e.ops.stage(file,plan,true,e.options),/不足/);assert.equal(e.records.size,0);assert.equal(e.files.size,0);}
});

test('approved proof is captured before asynchronous account verification, and async truthy page guards are refused',async()=>{
  const {file}=await fixture(),e=environment(),plan=await e.ops.inspect(file,e.options);let waiting,release;
  const entered=new Promise(resolve=>waiting=resolve),blocked=new Promise(resolve=>release=resolve);
  const options={...e.options,guard:async()=>{waiting();await blocked;}};
  const running=e.ops.stage(file,plan,true,options);await entered;plan.fileHash='f'.repeat(64);plan.chatHash='f'.repeat(64);release();
  assert.equal((await running).verified,3,'approved original proof is used, not its mutable UI object');
  await assert.rejects(()=>e.ops.inspect(file,{...e.options,isCurrent:async()=>true}),/页面已变化/);
});

test('corrupt/missing local originals and changing inventories fail before any checkpoint write',async()=>{
  const {file,assets}=await fixture();for(const corrupt of [async()=>null,async()=>({...assets[0],serialized:'corrupt'})]){const e=environment([assets[0]]);e.store.load=corrupt;await assert.rejects(()=>e.ops.inspect(file,e.options),/不完整/);assert.equal(e.records.size,0);}
  const e=environment(),inventory=e.store.inventory;let n=0;e.store.inventory=async(...args)=>{const value=await inventory(...args);if(++n>1)value.usage.bytes++;return value;};await assert.rejects(()=>e.ops.inspect(file,e.options),/目录已变化/);
});

test('journal failure precedes all assets; locks unavailable or occupied refuse safe staging',async()=>{
  const {file}=await fixture(),e=environment(),plan=await e.ops.inspect(file,e.options);e.journal.prepare=async()=>{throw Error('journal quota');};await assert.rejects(()=>e.ops.stage(file,plan,true,e.options),/journal quota/);assert.equal(e.files.size,0);
  for(const locks of [null,{request:async(name,opts,run)=>run(null)}]){const ops=createStoryboardPackageStage({...e,locks});await assert.rejects(()=>ops.stage(file,plan,true,e.options),/导入锁|另一页面/);}assert.equal(e.files.size,0);
});

test('cross-page exclusion prevents two simultaneous stages instead of relying on last write wins',async()=>{
  const {file}=await fixture(),e=environment(),plan=await e.ops.inspect(file,e.options),put=e.store.putFile;let release,entered;
  const blocked=new Promise(resolve=>release=resolve),writing=new Promise(resolve=>entered=resolve);e.store.putFile=async(...args)=>{entered();await blocked;return put(...args);};
  const running=e.ops.stage(file,plan,true,e.options);await writing;await assert.rejects(()=>e.ops.stage(file,plan,true,e.options),/另一页面/);release();assert.equal((await running).verified,3);assert.equal(e.records.size,1);
});

test('ready checkpoints are not proof that files still exist: a later deliberate removal is detected and can be restaged',async()=>{
  const {file,assets}=await fixture(),e=environment();await e.ops.stage(file,await e.ops.inspect(file,e.options),true,e.options);e.files.delete(assets[1].assetId);
  const plan=await e.ops.inspect(file,e.options);assert.equal(plan.missing,1);const before=e.calls.filter(([name])=>name==='put').length;
  await e.ops.stage(file,plan,true,e.options);assert.equal(e.calls.filter(([name])=>name==='put').length,before+1);assert.equal(e.records.size,1);
});

test('checkpoint validation rejects forged phase, foreign keys, duplicate IDs and body/secret fields',async()=>{
  const {file}=await fixture(0),e=environment();const result=await e.ops.stage(file,await e.ops.inspect(file,e.options),true,e.options),row=result.checkpoint;
  assert.equal(row.assetIds.length,0);for(const mutate of [r=>r.phase='committed',r=>r.key='foreign',r=>r.namespace='invalid',r=>r.revision=0,r=>r.createdAt=-1,r=>r.updatedAt=0,
    r=>r.assetIds=['a'.repeat(64),'a'.repeat(64)],r=>r.apiKey='secret',r=>r.payload={},r=>r.chatKey='private chat']){const bad=structuredClone(row);mutate(bad);assert.throws(()=>validateStoryboardPackageCheckpoint(bad));}
});

test('asset staging modules have no network, fee replay, destructive removal or metadata commit routes',async()=>{
  for(const file of ['qianmu-storyboard-package-input.js','qianmu-storyboard-package-stage.js']){
    const text=await readFile(new URL(`../${file}`,import.meta.url),'utf8');assert.doesNotMatch(text,/fetch\(|saveSettings\(|saveMetadata\(|\.remove\(|(?:store|objectStore\([^)]*\))\.delete\(|encoding-reserve|storyboardQueue/);
  }
});
