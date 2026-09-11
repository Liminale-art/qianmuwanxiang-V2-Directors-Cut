import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {cleanupReaderWorldMirrors} from '../qianmu-reader-book-cleanup.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

test('world cleanup only changes namespaced entries and requires a readback',async()=>{
  const rows=[{uid:1,id:'coread::a::slice',content:'secret',disable:false},{uid:2,id:'coread::ab::slice',content:'keep',disable:false}],calls=[];
  const options={names:['original','original'],isCurrent:()=>true,logicalId:e=>e.id,readEntries:async name=>{calls.push(name);return structuredClone(rows);},disableEntry:async(name,uid)=>{rows.find(e=>e.uid===uid).content='';rows.find(e=>e.uid===uid).disable=true;}};
  const result=await cleanupReaderWorldMirrors('a',options);
  assert.equal(result.status,'complete');assert.equal(result.entries,1);assert.deepEqual(calls,['original','original']);assert.equal(rows[1].content,'keep');
  assert.equal((await cleanupReaderWorldMirrors('a',options)).entries,0,'a retry does not reapply completed changes');
});
test('unknown, rejected and unverified world cleanup stop instead of reporting an empty success',async()=>{
  for(const failure of ['read','write','verify','shape']){
    const calls=[];const result=await cleanupReaderWorldMirrors('a',{names:['original','next'],isCurrent:()=>true,logicalId:e=>e.id,
      readEntries:async name=>{calls.push(name);if(failure==='read')throw Error('unavailable');if(failure==='shape')return {};return [{uid:1,id:'coread::a::s',content:'not yet cleared'}];},
      disableEntry:async()=>{if(failure==='write')throw Error('rejected');}});
    assert.equal(result.status,'failed',failure);assert.deepEqual(result.failedBooks,['original']);assert.ok(!calls.includes('next'));
  }
});
test('changing chats between entries never redirects the remaining writes',async()=>{
  let current=true;const calls=[];
  const result=await cleanupReaderWorldMirrors('a',{names:['old','new'],isCurrent:()=>current,logicalId:e=>e.id,
    readEntries:async()=>[{uid:1,id:'coread::a::1'},{uid:2,id:'coread::a::2'}],disableEntry:async(name,uid)=>{calls.push([name,uid]);current=false;}});
  assert.equal(result.status,'stale');assert.deepEqual(calls,[['old',1]]);
});
test('host adapter freezes only existing worldbooks and never creates or silently tolerates failed commands',async()=>{
  for(const scenario of ['ok','absent','switch','write-error','http-error']){
    const rows=[{uid:1,id:'coread::a::1',content:'memory',disable:false}],calls=[],context={chatMetadata:{world_info:'original'},getRequestHeaders:()=>({})};
    context.executeSlashCommandsWithOptions=async command=>{calls.push(command);if(scenario==='write-error')throw Error('rejected');if(command.includes('field=content'))rows[0].content='';else rows[0].disable=true;return {};};
    const c=vm.createContext({ctx:()=>context,contextScanCache:{worldBooks:{}},COREAD_DEDICATED_BOOK:'dedicated',cleanupReaderWorldMirrors,coreadEntryLogicalId:e=>e.id,quoteSlashValue:s=>JSON.stringify(s),
      fetch:async(path,options)=>{calls.push([path,options.method,JSON.parse(options.body)]);if(scenario==='http-error')return {ok:false};return {ok:true,json:async()=>{
        if(path.endsWith('/list')){if(scenario==='switch')context.chatMetadata={world_info:'replacement'};return scenario==='absent'?[]:[{file_id:'original',name:'display name'}];}
        return {entries:structuredClone(rows)};
      }};}});
    vm.runInContext(section('coreadPurgeBookMemory'),c);
    if(['switch','write-error','http-error'].includes(scenario))await assert.rejects(c.coreadPurgeBookMemory('a',()=>true));
    else assert.equal((await c.coreadPurgeBookMemory('a',()=>true)).status,'complete');
    assert.ok(calls.every(call=>typeof call!=='string'||call.startsWith('/setentryfield file="original" uid="1"')));
    assert.ok(!JSON.stringify(calls).includes('/getchatbook'));assert.ok(!calls.some(call=>Array.isArray(call)&&call[0].endsWith('/edit')));
    if(scenario==='absent'||scenario==='switch')assert.equal(calls.length,1);
  }
});
