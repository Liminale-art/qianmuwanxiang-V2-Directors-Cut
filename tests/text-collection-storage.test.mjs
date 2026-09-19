import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {collectTextCollectionStorage,cleanupTextCollectionPending} from '../qianmu-text-collection-storage.js';
import {textCollectionSyncQuery,textCollectionSyncResponse} from '../qianmu-text-collection-sync-contract.js';
import {renderStorageBackupSection} from '../qianmu-storage-backup-view.js';
import {createTextCollection} from '../qianmu-text-collection.js';
import {createTextCollectionOutboxEntry,emptyTextCollectionOutbox,summarizeTextCollectionOutbox} from '../qianmu-text-collection-outbox-store.js';

const expectedAccount='st-user:'+createHash('sha256').update('alice').digest('hex');
const query={version:1,expectedAccount};
const usage=()=>({ok:true,version:1,expectedAccount,libraryRevision:3,state:'present',count:1,deletedCount:1,bytes:2200,textBytes:10});
const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const options={resolveNamespace:async()=>'st-user:alice',isCurrent:()=>true};

test('inventory response refuses inconsistent counts, unknown content, foreign account and fabricated zero',()=>{
  assert.deepEqual(textCollectionSyncQuery(query,'inventory'),query);
  for(const patch of [{count:-1},{count:10001},{deletedCount:2},{bytes:0},{textBytes:2201},{state:'absent'},{libraryRevision:100001},{text:'private'},
    {expectedAccount:'st-user:'+'b'.repeat(64)},{count:0,textBytes:10}])assert.throws(()=>textCollectionSyncResponse({...usage(),...patch},'inventory',query));
  assert.throws(()=>textCollectionSyncQuery({...query,id:'collection-1'},'inventory'));
});

test('collector uses the fixed readonly account endpoint, only host CSRF, and returns small statistics',async()=>{
  let calls=0;const summary=await collectTextCollectionStorage({...options,headers:()=>({'x-csrf-token':'csrf','authorization':'private'}),fetchImpl:async(url,input)=>{
    calls++;assert.equal(url,'/api/plugins/qianmu-tts/text-collections/inventory');assert.deepEqual(JSON.parse(input.body),query);
    assert.equal(input.method,'POST');assert.equal(input.credentials,'same-origin');assert.equal(new Headers(input.headers).get('authorization'),null);
    return response(usage());
  }});
  assert.equal(calls,1);assert.equal(summary.status,'ready');assert.equal(summary.namespace,'st-user:alice');assert.equal(summary.bytes,2200);assert.equal(summary.textBytes,10);
  assert.equal('record' in summary,false);
});

test('old backend, malformed data and network failures remain unknown, never zero or leaked errors',async()=>{
  for(const fetchImpl of [async()=>new Response('',{status:404}),async()=>response({...usage(),count:99}),async()=>{throw Error('SECRET PATH');}]){
    const result=await collectTextCollectionStorage({...options,fetchImpl});assert.equal(result.status,'unavailable');assert.equal(result.bytes,null);assert.equal(result.count,null);
    assert.match(result.error,/未读取不代表零占用/);assert.doesNotMatch(result.error,/SECRET/);
  }
});

test('account and page changes during either success or failure invalidate the entire observation',async()=>{
  for(const mode of ['account','page','error']){
    let namespace='st-user:alice',live=true;
    await assert.rejects(collectTextCollectionStorage({resolveNamespace:async()=>namespace,isCurrent:()=>live,fetchImpl:async()=>{
      if(mode==='page')live=false;else namespace='st-user:bob';if(mode==='error')throw Error('network');return response(usage());
    }}),{code:'text_collection_storage_stale'});
  }
});

test('resource display distinguishes server originals, file overhead and browser quota without making a cleanup choice',()=>{
  const data={collectionStorage:{status:'ready',...usage()}};
  const html=renderStorageBackupSection(null,value=>`${value} B`,{data});
  assert.match(html,/1 条原件 · 文件 2200 B/);assert.match(html,/正文 UTF-8 10 B/);assert.match(html,/1 条删除标记/);assert.match(html,/不计入浏览器配额/);
  const failed=renderStorageBackupSection(null,String,{data:{collectionStorage:{status:'unavailable',error:'bad <img src=x>'}}});
  assert.match(failed,/bad &lt;img/);assert.doesNotMatch(failed,/<img|0 条原件/);
});

