import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createGalleryArchiveStorage as create} from '../qianmu-gallery-archive-storage.js';
import {encodeGalleryArchiveRecord as encode,inspectGalleryArchiveRecord as inspect,galleryArchiveRecipeState} from '../qianmu-gallery-archive-record.js';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';

const scope=()=>({namespace:'st-user:archive-test',ownerKey:'char:Alice.png',chatKey:'archive-chat'});
const recipe=()=>({source:'novel',prompt:'原配方\r\n红色杯子',negative:'blur',profile:{model:'saved-model'},payload:{prompt:'saved-prompt'},future:{keep:['原值',1,true]}});
const row=(index=1)=>({id:`record-${index}`,createdAt:index,url:`/user/images/record-${index}.png`,chatKey:'archive-chat',prompt:'原画面\r\n未知字段不能丢',
  tags:['室内','厨房'],snapshot:recipe(),messageRef:{chatKey:'archive-chat',messageKey:'original-floor',revisionId:'original-revision'},future:{nested:[null,{text:'未知😀'}]}});
const copy=value=>structuredClone(value);
const gate=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve};};
function fixture(){
  const owner=scope(),transport=streamCheckpointTransport(owner.namespace),records=new Map();let current=true,verifier=null;
  const verifyRecord=async(record,proof)=>{assert.deepEqual(proof.scope,owner);if(verifier)return verifier(record,proof);return JSON.stringify(record)===JSON.stringify((await encode(owner,records.get(record.id))).value.record);};
  return {owner,transport,records,add(value){records.set(value.id,copy(value));return value;},
    open:()=>create({scope:owner,guard:()=>current,verifyRecord,createStorage:transport.createStorage}),
    invalidate(){current=false;},set verifier(value){verifier=value;}};
}
const posts=f=>f.transport.calls.filter(row=>row.options.method==='POST');
const storedValues=f=>[...f.transport.files.values()].map(text=>JSON.parse(text)).filter(value=>value.schema==='qianmu.st-account-document.v1').map(value=>value.value);

test('exact original record and inline recipe survive native readback and independent client reopen',async()=>{
  const f=fixture(),record=f.add(row()),before=copy(record),a=await f.open();assert.equal(f.transport.calls.length,0);
  const receipt=await a.preserveRecord(record);assert.equal(receipt.proof,'record-readback-only');assert.equal(receipt.recipeState,'inline');
  assert.equal(receipt.originalVerified,false);assert.equal(receipt.canPrune,false);assert.equal(f.transport.files.size,2);assert.deepEqual(record,before);a.close();
  const b=await f.open(),loaded=await b.readRecord(receipt.reference);assert.deepEqual(loaded.record,before);assert.equal(loaded.recipeState,'inline');
  assert.doesNotMatch(JSON.stringify(storedValues(f)),/gallery-record-validation/);b.close();
  assert.ok(f.transport.calls.every(call=>call.path==='/api/files/upload'||call.path.startsWith('/user/files/')));
});

test('immutable content slots deduplicate identical saves and keep both different edits of the same record',async()=>{
  const f=fixture(),a=await f.open(),first=f.add(row());const original=await a.preserveRecord(first),uploads=posts(f).length;
  assert.deepEqual(await a.preserveRecord(first),original);assert.equal(posts(f).length,uploads);
  const edited=f.add({...first,prompt:'另一个版本'}),second=await a.preserveRecord(edited);assert.notDeepEqual(second.reference,original.reference);assert.equal(f.transport.files.size,4);
  assert.deepEqual((await a.readRecord(original.reference)).record,first);assert.deepEqual((await a.readRecord(second.reference)).record,edited);a.close();
});

test('same-account clients stage a complete page then browse only its metadata before opening one original record',async()=>{
  const f=fixture(),records=[f.add(row(3)),f.add(row(2)),f.add(row(1))],a=await f.open();
  const staged=await a.stagePage(records);assert.equal(staged.proof,'page-readback-only');assert.equal(staged.canPrune,false);assert.equal(f.transport.files.size,8);a.close();
  const b=await f.open(),before=f.transport.calls.length,reader=await b.openStagedPage(staged.descriptor);
  assert.equal(f.transport.calls.length,before,'opening the immutable head does not scan records');
  const listed=await reader.page({limit:2});assert.equal(listed.rows.length,2);assert.equal(f.transport.calls.length-before,2,'one index object needs only its native head and body');
  assert.doesNotMatch(JSON.stringify(listed),/原画面|原配方|saved-prompt|\/user\/images/);
  const original=await b.readRecord(listed.rows[0].record);assert.deepEqual(original.record,records[0]);
  const tail=await reader.page({cursor:listed.cursor});assert.equal(tail.rows.length,1);reader.close();b.close();
});

