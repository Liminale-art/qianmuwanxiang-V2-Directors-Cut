import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createVibeReceiptFileAccounting,validateVibeReceiptFileUsage} from '../qianmu-vibe-receipt-accounting.js';
import {createVibeReceiptOriginals} from '../qianmu-vibe-receipt-original.js';
import {createNativeVibeEncodingStore} from '../qianmu-vibe-native-encoding-store.js';
import {createVibeAssetOperations} from '../qianmu-vibe-assets-worker.js';
import {createVibeStorageController} from '../qianmu-vibe-storage.js';
import {validateVibeStorageSummary,collectVibeStorage} from '../qianmu-vibe-storage-summary.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {receiptInput} from './helpers/vibe-receipt-fixture.mjs';
import {receiptWritableFixture} from './helpers/vibe-receipt-writable-fixture.mjs';

const hex=n=>n.toString(16).padStart(64,'0'),slot='vibe-receipt-original';
const ref=(n,bytes=100,type=slot)=>({version:1,scope:hex(99),slot:type,fingerprint:hex(n),bytes});
const key=r=>`qianmu-v2-${r.scope}-${r.slot}-${r.fingerprint}.json`;
const selected=input=>({cacheKey:input.receipt.cacheKey,section:input.section});
const usage=()=>({version:1,scope:'registered-fee-original-files',complete:true,versions:2,selectedVersions:1,total:{count:4,bytes:400},selected:{count:2,bytes:200},history:{count:2,bytes:200}});
async function fixture(t,inputs=[]){
  const f=await characterNativeFixture(t),local=receiptWritableFixture(inputs),open=(db=local)=>{const store=createNativeVibeEncodingStore({legacy:db.open(),createStorage:f.createStorage});t.after(()=>store.close());return store;};
  return Object.assign(f,{local,open,store:open()});
}
async function registered(f){
  const {value}=await f.storage.read('vibe-receipt-catalogue'),files=new Map();let versions=0;
  for(const entry of value.entries)for(const version of entry.versions){
    versions++;const manifest=(await f.storage.readImmutable(version.reference)).value;
    for(const reference of [version.reference,...manifest.parts])files.set(key(reference),Buffer.byteLength(f.files.get(key(reference))));
  }
  return {count:files.size,bytes:[...files.values()].reduce((a,b)=>a+b,0),versions,files};
}

test('physical files are deduplicated across versions, chunks and repeat verification; shared files belong to current selection only once',()=>{
  const a=createVibeReceiptFileAccounting(),shared=ref(8,40,'vibe-receipt-part'),old=ref(9,60,'vibe-receipt-part');
  const first={digest:hex(1),files:[ref(1),shared,old,old]},second={digest:hex(2),files:[ref(2),shared]};
  a.verified(first);a.verified(second);a.verified(first);
  assert.deepEqual(a.summarize([hex(2)],2),{...usage(),total:{count:4,bytes:300},selected:{count:2,bytes:140},history:{count:2,bytes:160}});
  assert.deepEqual(a.summarize([hex(1),hex(2)],2),{...usage(),selectedVersions:2,total:{count:4,bytes:300},selected:{count:4,bytes:300},history:{count:0,bytes:0}});
  first.files[0].bytes=999;assert.equal(a.summarize([hex(2)],2).total.bytes,300,'retains counters, not caller objects');
});

test('summary requires complete original coverage and exact current digests, including empty accounts',()=>{
  const a=createVibeReceiptFileAccounting();assert.deepEqual(a.summarize([],0),{...usage(),versions:0,selectedVersions:0,total:{count:0,bytes:0},selected:{count:0,bytes:0},history:{count:0,bytes:0}});
  a.verified({digest:hex(1),files:[ref(1),ref(2,40,'vibe-receipt-part')]});
  for(const [ids,count] of [[[hex(1)],2],[[hex(2)],1],[[hex(1),hex(1)],1],[[],1]])assert.throws(()=>a.summarize(ids,count),{code:'vibe_receipt_accounting'});
});

test('contradictory byte counts, foreign scopes and changed file membership cannot be accepted as verified accounting',()=>{
  const base={digest:hex(1),files:[ref(1),ref(2,40,'vibe-receipt-part')]};
  for(const edit of [v=>v.files[1].bytes++,v=>v.files[1].scope=hex(98),v=>v.files[1].fingerprint=hex(3),v=>v.files[1].slot=slot,v=>v.files[0].bytes=0,v=>v.files[1].bytes=513*1024+1,v=>v.digest='bad']){
    const a=createVibeReceiptFileAccounting();a.verified(base);const next=structuredClone(base);edit(next);assert.throws(()=>a.verified(next),{code:'vibe_receipt_accounting'});
  }
});

