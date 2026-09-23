import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createStAccountStorage,configureStAccountStorage,createConfiguredStAccountStorage,isStAccountStorageConfigured,stAccountImmutableReference} from '../qianmu-st-account-storage.js';

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

test('immutable originals preserve complete text, create no head and read by exact version across clients',async()=>{
  const f=fixture(),a=await f.create(),value={record:{text:'完整原文\r\n😀'.repeat(18000),future:['',0,false,null]},origin:{chat:'deleted later'}};
  const saved=await a.preserveImmutable('collection-record',value);assert.equal(f.files.size,1);assert.equal(f.calls.length,3);
  assert.ok([...f.files.values()].every(body=>JSON.parse(body).schema==='qianmu.st-account-document.v1'));
  assert.equal(saved.reference.scope,a.scope);assert.equal(saved.reference.bytes,Buffer.byteLength([...f.files.values()][0]));a.close();
  const b=await f.create(),start=f.calls.length,loaded=await b.readImmutable(saved.reference);assert.equal(f.calls.length,start+1);assert.deepEqual(loaded.value,value);
  assert.equal(loaded.persistence,'st-account-file');assert.deepEqual(loaded.reference,saved.reference);assert.equal((await b.read('collection-record')).exists,false);
  loaded.value.record.text='caller edit';assert.deepEqual((await b.readImmutable(saved.reference)).value,value);b.close();
});

test('changing one immutable original uploads only that original and leaves every earlier version readable',async()=>{
  const f=fixture(),store=await f.create(),refs=[],values=Array.from({length:12},(_,i)=>({id:'item-'+i,text:('完整原文'+i).repeat(9000)}));
  for(const value of values)refs.push((await store.preserveImmutable('collection-record',value)).reference);
  const before=new Map(f.files),count=f.calls.length,next={...values[3],text:'单条修改'};
  const saved=await store.preserveImmutable('collection-record',next);assert.equal(f.files.size,before.size+1);
  const writes=f.calls.slice(count).filter(call=>call.request.method==='POST');assert.equal(writes.length,1);
  const sent=Buffer.from(JSON.parse(writes[0].request.body).data,'base64').toString('utf8');assert.ok(Buffer.byteLength(sent)<500);assert.ok(!sent.includes(values[0].text));
  for(const [name,text]of before)assert.equal(f.files.get(name),text);
  for(let i=0;i<refs.length;i++)assert.deepEqual((await store.readImmutable(refs[i])).value,values[i]);
  assert.deepEqual((await store.readImmutable(saved.reference)).value,next);store.close();
});

test('immutable reuse verifies the stored body without upload and never changes an existing mutable head',async()=>{
  const f=fixture(),store=await f.create(),first=await store.write('collections',{text:'old library'},{expectedFingerprint:null});
  const head=[...f.files].find(([,text])=>JSON.parse(text).schema==='qianmu.st-account-head.v1'),value={text:'single original'};
  const saved=await store.preserveImmutable('collections',value),count=f.calls.length,files=f.files.size;
  assert.deepEqual((await store.preserveImmutable('collections',value)).reference,saved.reference);assert.equal(f.calls.length,count+1);assert.equal(f.files.size,files);
  assert.equal(f.files.get(head[0]),head[1]);assert.equal((await store.read('collections')).fingerprint,first.fingerprint);store.close();
});

test('lost immutable upload acknowledgement stays unconfirmed and retry verifies without another upload',async()=>{
  let lose=true;const f=fixture({fetch:({path,request,files})=>{
    if(path==='/api/files/upload'&&lose){lose=false;const {name,data}=JSON.parse(request.body);files.set(name,Buffer.from(data,'base64').toString('utf8'));throw Error('accepted, receipt lost');}
  }}),store=await f.create(),value={text:'saved original'};
  await assert.rejects(store.preserveImmutable('collection-record',value),{code:'st_account_storage_connection',writeState:'unconfirmed'});
  const start=f.calls.length,saved=await store.preserveImmutable('collection-record',value);assert.deepEqual(saved.value,value);
  assert.equal(f.calls.length,start+1);assert.equal(f.calls.filter(call=>call.request.method==='POST').length,1);assert.equal(f.files.size,1);store.close();
});

test('immutable source and reference are captured before queueing; invalid JSON never reaches transport',async()=>{
  const f=fixture(),store=await f.create(),value={text:'original'},pending=store.preserveImmutable('collection-record',value);value.text='late edit';
  const saved=await pending;assert.equal(saved.value.text,'original');const ref={...saved.reference},reading=store.readImmutable(ref);ref.fingerprint='f'.repeat(64);
  assert.equal((await reading).value.text,'original');
  for(const value of [undefined,NaN,{x:undefined},[,,],{text:'\ud800'},new Date()]){
    const start=f.calls.length;await assert.rejects(store.preserveImmutable('collection-record',value));assert.equal(f.calls.length,start);
  }store.close();
});

