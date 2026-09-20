import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createStAccountStorage,configureStAccountStorage,createConfiguredStAccountStorage,isStAccountStorageConfigured} from '../qianmu-st-account-storage.js';

const origin='https://st.fixture.invalid',owner='st-user:fixture-account';
const response=(value,status=200,headers={})=>new Response(typeof value==='string'?value:JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});
const gate=()=>{let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve};};
function fixture({relative=false,fetch:override,...options}={}){
  const files=new Map(),calls=[];let account=owner,current=true;
  const transport=async(url,request)=>{
    calls.push({url,request});const path=new URL(url).pathname;
    if(override){const result=await override({url,request,path,files,calls});if(result)return result;}
    if(path==='/api/files/upload'){
      const {name,data}=JSON.parse(request.body);assert.match(name,/^qianmu-v2-[a-f0-9]{64}-[a-z0-9-]+\.json$/);
      files.set(name,Buffer.from(data,'base64').toString('utf8'));return response({path:`${relative?'':'/'}user/files/${name}`});
    }
    assert.match(path,/^\/user\/files\/qianmu-v2-[a-z0-9-]+\.json$/);const name=path.split('/').at(-1);
    return files.has(name)?response(files.get(name)):response({},404);
  };
  const config={resolveNamespace:async()=>account,isCurrent:()=>current,headers:()=>({'X-CSRF-Token':'csrf-fixture',Authorization:'never-send','x-api-key':'never-send'}),fetchImpl:transport,origin,cryptoImpl:webcrypto,...options};
  return {files,calls,config,create:()=>createStAccountStorage(config),setAccount:value=>{account=value;},setCurrent:value=>{current=value;}};
}

test('native files persist across independent clients without settings, Data Bank or plugin endpoints',async()=>{
  for(const relative of [false,true]){
    const f=fixture({relative}),first=await f.create(),value={notes:[{text:'跨端\r\n便笺😀',pinned:true}]};
    assert.equal((await first.read('notes')).exists,false);
    const saved=await first.write('notes',value,{expectedFingerprint:null});first.close();
    const second=await f.create(),loaded=await second.read('notes');assert.deepEqual(loaded.value,value);assert.equal(loaded.fingerprint,saved.fingerprint);
    assert.equal(loaded.persistence,'st-account-file');assert.equal(loaded.concurrency,'optimistic-non-cas');
    assert.equal(f.files.size,2);assert.ok(![...f.files.keys()].join('').includes('fixture-account'));
    for(const {url,request} of f.calls){assert.ok(url.startsWith(origin));assert.equal(request.cache,'no-store');assert.equal(request.credentials,'same-origin');assert.equal(request.redirect,'error');assert.equal(request.headers.Authorization,undefined);assert.equal(request.headers['x-api-key'],undefined);assert.equal(request.headers['X-CSRF-Token'],'csrf-fixture');}
    second.close();
  }
});

test('optimistic versions reject stale changes, serialize clients in this realm and retain old bodies',async()=>{
  const f=fixture(),a=await f.create(),b=await f.create();
  const first=await a.write('collections',{items:['first']},{expectedFingerprint:null});
  const second=await b.update('collections',value=>({items:[...value.items,'second']}));
  await assert.rejects(a.write('collections',{items:['lost']},{expectedFingerprint:first.fingerprint}),{code:'st_account_storage_conflict',writeState:'not_started'});
  assert.equal((await a.read('collections')).fingerprint,second.fingerprint);assert.equal(f.files.size,3);
  const old=[...f.files.values()].find(text=>text.includes('"items":["first"]'));assert.ok(old);
  await Promise.all([a.update('collections',value=>({items:[...value.items,'a']})),b.update('collections',value=>({items:[...value.items,'b']}))]);
  assert.deepEqual((await a.read('collections')).value.items,['first','second','a','b']);a.close();b.close();
});

