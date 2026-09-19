import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {exportTextCollectionBackup} from '../qianmu-text-collection-export.js';
import {createTextCollection,updateTextCollection} from '../qianmu-text-collection.js';
import {readTextCollectionBackupFile} from '../qianmu-text-collection-backup.js';
const account='st-user:'+createHash('sha256').update('alice').digest('hex');
const record=()=>updateTextCollection(createTextCollection({id:'collection-1',mode:'full',createdAt:1,source:{account,chatId:'gone',messageId:0,replyId:'old',charName:'旧角色',userName:'旧用户',text:'原文'}}),{text:'已编辑\r\n不同长度😀'},1,2);
function fixture(t){
  const f={current:true,namespace:'st-user:alice',accepted:true,checks:0,requests:[],asks:[],downloads:[],records:[record()]};
  t.mock.method(globalThis,'fetch',async(url,options)=>{f.requests.push({url,options});return new Response(JSON.stringify({ok:true,version:1,expectedAccount:account,libraryRevision:2,
    backup:{type:'qianmu-text-collections',version:1,sourceAccount:account,exportedAt:3,libraryRevision:2,records:f.records}}),{headers:{'content-type':'application/json'}});});
  f.options={resolveNamespace:async()=>f.namespace,isCurrent:()=>f.current,headers:()=>({'x-csrf-token':'fixture'}),check:()=>{f.checks++;if(!f.current)throw Error('closed');},
    confirm:async(...args)=>{f.asks.push(args);return f.accepted;},download:async(blob,name)=>{f.downloads.push({payload:await readTextCollectionBackupFile(blob,{check:()=>{}}),name});}};
  return f;
}
test('explicit snapshot export preserves edited originals and asks before starting one download',async t=>{
  const f=fixture(t);assert.deepEqual(await exportTextCollectionBackup(f.options),{status:'download-started',count:1});
  assert.equal(f.requests.length,1);assert.ok(f.requests[0].url.endsWith('/snapshot'));assert.equal(f.requests[0].options.method,'POST');
  assert.equal(f.asks.length,1);assert.match(f.asks[0][1],/未加密/);assert.equal(f.downloads.length,1);assert.deepEqual(f.downloads[0].payload.records,[record()]);
  assert.match(f.downloads[0].name,/^qianmu-text-collections-.*\.json$/);assert.doesNotMatch(JSON.stringify(f.downloads),/fixture|mutationId/);
});
test('empty and declined exports do not download or mutate originals',async t=>{
  const f=fixture(t);f.accepted=false;assert.equal((await exportTextCollectionBackup(f.options)).status,'cancelled');assert.equal(f.downloads.length,0);
  f.records=[];assert.equal((await exportTextCollectionBackup(f.options)).status,'empty');assert.equal(f.asks.length,1);assert.equal(f.downloads.length,0);
  assert.ok(f.requests.every(r=>r.url.endsWith('/snapshot')));
});
test('closing the page or changing account during confirmation cannot export old-account originals',async t=>{
  for(const mode of ['page','account']){
    const f=fixture(t);f.options.confirm=async()=>{if(mode==='page')f.current=false;else f.namespace='st-user:bob';return true;};
    await assert.rejects(exportTextCollectionBackup(f.options));assert.equal(f.downloads.length,0);t.mock.restoreAll();
  }
});
test('missing backend and download failure stay failures, never empty or successful backups',async t=>{
  const f=fixture(t);f.options.download=()=>{throw Error('browser download refused');};await assert.rejects(exportTextCollectionBackup(f.options),/download refused/);
  t.mock.method(globalThis,'fetch',async()=>new Response('{}',{status:404}));await assert.rejects(exportTextCollectionBackup(f.options),/更新千幕后端/);assert.equal(f.downloads.length,0);
});
