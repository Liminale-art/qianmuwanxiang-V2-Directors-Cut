import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextCollection,restoreTextCollectionCopy} from '../qianmu-text-collection.js';
import {createTextCollectionOutboxEntry,emptyTextCollectionOutbox,validateTextCollectionOutbox,summarizeTextCollectionOutbox,createTextCollectionOutboxStore} from '../qianmu-text-collection-outbox-store.js';
const account='st-user:'+'a'.repeat(64),other='st-user:'+'b'.repeat(64);
const original=()=>createTextCollection({id:'collection-1',createdAt:1,mode:'full',source:{account,chatId:'old-chat',messageId:0,replyId:'reply-0',charName:'角色',userName:'读者',text:'保留\r\n全部原文😀'}});
const request=(extra={})=>({version:1,expectedAccount:account,mutationId:'mutation-1',id:'collection-1',baseRevision:0,operation:'create',record:original(),...extra});
test('pending creation keeps exact request, source, text and identity without claiming server confirmation',()=>{
  const input=request(),row=createTextCollectionOutboxEntry(input,{queuedAt:2});assert.deepEqual(row.request,input);assert.equal(row.state,'pending');assert.equal(row.started,false);
  const state={...emptyTextCollectionOutbox(account),entries:[row]};assert.equal(validateTextCollectionOutbox(state,account),state);
  const summary=summarizeTextCollectionOutbox(state);assert.equal(summary.count,1);assert.equal(summary.pending,1);assert.equal(summary.conflicts,0);assert.equal(summary.scope,'current-account-local');assert.ok(summary.bytes>0);
  assert.doesNotMatch(JSON.stringify(summary),/原文|old-chat|角色|mutation-1/);assert.equal(summarizeTextCollectionOutbox(emptyTextCollectionOutbox(account)).bytes,0);
});
test('offline edits bind the original revision and provenance, while concurrent drafts keep distinct operation IDs',()=>{
  const base=original(),mutation={version:1,expectedAccount:account,mutationId:'mutation-1',id:base.id,baseRevision:1,operation:'edit',text:'尚未同步的修改'};
  const row=createTextCollectionOutboxEntry(mutation,{base,queuedAt:3}),state={...emptyTextCollectionOutbox(account),entries:[row,createTextCollectionOutboxEntry({...mutation,mutationId:'mutation-2',text:'另一页的修改'},{base,queuedAt:4})]};
  validateTextCollectionOutbox(state,account);assert.equal(state.entries[0].base.text,base.text);assert.equal(state.entries[1].request.baseRevision,1);
  for(const changed of [{base:null},{base:{...base,id:'different-id'}},{base:original(),request:{...mutation,baseRevision:2}},{base:restoreTextCollectionCopy(base,{id:'foreign-1',ownerAccount:other,restoredAt:2})}])assert.throws(()=>validateTextCollectionOutbox({...state,entries:[{...row,...changed}]},account));
});
test('strict outbox rejects wrong accounts, destructive work, duplicate identities and malformed conflict states',()=>{
  const row=createTextCollectionOutboxEntry(request(),{queuedAt:2}),state={...emptyTextCollectionOutbox(account),entries:[row]};
  for(const changed of [{namespace:other},{extra:'secret'},{entries:[row,row]},{entries:Array(1)},{entries:[{...row,state:'conflict'}]},{entries:[{...row,queuedAt:NaN}]},
    {entries:[{...row,base:original()}]},{entries:[{...row,request:{...request(),apiKey:'secret'}}]}])assert.throws(()=>validateTextCollectionOutbox({...state,...changed},account));
  const deleted={version:1,expectedAccount:account,mutationId:'mutation-1',id:'collection-1',baseRevision:1,operation:'delete'};assert.throws(()=>createTextCollectionOutboxEntry(deleted));
  const conflict={...row,started:true,state:'conflict'};assert.equal(summarizeTextCollectionOutbox({...state,entries:[conflict]}).conflicts,1);
});
test('store is lazy, uses a separate database and refuses volatile fallback on unavailable IDB',async()=>{
  let opened=0;const store=createTextCollectionOutboxStore({indexedDB:{open(name){opened++;assert.equal(name,'qianmu-text-collection-outbox');throw Error('unavailable');}}});
  assert.equal(opened,0);await assert.rejects(store.read(account),{code:'text_collection_sync_storage'});assert.equal(opened,1);store.close();await assert.rejects(store.read(account),{code:'text_collection_sync_closed'});
});
