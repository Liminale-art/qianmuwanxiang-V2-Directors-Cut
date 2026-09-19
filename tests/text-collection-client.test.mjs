import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextCollection} from '../qianmu-text-collection.js';
import {createTextCollectionClient} from '../qianmu-text-collection-client.js';
const expectedAccount=`st-user:${'a'.repeat(64)}`,base='/api/plugins/qianmu-tts/text-collections';
const item=()=>createTextCollection({id:'collection-1',mode:'full',createdAt:1,source:{account:expectedAccount,chatId:'chat-1',messageId:0,replyId:'reply-1',charName:'角色',userName:'读者',text:'完整\r\n正文😀'}});
const mutation=()=>({version:1,expectedAccount,mutationId:'mutation-1',operation:'create',id:'collection-1',baseRevision:0,record:item()});
const ack=()=>({ok:true,version:1,expectedAccount,libraryRevision:1,mutationId:'mutation-1',id:'collection-1',revision:1,updatedAt:1});
const list=()=>({ok:true,version:1,expectedAccount,libraryRevision:0,items:[],total:0,nextCursor:null});
const response=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});
const client=options=>createTextCollectionClient({expectedAccount,guard:()=>true,...options});
const gate=()=>{let release;return {promise:new Promise(resolve=>{release=resolve;}),release:value=>release(value)};};