test('local/server recipe references remain references and never claim all recipe bytes or images preserved',async()=>{
  const f=fixture(),store=await f.open();
  const variants=[['local-reference',{snapshotRef:'old-local-key'}],['not-recorded',{}],['unavailable',{recipeUnavailable:true}],['unresolved',{snapshot:{futureSchema:99}}],
    ['server-reference',{snapshotServerRef:{version:1,id:'a'.repeat(64)+'-11111111-1111-4111-8111-111111111111',sha256:'a'.repeat(64),bytes:200}}]];
  for(let index=0;index<variants.length;index++){
    const [state,fields]=variants[index],record=row(index+1);delete record.snapshot;Object.assign(record,fields);f.add(record);
    const saved=await store.preserveRecord(record);assert.equal(saved.recipeState,state);assert.equal(saved.canPrune,false);assert.equal(saved.originalVerified,false);
    assert.deepEqual((await store.readRecord(saved.reference)).record,record);
  }
  store.close();assert.equal(galleryArchiveRecipeState({snapshotServerRef:{version:99}}),'unresolved');
});

test('source, identity and credential validation fails before uploads without stripping original fields',async()=>{
  const f=fixture(),store=await f.open();
  const variants=[{...row(),chatKey:'wrong'},{...row(),messageRef:{chatKey:'wrong'}},{...row(),snapshot:{...recipe(),chatKey:'wrong'}},
    {...row(),id:''},{...row(),createdAt:NaN},{...row(),url:''},{...row(),future:{apiKey:'must-not-save'}},{...row(),url:'https://host/file?token=must-not-save'},
    {...row(),snapshot:{...recipe(),payload:{authorization:'must-not-save'}}}];
  for(const value of variants)await assert.rejects(store.preserveRecord(value));assert.equal(f.transport.calls.length,0);store.close();
});

test('invalid batch order, duplicate ids or oversize batch abort before any native request',async()=>{
  const f=fixture(),store=await f.open();
  for(const records of [[],[row(1),row(2)],[row(1),row(1)],Array.from({length:129},(_,i)=>row(129-i))])await assert.rejects(store.stagePage(records));
  assert.equal(f.transport.calls.length,0);store.close();
});

test('source verifier must explicitly approve and cannot mutate the frozen record through its callback',async()=>{
  for(const answer of [false,undefined]){
    const f=fixture(),store=await f.open();f.verifier=async()=>answer;await assert.rejects(store.preserveRecord(row()),/核对/);assert.equal(f.transport.calls.length,0);store.close();
  }
  const f=fixture(),record=f.add(row()),store=await f.open();f.verifier=async passed=>{passed.prompt='changed in verifier';return true;};
  const saved=await store.preserveRecord(record);assert.deepEqual((await store.readRecord(saved.reference)).record,record);store.close();
});

test('caller edits during asynchronous verification cannot alter the captured payload, and stale source rejects',async()=>{
  const f=fixture(),record=f.add(row()),store=await f.open(),wait=gate(),started=gate();
  f.verifier=async()=>{started.resolve();await wait.promise;return true;};
  const pending=store.preserveRecord(record);await started.promise;record.prompt='changed after start';wait.resolve();
  const saved=await pending;assert.notEqual((await store.readRecord(saved.reference)).record.prompt,record.prompt);store.close();
  const stale=fixture(),old=stale.add(row()),b=await stale.open();stale.records.set(old.id,{...old,prompt:'new source'});
  await assert.rejects(b.preserveRecord(old),/核对/);assert.equal(stale.transport.calls.length,0);b.close();
});

test('failed or uncertain upload keeps source and any written native body, with no delete or automatic retry',async()=>{
  for(const mode of ['reject','lost-response']){
    const f=fixture(),record=f.add(row()),before=copy(record),store=await f.open();
    f.transport.hook=async({path,options,files,json})=>{
      if(path!=='/api/files/upload')return null;
      if(mode==='reject')return json({},503);
      const {name,data}=JSON.parse(options.body);files.set(name,Buffer.from(data,'base64').toString('utf8'));throw Error('lost acknowledgement');
    };
    await assert.rejects(store.preserveRecord(record),error=>error.writeState==='unconfirmed');assert.equal(posts(f).length,1);assert.deepEqual(record,before);
    assert.equal(f.transport.files.size,mode==='lost-response'?1:0);store.close();
  }
});

