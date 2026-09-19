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

test('batch handles preserve identities through loss, reject partial receipts and never fall back to single writes',async()=>{
  const sent=[];let mode='lost';const s=await createTextCollectionSession(options({fetchImpl:async(url,o)=>{
    assert.match(url,/\/write-batch$/);const request=JSON.parse(o.body);sent.push(request);if(mode==='lost')throw Error('lost');
    const results=request.mutations.map((r,i)=>({...ack(r),libraryRevision:2+i}));if(mode==='partial')results.pop();
    return response({ok:true,version:1,expectedAccount:account,libraryRevision:3,results});
  }}));
  const rows=[s.prepareDelete('collection-1',1).request,s.prepareDelete('collection-2',1).request],batch=s.prepareBatch(rows);rows.pop();
  await assert.rejects(batch.submit(),{writeState:'unconfirmed'});mode='partial';await assert.rejects(batch.submit(),{writeState:'unconfirmed'});
  mode='ok';assert.equal((await batch.submit()).results.length,2);assert.deepEqual(sent[0],sent[1]);assert.deepEqual(sent[1],sent[2]);s.close();
  assert.throws(()=>s.prepareBatch(batch.request.mutations));
});

test('old backend capability failure is read-only and cannot start a restoration',async()=>{
  const sent=[];const s=await createTextCollectionSession(options({fetchImpl:async(url)=>{sent.push(url);return new Response('',{status:404});}}));
  await assert.rejects(s.batchInfo(),{code:'text_collection_sync_unavailable',writeState:'not_started'});
  assert.equal(sent.length,1);assert.match(sent[0],/\/batch-info$/);s.close();
});
