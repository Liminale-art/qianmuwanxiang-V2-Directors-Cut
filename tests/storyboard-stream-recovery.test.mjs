import test from 'node:test';
import assert from 'node:assert/strict';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
import {createStoryboardMessageReference} from '../qianmu-storyboard.js';
import {storyboardStreamGeneration,storyboardStreamGenerationInput,storyboardStreamDigest} from '../qianmu-storyboard-stream-reference.js';
import {createStoryboardStreamCheckpointStorage} from '../qianmu-storyboard-stream-checkpoint-storage.js';
import {createStoryboardStreamFinalStorage} from '../qianmu-storyboard-stream-final-storage.js';
import {probeStoryboardStreamRecovery} from '../qianmu-storyboard-stream-recovery.js';
const namespace='st-user:recovery';
async function fixture(){
  const storage=streamCheckpointTransport(namespace),message={name:'Alice',mes:'Private paragraph.\n\n',send_date:'day-1',gen_started:'generation-1',swipe_id:0};
  const reference=createStoryboardMessageReference({message,chatKey:'chat',floor:9999}),key=await storyboardStreamDigest(storyboardStreamGenerationInput(reference,storyboardStreamGeneration(message)));
  const scope={namespace,chatKey:reference.chatKey,messageKey:reference.messageKey,revisionId:`stream:${key}`,planId:`stream-${key}`};let current=true;
  const probe=overrides=>probeStoryboardStreamRecovery({reference,message,resolveNamespace:async()=>namespace,guard:()=>current,createStorage:storage.createStorage,...overrides});
  return {storage,message,reference,scope,probe,set current(value){current=value;},
    async partial(status='waiting'){
      const client=await createStoryboardStreamCheckpointStorage({scope,guard:()=>true,createStorage:storage.createStorage});
      const record={version:1,requestId:'old',sourceDigest:'a'.repeat(64),prefixLength:10,status:'preparing',passes:1,updatedAt:Date.now()};
      await client.prepare(record);if(status!=='preparing')await client.settle(record,status);client.close();
    },
    async final(status='complete'){
      const client=await createStoryboardStreamFinalStorage({scope:{...scope,sourceRevisionId:reference.revisionId},guard:()=>true,createStorage:storage.createStorage});
      const record={version:1,sourceRevisionId:reference.revisionId,requestId:'old-final',status:'preparing',updatedAt:Date.now()};
      await client.prepare(record);if(status!=='preparing')await client.settle(record,status);client.close();
    },
  };
}

test('new generation recovery uses exactly two deterministic GETs, no listing, writing or prose access',async()=>{
  const f=await fixture();Object.defineProperty(f.message,'mes',{get(){assert.fail('probe must not read prose');}});
  assert.equal(await f.probe(),false);assert.equal(f.storage.calls.length,2);assert.ok(f.storage.calls.every(row=>row.options.method==='GET'&&row.path.startsWith('/user/files/')));
  assert.equal(f.storage.files.size,0);
});

test('ordinary legacy messages lacking stream host identity need neither an account lookup nor storage',async()=>{
  const f=await fixture();delete f.message.gen_started;
  assert.equal(await f.probe({resolveNamespace:async()=>assert.fail('legacy account lookup'),createStorage:async()=>assert.fail('legacy storage')}),false);assert.equal(f.storage.calls.length,0);
});

for(const status of ['preparing','ready','waiting','failed','cancelled'])test(`remote partial ${status} marker is detected without reviving work or needing a local plan`,async()=>{
  const f=await fixture();await f.partial(status);const before=f.storage.calls.length;
  assert.equal(await f.probe(),true);assert.ok(f.storage.calls.slice(before).every(row=>row.options.method==='GET'));assert.equal(f.storage.calls.length-before,3);
});

for(const status of ['preparing','complete','failed','cancelled'])test(`remote final ${status} marker is detected even if no partial record was written`,async()=>{
  const f=await fixture();await f.final(status);assert.equal(await f.probe(),true);
});

test('different current generation, swipe or chat cannot borrow another generation checkpoint',async()=>{
  const f=await fixture();await f.partial();
  for(const [key,value] of [['gen_started','other-generation'],['swipe_id',1]]){
    const message={...f.message,[key]:value},reference=createStoryboardMessageReference({message,chatKey:'chat',floor:9999});assert.equal(await f.probe({message,reference}),false);
  }
  const reference=createStoryboardMessageReference({message:f.message,chatKey:'other-chat',floor:9999});assert.equal(await f.probe({reference}),false);
});

test('read errors and corrupt checkpoint bodies are not absence and never upload or retry',async()=>{
  for(const mode of ['network','corrupt']){
    const f=await fixture();if(mode==='corrupt'){await f.partial();for(const [key,text] of f.storage.files)if(JSON.parse(text).schema==='qianmu.st-account-document.v1')f.storage.files.set(key,'broken');}
    else f.storage.hook=()=>{throw Error('read failed');};
    const before=f.storage.calls.length;await assert.rejects(f.probe());assert.ok(f.storage.calls.slice(before).every(row=>row.options.method==='GET'));
  }
});

test('source/account changes during recovery stop the probe instead of returning an empty result',async()=>{
  for(const mode of ['source','generation','account']){
    const f=await fixture();f.storage.hook=()=>{if(mode==='source')f.current=false;if(mode==='generation')f.message.gen_started='changed';if(mode==='account')f.storage.namespace='st-user:other';};
    await assert.rejects(f.probe());assert.equal(f.storage.files.size,0);
  }
});

test('invalid scopes and malformed host identities never read or write a checkpoint',async()=>{
  const f=await fixture();for(const options of [{reference:{...f.reference,role:'user'}},{message:{...f.message,gen_started:'bad\nidentity'}},{resolveNamespace:async()=>''}])await assert.rejects(f.probe(options));
  assert.equal(f.storage.calls.length,0);
});