test('existing corrupted native body is not overwritten, and missing requested object is not an empty success',async()=>{
  const f=fixture(),record=f.add(row()),store=await f.open(),saved=await store.preserveRecord(record);
  const body=[...f.transport.files].find(([,text])=>JSON.parse(text).schema==='qianmu.st-account-document.v1');f.transport.files.set(body[0],body[1].replace('原画面','坏画面'));
  const count=posts(f).length;await assert.rejects(store.readRecord(saved.reference));await assert.rejects(store.preserveRecord(record));assert.equal(posts(f).length,count);
  await assert.rejects(store.readRecord({sha256:'b'.repeat(64),bytes:100}),/缺失/);store.close();
});

test('foreign account and chat objects cannot be adopted even with a known content reference',async()=>{
  const f=fixture(),record=f.add(row()),a=await f.open(),saved=await a.preserveRecord(record);a.close();
  const other=await create({scope:{...scope(),chatKey:'other'},guard:()=>true,verifyRecord:async()=>true,createStorage:f.transport.createStorage});
  await assert.rejects(other.readRecord(saved.reference),/账户或聊天/);other.close();
  const mismatch=streamCheckpointTransport('st-user:wrong');await assert.rejects(create({scope:scope(),guard:()=>true,verifyRecord:async()=>true,createStorage:mismatch.createStorage}),/账户不一致/);assert.equal(mismatch.calls.length,0);
});

test('partial batch failure retains saved records but never publishes a page or deletes earlier files',async()=>{
  const f=fixture(),records=[f.add(row(2)),f.add(row(1))],store=await f.open();let uploads=0;
  f.transport.hook=async({path,json})=>path==='/api/files/upload'&&++uploads===3?json({},503):null;
  await assert.rejects(store.stagePage(records),error=>error.writeState==='unconfirmed');
  assert.ok(storedValues(f).some(value=>value.schema==='qianmu.gallery.record.v1'));assert.equal(storedValues(f).some(value=>value.schema==='qianmu.gallery.index-page.v1'),false);
  assert.deepEqual((await store.readRecord((await encode(scope(),records[0])).reference)).record,records[0]);store.close();
});

test('source invalidated after record write leaves immutable data but reports unconfirmed and publishes no page',async()=>{
  const f=fixture(),records=[f.add(row())],store=await f.open();let checks=0;
  f.verifier=async()=>++checks<3;
  await assert.rejects(store.stagePage(records),error=>error.writeState==='unconfirmed');assert.equal(f.transport.files.size,2);
  assert.equal(storedValues(f).some(value=>value.schema==='qianmu.gallery.index-page.v1'),false);store.close();
});

test('closing or changing account during an upload returns no successful receipt and retains already stored bytes',async()=>{
  for(const mode of ['close','account']){
    const f=fixture(),record=f.add(row()),store=await f.open(),held=gate(),entered=gate();
    f.transport.hook=async({path,options,files,json})=>{
      if(path!=='/api/files/upload')return null;
      const {name,data}=JSON.parse(options.body);files.set(name,Buffer.from(data,'base64').toString('utf8'));entered.resolve();await held.promise;return json({path:`/user/files/${name}`});
    };
    const pending=store.preserveRecord(record),rejected=assert.rejects(pending);await entered.promise;
    if(mode==='close')store.close();else f.transport.namespace='st-user:other';held.resolve();await rejected;assert.equal(f.transport.files.size,1);assert.equal(posts(f).length,1);store.close();
  }
});

test('one writer at a time, async guard rejection and changed scope are explicit and do not leave rejected background work',async()=>{
  const f=fixture(),record=f.add(row()),store=await f.open(),held=gate(),entered=gate();
  f.verifier=async()=>{entered.resolve();await held.promise;return true;};
  const first=store.preserveRecord(record);await entered.promise;
  await assert.rejects(store.preserveRecord(record),/正在保存/);held.resolve();await first;
  f.owner.chatKey='changed';await assert.rejects(store.readRecord((await encode(scope(),record)).reference),/来源|聊天/);store.close();
  await assert.rejects(create({scope:scope(),guard:async()=>true,verifyRecord:async()=>true,createStorage:f.transport.createStorage}),/变化/);
});

