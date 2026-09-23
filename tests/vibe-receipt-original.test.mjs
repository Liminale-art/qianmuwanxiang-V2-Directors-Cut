import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createVibeReceiptOriginals,validateVibeReceiptOriginal,VIBE_RECEIPT_ORIGINAL_SLOT,VIBE_RECEIPT_ORIGINAL_LIMITS as limits} from '../qianmu-vibe-receipt-original.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';
import {receiptInput,receiptLegacyFixture} from './helpers/vibe-receipt-fixture.mjs';
import {VIBE_ENCODING_RECEIPT_LIMIT,VIBE_ENCODING_ARCHIVE_LIMIT} from '../qianmu-vibe-encoding-store.js';

async function fixture(t){const f=await characterNativeFixture(t),clients=[];t.after(()=>clients.forEach(c=>c.close()));
  const open=async(options={})=>{const client=await f.createStorage({maxBytes:limits.part});clients.push(client);return createVibeReceiptOriginals(client,options);};
  return {...f,open,originals:await open(),get uploads(){return f.uploads;}};
}
const selected=input=>({cacheKey:input.receipt.cacheKey,section:input.section});
const manifest=async(f,saved)=>(await f.storage.readImmutable(saved.reference)).value;

test('actual local census captures current, archived and complete histories in one readonly transaction',async t=>{
  const a=await receiptInput({reviewCount:65,undefinedDelivery:true}),b=await receiptInput({status:'ready',section:'archived',information:.5});
  const f=receiptLegacyFixture([a,b]),store=f.open();t.after(()=>store.close());const before=structuredClone(f.state.tables),result=await store.census(namespace);
  assert.deepEqual(result.current,[a.receipt]);assert.deepEqual(result.archived,[b.receipt]);assert.deepEqual(result.reviewSegments,a.segments);
  assert.deepEqual(result.archiveUsage,before.archiveUsage[0]);assert.deepEqual(result.reviewUsage,before.reviewUsage[0]);
  assert.equal(f.state.transactions.length,1);assert.deepEqual(f.state.transactions[0].names,['receipts','archive','archiveUsage','reviewSegments','reviewUsage']);assert.deepEqual(f.state.tables,before);
  assert.deepEqual(f.state.reads.map(r=>r.limit),[2049,16385,4097]);
});

test('empty, unavailable and closed local census never constructs a write transaction or an empty fallback',async t=>{
  const f=receiptLegacyFixture(),store=f.open();t.after(()=>store.close());assert.deepEqual(await store.census(namespace),{namespace,current:[],archived:[],reviewSegments:[],archiveUsage:null,reviewUsage:null});
  await assert.rejects(store.census('other'));store.close();await assert.rejects(store.census(namespace));
  const broken=receiptLegacyFixture();broken.state.error=true;const db=broken.open();t.after(()=>db.close());await assert.rejects(db.census(namespace));assert.equal(broken.state.transactions.length,0);
});

test('census refuses every existing capacity overflow without truncating or raising the limits',async t=>{
  const input=await receiptInput();
  for(const [name,count] of [['receipts',2049],['archive',16385],['reviewSegments',4097]]){
    const f=receiptLegacyFixture();f.state.tables[name]=Array(count).fill(input.receipt);
    const store=f.open();t.after(()=>store.close());await assert.rejects(store.census(namespace),/超过原有上限/);assert.equal(f.state.tables[name].length,count);
  }
});

test('census rejects inaccurate counters, duplicate/archive uncertainty, orphaned or broken review evidence',async t=>{
  const current=await receiptInput({reviewCount:33}),old=await receiptInput({status:'ready',section:'archived',information:.5});
  const edits=[s=>s.archiveUsage[0].bytes++,s=>s.reviewUsage[0].reviews++,s=>s.reviewUsage=[],s=>s.archiveUsage=[],s=>s.receipts.push(s.archive[0]),
    s=>s.archive[0].status='unknown',s=>s.reviewSegments[0].reviews[0].attemptId='forged-attempt',s=>s.receipts=[],s=>s.reviewSegments.pop(),
    s=>s.reviewSegments.push(s.reviewSegments[0]),s=>s.receipts[0].pastReviews=[s.reviewSegments[0].reviews[0]],s=>s.receipts[0].identity.parameters.information_extracted=.1];
  for(const edit of edits){const f=receiptLegacyFixture([current,old]);edit(f.state.tables);const store=f.open();t.after(()=>store.close());await assert.rejects(store.census(namespace));}
});