test('immutable references reject foreign scope, paths, over-budget bytes, accessors and hidden fields without fetching',async()=>{
  const f=fixture(),store=await f.create(),ref=(await store.preserveImmutable('collection-record',{text:'private'})).reference;let getters=0;
  const accessor={...ref};Object.defineProperty(accessor,'scope',{enumerable:true,get(){getters++;return ref.scope;}});
  const hidden={...ref};Object.defineProperty(hidden,'extra',{value:'bad'});
  for(const bad of [null,{...ref,scope:'b'.repeat(64)},{...ref,slot:'../collections'},{...ref,fingerprint:'https://elsewhere'},
    {...ref,fingerprint:{toString(){getters++;return ref.fingerprint;}}},
    {...ref,bytes:0},{...ref,bytes:Infinity},{...ref,bytes:64*1024*1024+1025},{...ref,version:2},{...ref,extra:true},accessor,hidden]){
    const start=f.calls.length;await assert.rejects(store.readImmutable(bad));assert.equal(f.calls.length,start);
  }
  assert.equal(getters,0);assert.throws(()=>stAccountImmutableReference(ref,{scope:store.scope,slot:'notes'}));store.close();
});

test('deleted or corrupted immutable bodies never fall back to a newer head or get silently repaired',async()=>{
  for(const mode of ['missing','changed','bytes','slot','duplicate']){
    const f=fixture(),store=await f.create(),saved=await store.preserveImmutable('collection-record',{text:'old'}),[name]=f.files.keys();
    await store.write('collection-record',{text:'new head must not be borrowed'},{expectedFingerprint:null});
    let ref={...saved.reference};if(mode==='missing')f.files.delete(name);
    if(mode==='changed')f.files.set(name,f.files.get(name).replace('"old"','"bad"'));
    if(mode==='bytes')ref.bytes++;
    if(mode==='slot')ref.slot='another-slot';
    if(mode==='duplicate')f.files.set(name,f.files.get(name).replace('"value":','"value":null,"value":'));
    const writes=f.calls.filter(call=>call.request.method==='POST').length,start=f.calls.length;
    await assert.rejects(store.readImmutable(ref));assert.equal(f.calls.length,start+1);assert.equal(f.calls.filter(call=>call.request.method==='POST').length,writes);
    if(['changed','duplicate'].includes(mode)){
      await assert.rejects(store.preserveImmutable('collection-record',{text:'old'}));assert.equal(f.calls.filter(call=>call.request.method==='POST').length,writes);
    }store.close();
  }
});

test('immutable references cannot be reused in another account and late account changes cannot publish originals',async()=>{
  const f=fixture(),a=await f.create(),saved=await a.preserveImmutable('collection-record',{text:'private'});a.close();f.setAccount('st-user:other');
  const b=await f.create(),start=f.calls.length;await assert.rejects(b.readImmutable(saved.reference),{code:'st_account_storage_reference'});assert.equal(f.calls.length,start);b.close();
  const entered=gate(),release=gate(),late=fixture({headers:async()=>{entered.resolve();return release.promise;}}),c=await late.create();
  const pending=c.preserveImmutable('collection-record',{text:'never sent'});await entered.promise;late.setAccount('st-user:changed');release.resolve({});
  await assert.rejects(pending,{code:'st_account_storage_account'});assert.equal(late.calls.length,0);c.close();
});

test('immutable cancellation and timeouts settle without publishing a mutable head or retrying',async()=>{
  for(const mode of ['abort','close','timeout']){
    const entered=gate(),controller=new AbortController(),f=fixture({timeoutMs:100,fetch:()=>{entered.resolve();return new Promise(()=>{});}}),store=await f.create();
    const pending=store.preserveImmutable('collection-record',{text:'original'},{signal:controller.signal});await entered.promise;
    if(mode==='abort')controller.abort();if(mode==='close')store.close();
    await assert.rejects(pending,e=>e.writeState==='not_started');assert.equal(f.calls.length,1);assert.equal(f.files.size,0);store.close();
  }
});

test('immutable upload acknowledgement and subsequent readback must both identify the complete saved original',async()=>{
  for(const mode of ['wrong-receipt','tamper-after-upload']){
    const f=fixture({fetch:({path,request,files})=>{
      if(path!=='/api/files/upload')return;
      if(mode==='wrong-receipt')return response({path:'/user/files/not-the-requested-file.json'});
      const {name,data}=JSON.parse(request.body);files.set(name,Buffer.from(data,'base64').toString('utf8').replace('"original"','"tampered"'));return response({path:'/user/files/'+name});
    }}),store=await f.create();await assert.rejects(store.preserveImmutable('collection-record',{text:'original'}),e=>e.writeState==='unconfirmed');
    assert.equal(f.calls.filter(call=>call.request.method==='POST').length,1);assert.ok([...f.files.values()].every(text=>JSON.parse(text).schema!=='qianmu.st-account-head.v1'));store.close();
  }
});

test('immutable operations retain the existing per-call guard and byte limits before transport',async()=>{
  const f=fixture({maxBytes:1024}),store=await f.create(),saved=await store.preserveImmutable('collection-record',{text:'safe'});
  for(const invoke of [()=>store.readImmutable(saved.reference,{guard:()=>false}),()=>store.preserveImmutable('collection-record',{text:'safe'},{guard:()=>false}),
    ()=>store.preserveImmutable('collection-record',{text:'文'.repeat(400)})]){
    const count=f.calls.length;await assert.rejects(invoke());assert.equal(f.calls.length,count);
  }store.close();
});

test('a timeout after immutable upload begins is unconfirmed and never starts a blind second upload',async()=>{
  const f=fixture({timeoutMs:100,fetch:({path})=>path==='/api/files/upload'?new Promise(()=>{}):null}),store=await f.create();
  await assert.rejects(store.preserveImmutable('collection-record',{text:'original'}),{code:'st_account_storage_timeout',writeState:'unconfirmed'});
  assert.equal(f.calls.length,2);assert.equal(f.calls.filter(call=>call.request.method==='POST').length,1);store.close();
});
