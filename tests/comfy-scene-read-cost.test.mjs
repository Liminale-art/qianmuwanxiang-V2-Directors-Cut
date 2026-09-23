import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeComfySceneStore} from '../qianmu-comfy-scene-native-store.js';
import {changeComfySceneRecord,comfySceneScopeKey} from '../qianmu-comfy-scene-lock.js';
import {COMFY_SCENE_SNAPSHOT_SCHEMA,comfySceneSnapshotBytes} from '../qianmu-comfy-scene-backup.js';
import {COMFY_SELECTION_SCHEMA} from '../qianmu-comfy-selection.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {comfySceneIdbFixture,comfySceneJournalFixture} from './helpers/comfy-scene-idb-fixture.mjs';

function oldSource(count){
  const rows=[];
  for(let i=0;i<count;i++){
    const scope={namespace,chatKey:'chat',continuityId:'scene-'+String(i).padStart(4,'0'),narrativeLayer:'present'},lock={schema:COMFY_SELECTION_SCHEMA,scope,poolKey:'a'.repeat(64),candidateId:'candidate',executionKey:'b'.repeat(64)};
    const reserved=changeComfySceneRecord(null,scope,{type:'reserve',lock,expectedRevision:0,attemptId:'old-'+i,ownerId:'old-page',token:'old-token-'+i},100);
    const begun=changeComfySceneRecord(reserved.row,scope,{type:'begin',receipt:reserved.receipt},100);
    const record=changeComfySceneRecord(begun.row,scope,{type:'settle',receipt:reserved.receipt,outcome:'succeeded'},100).row,bytes=comfySceneSnapshotBytes(record);
    rows.push({key:comfySceneScopeKey(scope),value:{namespace,chatKey:'chat',bytes,record}});
  }
  rows.sort((a,b)=>a.key<b.key?-1:1);
  return {schema:COMFY_SCENE_SNAPSHOT_SCHEMA,namespace,usage:{count,bytes:rows.reduce((n,row)=>n+row.value.bytes,0),generation:0},rows};
}

// Measured upper bounds for the unchanged-source path, not a claim that the
// remaining full local scans or one remote file per scene are optimized away.
for(const count of [1,32,128])test(`native scene read-cost baseline with ${count} preserved old scenes`,async t=>{
  const f=await characterNativeFixture(t),source=oldSource(count),old=comfySceneIdbFixture(source),before=structuredClone(old.state.tables);
  const store=createNativeComfySceneStore({legacy:old.open(),journal:comfySceneJournalFixture().open(),createStorage:f.createStorage,now:()=>100});t.after(()=>store.close());
  await store.review(namespace,'chat');const measurements={legacyRows:count};
  for(const mode of ['inspect','review']){
    f.reset();old.state.reads.length=0;old.state.transactions.length=0;const start=performance.now();
    if(mode==='inspect')assert.equal((await store.inspect(source.rows[0].value.record.scope)).established,true);
    else assert.equal((await store.review(namespace,'chat')).rows.length,count);
    const result={legacyTransactions:old.state.transactions.length,cursorSteps:old.state.reads.filter(row=>row.kind==='cursor').length,
      primaryKeyChecks:old.state.reads.filter(row=>row.kind==='keys').length,fileGets:f.calls.filter(call=>call.request.method==='GET').length,uploads:f.uploads,elapsedMs:Math.round(performance.now()-start)};
    assert.ok(result.legacyTransactions<=2);assert.ok(result.cursorSteps<=2*(count+1));assert.ok(result.primaryKeyChecks>=1);
    assert.ok(result.fileGets<=(mode==='inspect'?5:count+4));assert.equal(result.uploads,0);measurements[mode]=result;
  }
  assert.deepEqual(old.state.tables,before);assert.equal(old.state.writes.length,0);
  t.diagnostic(JSON.stringify({...measurements,scope:'isolated ST/IDB protocol, not VPS or browser timing'}));
});