const localState=()=>({...emptyTextCollectionOutbox(expectedAccount),entries:[createTextCollectionOutboxEntry({version:1,expectedAccount,mutationId:'pending-1',operation:'create',id:'local-01',baseRevision:0,
  record:createTextCollection({id:'local-01',mode:'full',createdAt:1,source:{account:expectedAccount,chatId:'deleted',messageId:0,replyId:'r',charName:'角色',userName:'用户',text:'私人待存原文'}})},{queuedAt:1})]});
test('server outage leaves independent device statistics available without writing or closing an injected store',async()=>{
  const state=localState(),store={read:async account=>{assert.equal(account,expectedAccount);return structuredClone(state);},close(){throw Error('borrowed');}};
  const result=await collectTextCollectionStorage({...options,outboxStore:store,fetchImpl:async()=>{throw Error('offline');}});
  assert.equal(result.status,'unavailable');assert.equal(result.bytes,null);assert.deepEqual(result.pending,summarizeTextCollectionOutbox(state));assert.equal(result.pending.count,1);
  assert.doesNotMatch(JSON.stringify(result),/私人待存原文|pending-1|deleted/);
});
test('local read failure preserves unknown scope while remote statistics remain readable, and stale reads reject all',async()=>{
  const result=await collectTextCollectionStorage({...options,outboxStore:{read:async()=>{throw Error('PRIVATE');}},fetchImpl:async()=>response(usage())});
  assert.equal(result.status,'ready');assert.equal(result.pending.status,'unavailable');assert.equal(result.pending.bytes,null);assert.doesNotMatch(result.pending.error,/PRIVATE/);
  let account='st-user:alice',calls=0;await assert.rejects(collectTextCollectionStorage({resolveNamespace:async()=>account,isCurrent:()=>true,outboxStore:{read:async()=>{account='st-user:bob';return localState();}},fetchImpl:async()=>{calls++;return response(usage());}}),{code:'text_collection_storage_stale'});assert.equal(calls,0);
});
test('pending resource row explains local estimates independently of a failed server inventory and escapes errors',()=>{
  const html=renderStorageBackupSection(null,value=>`${value} B`,{data:{collectionStorage:{status:'unavailable',pending:summarizeTextCollectionOutbox(localState())}}});
  assert.match(html,/收藏待存 · 当前账户本机/);assert.match(html,/1 条 · \d+ B 内容及请求记录估算 · 冲突 0 条/);assert.match(html,/不是可重建缓存/);assert.doesNotMatch(html,/私人待存原文/);
  const failed=renderStorageBackupSection(null,String,{data:{collectionStorage:{pending:{status:'unavailable',error:'<bad>'}}}});assert.match(failed,/&lt;bad&gt;/);assert.doesNotMatch(failed,/0 条 ·/);
});

test('pending cleanup confirms exact local originals, explains skipped modules and never calls server headers',async()=>{
  let state=structuredClone(localState()),updates=0,consent=false,message='';state.entries[0].started=true;
  const store={read:async()=>structuredClone(state),update:async(_account,mutate,{guard})=>{assert.equal(guard(),true);const draft=structuredClone(state);mutate(draft);updates++;state=draft;}};
  const input={...options,outboxStore:store,check(){},headers:()=>assert.fail('cleanup must not send'),otherModules:2,confirm:async(_title,value)=>{message=value;return consent;}};
  assert.equal((await cleanupTextCollectionPending(input)).status,'cancelled');assert.equal(updates,0);assert.match(message,/1 条待存文字.*1 条提交结果未知.*其他 2 个模块/);
  consent=true;assert.deepEqual(await cleanupTextCollectionPending(input),{status:'complete',removed:1,missing:0});assert.equal(state.entries.length,0);assert.equal(updates,1);
  assert.equal((await cleanupTextCollectionPending(input)).status,'empty');assert.equal(updates,1);
});
test('account or page invalidation during cleanup confirmation cannot mutate local content',async()=>{
  for(const mode of ['account','page']){let namespace='st-user:alice',live=true,writes=0;
    const result=cleanupTextCollectionPending({resolveNamespace:async()=>namespace,isCurrent:()=>live,check(){if(!live)throw Error('closed');},outboxStore:{read:async()=>localState(),update:async()=>{writes++;}},
      confirm:async()=>{if(mode==='account')namespace='st-user:bob';else live=false;return true;}});
    await assert.rejects(result);assert.equal(writes,0);
  }
});