test('same-account independent readers recover each status and exact source, channel, attempt and fractional time',async t=>{
  const f=await fixture(t),b=await f.open();
  for(const status of ['reserved','submitting','unknown','rejected','reviewed','ready']){
    const input=await receiptInput({status}),saved=await f.originals.preserve(input);assert.deepEqual(await b.read(saved.reference,selected(input)),input);
  }
  assert.ok(!f.calls.some(call=>/delete|plugins|generate|completions|encode-vibe/.test(call.path)));
  assert.ok([...f.files.values()].every(text=>JSON.parse(text).schema==='qianmu.st-account-document.v1'));
});

test('full 2048-review history splits safely and preserves explicit undefined and negative zero',async t=>{
  const f=await fixture(t),events=[],api=await f.open({onProgress:e=>events.push(e)}),input=await receiptInput({reviewCount:2048,undefinedDelivery:true});input.receipt.createdAt=-0;
  const saved=await api.preserve(input),m=await manifest(f,saved);assert.ok(m.parts.length>3);
  const loaded=await (await f.open()).read(saved.reference,selected(input));assert.deepEqual(loaded,input);assert.ok(Object.is(loaded.receipt.createdAt,-0));
  assert.ok(Object.hasOwn(loaded.segments[0].reviews[0],'delivery'));assert.equal(loaded.receipt.identity.parameters.information_extracted,0);
  assert.equal(events.at(-1).stage,'complete');assert.equal(events.at(-1).bytes,m.bytes);assert.equal(events.filter(e=>e.stage==='part').reduce((sum,e)=>sum+e.bytes,0),m.bytes);
});

test('archive classification and complete service provenance survive without settling or authorizing anything',async t=>{
  const f=await fixture(t),input=await receiptInput({status:'ready',section:'archived',reviewCount:16});input.receipt.delivery={version:1,transport:'service',channelKey:'d'.repeat(64),serviceAttemptId:'e'.repeat(64)};
  const saved=await f.originals.preserve(input);assert.deepEqual(await f.originals.read(saved.reference,selected(input)),input);
  assert.deepEqual(Object.keys(f.originals).sort(),['preserve','read']);
  const invalid=await receiptInput({section:'archived'}),uploads=f.uploads;await assert.rejects(f.originals.preserve(invalid));assert.equal(f.uploads,uploads);
});

test('receipt identities, review provenance and chain integrity fail before any preservation',async t=>{
  const f=await fixture(t),base=await receiptInput({reviewCount:40});
  const edits=[i=>i.namespace='st-user:other',i=>i.receipt.namespace='st-user:other',i=>i.receipt.sourceAssetRef.namespace='st-user:other',
    i=>i.receipt.delivery.apiKey='not-allowed',i=>i.receipt.identity.parameters.information_extracted=.2,i=>i.receipt.status='ready',
    i=>i.segments.pop(),i=>i.segments.push(i.segments[0]),i=>i.segments[0].reviews[0].feeReview.method=undefined,i=>i.receipt.pastReviews=[i.segments[0].reviews[0]],
    i=>i.receipt.reviewArchive.count++,i=>i.extra=true];
  for(const edit of edits){const input=structuredClone(base);edit(input);await assert.rejects(f.originals.preserve(input));}assert.equal(f.uploads,0);
});

test('unrepresentable records are rejected rather than dropping properties or running accessors',async t=>{
  const f=await fixture(t),base=await receiptInput();
  const edits=[i=>i.receipt.createdAt=NaN,i=>i.receipt.createdAt=Infinity,i=>i.receipt.extra=()=>0,i=>i.segments=new Array(2),
    i=>i.receipt.extra=new Date(),i=>Object.setPrototypeOf(i.receipt,null),i=>i.receipt.extra=i,i=>Object.defineProperty(i,'hidden',{value:1}),i=>i[Symbol('x')]=1,
    i=>Object.defineProperty(i,'receipt',{get(){throw Error('getter must not execute');},enumerable:true})];
  for(const edit of edits){const input=structuredClone(base);edit(input);await assert.rejects(f.originals.preserve(input),error=>error.message!=='getter must not execute');}assert.equal(f.uploads,0);
});