test('fixed same-origin POST routes send only host CSRF and exact versioned payloads',async()=>{
  const calls=[],c=client({headers:()=>({'X-CSRF-Token':'fixture',Authorization:'provider-secret','x-api-key':'other-secret'}),fetchImpl:async(url,options)=>{
    calls.push({url,options});return response(url.endsWith('/list')?list():url.endsWith('/get')?{ok:true,version:1,expectedAccount,libraryRevision:1,record:item()}:ack());
  }});
  assert.deepEqual(await c.list(),list());assert.deepEqual((await c.get('collection-1')).record,item());assert.deepEqual(await c.write(mutation()),ack());
  assert.deepEqual(calls.map(c=>c.url),[`${base}/list`,`${base}/get`,`${base}/write`]);
  for(const {options}of calls){assert.equal(options.method,'POST');assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');assert.deepEqual(options.headers,{Accept:'application/json','Content-Type':'application/json','X-CSRF-Token':'fixture'});}
  assert.deepEqual(JSON.parse(calls[2].options.body),mutation());
  await assert.rejects(c.write({...mutation(),apiKey:'secret'}));await assert.rejects(c.list({cursor:null,limit:50,expectedAccount:`st-user:${'b'.repeat(64)}`}));assert.equal(calls.length,3);c.close();
});

test('foreign account, wrong mutation confirmation, redirection and incomplete pages never report success',async()=>{
  for(const mode of ['account','mutation','redirect','url','partial']){
    const c=client({fetchImpl:async()=>{
      const value=ack();if(mode==='account')value.expectedAccount=`st-user:${'b'.repeat(64)}`;if(mode==='mutation')value.mutationId='mutation-other';
      if(mode==='redirect')return response({},307);if(mode==='partial')return response({...list(),total:2});
      const result=response(value);if(mode==='url')Object.defineProperty(result,'url',{value:'https://foreign.invalid/wrong'});return result;
    }});
    await assert.rejects(mode==='partial'?c.list():c.write(mutation()),e=>e.writeState===(mode==='partial'?'not_started':'unconfirmed'));c.close();
  }
});

test('missing backend and authentication failures are actionable without fallback or fabricated local saving',async()=>{
  for(const status of [404,405,501,401,403]){
    let calls=0;const c=client({fetchImpl:async()=>{calls++;return response({},status);}});
    await assert.rejects(c.write(mutation()),e=>e.code===`text_collection_sync_${status===401||status===403?'account':'unavailable'}`&&e.writeState==='unconfirmed');assert.equal(calls,1);c.close();
  }
  const c=client({fetchImpl:async()=>response({ok:false,version:1,code:'text_collection_sync_conflict',message:'请重新载入',writeState:'not_started'},409)});
  await assert.rejects(c.write(mutation()),{code:'text_collection_sync_conflict',writeState:'unconfirmed'});c.close();
});

test('malformed UTF8, truncated JSON, oversized and stalled responses are rejected and cancelled',async()=>{
  for(const mode of ['utf8','json','declared','actual','stall']){
    let cancelled=0;const c=client({timeoutMs:100,fetchImpl:async()=>{
      if(mode==='declared')return response(list(),200,{'content-length':String(256*1024+1)});
      return new Response(new ReadableStream({start(control){if(mode==='utf8'){control.enqueue(new Uint8Array([255]));control.close();}if(mode==='json'){control.enqueue(new TextEncoder().encode('{'));control.close();}if(mode==='actual')control.enqueue(new Uint8Array(256*1024+1));},cancel(){cancelled++;}}),{headers:{'content-type':'application/json'}});
    }});
    await assert.rejects(c.list());if(['actual','stall'].includes(mode))assert.equal(cancelled,1);c.close();
  }
});

test('timeout, abort and close stop transports ignoring cancellation without retrying ambiguous writes',async()=>{
  for(const mode of ['timeout','abort','close']){
    const entered=gate(),controller=new AbortController();let calls=0;
    const c=client({timeoutMs:100,fetchImpl:()=>{calls++;entered.release();return new Promise(()=>{});}});
    const pending=c.write(mutation(),{signal:controller.signal});await entered.promise;
    if(mode==='abort')controller.abort();if(mode==='close')c.close();
    await assert.rejects(pending,e=>e.writeState==='unconfirmed');assert.equal(calls,1);c.close();
  }
});

test('account guards reject late data and a closed session cannot dispatch after delayed headers',async()=>{
  let valid=false,calls=0;const c=client({guard:()=>valid,fetchImpl:async()=>{calls++;valid=false;return response(list());}});
  await assert.rejects(c.list());assert.equal(calls,0);valid=true;await assert.rejects(c.list());assert.equal(calls,1);c.close();
  const held=gate(),entered=gate(),closing=client({headers:()=>{entered.release();return held.promise;},fetchImpl:()=>{calls++;return response(list());}});
  const pending=closing.list();await entered.promise;closing.close();await assert.rejects(pending);held.release({});await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
});

test('snapshot accepts complete originals beyond summary limits but rejects oversized and duplicate-key envelopes',async()=>{
  const records=Array.from({length:4},(_,i)=>createTextCollection({id:`collection-${i}`,mode:'full',createdAt:1,source:{...item().source,text:'文'.repeat(100000)}}));
  const value={ok:true,version:1,expectedAccount,libraryRevision:4,backup:{type:'qianmu-text-collections',version:1,sourceAccount:expectedAccount,libraryRevision:4,exportedAt:2,records}};
  let sent;const c=client({fetchImpl:async(url,options)=>{sent={url,input:JSON.parse(options.body)};return response(value);}});
  assert.deepEqual((await c.snapshot()).backup.records,records);assert.deepEqual(sent,{url:`${base}/snapshot`,input:{version:1,expectedAccount}});c.close();
  for(const mode of ['declared','duplicate','invalid']){
    const bad=client({fetchImpl:async()=>mode==='declared'?response(value,200,{'content-length':String(64*1024*1024+1025)}):mode==='duplicate'
      ?new Response(JSON.stringify(value).replace('"ok":true','"ok":false,"ok":true'),{headers:{'content-type':'application/json'}})
      :response({...value,backup:{...value.backup,records:[...records,records[0]]}})});
    await assert.rejects(bad.snapshot(),e=>e.writeState==='not_started');bad.close();
  }
});

test('input records are frozen before asynchronous work and explicit retries retain the same mutation identity',async()=>{
  const held=gate(),entered=gate(),sent=[];let first=true;
  const c=client({headers:()=>{entered.release();return held.promise;},fetchImpl:async(url,options)=>{sent.push(JSON.parse(options.body));if(first){first=false;throw Error('ack lost');}return response(ack());}});
  const input=structuredClone(mutation()),pending=c.write(input);await entered.promise;input.record.text='changed outside';held.release({});
  await assert.rejects(pending);await c.write(mutation());assert.equal(sent[0].record.text,item().text);assert.deepEqual(sent[0],sent[1]);c.close();
});