test('metadata validation rejects incomplete, inflated, inconsistent or raw-body summaries and clones accepted fields',()=>{
  for(const edit of [v=>v.complete=false,v=>v.total.bytes++,v=>v.total.count++,v=>v.selectedVersions=2,v=>v.versions=0,v=>v.selected.count=0,
    v=>v.history.bytes=-1,v=>v.total.bytes=NaN,v=>v.total.bytes=Number.MAX_SAFE_INTEGER+1,v=>v.scope='vps-disk',v=>v.receipts=[],v=>v.total.body='private',v=>v.version=2]){
    const v=usage();edit(v);assert.throws(()=>validateVibeReceiptFileUsage(v,1),{code:'vibe_receipt_accounting'});
  }
  const source=usage(),copy=validateVibeReceiptFileUsage(source,1);copy.total.bytes=999;assert.equal(source.total.bytes,400);
});

test('actual original preservation and reading report verified UTF-8 envelope bytes, with no receipt body or extra requests',async t=>{
  const f=await fixture(t),events=[],api=createVibeReceiptOriginals(f.storage,{onVerifiedFiles:event=>events.push(event)}),input=await receiptInput({reviewCount:600});
  const saved=await api.preserve(input);assert.equal(events.length,1);const manifest=(await f.storage.readImmutable(saved.reference)).value;
  assert.deepEqual(events[0],{digest:manifest.digest,files:[saved.reference,...manifest.parts]});
  for(const reference of events[0].files)assert.equal(reference.bytes,Buffer.byteLength(f.files.get(key(reference))));
  f.reset();assert.deepEqual(await api.read(saved.reference,selected(input)),input);const counted=f.calls.length;
  f.reset();assert.deepEqual(await createVibeReceiptOriginals(f.storage).read(saved.reference,selected(input)),input);assert.equal(f.calls.length,counted);
  assert.deepEqual(events[1],events[0]);events[0].files[0].bytes=1;assert.deepEqual(await api.read(saved.reference,selected(input)),input);
});

test('corrupt or missing parts and revoked scope never produce a completed verified-file event',async t=>{
  for(const mode of ['missing','corrupt','scope']){
    const f=await fixture(t),input=await receiptInput(),plain=createVibeReceiptOriginals(f.storage),saved=await plain.preserve(input),events=[];
    const part=[...f.files.keys()].find(name=>name.includes('-vibe-receipt-part-'));
    if(mode==='missing')f.files.delete(part);if(mode==='corrupt')f.files.set(part,f.files.get(part)+' ');if(mode==='scope')f.account('st-user:other');
    await assert.rejects(createVibeReceiptOriginals(f.storage,{onVerifiedFiles:v=>events.push(v)}).read(saved.reference,selected(input)));assert.equal(events.length,0);
  }
});

test('a failed accounting callback or revoked caller guard prevents a successful original result',async t=>{
  const f=await fixture(t),input=await receiptInput(),saved=await createVibeReceiptOriginals(f.storage).preserve(input);
  await assert.rejects(createVibeReceiptOriginals(f.storage,{onVerifiedFiles(){throw Error('accounting refused');}}).read(saved.reference,selected(input)),/accounting refused/);
  let live=true;await assert.rejects(createVibeReceiptOriginals(f.storage,{guard:()=>live,onVerifiedFiles(){live=false;}}).read(saved.reference,selected(input)));
});

test('ordinary native inventory counts every registered history file once, including archive, excluding old indices and unregistered originals',async t=>{
  const a=await receiptInput({status:'reserved',reviewCount:33}),b=await receiptInput({status:'ready',information:1}),f=await fixture(t,[a,b]),store=f.store;
  await store.get(namespace,a.receipt.cacheKey);await store.transition(namespace,a.receipt.cacheKey,a.receipt.attemptId,'submitting');
  await store.transition(namespace,a.receipt.cacheKey,a.receipt.attemptId,'ready',{assetRef:{version:1,namespace,id:hex(333)}});
  await store.archiveCompleted(namespace,[await store.get(namespace,b.receipt.cacheKey)],true);
  const orphan=await receiptInput({information:.5});await createVibeReceiptOriginals(f.storage).preserve(orphan);
  const before=new Map(f.files),actual=await f.open(receiptWritableFixture()).inventory(namespace),expected=await registered(f);
  assert.equal(actual.receipts.length,1);assert.equal(actual.archived.count,1);assert.equal(actual.fileUsage.versions,5);assert.equal(actual.fileUsage.selectedVersions,2);
  assert.deepEqual(actual.fileUsage.total,{count:expected.count,bytes:expected.bytes});assert.ok(actual.fileUsage.history.bytes>0);
  assert.equal(actual.fileUsage.total.bytes,actual.fileUsage.selected.bytes+actual.fileUsage.history.bytes);assert.deepEqual(f.files,before);
  assert.ok([...f.files.values()].reduce((n,text)=>n+Buffer.byteLength(text),0)>actual.fileUsage.total.bytes);
});