test('late local completion preserves both exact originals and never silently rewrites earlier uncertainty',async t=>{
  const f=await fixture(t),input=await receiptInput({status:'submitting'}),local=receiptLegacyFixture([input]),store=local.open();t.after(()=>store.close());
  const before=await store.census(namespace),a=await f.originals.preserve({...input,receipt:before.current[0]});
  const row=local.state.tables.receipts[0];row.status='ready';row.assetRef={version:1,namespace,id:'e'.repeat(64)};row.updatedAt=2;
  const after=await store.census(namespace),b=await f.originals.preserve({...input,receipt:after.current[0]});assert.notEqual(a.reference.fingerprint,b.reference.fingerprint);
  const reader=await f.open();assert.equal((await reader.read(a.reference,selected(input))).receipt.status,'submitting');assert.equal((await reader.read(b.reference,selected(input))).receipt.status,'ready');
  assert.equal((await reader.read(b.reference,selected(input))).receipt.attemptId,input.receipt.attemptId);
  const uploads=f.uploads,repeated=await f.originals.preserve({...input,receipt:after.current[0]});assert.deepEqual(repeated,b);assert.equal(f.uploads,uploads);
});

test('well-hashed but invalid lossless tag data cannot become a fee receipt',async t=>{
  const f=await fixture(t),input=await receiptInput(),saved=await f.originals.preserve(input),m=await manifest(f,saved);
  const {vibeDigest}=await import('../qianmu-vibe-file.js');
  for(const text of ['["function","return true"]','["object",[["namespace","one"],["namespace","two"]]]','["array",[]]']){
    const part=await f.storage.preserveImmutable('vibe-receipt-part',text),forged={...m,bytes:Buffer.byteLength(text),digest:await vibeDigest(text),parts:[part.reference]};
    const original=await f.storage.preserveImmutable(VIBE_RECEIPT_ORIGINAL_SLOT,forged);await assert.rejects(f.originals.read(original.reference,selected(input)));
  }
});

test('input is captured before the first await; subsequent edits cannot change retained fee evidence',async t=>{
  const f=await fixture(t),input=await receiptInput({reviewCount:20}),before=structuredClone(input);let first=true;
  const api=await f.open({guard(){if(first){first=false;input.receipt.status='rejected';input.segments.length=0;}return true;}});
  const saved=await api.preserve(input);assert.deepEqual(await f.originals.read(saved.reference,selected(before)),before);
});

test('foreign, arbitrary-slot, oversized and unselected references fail without issuing a request',async t=>{
  const f=await fixture(t),input=await receiptInput(),saved=await f.originals.preserve(input);f.reset();
  for(const patch of [{scope:'a'.repeat(64)},{slot:'vibe-original'},{version:2},{bytes:limits.manifest+1025},{url:'https://other.invalid'}])await assert.rejects(f.originals.read({...saved.reference,...patch},selected(input)));
  await assert.rejects(f.originals.read(saved.reference));assert.equal(f.calls.length,0);
  await assert.rejects(f.originals.read(saved.reference,{cacheKey:'a'.repeat(64),section:'current'}));
  await assert.rejects(f.originals.read(saved.reference,{...selected(input),section:'archived'}));
});

test('directory validation binds account, bounds and immutable part slots',async t=>{
  const f=await fixture(t),input=await receiptInput(),saved=await f.originals.preserve(input),m=await manifest(f,saved);
  for(const edit of [v=>v.namespace='st-user:other',v=>v.schema='unknown',v=>v.parts[0].slot='vibe-original-part',v=>v.parts[0].scope='f'.repeat(64),
    v=>v.parts=Array(limits.parts+1).fill(v.parts[0]),v=>v.bytes=limits.body+1,v=>v.section='other',v=>v.extra=true]){
    const value=structuredClone(m);edit(value);assert.throws(()=>validateVibeReceiptOriginal(value,{namespace,scope:f.storage.scope}));
  }
  assert.equal(VIBE_ENCODING_RECEIPT_LIMIT,2048);assert.equal(VIBE_ENCODING_ARCHIVE_LIMIT,16384);
});

test('missing and corrupted parts fail closed without recreating a receipt or authorizing retries',async t=>{
  for(const corrupt of [false,true]){const f=await fixture(t),input=await receiptInput(),saved=await f.originals.preserve(input),name=[...f.files.keys()].find(n=>n.includes('-vibe-receipt-part-'));
    if(corrupt)f.files.set(name,f.files.get(name).replace('original-attempt','tampered-attempt'));else f.files.delete(name);
    const uploads=f.uploads;await assert.rejects(f.originals.read(saved.reference,selected(input)));assert.equal(f.uploads,uploads);
  }
});

