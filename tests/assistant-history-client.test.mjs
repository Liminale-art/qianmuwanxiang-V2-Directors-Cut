import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {collectAssistantHistoryPage as collect} from '../qianmu-assistant-storage-client.js';
const namespace='st-user:alice',account='st-user:'+createHash('sha256').update('alice').digest('hex');
const value=()=>({ok:true,version:1,expectedAccount:account,scope:'a'.repeat(64),offset:0,snapshot:'b'.repeat(64),total:0,nextOffset:null,entries:[]});
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const options=patch=>({resolveNamespace:async()=>namespace,isCurrent:()=>true,headers:()=>({'X-CSRF-Token':'fixture',Authorization:'PRIVATE'}),fetchImpl:async()=>json(value()),...patch});
test('catalogue uses its fixed same-origin endpoint and only hashed account, cursor and CSRF',async()=>{
 let sent;const result=await collect(options({fetchImpl:async(url,init)=>{sent={url,init};return json(value());}}));
 assert.equal(sent.url,'/api/plugins/qianmu-tts/assistant/history-catalogue');assert.deepEqual(JSON.parse(sent.init.body),{version:1,expectedAccount:account,offset:0,snapshot:null});assert.doesNotMatch(JSON.stringify(sent),/PRIVATE|alice/);assert.equal(sent.init.redirect,'error');assert.equal(result.namespace,namespace);assert.equal(result.total,0);
});
test('catalogue rejects unavailable/malformed/oversized/redirect responses instead of yielding empty histories',async()=>{
 for(const response of [()=>new Response('Not found',{status:404}),()=>json({...value(),secret:'PRIVATE'}),()=>json({...value(),total:1}),()=>json('x'.repeat(8300)),()=>{const r=json(value());Object.defineProperty(r,'redirected',{value:true});return r;}])await assert.rejects(collect(options({fetchImpl:async()=>response()})),error=>{assert.equal(error.code,'assistant_history_catalogue_unavailable');assert.doesNotMatch(error.message,/PRIVATE/);return true;});
});
test('catalogue guards account changes and rejects unsigned or stale page cursors before adoption',async()=>{
 let owner=namespace;await assert.rejects(collect(options({resolveNamespace:async()=>owner,fetchImpl:async()=>{owner='st-user:bob';return json(value());}})),{code:'prose_assistant_storage_stale'});
 let calls=0;await assert.rejects(collect(options({offset:8,fetchImpl:async()=>{calls++;return json(value());}})));assert.equal(calls,0);
 await assert.rejects(collect(options({snapshot:'c'.repeat(64)})),{code:'assistant_history_catalogue_unavailable'});
});
test('catalogue cancellation cancels stalled response and does not return a usable page',async()=>{
 const controller=new AbortController();let cancel=false,start;const started=new Promise(r=>start=r);
 const pending=collect(options({signal:controller.signal,fetchImpl:async()=>new Response(new ReadableStream({start(){start();},cancel(){cancel=true;}}),{headers:{'content-type':'application/json'}})}));
 await started;controller.abort();await assert.rejects(pending,{code:'assistant_history_catalogue_unavailable'});assert.equal(cancel,true);
});
