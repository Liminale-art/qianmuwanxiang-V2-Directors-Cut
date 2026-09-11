import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCoreadPackageData,createCoreadImportProgress} from '../qianmu-reader-package.js';
import {isPlainObject} from '../qianmu-storyboard-utils.js';
function fixture(fail=''){
  const calls=[],warnings=[],state={books:[{id:'old',title:'before'},{id:'untouched'}]};
  const blobStore=Object.fromEntries(['putBook','putCover','putReaderChat','putReaderImageByKey','putReaderVectors','bulkPutAudio','pushRetLog'].map(name=>[name,async(...args)=>{
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
  assert.deepEqual(e.calls.map(c=>c[0]),['putBook','putCover','putBook','putReaderChat','putReaderImageByKey','putReaderVectors','bulkPutAudio','pushRetLog','pushRetLog']);
  assert.deepEqual(e.state.books.map(b=>b.id),['new','old','untouched']);assert.equal(e.state.books[1].title,'updated');assert.equal(e.state.books[1].hasCover,true);
  assert.equal(e.calls[0][2].fullText,'new content');assert.equal(e.calls[6][1][0].meta.source,'coread');
  assert.deepEqual(e.calls.slice(-2).map(c=>c[1]),[{at:10},{at:20}]);assert.ok(e.calls.slice(-2).every(c=>c[2]===50));
});
test('moving the writer does not change existing independent failure or invalid-row behavior',async()=>{
  const e=fixture('putBook');e.data.chats.unshift(null);e.data.images.unshift({});
  const result=await applyCoreadPackageData(e.data,e.options);assert.equal(result.ok,0);assert.equal(result.chatOk,1);assert.equal(result.imageOk,1);
  assert.deepEqual(e.state.books,[{id:'old',title:'before'},{id:'untouched'}]);assert.equal(e.warnings.length,2);
  assert.equal(result.failed,2);assert.equal(result.invalid,2);
});
test('legacy book-only packs remain supported without calling absent media categories',async()=>{
  const e=fixture();const result=await applyCoreadPackageData({books:[]},e.options);
  assert.equal(Object.values(result).every(n=>n===0),true);assert.deepEqual(e.calls,[]);
});

for(const method of ['putBook','putCover','putReaderChat','putReaderImageByKey','putReaderVectors','bulkPutAudio','pushRetLog'])test(method+' cannot resume the remaining import after its guard expires',async()=>{
  for(const fail of [false,true]){
    const e=fixture();e.options.progress=createCoreadImportProgress();let release,current=true;
    e.options.check=()=>{if(!current)throw Error('stale import');};
    e.options.blobStore[method]=async(...args)=>{e.calls.push([method,...args]);await new Promise(r=>release=r);if(fail)throw Error('late database failure');return method==='bulkPutAudio'?{added:1}:undefined;};
    const pending=applyCoreadPackageData(e.data,e.options);await new Promise(r=>setImmediate(r));assert.equal(typeof release,'function');
    const before=e.calls.length;current=false;release();await assert.rejects(()=>pending,/stale import/);
    assert.equal(e.calls.length,before,'no subsequent category or record writes');assert.deepEqual(e.warnings,[],'stale state must not be swallowed as an ordinary row failure');
    if(['putBook','putCover'].includes(method))assert.equal(e.state.books[0].title,'before','no stale index writeback');
    if(!fail){const key={putBook:'ok',putCover:'coverOk',putReaderChat:'chatOk',putReaderImageByKey:'imageOk',putReaderVectors:'vectorOk',bulkPutAudio:'audioOk',pushRetLog:'logOk'}[method];assert.ok(e.options.progress[key]>0,'completed work remains counted after the guard throws');}
  }
});
test('an already stale package cannot start its first write',async()=>{
  const e=fixture();e.options.check=()=>{throw Error('stale import');};
  await assert.rejects(()=>applyCoreadPackageData(e.data,e.options),/stale import/);assert.deepEqual(e.calls,[]);
});
