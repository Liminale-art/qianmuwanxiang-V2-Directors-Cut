import test from 'node:test';
import assert from 'node:assert/strict';
import {createEnsembleStorage} from '../qianmu-ensemble-storage.js';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
const namespace='st-user:ensemble-test';
async function fixture({chatKey='chat-a',transport=streamCheckpointTransport(namespace),isCurrent=()=>true,createStorage}={}){
  let owner=namespace;const store=await createEnsembleStorage({namespace,chatKey,isCurrent,resolveNamespace:async()=>owner,createStorage:createStorage||transport.createStorage});
  return {store,transport,setOwner:next=>{owner=next;transport.namespace=next;}};
}
const add=(current,id='ink')=>({...structuredClone(current),schemes:[...current.schemes,{id,revision:'v1',name:'水墨',description:'留白',tags:['ink'],binding:{routeId:'route-1',artistPresetId:'artist-1'}}]});
const selection=current=>({...structuredClone(current),revision:'selected-1',enabled:true,schemeIds:['ink']});
const posts=transport=>transport.calls.filter(row=>row.options.method==='POST');

test('native ensemble starts with no writes, empty library and disabled new-chat selection; no module or file scan occurs',async()=>{
  const e=await fixture();try{const library=await e.store.readLibrary(),choice=await e.store.readSelection();assert.equal(library.exists,false);assert.equal(choice.exists,false);
    assert.deepEqual(library.value.schemes,[]);assert.equal(choice.value.enabled,false);assert.deepEqual(choice.value.schemeIds,[]);assert.equal(posts(e.transport).length,0);
    assert.equal(e.transport.calls.length,2);assert.ok(e.transport.calls.every(row=>row.path.startsWith('/user/files/')));
  }finally{e.store.close();}
});
test('confirmed ST library and chat selection reopen on another client, while another chat shares only the library',async()=>{
  const e=await fixture();let second,other;try{
    const first=await e.store.readLibrary();await e.store.saveLibrary(add(first.value),first);
    const chosen=await e.store.readSelection();await e.store.saveSelection(selection(chosen.value),chosen);
    second=await fixture({transport:e.transport});assert.equal((await second.store.readLibrary()).value.schemes[0].id,'ink');assert.equal((await second.store.readSelection()).value.enabled,true);
    other=await fixture({chatKey:'chat-b',transport:e.transport});assert.equal((await other.store.readLibrary()).value.schemes[0].id,'ink');assert.equal((await other.store.readSelection()).value.enabled,false);
    assert.ok([...e.transport.files.keys()].filter(name=>name.includes('ensemble-chat-')).every(name=>/-ensemble-chat-[a-f0-9]{64}(?:-[a-f0-9]{64})?\.json$/.test(name)));
  }finally{e.store.close();second?.store.close();other?.store.close();}
});
test('repeated reads reuse immutable verified views and simultaneous first reads share one GET',async()=>{
  const e=await fixture();try{
    const [one,two]=await Promise.all([e.store.readLibrary(),e.store.readLibrary()]);assert.equal(one,two);assert.equal(e.transport.calls.length,1);
    assert.equal(await e.store.readLibrary(),one);assert.equal(e.transport.calls.length,1);assert.ok(Object.isFrozen(one.value.schemes));
    await e.store.readLibrary({fresh:true});assert.equal(e.transport.calls.length,2);
  }finally{e.store.close();}
});
test('explicit refresh gets another client update, and stale writes never overwrite that remote version',async()=>{
  const e=await fixture(),other=await fixture({transport:e.transport});try{
    const old=await e.store.readLibrary(),remote=await other.store.readLibrary();await other.store.saveLibrary(add(remote.value),remote);
    assert.equal((await e.store.readLibrary()).value.schemes.length,0);
    await assert.rejects(e.store.saveLibrary(add(old.value,'cg'),old),{code:'st_account_storage_conflict'});
    const fresh=await e.store.readLibrary({fresh:true});assert.deepEqual(fresh.value.schemes.map(r=>r.id),['ink']);
  }finally{e.store.close();other.store.close();}
});
test('only views issued by the same account/chat store and the correct document kind can authorize a write',async()=>{
  const e=await fixture(),other=await fixture({transport:e.transport});try{
    const lib=await e.store.readLibrary(),foreign=await other.store.readLibrary();
    await assert.rejects(e.store.saveLibrary(add(lib.value),{...lib}),{code:'ensemble_storage'});await assert.rejects(e.store.saveLibrary(add(lib.value),foreign),{code:'ensemble_storage'});
    await assert.rejects(e.store.saveSelection(selection((await e.store.readSelection()).value),lib),{code:'ensemble_storage'});assert.equal(posts(e.transport).length,0);
  }finally{e.store.close();other.store.close();}
});
test('cached library reads and all saves still verify the live account and closed lifecycle',async()=>{
  const e=await fixture(),lib=await e.store.readLibrary(),count=e.transport.calls.length;e.setOwner('st-user:other');
  await assert.rejects(e.store.readLibrary(),{code:'ensemble_storage'});await assert.rejects(e.store.saveLibrary(add(lib.value),lib),{code:'ensemble_storage'});assert.equal(e.transport.calls.length,count);
  e.store.close();await assert.rejects(e.store.readSelection(),{code:'ensemble_storage'});
});
test('login and service failures are not treated as empty libraries and do not write fallback data',async()=>{
  for(const status of [401,403,405,500]){const e=await fixture();try{
    e.transport.hook=({json})=>json({},status);await assert.rejects(e.store.readLibrary());assert.equal(posts(e.transport).length,0);
  }finally{e.store.close();}}
});
test('invalid or cross-account documents fail instead of overwriting or normalizing into an empty library',async()=>{
  for(const change of [v=>v.schema='future',v=>v.namespace='st-user:other']){
    const e=await fixture(),raw=await e.transport.createStorage({});try{
      const initial=await e.store.readLibrary(),bad=add(initial.value);change(bad);await raw.write('ensemble-library',bad,{expectedFingerprint:null});
      const writes=posts(e.transport).length;await assert.rejects(e.store.readLibrary({fresh:true}),error=>['storyboard_style_selection','ensemble_storage'].includes(error.code));assert.equal(posts(e.transport).length,writes);
    }finally{e.store.close();raw.close();}
  }
});
test('lost upload acknowledgement causes one attempt only, retains original views and does not warm cache with unconfirmed data',async()=>{
  const e=await fixture();try{
    const prior=await e.store.readLibrary();let uploads=0;e.transport.hook=({path})=>{if(path==='/api/files/upload'){uploads++;throw Error('lost acknowledgement');}};
    await assert.rejects(e.store.saveLibrary(add(prior.value),prior),error=>error.writeState==='unconfirmed');assert.equal(uploads,1);assert.deepEqual(prior.value.schemes,[]);
    e.transport.hook=null;assert.equal((await e.store.readLibrary()).value.schemes.length,0);
  }finally{e.store.close();}
});
test('save captures the requested edit before yielding, omits credential fields and leaves all earlier immutable bodies intact',async()=>{
  const e=await fixture();try{
    const prior=await e.store.readLibrary(),next=add(prior.value);next.schemes[0].apiKey='must-not-store';const write=e.store.saveLibrary(next,prior);next.schemes[0].name='later edit';
    const saved=await write;assert.equal(saved.value.schemes[0].name,'水墨');const files=[...e.transport.files.keys()];
    const updated=add(saved.value,'cg');await e.store.saveLibrary(updated,saved);assert.ok(files.every(name=>e.transport.files.has(name)));
    assert.doesNotMatch([...e.transport.files.values()].join('\n'),/must-not-store|apiKey|later edit/);assert.ok(e.transport.calls.every(row=>row.options.method!=='DELETE'));
  }finally{e.store.close();}
});
test('selection changes require a fresh revision and cannot cross their original chat',async()=>{
  const e=await fixture();try{
    const current=await e.store.readSelection();await assert.rejects(e.store.saveSelection({...current.value,enabled:true},current),{code:'ensemble_storage'});
    await assert.rejects(e.store.saveSelection({...selection(current.value),chatKey:'other'},current),{code:'storyboard_style_selection'});assert.equal(posts(e.transport).length,0);
  }finally{e.store.close();}
});

