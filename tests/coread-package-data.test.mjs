import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCoreadPackageData,createCoreadImportProgress} from '../qianmu-reader-package.js';
import {isPlainObject} from '../qianmu-storyboard-utils.js';
function fixture(fail=''){
  const calls=[],warnings=[],state={books:[{id:'old',title:'before'},{id:'untouched'}]};
  const blobStore=Object.fromEntries(['putBookWithCover','putReaderChat','putReaderImageByKey','putReaderVectors','bulkPutAudio','pushRetLog'].map(name=>[name,async(...args)=>{
    if(name==='bulkPutAudio')args[0]=Array.from(args[0]);
    calls.push([name,...args]);if(name===fail)throw Error('synthetic failure');return name==='bulkPutAudio'?{added:1}:undefined;
  }]));
  const options={blobStore,coread:()=>state,isPlainObject,base64ToBlob:(data,mime)=>({data,mime}),warn:(...args)=>warnings.push(args)};
  const data={books:[{meta:{id:'old',title:'updated'},fullText:'new content',coverB64:'cover'},{meta:{id:'new',title:'added'}}],
    chats:[{key:'chat::old',rec:{messages:['fixture']}}],images:[{key:'old::1',b64:'image'}],vectors:[{key:'chat::old',rec:{vecs:{}}}],
    audio:[{key:'audio',b64:'sound',meta:{source:'old'},createdAt:10}],retrievalLogs:[{id:2,at:20},{id:1,at:10}]};
  return {calls,warnings,state,options,data};
}
test('the extracted writer retains store order, overwrite semantics, metadata and counts',async()=>{
  const e=fixture(),result=await applyCoreadPackageData(e.data,e.options);
  assert.deepEqual(result,{ok:2,coverOk:1,chatOk:1,imageOk:1,vectorOk:1,audioOk:1,logOk:2,failed:0,invalid:0,skipped:0});
  assert.deepEqual(e.calls.map(c=>c[0]),['putBookWithCover','putBookWithCover','putReaderChat','putReaderImageByKey','putReaderVectors','bulkPutAudio','pushRetLog','pushRetLog']);
  assert.deepEqual(e.state.books.map(b=>b.id),['new','old','untouched']);assert.equal(e.state.books[1].title,'updated');assert.equal(e.state.books[1].hasCover,true);
  assert.equal(e.calls[0][2].fullText,'new content');assert.deepEqual(e.calls[0][3],{data:'cover',mime:'image/jpeg'});assert.equal(e.calls[1][3],null);assert.equal(e.calls[5][1][0].meta.source,'coread');
  assert.deepEqual(e.calls.slice(-2).map(c=>c[1]),[{at:10},{at:20}]);assert.ok(e.calls.slice(-2).every(c=>c[2]===50));
});
test('moving the writer does not change existing independent failure or invalid-row behavior',async()=>{
  const e=fixture('putBookWithCover');e.data.chats.unshift(null);e.data.images.unshift({});
  const result=await applyCoreadPackageData(e.data,e.options);assert.equal(result.ok,0);assert.equal(result.chatOk,1);assert.equal(result.imageOk,1);
  assert.deepEqual(e.state.books,[{id:'old',title:'before'},{id:'untouched'}]);assert.equal(e.warnings.length,2);
  assert.equal(result.failed,2);assert.equal(result.invalid,2);
  assert.equal(result.coverOk,0,'a failed book-cover unit cannot publish a saved cover');
});

test('cover decoding failure occurs before overwriting its book and does not claim saved metadata',async()=>{
  const e=fixture();e.options.base64ToBlob=(data,mime)=>{if(data==='cover')throw Error('decode failed');return {data,mime};};
  const result=await applyCoreadPackageData(e.data,e.options);
  assert.equal(result.ok,1);assert.equal(result.coverOk,0);assert.equal(result.failed,1);
  assert.equal(e.calls.some(call=>call[0]==='putBookWithCover'&&call[1]==='old'),false);
  assert.equal(e.state.books.find(book=>book.id==='old').title,'before');
  assert.equal(result.chatOk,1,'independent categories keep their existing partial-import behavior');
});
test('legacy book-only packs remain supported without calling absent media categories',async()=>{
  const e=fixture();const result=await applyCoreadPackageData({books:[]},e.options);
  assert.equal(Object.values(result).every(n=>n===0),true);assert.deepEqual(e.calls,[]);
});

