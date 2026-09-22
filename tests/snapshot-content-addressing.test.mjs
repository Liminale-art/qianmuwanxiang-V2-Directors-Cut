import test from 'node:test';
import assert from 'node:assert/strict';
import {writePreservedSnapshotArchives,writePreservedPlanArchives} from '../qianmu-plan-archive-write.js';
import {vibeDigest} from '../qianmu-vibe-file.js';

// A bounded transaction event fixture, not browser IndexedDB acceptance.
function database(initial=[]){
  const files=new Map(initial);
  return {files,transaction(){
    const staged=new Map(files);let pending=0,closed=false;
    const tx={abort(){if(closed)return;closed=true;tx.onabort?.();},objectStore(){return {get:key=>request(()=>staged.get(key)),add:(value,key)=>request(()=>{if(staged.has(key))throw Error('duplicate');staged.set(key,structuredClone(value));return key;})};}};
    function request(work){const result={};pending++;queueMicrotask(()=>{if(closed)return;try{result.result=structuredClone(work());result.onsuccess?.();}catch(error){tx.error=error;tx.abort();}pending--;if(!pending&&!closed)queueMicrotask(()=>{if(closed||pending)return;closed=true;files.clear();for(const entry of staged)files.set(...entry);tx.oncomplete?.();});});return result;}
    return tx;
  }};
}
test('new snapshots are content addressed on their first write while old base rows remain byte-for-byte intact',async()=>{
  const base='chat\u241fone',original={key:base,chatKey:'chat',recordId:'one',snapshot:{prompt:'old'}},db=database([[base,original]]);
  const row={...original,snapshot:{prompt:'new',payload:{seed:0}}},key=base+'\u241frevision:'+await vibeDigest(JSON.stringify(['chat','one',row.snapshot]));
  assert.deepEqual(await writePreservedSnapshotArchives(db,'snapshots',[row]),{stored:[key]});assert.deepEqual(db.files.get(base),original);assert.deepEqual(db.files.get(key),{...row,key});
  assert.deepEqual(await writePreservedSnapshotArchives(db,'snapshots',[row]),{stored:[key]});assert.equal(db.files.size,2);
  const fresh=database();assert.deepEqual(await writePreservedSnapshotArchives(fresh,'snapshots',[row]),{stored:[key]});assert.equal(fresh.files.has(base),false);
});
test('content-addressed snapshot collision aborts without changing previous variants or old plan key behavior',async()=>{
  const row={key:'chat\u241fone',chatKey:'chat',recordId:'one',snapshot:{prompt:'correct'}},key=row.key+'\u241frevision:'+await vibeDigest(JSON.stringify(['chat','one',row.snapshot]));
  const prior={...row,key,snapshot:{prompt:'corrupt'}},db=database([[key,prior]]);
  await assert.rejects(writePreservedSnapshotArchives(db,'snapshots',[row]));assert.deepEqual([...db.files],[[key,prior]]);
  const plan={key:'chat\u241fplan',chatKey:'chat',planId:'plan',plan:{shots:[]}},plans=database();
  assert.deepEqual(await writePreservedPlanArchives(plans,'plans',[plan]),{stored:[plan.key]});assert.deepEqual(plans.files.get(plan.key),plan);
});
