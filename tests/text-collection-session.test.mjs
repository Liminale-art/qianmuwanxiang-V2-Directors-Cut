import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {createTextCollectionSession} from '../qianmu-text-collection-session.js';
import {createTextCollection} from '../qianmu-text-collection.js';
const account='st-user:'+createHash('sha256').update('alice').digest('hex');
const options=extra=>({resolveNamespace:async()=>'st-user:alice',isCurrent:()=>true,cryptoImpl:webcrypto,...extra});
const item=()=>createTextCollection({id:'collection-1',mode:'full',createdAt:1,source:{account,chatId:'old-chat',messageId:0,replyId:'reply-1',charName:'旧角色',userName:'旧用户',text:'保留原文'}});
const response=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const ack=request=>({ok:true,version:1,expectedAccount:account,mutationId:request.mutationId,id:request.id,revision:request.baseRevision+1,updatedAt:request.record?.updatedAt||2,libraryRevision:request.baseRevision+1});

test('account hash matches backend identity without retaining handle in write payloads',async()=>{
  const sent=[];const s=await createTextCollectionSession(options({fetchImpl:async(_,o)=>{const r=JSON.parse(o.body);sent.push(r);return response(ack(r));}}));
  assert.equal(s.expectedAccount,account);const original=item();await s.prepareCreate(original).submit();
  assert.deepEqual(sent[0].record,original);assert.doesNotMatch(JSON.stringify(sent),/st-user:alice/);s.close();
});
test('one immutable prepared operation survives lost acknowledgement without silent rebase or duplicate identity',async()=>{
  const sent=[];let first=true;const s=await createTextCollectionSession(options({fetchImpl:async(_,o)=>{const r=JSON.parse(o.body);sent.push(r);if(first){first=false;throw Error('lost');}return response(ack(r));}}));
  const source=structuredClone(item()),operation=s.prepareCreate(source);source.text='changed elsewhere';
  await assert.rejects(operation.submit());await operation.submit();assert.deepEqual(sent[0],sent[1]);assert.equal(sent[0].record.text,item().text);
  assert.notEqual(s.prepareCreate(item()).request.mutationId,operation.request.mutationId);s.close();
});
test('editing and deletion preserve captured revision and never ship hidden text on deletion',async()=>{
  const sent=[];const s=await createTextCollectionSession(options({fetchImpl:async(_,o)=>{const r=JSON.parse(o.body);sent.push(r);return response(ack(r));}}));
  await s.prepareEdit('collection-1',1,'编辑正文').submit();await s.prepareDelete('collection-1',1).submit();
  assert.equal(sent[0].baseRevision,1);assert.equal(sent[0].text,'编辑正文');assert.equal(sent[1].baseRevision,1);
  assert.deepEqual(Object.keys(sent[1]).sort(),['version','expectedAccount','mutationId','operation','id','baseRevision'].sort());s.close();
});
test('changed account or invalidated page never sends prepared old-account content',async()=>{
  for(const change of ['account','page','close']){
    let namespace='st-user:alice',current=true,calls=0;const s=await createTextCollectionSession(options({resolveNamespace:async()=>namespace,isCurrent:()=>current,fetchImpl:async()=>{calls++;}}));
    const operation=s.prepareCreate(item());if(change==='account')namespace='st-user:bob';if(change==='page')current=false;if(change==='close')s.close();
    await assert.rejects(operation.submit());assert.equal(calls,0);s.close();assert.throws(()=>s.prepareDelete('collection-1',1));
  }
});
test('initialization rechecks account after hashing and rejects unavailable secure context without network fallback',async()=>{
  let namespace='st-user:alice';const cryptoImpl={subtle:{digest:async(...args)=>{namespace='st-user:bob';return webcrypto.subtle.digest(...args);}}};
  await assert.rejects(createTextCollectionSession(options({resolveNamespace:async()=>namespace,cryptoImpl})),{code:'text_collection_sync_account'});
  await assert.rejects(createTextCollectionSession(options({cryptoImpl:{}})),{code:'text_collection_sync_setup'});
  await assert.rejects(createTextCollectionSession(options({resolveNamespace:async()=>null})),{code:'text_collection_sync_account'});
});