test('unchanged values never upload again and caller domain conflicts retain their intended error code',async()=>{
  const f=fixture(),store=await f.create(),saved=await store.write('notes',{text:'same'},{expectedFingerprint:null});
  const uploads=()=>f.calls.filter(call=>call.request.method==='POST').length,before=uploads();
  await store.update('notes',value=>value);await store.write('notes',{text:'same'},{expectedFingerprint:saved.fingerprint});assert.equal(uploads(),before);
  const conflict=Object.assign(new Error('domain conflict'),{code:'text_collection_sync_conflict'});
  await assert.rejects(store.update('notes',()=>{throw conflict;}),cause=>cause===conflict&&cause.writeState==='not_started');
  assert.equal(uploads(),before);store.close();
});

test('write snapshots caller data before queueing and rejects absent revision or non-JSON values',async()=>{
  const f=fixture(),store=await f.create(),value={text:'original'},pending=store.write('notes',value,{expectedFingerprint:null});value.text='mutated';
  assert.equal((await pending).value.text,'original');
  for(const bad of [undefined,NaN,Infinity,()=>{},new Date(),{x:undefined},[,,],JSON.parse('{"__proto__":{}}'),{text:'\ud800'}]){
    const count=f.calls.length;await assert.rejects(store.write('notes',bad,{expectedFingerprint:null}));assert.equal(f.calls.length,count);
  }
  await assert.rejects(store.write('notes',{}),{code:'st_account_storage_conflict'});
  await assert.rejects(store.update('notes',async()=>({x:1})),{code:'st_account_storage_format'});store.close();
});

test('slot, same-origin and per-operation source guards prevent unrelated requests',async()=>{
  const f=fixture(),store=await f.create();
  for(const slot of ['../notes','notes/other','Notes','x'.repeat(97)])assert.throws(()=>store.read(slot),{code:'st_account_storage_slot'});
  await assert.rejects(store.read('notes',{guard:()=>false}),{code:'st_account_storage_scope'});assert.equal(f.calls.length,0);
  for(const value of ['https://evil.invalid/path','file:///tmp','https://user:password@st.fixture.invalid'])await assert.rejects(createStAccountStorage({...f.config,origin:value}),{code:'st_account_storage_setup'});
  await store.write('assistant-'+ 'a'.repeat(64),{rows:[]},{expectedFingerprint:null});store.close();
});

test('account changes and reconfiguration invalidate old clients before late writes',async()=>{
  const held=gate(),entered=gate(),f=fixture({headers:async()=>{entered.resolve();return held.promise;}}),store=await f.create();
  const pending=store.write('notes',{}, {expectedFingerprint:null});await entered.promise;f.setAccount('st-user:other-account');held.resolve({});
  await assert.rejects(pending,{code:'st_account_storage_account'});assert.equal(f.calls.length,0);store.close();
  const normal=fixture();configureStAccountStorage(normal.config);assert.equal(isStAccountStorageConfigured(),true);
  const configured=await createConfiguredStAccountStorage();configureStAccountStorage(normal.config);
  await assert.rejects(configured.read('notes'));assert.equal(normal.calls.length,0);configured.close();
});

test('foreign heads, corrupted bodies and duplicate JSON keys are never adopted',async()=>{
  for(const kind of ['scope','slot','hash','body','duplicate']){
    const f=fixture(),store=await f.create();await store.write('notes',{text:'valid'},{expectedFingerprint:null});
    const headName=[...f.files.keys()].find(name=>JSON.parse(f.files.get(name)).schema.includes('head')),head=JSON.parse(f.files.get(headName));
    if(kind==='scope')head.scope='b'.repeat(64);if(kind==='slot')head.slot='collections';if(kind==='hash')head.fingerprint='b'.repeat(64);
    if(kind==='body'){const body=[...f.files.keys()].find(name=>name!==headName);f.files.set(body,JSON.stringify({...JSON.parse(f.files.get(body)),value:{text:'tampered'}}));}
    f.files.set(headName,kind==='duplicate'?JSON.stringify(head).replace('"slot":"notes"','"slot":"other","slot":"notes"'):JSON.stringify(head));
    await assert.rejects(store.read('notes'));store.close();
  }
});