test('staged page close cancels its pending native read without closing unrelated readers',async()=>{
  const f=fixture(),record=f.add(row()),store=await f.open(),staged=await store.stagePage([record]),a=await store.openStagedPage(staged.descriptor),b=await store.openStagedPage(staged.descriptor);
  const held=gate(),entered=gate();let signal;
  f.transport.hook=async({path,options,files,json})=>{if(!path.startsWith('/user/files/'))return null;signal=options.signal;entered.resolve();await held.promise;return json(files.get(path.split('/').at(-1)));};
  const pending=a.page(),rejected=assert.rejects(pending);await entered.promise;a.close();assert.equal(signal.aborted,true);held.resolve();await rejected;
  f.transport.hook=null;assert.equal((await b.page()).rows.length,1);b.close();store.close();
});

test('canonical record hash ignores JSON property order but not unknown fields; foreign or forged record envelope fails',async()=>{
  const a=row(),b=Object.fromEntries(Object.entries(a).reverse()),first=await encode(scope(),a),second=await encode(scope(),b);assert.deepEqual(first.reference,second.reference);
  const changed=await encode(scope(),{...a,future:{keep:'different'}});assert.notDeepEqual(changed.reference,first.reference);
  await assert.rejects(inspect(scope(),changed.value,first.reference));await assert.rejects(inspect({...scope(),ownerKey:'char:Other.png'},first.value,first.reference));
  assert.deepEqual((await inspect(scope(),first.value,first.reference)).value.record,a);
});

test('archive foundation does not change application wiring, generation admission or current pruning',async()=>{
  const entry=await readFile(new URL('../index.js',import.meta.url),'utf8'),release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));
  for(const name of ['qianmu-gallery-archive-record.js','qianmu-gallery-archive-storage.js']){assert.equal(entry.includes(name),false);assert.equal(release.files.includes(name),false);}
  const code=await readFile(new URL('../qianmu-gallery-archive-storage.js',import.meta.url),'utf8');
  assert.doesNotMatch(code,/\bfetch\s*\(|storage\.(?:delete|remove|update)\(|\.unlink\(|\.admit\(|storyboardImages\s*=/);
});

test('a foreign staged page is rejected before its metadata can be returned',async()=>{
  const f=fixture(),store=await f.open(),staged=await store.stagePage([f.add(row())]);store.close();
  const other=await create({scope:{...scope(),ownerKey:'char:Other.png'},guard:()=>true,verifyRecord:async()=>true,createStorage:f.transport.createStorage});
  const ref={sha256:staged.descriptor.sha256,bytes:staged.descriptor.bytes};
  await assert.rejects(other.readPage(ref),/不属于/);
  const reader=await other.openStagedPage(staged.descriptor);await assert.rejects(reader.page(),/不属于/);reader.close();other.close();
});

test('restaging an unchanged page is idempotent, and a metadata-only browse never verifies or rewrites source records',async()=>{
  const f=fixture(),records=[f.add(row(2)),f.add(row(1))],store=await f.open(),first=await store.stagePage(records),count=posts(f).length;
  assert.deepEqual(await store.stagePage(records),first);assert.equal(posts(f).length,count);
  f.verifier=async()=>assert.fail('browsing cannot revalidate a live source or block deleted-chat archives');
  f.records.clear();const reader=await store.openStagedPage(first.descriptor);assert.equal((await reader.page()).rows.length,2);
  assert.deepEqual((await store.readRecord(first.records[0].reference)).record,records[0]);assert.equal(posts(f).length,count);reader.close();store.close();
});

test('encoded record size, getter and lossless JSON failures never reach native storage',async()=>{
  const f=fixture(),store=await f.open(),getter=row();let invoked=0;
  Object.defineProperty(getter,'prompt',{enumerable:true,get(){invoked++;return 'bad';}});
  for(const value of [getter,{...row(),prompt:'文'.repeat(400000)},{...row(),future:{value:undefined}},{...row(),prompt:'\ud800'}])await assert.rejects(store.preserveRecord(value));
  assert.equal(invoked,0);assert.equal(f.transport.calls.length,0);store.close();
});