test('refresh failures retire cached views instead of returning old account data on the next open',async()=>{
  const e=await fixture();try{await e.store.readLibrary();e.transport.hook=({json})=>json({},401);
    await assert.rejects(e.store.readLibrary({fresh:true}));await assert.rejects(e.store.readLibrary());assert.equal(e.transport.calls.length,3);
  }finally{e.store.close();}
});
test('mutating a saved scheme requires a new revision, and the prior immutable version remains recoverable',async()=>{
  const e=await fixture();try{const empty=await e.store.readLibrary(),saved=await e.store.saveLibrary(add(empty.value),empty),changed=structuredClone(saved.value);
    changed.schemes[0].description='新的表现';const writes=posts(e.transport).length;await assert.rejects(e.store.saveLibrary(changed,saved),{code:'ensemble_storage'});assert.equal(posts(e.transport).length,writes);
    changed.schemes[0].revision='v2';const next=await e.store.saveLibrary(changed,saved);assert.equal(next.value.schemes[0].revision,'v2');assert.equal(saved.value.schemes[0].description,'留白');
  }finally{e.store.close();}
});
test('concurrent duplicate saves are not retried or merged, and reads cannot substitute stale content while a save is pending',async()=>{
  const e=await fixture();let release,reached;const started=new Promise(r=>{reached=r;});const gate=new Promise(r=>{release=r;});try{
    const old=await e.store.readLibrary();let held=false;e.transport.hook=async({path})=>{if(path==='/api/files/upload'&&!held){held=true;reached();await gate;}};
    const saving=e.store.saveLibrary(add(old.value),old);await started;
    await assert.rejects(e.store.saveLibrary(add(old.value,'cg'),old),{code:'ensemble_storage'});await assert.rejects(e.store.readLibrary(),{code:'ensemble_storage'});
    release();const saved=await saving;assert.deepEqual(saved.value.schemes.map(row=>row.id),['ink']);assert.equal(posts(e.transport).length,2);
  }finally{release?.();e.store.close();}
});
test('closing during an outstanding native read cancels it and cannot deliver or cache a late view',async()=>{
  const e=await fixture();let release,reached;const started=new Promise(r=>{reached=r;});const gate=new Promise(r=>{release=r;});
  e.transport.hook=async()=>{reached();await gate;};const reading=e.store.readLibrary();const rejected=assert.rejects(reading);
  await started;e.store.close();release();await rejected;await assert.rejects(e.store.readLibrary(),{code:'ensemble_storage'});
});

test('global style library is editable without an active chat, but no invented chat selection is stored',async()=>{
  const e=await fixture({chatKey:null});let chat;try{
    const library=await e.store.readLibrary();await e.store.saveLibrary(add(library.value),library);
    await assert.rejects(e.store.readSelection(),{code:'ensemble_storage'});await assert.rejects(e.store.saveSelection({},library),{code:'ensemble_storage'});
    chat=await fixture({transport:e.transport});assert.equal((await chat.store.readLibrary()).value.schemes[0].id,'ink');assert.equal((await chat.store.readSelection()).value.enabled,false);
    assert.equal([...e.transport.files.keys()].filter(name=>name.includes('ensemble-chat-')).length,0);
  }finally{e.store.close();chat?.store.close();}
});
