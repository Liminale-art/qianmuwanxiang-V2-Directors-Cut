import test from 'node:test';
import assert from 'node:assert/strict';
import {createPackageImportFixture} from './helpers/storyboard-package-fixture.mjs';
import {buildStoryboardVibePackage,STORYBOARD_PACKAGE_LIMITS} from '../qianmu-storyboard-package-assets.js';
import {parseNovelVibeFile,vibeDigest} from '../qianmu-vibe-file.js';
import {inspectStoryboardPackageFile,STORYBOARD_PACKAGE_INPUT_LIMIT,readStoryboardPackageImage} from '../qianmu-storyboard-package-input.js';
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
async function packet(){
  const namespace='st-user:source', [asset]=await parseNovelVibeFile(JSON.stringify({identifier:'novelai-vibe-transfer',version:1,type:'image',id:await vibeDigest(image),image,name:'Original',
    encodings:{future:{zero:{encoding:btoa('original opaque encoding'),params:{information_extracted:0}}}}}));
  const payload={type:'qianmu-storyboard',version:6,credentialsIncluded:false,settings:{promptMode:'combined',vibeLibrary:[{id:'vibe',name:'Original',assetRef:{version:1,namespace,id:asset.assetId},strength:0,informationExtracted:0}],
    selectedVibeIds:['vibe']},chat:{images:[],collections:[]},media:[]};
  return {asset,payload,namespace,...await buildStoryboardVibePackage(payload,{namespace,load:async()=>asset})};
}
test('actual default import stages cross-account Vibe originals before applying a detached metadata mutation',async()=>{
  const p=await packet(),f=createPackageImportFixture(),original=await p.file.text();f.e.store.voice={keep:true};await f.import(p.file);
  assert.equal(f.e.state.promptMode,'combined');assert.equal(f.e.state.vibeLibrary[0].assetRef.namespace,f.e.namespace);assert.equal(f.e.state.vibeLibrary[0].assetRef.id,p.asset.assetId);
  assert.equal(f.e.files.get(p.asset.assetId).serialized,p.asset.serialized);assert.deepEqual(f.e.state.selectedVibeIds,['vibe']);assert.deepEqual(f.e.store.voice,{keep:true});
  assert.ok(f.e.events.indexOf('asset')<f.e.events.indexOf('journal'));assert.ok(f.e.events.indexOf('journal')<f.e.events.indexOf('settings'));assert.equal(f.e.pending.phase,'applied');
  assert.equal([...f.e.checkpoints.values()][0].phase,'assets_ready');assert.equal(f.e.assetClosed,true);assert.equal(await p.file.text(),original);
  assert.match(f.e.lastConfirmation[1],/不含 Comfy/);assert.match(f.e.lastConfirmation[1],/1 份/);
});
test('cancellation and whole-batch capacity refusal cannot stage originals or apply metadata',async()=>{
  const p=await packet();for(const mode of ['cancel','capacity']){const f=createPackageImportFixture(),before=JSON.stringify(f.e.state);if(mode==='cancel')f.e.confirm=false;else f.e.assetLimit=1;
    await f.import(p.file);assert.equal(JSON.stringify(f.e.state),before);assert.equal(f.e.files.size,0);assert.equal(f.e.checkpoints.size,0);assert.equal(f.e.pending,null);assert.equal(f.e.assetClosed,true);
    if(mode==='capacity')assert.match(f.e.notices.at(-1)[0],/空间/);
  }
});
test('interrupted actual stage retains its checkpoint and retries originals without fee work',async()=>{
  const p=await packet(),f=createPackageImportFixture();f.e.failAsset=true;await f.import(p.file);assert.equal(f.e.pending,null);assert.equal(f.e.state.promptMode,'manual');assert.equal([...f.e.checkpoints.values()][0].phase,'staging');
  f.e.failAsset=false;await f.import(p.file);assert.equal(f.e.pending.phase,'applied');assert.equal(f.e.state.promptMode,'combined');assert.equal(f.e.events.filter(x=>x==='asset').length,1);
  // Resuming metadata recovery doesn't re-open the asset stage or replay a generation request.
  f.e.choice='1';await f.recover();assert.equal(f.e.events.filter(x=>x==='asset').length,1);
});
test('asset-only recovery is explicit, current-chat scoped and never deletes originals',async()=>{
  const p=await packet(),f=createPackageImportFixture();f.e.failAsset=true;await f.import(p.file);const row=[...f.e.checkpoints.values()][0];f.e.files.set(p.asset.assetId,p.asset);
  f.e.checkpoints.set('other',{...row,key:'other',chatHash:'b'.repeat(64)});f.e.confirm=false;await f.recover();assert.equal(f.e.checkpoints.size,2);
  f.e.confirm=true;await f.recover();assert.equal(f.e.checkpoints.size,1);assert.ok(f.e.checkpoints.has('other'));assert.equal(f.e.files.get(p.asset.assetId).serialized,p.asset.serialized);assert.equal(f.e.pending,null);
});
test('typed remapping never rewrites frozen Comfy or character account identities',async()=>{
  const p=await packet(),references={version:1,namespace:p.namespace,enabled:false,workflowHash:'a'.repeat(64),items:[{url:'/user/images/source/a.png',name:'source',mime:'image/png',bytes:70,sha256:'b'.repeat(64)}]};
  p.payload.settings.profiles={comfy:{comfyReferences:references}};
  const f=createPackageImportFixture(),{file}=await buildStoryboardVibePackage(p.payload,{namespace:p.namespace,load:async()=>p.asset});await f.import(file);
  assert.equal(f.e.pending.phase,'applied');assert.deepEqual(f.e.state.profiles.comfy.comfyReferences,references);assert.notEqual(references.namespace,f.e.namespace);
  assert.equal(f.e.state.vibeLibrary[0].assetRef.namespace,f.e.namespace);
});
test('unified input accepts old and new files, still rejects unsupported contents instead of silently omitting them',async()=>{
  const p=await packet();assert.equal((await inspectStoryboardPackageFile(p.file,{auto:true})).payload.version,7);
  assert.equal((await inspectStoryboardPackageFile(new Blob([JSON.stringify(p.payload)]),{auto:true})).payload.version,6);
  const raw=JSON.parse(await p.file.text());for(const change of [x=>x.version=99,x=>x.resources={workflows:[]},x=>x.settings.comfyLibrarySelection={id:'lost'},x=>x.chat.characterArchives=[]]){
    const value=structuredClone(raw);change(value);await assert.rejects(()=>inspectStoryboardPackageFile(new Blob([JSON.stringify(value)]),{auto:true}),/不支持/);
  }
  assert.equal(STORYBOARD_PACKAGE_LIMITS.total,128*1048576);assert.equal(STORYBOARD_PACKAGE_INPUT_LIMIT,STORYBOARD_PACKAGE_LIMITS.total);
});
test('default export media reads use actual MIME, bounded streaming and no provider credential',async()=>{
  let options;const bytes=Uint8Array.from(atob(image),c=>c.charCodeAt(0));const blob=await readStoryboardPackageImage('/user/images/test.png',{guard:async()=>{},fetch:async(url,opts)=>{options=opts;return new Response(bytes,{headers:{'content-type':'application/octet-stream'}});}});
  assert.equal(blob.type,'image/png');assert.equal(blob.size,bytes.length);assert.equal(options.credentials,'same-origin');assert.equal(options.headers,undefined);assert.equal(options.signal.aborted,true);
  for(const response of [new Response(bytes,{headers:{'content-length':String(25*1048576)}}),new Response('bad'),new Response('',{status:404})])await assert.rejects(()=>readStoryboardPackageImage('/bad',{guard:async()=>{},fetch:async()=>response}));
});
test('media body growth or context changes cancel the stream before any package download',async()=>{
  let cancelled=0,reads=0;const response=()=>({ok:true,headers:new Headers(),body:{getReader:()=>({read:async()=>({done:false,value:new Uint8Array(8*1048576)}),cancel:async()=>{cancelled++;},releaseLock:()=>{}})}});
  await assert.rejects(()=>readStoryboardPackageImage('/large',{guard:async()=>{},fetch:async()=>response()}),/24 MiB/);assert.equal(cancelled,1);
  await assert.rejects(()=>readStoryboardPackageImage('/changed',{guard:async()=>{if(++reads===3)throw Error('chat changed');},fetch:async()=>response()}),/chat changed/);assert.equal(cancelled,2);
});
