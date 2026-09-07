import test from 'node:test';
import assert from 'node:assert/strict';
import {createVibeLibraryAssets} from '../qianmu-vibe-library-assets.js';
const namespace='st-user:one',assetId='a'.repeat(64),assetRef={version:1,namespace,id:assetId};
const head=(id=assetId)=>({assetId:id,summary:{name:'Imported'},defaults:{strength:0,information:0}});
function setup(call=async()=>[head()]){
  const state={vibeLibrary:[]},notices=[];let saves=0,at=0,current=true,account=namespace;
  const service=createVibeLibraryAssets({state,namespace,call,guard:async()=>{if(account!==namespace)throw Error('account changed');},isCurrent:()=>current,
    publish:()=>saves++,uid:()=>`asset-${++at}`,notify:text=>notices.push(text)});
  return {state,service,notices,saves:()=>saves,setCurrent:value=>current=value,setAccount:value=>account=value};
}
test('file import publishes one atomic lightweight library update, preserves zero and deduplicates the same file/defaults',async()=>{
  const e=setup();await e.service.import(new Blob(['mock']));assert.equal(e.saves(),1);assert.equal(e.state.vibeLibrary.length,1);
  assert.deepEqual(e.state.vibeLibrary[0].assetRef,assetRef);assert.equal(e.state.vibeLibrary[0].strength,0);assert.equal(e.state.vibeLibrary[0].informationExtracted,0);
  await e.service.import(new Blob(['mock']));assert.equal(e.saves(),1);assert.match(e.notices[1],/已在库中/);
});

test('adopting a recovered receipt reads the exact variant defaults, preserves zero and leaves current selections alone',async()=>{
  const selection={model:'nai-diffusion-4-full',information:0,expectedSourceId:'b'.repeat(64)},calls=[];
  const e=setup(async(type,args)=>{calls.push({type,...args});return {name:'Recovered',defaults:{strength:0,information:args.information}};});
  e.state.selectedVibeIds=['existing'];await e.service.adopt(assetRef,selection);
  assert.equal(calls[0].type,'library-info');assert.equal(calls[0].information,0);assert.equal(calls[0].expectedSourceId,selection.expectedSourceId);
  assert.equal(e.state.vibeLibrary[0].strength,0);assert.equal(e.state.vibeLibrary[0].informationExtracted,0);assert.deepEqual(e.state.selectedVibeIds,['existing']);
  await e.service.adopt(assetRef,selection);assert.equal(e.saves(),1);
  await e.service.adopt(assetRef,{...selection,information:.7});assert.equal(e.saves(),2);assert.equal(e.state.vibeLibrary.length,2);
});

test('adopting does not publish after concurrent library, account or page changes',async()=>{
  for(const change of [e=>e.setCurrent(false),e=>e.setAccount('st-user:two'),e=>e.state.vibeLibrary.push({id:'external'})]){
    let release;const e=setup(()=>new Promise(resolve=>release=resolve));
    const request=e.service.adopt(assetRef,{model:'nai-diffusion-4-full',information:0});await new Promise(resolve=>setImmediate(resolve));change(e);
    const before=structuredClone(e.state);release({name:'Recovered',defaults:{strength:0,information:0}});
    await assert.rejects(request);assert.deepEqual(e.state,before);assert.equal(e.saves(),0);
  }
});
test('stored assets never imply a late library write after account, page, cancellation, content or capacity changes',async()=>{
  for(const change of [e=>e.setCurrent(false),e=>e.setAccount('st-user:two'),e=>e.state.vibeLibrary.push({id:'external'}),e=>e.active=false]){
    let release;const e=setup(()=>new Promise(resolve=>release=resolve));e.active=true;
    const request=e.service.import(new Blob(['mock']),()=>e.active);await new Promise(resolve=>setImmediate(resolve));change(e);const before=structuredClone(e.state);release([head()]);
    await assert.rejects(request);assert.deepEqual(e.state,before);assert.equal(e.saves(),0);
  }
  const e=setup(async()=>[head(),head('b'.repeat(64))]);e.state.vibeLibrary=Array.from({length:499},(_,i)=>({id:`old-${i}`}));const before=structuredClone(e.state);
  await assert.rejects(()=>e.service.import(new Blob(['mock'])),/库已满/);assert.deepEqual(e.state,before);assert.equal(e.saves(),0);
});
test('preview and validation use the exact account/model/IE; original bytes are read only when expressly requested',async()=>{
  const calls=[],e=setup(async(type,options)=>{calls.push({type,...options});return null;});
  assert.equal(await e.service.preview(assetRef),null);assert.deepEqual(calls.map(row=>row.type),['preview']);
  await e.service.preview(assetRef,{original:true});assert.deepEqual(calls.map(row=>row.type),['preview','preview','original-preview']);
  await e.service.validate([{assetRef,informationExtracted:0}],'nai-diffusion-4-full');assert.equal(calls.at(-1).information,0);assert.equal(calls.at(-1).model,'nai-diffusion-4-full');
  const count=calls.length;await assert.rejects(()=>e.service.preview({...assetRef,namespace:'st-user:two'}),/账户/);assert.equal(calls.length,count);
});
test('export sends edited defaults, explicitly preserves bundle intent, and discards a download after concurrent library edits',async()=>{
  let last,release;const e=setup(async(type,options)=>{last={type,...options};return new Promise(resolve=>release=resolve);});
  const row={id:'one',name:'Edited',assetRef,strength:0,informationExtracted:.7};e.state.vibeLibrary=[row];
  const run=e.service.export([row],{bundle:true});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(last.settings,[{name:'Edited',strength:0,information:.7}]);assert.equal(last.bundle,true);release(new Blob(['{}']));assert.ok(await run instanceof Blob);
  const pending=e.service.export([row]);await new Promise(resolve=>setImmediate(resolve));row.name='changed';release(new Blob(['{}']));await assert.rejects(pending,/已变化/);
  await assert.rejects(()=>e.service.export([{id:'url'}]),/已导入/);
});