for(const method of ['putBookWithCover','putReaderChat','putReaderImageByKey','putReaderVectors','bulkPutAudio','pushRetLog'])test(method+' cannot resume the remaining import after its guard expires',async()=>{
  for(const fail of [false,true]){
    const e=fixture();e.options.progress=createCoreadImportProgress();let release,current=true;
    e.options.check=()=>{if(!current)throw Error('stale import');};
    e.options.blobStore[method]=async(...args)=>{e.calls.push([method,...args]);await new Promise(r=>release=r);if(fail)throw Error('late database failure');return method==='bulkPutAudio'?{added:1}:undefined;};
    const pending=applyCoreadPackageData(e.data,e.options);await new Promise(r=>setImmediate(r));assert.equal(typeof release,'function');
    const before=e.calls.length;current=false;release();await assert.rejects(()=>pending,/stale import/);
    assert.equal(e.calls.length,before,'no subsequent category or record writes');assert.deepEqual(e.warnings,[],'stale state must not be swallowed as an ordinary row failure');
    if(method==='putBookWithCover')assert.equal(e.state.books[0].title,'before','no stale index writeback');
    if(!fail){const key={putBookWithCover:'ok',putReaderChat:'chatOk',putReaderImageByKey:'imageOk',putReaderVectors:'vectorOk',bulkPutAudio:'audioOk',pushRetLog:'logOk'}[method];assert.ok(e.options.progress[key]>0,'completed work remains counted after the guard throws');if(method==='putBookWithCover')assert.equal(e.options.progress.coverOk,1,'both committed originals remain counted');}
  }
});
test('an already stale package cannot start its first write',async()=>{
  const e=fixture();e.options.check=()=>{throw Error('stale import');};
  await assert.rejects(()=>applyCoreadPackageData(e.data,e.options),/stale import/);assert.deepEqual(e.calls,[]);
});

test('audio batch reports committed rows before interruption without losing previous failures',async()=>{
  const e=fixture('putBookWithCover');e.options.progress=createCoreadImportProgress();let current=true;
  e.options.check=()=>{if(!current)throw Error('stale import');};
  e.options.blobStore.bulkPutAudio=async(entries,{onProgress})=>{
    onProgress({added:2,skipped:1,failed:1});current=false;throw Error('late interruption');
  };
  await assert.rejects(()=>applyCoreadPackageData(e.data,e.options),/stale import/);
  assert.equal(e.options.progress.audioOk,2);assert.equal(e.options.progress.skipped,1);
  assert.equal(e.options.progress.failed,3,'two earlier book failures plus one audio failure');
  assert.equal(e.options.progress.logOk,0);
});

test('audio is decoded only as the writer requests it, not all at once before the first commit',async()=>{
  const e=fixture(),events=[];let release;
  const data={books:[],audio:[{key:'a',b64:'a'},{key:'b',b64:'b'}]};
  e.options.base64ToBlob=data=>{events.push('decode:'+data);return {data};};
  e.options.blobStore.bulkPutAudio=async(entries,{onProgress})=>{
    assert.equal(Array.isArray(entries),false);let added=0;
    for(const entry of entries){events.push('write:'+entry.key);if(entry.key==='a')await new Promise(r=>release=r);onProgress({added:++added,skipped:0,failed:0});}
    return {added,skipped:0,failed:0};
  };
  const pending=applyCoreadPackageData(data,e.options);await new Promise(r=>setImmediate(r));
  assert.deepEqual(events,['decode:a','write:a']);release();const result=await pending;
  assert.deepEqual(events,['decode:a','write:a','decode:b','write:b']);assert.equal(result.audioOk,2);
});

test('lazy decoder failures remain counted alongside earlier and per-audio write failures',async()=>{
  const e=fixture('putBookWithCover');e.data.audio=[{key:'a',b64:'ok'},{key:'b',b64:'bad'},{key:'c',b64:'ok'}];
  e.options.base64ToBlob=data=>{if(data==='bad')throw Error('decode failed');return {data};};
  e.options.blobStore.bulkPutAudio=async(entries,{onProgress})=>{
    const result={added:0,failed:0,skipped:0};for(const entry of entries){result[entry.key==='a'?'failed':'added']++;onProgress({...result});}return result;
  };
  const result=await applyCoreadPackageData(e.data,e.options);assert.equal(result.failed,4);assert.equal(result.audioOk,1);assert.equal(result.logOk,2);
});

test('a scope change after one audio commit stops before decoding the next original',async()=>{
  const e=fixture(),decoded=[];let current=true;e.options.progress=createCoreadImportProgress();
  e.options.check=()=>{if(!current)throw Error('stale import');};
  e.options.base64ToBlob=data=>{decoded.push(data);return {data};};
  e.options.blobStore.bulkPutAudio=async(entries,{onProgress})=>{for(const _ of entries){onProgress({added:1});current=false;}return {added:1};};
  await assert.rejects(applyCoreadPackageData({books:[],audio:[{key:'a',b64:'one'},{key:'b',b64:'two'}]},e.options),/stale import/);
  assert.deepEqual(decoded,['one']);assert.equal(e.options.progress.audioOk,1);
});