test('upload acknowledgement accepts only the exact native user file, never redirects or external paths',async()=>{
  for(const target of ['https://evil.invalid/stolen.json','/user/files/other.json','/user/files/../notes.json','/files/other.json','/user/files/x.json?token=secret']){
    const f=fixture({fetch:({path})=>path==='/api/files/upload'?response({path:target}):null}),store=await f.create();
    await assert.rejects(store.write('notes',{text:'private'},{expectedFingerprint:null}),{code:'st_account_storage_path',writeState:'unconfirmed'});
    assert.equal(f.calls.filter(call=>call.request.method==='POST').length,1);store.close();
  }
  for(const status of [301,302,307,401,403,500]){
    const f=fixture({fetch:()=>response({},status)}),store=await f.create();await assert.rejects(store.read('notes'));store.close();
  }
  const f=fixture({fetch:()=>{const r=response({});Object.defineProperty(r,'url',{value:'https://evil.invalid/'});return r;}}),store=await f.create();
  await assert.rejects(store.read('notes'),{code:'st_account_storage_path'});store.close();
});

test('stream bounds, malformed UTF8 and unreadable data fail without truncation or writing',async()=>{
  for(const mode of ['declared','actual','utf8','html']){
    const f=fixture({fetch:()=>mode==='declared'?response({},200,{'content-length':'4097'}):mode==='actual'?response('x'.repeat(4097)):mode==='html'?response('<html>login</html>',200,{'content-type':'text/html'}):new Response(new Uint8Array([255]),{headers:{'content-type':'application/json'}})});
    const store=await f.create();await assert.rejects(store.read('notes'));assert.equal(f.calls.length,1);store.close();
  }
  const f=fixture({maxBytes:1024}),store=await f.create();await assert.rejects(store.write('notes',{text:'文'.repeat(400)},{expectedFingerprint:null}),{code:'st_account_storage_capacity'});assert.equal(f.calls.length,0);store.close();
});

test('timeouts, abort and close settle ignored fetch signals without a blind retry',async()=>{
  for(const mode of ['timeout','abort','close']){
    const entered=gate(),controller=new AbortController(),f=fixture({timeoutMs:100,fetch:()=>{entered.resolve();return new Promise(()=>{});}}),store=await f.create();
    const pending=store.read('notes',{signal:controller.signal});await entered.promise;if(mode==='abort')controller.abort();if(mode==='close')store.close();
    await assert.rejects(pending,e=>e.writeState==='not_started');assert.equal(f.calls.length,1);store.close();
  }
  const f=fixture({timeoutMs:100,fetch:({path})=>path==='/api/files/upload'?new Promise(()=>{}):null}),store=await f.create();
  await assert.rejects(store.write('notes',{}, {expectedFingerprint:null}),{code:'st_account_storage_timeout',writeState:'unconfirmed'});assert.equal(f.calls.length,2);store.close();
});

test('head races preserve uploaded copies and report conflict rather than fake CAS success',async()=>{
  let count=0;
  const f=fixture({fetch:({path,files})=>{
    if(path==='/api/files/upload')return null;
    if(++count===2)return response({schema:'qianmu.st-account-head.v1',scope:[...files.keys()][0].split('-').slice(2,3)[0],slot:'notes',fingerprint:'f'.repeat(64)});
    return null;
  }}),store=await f.create();
  await assert.rejects(store.write('notes',{text:'preserved'},{expectedFingerprint:null}),{code:'st_account_storage_conflict',writeState:'unconfirmed'});
  assert.equal(f.files.size,1);assert.ok([...f.files.values()][0].includes('preserved'));assert.equal(f.calls.filter(c=>c.request.method==='POST').length,1);store.close();
});