test('missing historical predecessor, account switch and unresolved branch make inventory fail, never expose a partial file total',async t=>{
  for(const mode of ['missing','switch','conflict']){
    const input=await receiptInput({status:'reserved'}),f=await fixture(t,[input]);await f.store.get(namespace,input.receipt.cacheKey);
    await f.store.transition(namespace,input.receipt.cacheKey,input.receipt.attemptId,'submitting');
    const index=(await f.storage.read('vibe-receipt-catalogue')).value,old=index.entries[0].versions[0].reference;
    if(mode==='missing')f.files.delete(key(old));
    if(mode==='switch')f.hook(call=>{if(call.path.includes('-vibe-receipt-part-'))f.account('st-user:other');});
    let store=f.open(receiptWritableFixture());
    if(mode==='conflict'){const alien=structuredClone(input);alien.receipt.attemptId='different-uncertain-request';store=f.open(receiptWritableFixture([alien]));}
    await assert.rejects(store.inventory(namespace));
  }
});

test('real native receipt inventory reaches the ordinary Worker summary and bridge without double-counting decoded content',async t=>{
  const input=await receiptInput({status:'ready'}),f=await fixture(t,[input]),store={inventory:async()=>({persistence:'st-account-file',heads:[],retained:{count:0,bytes:0},usage:{count:0,bytes:0,previewBytes:0,limit:512*1048576},metadata:{bytes:0,count:0}})};
  const run=createVibeAssetOperations(store,{encodings:f.store}),result=await run({type:'storage-summary',namespace});
  assert.equal(result.version,4);assert.equal(result.feeOriginals.selectedVersions,1);assert.equal(result.feeOriginals.versions,1);
  assert.equal(result.bytes,result.records.bytes+result.metadata.bytes);assert.ok(result.feeOriginals.total.bytes>result.records.bytes);
  assert.deepEqual(validateVibeStorageSummary(result,namespace),result);
  assert.deepEqual(await collectVibeStorage({resolveNamespace:async()=>namespace,call:async()=>result}),result);
  assert.doesNotMatch(JSON.stringify(result),/original-attempt|fingerprint|sourceAssetRef|parts|sourceId/);
  const expected=await registered(f);assert.equal(result.feeOriginals.total.bytes,expected.bytes);
  const broken={...result,feeOriginals:{...result.feeOriginals,complete:false}};
  const rejected=await collectVibeStorage({resolveNamespace:async()=>namespace,call:async()=>broken});assert.equal(rejected.bytes,null);assert.equal(rejected.status,'unavailable');
});

test('empty native inventory is zero only after successful complete reads and never creates a phantom fee directory',async t=>{
  const f=await fixture(t),view=await f.store.inventory(namespace);assert.equal(view.fileUsage.versions,0);assert.equal(view.fileUsage.total.bytes,0);assert.equal(view.metadata.bytes,0);assert.equal(f.uploads,0);
  const broken=f.open(receiptWritableFixture());f.hook(()=>{throw Error('network unavailable');});await assert.rejects(broken.inventory(namespace));assert.equal(f.uploads,0);
});

test('actual Vibe manager presents the independent history-file partition after ordinary inventory without offering to delete originals',async t=>{
  const input=await receiptInput({status:'ready'}),f=await fixture(t,[input]);
  const assets={inventory:async()=>({persistence:'st-account-file',heads:[],retained:{count:0,bytes:0},usage:{count:0,bytes:0,previewBytes:0,limit:512*1048576},metadata:{bytes:0,count:0}})};
  const run=createVibeAssetOperations(assets,{encodings:f.store}),snapshot=await run({type:'storage-inventory',namespace});
  const nodes=new Map(),host={innerHTML:'',isConnected:true,querySelector(selector){if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',setAttribute(){},addEventListener(){}});return nodes.get(selector);},querySelectorAll:()=>[]};
  let rendered;const done=new Promise(resolve=>rendered=resolve);
  const controller=createVibeStorageController({actions:{list:async()=>({...snapshot,library:[]})},onClose(){},icons(){if(host.innerHTML.includes('已登记费用原件'))rendered();}});t.after(()=>controller.dispose());
  controller.mount(host);await done;assert.match(host.innerHTML,/已登记费用原件/);assert.match(host.innerHTML,/历史独有文件 0 B/);assert.match(host.innerHTML,/不与上方内容估算直接相加/);assert.match(host.innerHTML,/不表示可安全删除/);
  assert.doesNotMatch(host.innerHTML,/删除历史原件|清理历史原件|original-attempt/);
});

test('accounting details remain in the explicit manager rather than the ordinary inventory summary',async()=>{
  const release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url)));assert.ok(release.files.includes('qianmu-vibe-receipt-accounting.js'));
  const code=await readFile(new URL('../qianmu-vibe-storage.js',import.meta.url),'utf8');assert.match(code,/已登记费用原件/);assert.match(code,/历史独有文件/);assert.match(code,/未登记残留/);assert.match(code,/不与.*相加/);
  const summary=await readFile(new URL('../qianmu-storage-backup-view.js',import.meta.url),'utf8');assert.doesNotMatch(summary,/已登记费用原件|历史独有文件|未登记残留/);
});
