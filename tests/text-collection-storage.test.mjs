import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {collectTextCollectionStorage} from '../qianmu-text-collection-storage.js';
import {textCollectionSyncQuery,textCollectionSyncResponse} from '../qianmu-text-collection-sync-contract.js';
import {renderStorageBackupSection} from '../qianmu-storage-backup-view.js';

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
