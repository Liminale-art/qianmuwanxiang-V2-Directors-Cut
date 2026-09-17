import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createNotesSyncRuntime} from '../qianmu-notes-sync-runtime.js';
import {createNotesSyncStore,emptyNotesLocalState,validateNotesLocalState} from '../qianmu-notes-sync-store.js';
import {notesSyncWriteRequest} from '../qianmu-notes-sync-contract.js';

const ns='st-user:fixture',account='st-user:'+createHash('sha256').update('fixture').digest('hex');
let sequence=0;const uid=()=>`fixture_${String(++sequence).padStart(12,'0')}`;
const note=(id='one',body='original',extra={})=>({id,title:'便笺',body,pinned:false,createdAt:10,updatedAt:10,...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function memoryStore(){const states=new Map();let tail=Promise.resolve(),fail=false;
  const serial=work=>{const job=tail.then(work);tail=job.catch(()=>{});return job;};
  return {states,get fail(){return fail;},set fail(value){fail=value;},
    read:namespace=>serial(()=>structuredClone(states.get(namespace)||emptyNotesLocalState(namespace))),
    update:(namespace,work,{guard=()=>true}={})=>serial(()=>{if(fail)throw Error('quota');assert.notEqual(guard(),false);const state=structuredClone(states.get(namespace)||emptyNotesLocalState(namespace));work(state);validateNotesLocalState(state,namespace);assert.notEqual(guard(),false);states.set(namespace,state);return structuredClone(state);}),close(){}};
}
function server(){let revision=0;const rows=new Map(),mutations=new Map(),calls=[];
  const client={async write(input){calls.push(structuredClone(input));const request=notesSyncWriteRequest({version:1,expectedAccount:account,...input}),before=rows.get(input.id),prior=mutations.get(input.mutationId);
    if(prior){assert.equal(prior.request,JSON.stringify(request),'idempotent payload must not change');return structuredClone(prior.response);}
    if((before?.revision||0)!==input.baseRevision||before?.deleted)return {ok:false,version:1,code:'notes_sync_conflict',message:'conflict',writeState:'not_started',expectedAccount:account,revision,note:structuredClone(before||null)};
    const row={id:input.id,...input.note,updatedAt:100+revision,revision:++revision,deleted:input.deleted};
    if(row.deleted){row.title='';row.body='';row.pinned=false;}
    rows.set(row.id,row);const response={ok:true,version:1,expectedAccount:account,revision,note:row};mutations.set(input.mutationId,{request:JSON.stringify(request),response:structuredClone(response)});return structuredClone(response);
  },async list(){return {ok:true,version:1,expectedAccount:account,revision,notes:structuredClone([...rows.values()])};},close(){}};
  return {client,rows,calls,mutations,async edit(id,body){const prior=rows.get(id);return client.write({id,baseRevision:prior?.revision||0,note:{title:prior?.title||'remote',body,pinned:false,createdAt:prior?.createdAt||10},deleted:false,mutationId:uid()});},async remove(id){const prior=rows.get(id);return client.write({id,baseRevision:prior.revision,note:{title:prior.title,body:prior.body,pinned:prior.pinned,createdAt:prior.createdAt},deleted:true,mutationId:uid()});}};
}
const runtime=(store,client=null,extra={})=>createNotesSyncRuntime({namespace:ns,store,client,uid,...extra});

test('all notes including unpinned persist across runtime restart, account-scoped and local-first',async()=>{
  const store=memoryStore(),a=runtime(store);const saved=await a.save(note());assert.equal(saved.localRevision,1);assert.equal(a.status.state,'pending');a.close();
  const b=runtime(store);assert.equal((await b.list())[0].body,'original');assert.equal((await b.list())[0].pinned,false);
  const other=runtime(store,null,{namespace:'st-user:other'});assert.deepEqual(await other.list(),[]);await b.sync();assert.equal(b.status.state,'local-only');
});
test('geometry stays local and geometry-only edits never send another content write',async()=>{
  const store=memoryStore(),service=server(),a=runtime(store,service.client);await a.save(note('one','body',{x:37,width:333,floating:true}));await a.sync();
  const current=(await a.list())[0];await a.save({...current,x:150,width:400,floating:false});await a.sync();
  assert.equal(service.calls.length,1);assert.deepEqual(Object.keys(service.calls[0].note),['title','body','pinned','createdAt']);
  const other=runtime(memoryStore(),service.client);await other.sync();const pulled=(await other.list())[0];assert.equal(pulled.x,24);assert.equal(pulled.width,280);assert.equal(pulled.floating,false);
});
test('same-session queued input snapshots keep call order even when all carry the original local revision',async()=>{
  const store=memoryStore(),a=runtime(store);const first=await a.save(note());await Promise.all(['a','ab','abc'].map(body=>a.save({...first,body})));
  assert.equal((await a.list())[0].body,'abc');assert.equal((await a.list()).length,1);
});
test('another tab stale edit becomes a single conflict copy and subsequent queued snapshots follow it',async()=>{
  const store=memoryStore(),a=runtime(store),b=runtime(store);await a.save(note());const original=(await b.list())[0];
  await a.save({...original,body:'tab A'});
  const saved=await b.save({...original,body:'tab B'});assert.notEqual(saved.id,original.id);
  await b.save({...original,body:'tab B later'});const all=await b.list();assert.equal(all.length,2);assert.equal(all.find(x=>x.id===original.id).body,'tab A');assert.equal(all.find(x=>x.id===saved.id).body,'tab B later');
});
test('late write acknowledgement cannot overwrite newer typing and a new mutation follows the acknowledged base',async()=>{
  const store=memoryStore(),service=server(),entered=deferred(),release=deferred();let once=true;
  const client={...service.client,async write(input){const response=await service.client.write(input);if(once){once=false;entered.resolve();await release.promise;}return response;}};
  const a=runtime(store,client),first=await a.save(note());const syncing=a.sync();await entered.promise;await a.save({...first,body:'newer typing'});release.resolve();await syncing;
  assert.equal((await a.list())[0].body,'newer typing');assert.equal(service.rows.get('one').body,'newer typing');assert.equal(service.calls.length,2);assert.equal(service.calls[1].baseRevision,1);assert.notEqual(service.calls[0].mutationId,service.calls[1].mutationId);
});
test('lost acknowledgement and offline edits retry the identical durable payload before the newer edit',async()=>{
  const store=memoryStore(),service=server();let lose=true;const client={...service.client,async write(input){const response=await service.client.write(input);if(lose){lose=false;throw Error('network lost after write');}return response;}};
  const a=runtime(store,client),first=await a.save(note());await assert.rejects(a.sync());assert.equal(a.status.pending,1);const mutation=service.calls[0].mutationId;
  await a.save({...first,body:'edited offline'});await a.sync();assert.equal(service.calls[1].mutationId,mutation);assert.deepEqual(service.calls[1],service.calls[0]);assert.equal(service.rows.get('one').body,'edited offline');assert.equal(a.status.pending,0);
});
test('durable pending survives reload with the same mutation ID',async()=>{
  const store=memoryStore(),service=server(),a=runtime(store,{...service.client,write:async()=>{throw Error('offline');}});await a.save(note());await assert.rejects(a.sync());
  const pending=(await store.read(ns)).rows[0].pending;a.close();const b=runtime(store,service.client);await b.sync();assert.equal(service.calls[0].mutationId,pending.mutationId);
});
test('server conflict retains both server content and the whole latest local edit under a new ID',async()=>{
  const store=memoryStore(),service=server(),a=runtime(store,service.client);await a.save(note());await a.sync();const first=(await a.list())[0];
  await a.save({...first,body:'local candidate'});await service.edit('one','remote winner');await a.sync();
  const all=await a.list();assert.equal(all.length,2);assert.equal(all.find(x=>x.id==='one').body,'remote winner');const copy=all.find(x=>x.id!=='one');assert.equal(copy.body,'local candidate');assert.equal(copy.syncConflictOf,'one');assert.equal(service.rows.get(copy.id).body,'local candidate');
});
test('deletion conflict does not swallow local original or newer server content',async()=>{
  const store=memoryStore(),service=server(),a=runtime(store,service.client);await a.save(note());await a.sync();const first=(await a.list())[0];
  await a.remove(first.id,{localRevision:first.localRevision});await service.edit('one','server edited');await a.sync();
  const all=await a.list();assert.equal(all.length,2);assert.equal(all.find(x=>x.id==='one').body,'server edited');assert.equal(all.find(x=>x.id!=='one').body,'original');
});
test('remote tombstones persist and a stale local editor creates a new note instead of resurrecting the ID',async()=>{
  const store=memoryStore(),service=server(),a=runtime(store,service.client);await a.save(note());await a.sync();const before=(await a.list())[0];await service.remove('one');await a.sync();assert.deepEqual(await a.list(),[]);
  const copy=await a.save({...before,body:'stale but valuable edit'});assert.notEqual(copy.id,'one');await a.sync();assert.equal(service.rows.get('one').deleted,true);assert.equal(service.rows.get(copy.id).body,'stale but valuable edit');
});
test('delete of never-submitted local creation cancels its pending upload',async()=>{
  const store=memoryStore(),service=server(),a=runtime(store,service.client),first=await a.save(note());await a.remove(first.id,{localRevision:first.localRevision});await a.sync();assert.equal(service.calls.length,0);assert.deepEqual(await a.list(),[]);
});
test('delete after a create was sent but its acknowledgement is pending follows with a real CAS tombstone',async()=>{
  const store=memoryStore(),service=server(),entered=deferred(),release=deferred();let once=true;
  const a=runtime(store,{...service.client,async write(input){const response=await service.client.write(input);if(once){once=false;entered.resolve();await release.promise;}return response;}});
  const first=await a.save(note()),work=a.sync();await entered.promise;await a.remove(first.id,{localRevision:first.localRevision});release.resolve();await work;assert.equal(service.rows.get('one').deleted,true);assert.deepEqual(await a.list(),[]);
});
test('stale deletion in another local tab rejects without deleting the newer content',async()=>{
  const store=memoryStore(),a=runtime(store),b=runtime(store);const first=await a.save(note());await b.list();await a.save({...first,body:'new local version'});
  await assert.rejects(b.remove('one',{localRevision:first.localRevision}),{code:'notes_sync_local_conflict'});assert.equal((await b.list())[0].body,'new local version');
});
test('close and account guard changes reject late responses without applying remote data',async()=>{
  for(const mode of ['close','guard']){const store=memoryStore(),service=server(),entered=deferred(),release=deferred();let valid=true;
    await service.edit('remote','private');const a=runtime(store,{...service.client,async list(){entered.resolve();await release.promise;return service.client.list();}},{guard:()=>valid});const work=a.sync();await entered.promise;
    if(mode==='close')a.close();else valid=false;release.resolve();await assert.rejects(work);assert.equal((await store.read(ns)).rows.length,0);
  }
});
test('wrong-account, duplicated or stale remote snapshots never replace locally known records',async()=>{
  const store=memoryStore(),service=server(),a=runtime(store,service.client);await a.save(note());await a.sync();const state=await store.read(ns);
  for(const mutate of [value=>value.expectedAccount='st-user:'+'0'.repeat(64),value=>value.notes.push(value.notes[0]),value=>{value.revision=0;value.notes=[];}]){
    const b=runtime(store,{...service.client,async list(){const response=await service.client.list();mutate(response);return response;}});await assert.rejects(b.sync());assert.deepEqual(await store.read(ns),state);
  }
});
test('legacy migration requires explicit ownership and a durable receipt, preserves collisions and original inputs',async()=>{
  const store=memoryStore(),a=runtime(store),legacy=[note('one','legacy'),note('two','not pinned')],before=structuredClone(legacy);await a.save(note('one','existing'));
  await assert.rejects(a.importLegacy(legacy,{receipt:'fixture'}),{code:'notes_sync_consent'});
  const result=await a.importLegacy(legacy,{confirmed:true,receipt:'fixture'});assert.equal(result.imported,2);assert.deepEqual(legacy,before);assert.equal((await a.list()).length,3);
  a.close();const b=runtime(store);assert.equal((await b.importLegacy(legacy,{confirmed:true,receipt:'fixture'})).repeated,true);assert.equal((await b.list()).length,3);
});
test('invalid or failed migration and failed save do not become an empty-success or in-memory-only result',async()=>{
  const store=memoryStore(),a=runtime(store);await a.save(note());const before=await store.read(ns);
  await assert.rejects(a.importLegacy([note('a'),note('b','bad\0text')],{confirmed:true,receipt:'invalid'}));assert.deepEqual(await store.read(ns),before);
  store.fail=true;await assert.rejects(a.save(note('new')));await assert.rejects(a.importLegacy([note('a')],{confirmed:true,receipt:'quota'}));store.fail=false;assert.deepEqual(await store.read(ns),before);
});
test('oversized and malformed note text rejects without silently clipping user content',async()=>{
  const a=runtime(memoryStore());for(const invalid of [note('a','x'.repeat(20001)),note('a','\ud800'),note('a','x',{title:'x'.repeat(121)}),note('bad\nid')])await assert.rejects(a.save(invalid));assert.deepEqual(await a.list(),[]);
});
test('store is lazy and refuses unavailable storage instead of pretending notes were saved',async()=>{
  let opens=0;const store=createNotesSyncStore({indexedDB:{open(){opens++;throw Error('unavailable');}}});assert.equal(opens,0);await assert.rejects(store.read(ns),{code:'notes_sync_storage'});await assert.rejects(store.read(ns),{code:'notes_sync_storage'});assert.equal(opens,2);store.close();await assert.rejects(store.read(ns),{code:'notes_sync_closed'});
});
test('synchronization resolves with terminal status rather than a stuck syncing indicator',async()=>{
  const a=runtime(memoryStore(),server().client);await a.save(note());assert.equal((await a.sync()).state,'synced');assert.equal(a.status.state,'synced');
  const b=runtime(memoryStore());await b.save(note());assert.equal((await b.sync()).state,'local-only');assert.equal(b.status.pending,1);
});
test('shared-store parallel synchronizers use the same idempotent pending mutation',async()=>{
  const store=memoryStore(),service=server(),a=runtime(store,service.client),b=runtime(store,service.client);await a.save(note());await Promise.all([a.sync(),b.sync()]);assert.equal(service.mutations.size,1);assert.equal(service.rows.size,1);assert.equal(a.status.pending,0);assert.equal(b.status.pending,0);
});
test('a schema-valid acknowledgement for different content never clears the durable pending note',async()=>{
  const store=memoryStore(),service=server(),a=runtime(store,{...service.client,async write(input){const response=await service.client.write(input);response.note.body='wrong acknowledgement';return response;}});
  await a.save(note());await assert.rejects(a.sync(),{code:'notes_sync_response'});assert.equal((await a.list())[0].body,'original');assert.equal(a.status.pending,1);
});
test('two devices deleting the same note converge to the server tombstone without recreating a copy',async()=>{
  const store=memoryStore(),service=server(),a=runtime(store,service.client);await a.save(note());await a.sync();const original=(await a.list())[0];
  await a.remove('one',{localRevision:original.localRevision});await service.remove('one');await a.sync();assert.deepEqual(await a.list(),[]);assert.equal(a.status.pending,0);assert.equal(a.status.conflicts,0);assert.equal(service.rows.size,1);
});
test('queued typing follows a server-conflict copy even while the editor still sends the original ID and base',async()=>{
  const store=memoryStore(),service=server(),a=runtime(store,service.client);await a.save(note());await a.sync();const original=(await a.list())[0];
  await a.save({...original,body:'first local edit'});await service.edit('one','remote edit');await a.sync();
  await Promise.all(['continued','continued final'].map(body=>a.save({...original,body})));await a.sync();
  const all=await a.list();assert.equal(all.length,2);assert.equal(all.find(row=>row.id==='one').body,'remote edit');assert.equal(all.find(row=>row.id!=='one').body,'continued final');
});
