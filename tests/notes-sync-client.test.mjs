import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createNotesSyncClient } from '../qianmu-notes-sync-client.js';

const namespace='st-user:fixture', account='st-user:'+createHash('sha256').update('fixture').digest('hex');
const note={id:'a',title:'正文',body:'完整\n正文😀',pinned:false,createdAt:1,updatedAt:2,revision:1,deleted:false};
const list=()=>({ok:true,version:1,expectedAccount:account,revision:1,notes:[note]});
const write=()=>({id:'a',baseRevision:0,note:{title:note.title,body:note.body,pinned:false,createdAt:1},deleted:false,mutationId:'fixture_write_1'});
const response=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json',...headers}});

test('fixed same-origin endpoints forward only host CSRF and exact note fields, never provider credentials or geometry',async()=>{
  const calls=[],client=createNotesSyncClient({namespace,headers:()=>({'x-csrf-token':'fixture-token',Authorization:'never forward','x-api-key':'never forward'}),fetchImpl:async(url,options)=>{
    calls.push([url,options]);return response(options.method==='GET'?list():{ok:true,version:1,expectedAccount:account,revision:1,note});
  }});
  assert.deepEqual(await client.list(),list());assert.equal((await client.write(write())).note.body,note.body);
  assert.deepEqual(calls.map(([url])=>url),['/api/plugins/qianmu-tts/notes','/api/plugins/qianmu-tts/notes/write']);
  for(const [,options]of calls){assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers['x-api-key'],undefined);assert.equal(options.headers['X-CSRF-Token'],'fixture-token');}
  const payload=JSON.parse(calls[1][1].body);assert.equal(payload.expectedAccount,account);assert.deepEqual(Object.keys(payload.note).sort(),['body','createdAt','pinned','title']);
  await assert.rejects(client.write({...write(),x:30}),/请求无效/);assert.equal(calls.length,2);client.close();
});

test('a 409 conflict is validated rather than treated as a successful write or dropped prose',async()=>{
  const value={ok:false,version:1,code:'notes_sync_conflict',message:'another edit',writeState:'not_started',expectedAccount:account,revision:1,note};
  const client=createNotesSyncClient({namespace,fetchImpl:async()=>response(value,409)});assert.deepEqual(await client.write(write()),value);client.close();
});

test('foreign accounts, mismatched write identity, redirects and duplicate directories are rejected',async()=>{
  for(const mode of ['account','identity','redirect','duplicate','url']){
    const client=createNotesSyncClient({namespace,fetchImpl:async()=>{
      if(mode==='redirect')return response({},307,{Location:'https://not-the-st.invalid/'});
      if(mode==='identity')return response({ok:true,version:1,expectedAccount:account,revision:1,note:{...note,id:'another'}});
      const value=list();if(mode==='account')value.expectedAccount='st-user:'+'f'.repeat(64);if(mode==='duplicate')value.notes.push(note);
      const result=response(value);if(mode==='url')Object.defineProperty(result,'url',{value:'https://not-the-st.invalid/wrong'});return result;
    }});
    await assert.rejects(mode==='identity'?client.write(write()):client.list());client.close();
  }
});

test('missing service is local-only, authentication failure is actionable, and server markup stays data',async()=>{
  for(const status of [404,405,501,401,403]){
    const client=createNotesSyncClient({namespace,fetchImpl:async()=>new Response('<html>not a service</html>',{status})});
    await assert.rejects(client.list(),error=>error.code===([401,403].includes(status)?'notes_sync_account':'notes_sync_unavailable'));client.close();
  }
  const client=createNotesSyncClient({namespace,fetchImpl:async()=>response({ok:false,version:1,code:'notes_sync_stale_lock',message:'需要核对 <lock>',writeState:'not_started'},503)});
  await assert.rejects(client.write(write()),error=>error.message==='需要核对 <lock>'&&error.writeState==='unconfirmed');client.close();
});

test('malformed, truncated, non-UTF8, oversized or hanging bodies never count as complete confirmations',async()=>{
  for(const mode of ['json','utf8','declared-size','actual-size','hanging']){
    let cancelled=0;
    const client=createNotesSyncClient({namespace,timeoutMs:100,fetchImpl:async()=>{
      if(mode==='declared-size')return response(list(),200,{'content-length':String(65*1024*1024)});
      const stream=new ReadableStream({start(controller){if(mode==='json'){controller.enqueue(new TextEncoder().encode('{"ok":true'));controller.close();}if(mode==='utf8'){controller.enqueue(new Uint8Array([0xff]));controller.close();}if(mode==='actual-size'){controller.enqueue(new Uint8Array(512*1024+1));}},cancel(){cancelled++;}});
      return new Response(stream,{headers:{'content-type':'application/json'}});
    }});
    await assert.rejects(mode==='actual-size'?client.write(write()):client.list());
    if(['hanging','actual-size'].includes(mode))assert.equal(cancelled,1);client.close();
  }
});

test('close and abort terminate even a transport that ignores its signal and preserve ambiguous write state',async()=>{
  for(const mode of ['close','abort','timeout']){
    let entered;const ready=new Promise(resolve=>entered=resolve),controller=new AbortController();
    const client=createNotesSyncClient({namespace,timeoutMs:100,fetchImpl:async()=>{entered();return new Promise(()=>{});}});
    const pending=client.write(write(),{signal:controller.signal});await ready;
    if(mode==='close')client.close();if(mode==='abort')controller.abort();
    await assert.rejects(pending,error=>error.writeState==='unconfirmed');client.close();
  }
});

test('account guards run before dispatch and after response, and late headers cannot send after close',async()=>{
  let calls=0,valid=false;
  const client=createNotesSyncClient({namespace,guard:()=>valid,fetchImpl:async()=>{calls++;valid=false;return response(list());}});
  await assert.rejects(client.list());assert.equal(calls,0);valid=true;await assert.rejects(client.list());assert.equal(calls,1);client.close();
  let release,entered;const ready=new Promise(resolve=>entered=resolve);
  const closing=createNotesSyncClient({namespace,headers:()=>{entered();return new Promise(resolve=>release=resolve);},fetchImpl:async()=>{calls++;return response(list());}});
  const pending=closing.list();await ready;closing.close();await assert.rejects(pending);release({});await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
});
