import test from 'node:test';
import assert from 'node:assert/strict';
import {promoteChatCharacterDraft} from '../qianmu-character-chat-promotion.js';
import {createChatCharacterDraft,editChatCharacterDraft,setChatCharacterDraftStatus} from '../qianmu-character-chat-draft.js';

const owner={namespace:'st-user:alice',chatKey:'chat-a'},id='12345678-1234-4234-8234-123456789abc';
const draft=(scope=owner)=>createChatCharacterDraft({owner:scope,id,source:{kind:'body',chatKey:scope.chatKey,messageKey:'m1',revisionId:'r1',characterId:'C1'},character:{id:'C1',name:'Stranger',identity:['silver hair']}});
function fixture(){
  let current=draft(),active=true;const records=new Map(),calls=[];
  const store={async createOnce(namespace,{id,document},{isCurrent}){
    assert.equal(isCurrent(),true);calls.push({namespace,id});const key=JSON.stringify([namespace,id]),old=records.get(key);
    if(old){if(old.head.version!==1||JSON.stringify(old.document)!==JSON.stringify(document))throw Error('conflict');return {head:structuredClone(old.head),created:false};}
    const record={head:{key,namespace,id,revision:'stored-v1',version:1},document:structuredClone(document)};records.set(key,record);return {head:structuredClone(record.head),created:true};
  },async load(namespace,id){return structuredClone(records.get(JSON.stringify([namespace,id])));}};
  const options={owner,expectedRevision:1,confirmed:true,store,readDraft:()=>current,isCurrent:()=>active,guard:async()=>{if(!active)throw Error('changed');}};
  return {options,records,calls,store,get current(){return current;},set current(value){current=value;},deactivate(){active=false;}};
}

test('explicit promotion returns only after readback, with no draft mutations or automatic bindings',async()=>{
  const f=fixture(),original=JSON.stringify(f.current),result=await promoteChatCharacterDraft(f.current,f.options);
  assert.equal(result.status,'saved');assert.equal(result.created,true);assert.equal(result.automaticBinding,false);assert.match(result.archiveId,/^chatdraft_[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(f.current),original);assert.equal(f.records.size,1);
});

test('repeat after a lost readback uses the same archive ID and does not create a second global record',async()=>{
  const f=fixture(),load=f.store.load;let fail=true;f.store.load=async(...args)=>{if(fail)throw Error('readback failed');return load(...args);};
  let uncertainId='';await assert.rejects(promoteChatCharacterDraft(f.current,f.options),error=>{uncertainId=error.promotionArchiveId;return error.promotionState==='unconfirmed';});assert.equal(f.records.size,1);
  fail=false;const result=await promoteChatCharacterDraft(f.current,f.options);assert.equal(result.created,false);assert.equal(result.archiveId,uncertainId);assert.equal(f.calls[0].id,f.calls[1].id);assert.equal(f.records.size,1);
});

test('creation acknowledgement loss also retries the same committed archive rather than guessing another ID',async()=>{
  const f=fixture(),create=f.store.createOnce;let fail=true;f.store.createOnce=async(...args)=>{const result=await create(...args);if(fail)throw Error('lost acknowledgement');return result;};
  await assert.rejects(promoteChatCharacterDraft(f.current,f.options),{promotionState:'unconfirmed'});fail=false;
  assert.equal((await promoteChatCharacterDraft(f.current,f.options)).created,false);assert.equal(f.records.size,1);
});

test('missing confirmation, stale revision, rejected draft and absent guards fail before storage',async()=>{
  const f=fixture();for(const patch of [{confirmed:false},{expectedRevision:2},{isCurrent:undefined},{readDraft:undefined},{guard:undefined}])await assert.rejects(promoteChatCharacterDraft(f.current,{...f.options,...patch}),{promotionState:'not_started'});
  f.current=setChatCharacterDraftStatus(f.current,'reject',{owner,expectedRevision:1});await assert.rejects(promoteChatCharacterDraft(f.current,{...f.options,expectedRevision:2}),{promotionState:'not_started'});
  assert.equal(f.calls.length,0);
});

test('changes while awaiting account/source guard prevent writing the stale selection',async()=>{
  const f=fixture();f.options.guard=async()=>{f.current=editChatCharacterDraft(f.current,{name:'Edited'},{owner,expectedRevision:1});};
  await assert.rejects(promoteChatCharacterDraft(f.current,f.options),{promotionState:'not_started'});assert.equal(f.calls.length,0);
});

test('context changes after storage retain the archive but do not mark the old draft as saved',async()=>{
  const f=fixture(),create=f.store.createOnce;f.store.createOnce=async(...args)=>{const result=await create(...args);f.deactivate();return result;};
  await assert.rejects(promoteChatCharacterDraft(f.current,f.options),{promotionState:'unconfirmed'});assert.equal(f.records.size,1);assert.equal(f.current.status,'detected');
});

test('wrong readback document, version or scope is never a success receipt',async()=>{
  for(const patch of [record=>{record.head.revision='another';},record=>{record.head.namespace='st-user:other';},record=>{record.head.version=2;},record=>{record.document.name='Other';}]){
    const f=fixture(),load=f.store.load;f.store.load=async(...args)=>{const result=await load(...args);patch(result);return result;};
    await assert.rejects(promoteChatCharacterDraft(f.current,f.options),{promotionState:'unconfirmed'});assert.equal(f.records.size,1);
  }
});

test('later global edits and newer draft revisions do not cause overwrite or a second automatic copy',async()=>{
  const f=fixture();await promoteChatCharacterDraft(f.current,f.options);const record=[...f.records.values()][0];record.head.version=2;record.document.name='Global edit';
  await assert.rejects(promoteChatCharacterDraft(f.current,f.options),{promotionState:'unconfirmed'});assert.equal(record.document.name,'Global edit');assert.equal(f.records.size,1);
  f.current=editChatCharacterDraft(f.current,{name:'New draft'},{owner,expectedRevision:1});
  await assert.rejects(promoteChatCharacterDraft(f.current,{...f.options,expectedRevision:2}),{promotionState:'unconfirmed'});assert.equal(f.records.size,1);assert.equal(f.calls[0].id,f.calls.at(-1).id);
});

test('same temporary UUID or display name in different chats/accounts produces independent fixed identities',async()=>{
  const f=fixture(),results=[];
  for(const scope of [owner,{...owner,chatKey:'chat-b'},{...owner,namespace:'st-user:bob'}]){f.current=draft(scope);results.push(await promoteChatCharacterDraft(f.current,{...f.options,owner:scope}));}
  assert.equal(new Set(results.map(row=>row.archiveId)).size,3);assert.equal(f.records.size,3);
  await assert.rejects(promoteChatCharacterDraft(f.current,f.options),{promotionState:'not_started'});
});