test('correctly addressed but reordered or inconsistent aggregate parts are rejected',async t=>{
  const f=await fixture(t),input=await receiptInput({reviewCount:600}),saved=await f.originals.preserve(input),m=await manifest(f,saved);assert.ok(m.parts.length>1);
  for(const edit of [v=>v.parts.reverse(),v=>v.bytes++,v=>v.digest='0'.repeat(64),v=>v.cacheKey='1'.repeat(64)]){
    const value=structuredClone(m);edit(value);const forged=await f.storage.preserveImmutable(VIBE_RECEIPT_ORIGINAL_SLOT,value);
    await assert.rejects(f.originals.read(forged.reference,{cacheKey:value.cacheKey,section:value.section}));
  }
});

test('account changes, cancellation, guard rejection and closed transport stop both reads and writes',async t=>{
  for(const kind of ['account','cancel','guard','closed']){const f=await fixture(t),input=await receiptInput(),saved=await f.originals.preserve(input),abort=new AbortController();let active=true;
    const client=await f.createStorage({maxBytes:limits.part});t.after(()=>client.close());const api=createVibeReceiptOriginals(client,{signal:abort.signal,guard:()=>active});
    if(kind==='account')f.account('st-user:other');if(kind==='cancel')abort.abort();if(kind==='guard')active=false;if(kind==='closed')client.close();
    const uploads=f.uploads;await assert.rejects(api.preserve(input));await assert.rejects(api.read(saved.reference,selected(input)));assert.equal(f.uploads,uploads);
  }
});

test('mid-progress cancellation leaves verified parts but no completed original directory',async t=>{
  const f=await fixture(t),input=await receiptInput({reviewCount:600}),abort=new AbortController(),api=await f.open({signal:abort.signal,onProgress(){abort.abort();}});
  await assert.rejects(api.preserve(input));assert.ok([...f.files.keys()].some(n=>n.includes('-vibe-receipt-part-')));
  assert.ok(![...f.files.keys()].some(n=>n.includes('-vibe-receipt-original-')));
});

test('lost immutable acknowledgement is surfaced without automatic retransmission or ledger mutation',async t=>{
  const f=await fixture(t),input=await receiptInput();let writes=0;
  f.hook(call=>{if(call.path!=='/api/files/upload')return;writes++;const {name,data}=JSON.parse(call.request.body);f.files.set(name,Buffer.from(data,'base64').toString());throw Error('accepted; acknowledgement lost');});
  await assert.rejects(f.originals.preserve(input));assert.equal(writes,1);assert.equal(f.files.size,1);assert.ok(![...f.files.keys()].some(n=>n.endsWith('-vibe-receipt-original.json')));
});

test('actual readonly census can be preserved and reread on a separate client without a local DB',async t=>{
  const f=await fixture(t),inputs=[await receiptInput({reviewCount:65}),await receiptInput({status:'ready',section:'archived',information:.5})],legacy=receiptLegacyFixture(inputs),store=legacy.open();t.after(()=>store.close());
  const before=structuredClone(legacy.state.tables),census=await store.census(namespace),reader=await f.open();
  for(const section of ['current','archived'])for(const receipt of census[section]){
    const input={namespace,section,receipt,segments:census.reviewSegments.filter(row=>row.cacheKey===receipt.cacheKey)},saved=await f.originals.preserve(input);
    assert.deepEqual(await reader.read(saved.reference,selected(input)),input);
  }assert.deepEqual(legacy.state.tables,before);
});

test('new original component is in the release but is not advertised or wired as a paid execution ledger',async()=>{
  const release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));assert.ok(release.files.includes('qianmu-vibe-receipt-original.js'));
  const source=await readFile(new URL('../qianmu-vibe-receipt-original.js',import.meta.url),'utf8');assert.doesNotMatch(source,/client\.(?:write|update|delete)\(|fetch\(|indexedDB/);
  const retention=await readFile(new URL('../qianmu-vibe-encoding-retention.js',import.meta.url),'utf8');assert.doesNotMatch(retention,/qianmu-vibe-receipt-original/);
});
