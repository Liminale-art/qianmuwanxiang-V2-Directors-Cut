import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {vibeDigest} from '../qianmu-vibe-file.js';
import {GALLERY_PAGE_INDEX_LIMITS as LIMIT,encodeGalleryIndexPage as encodePage,encodeGalleryIndexManifest as encodeHead,createGalleryPageIndexReader as create} from '../qianmu-gallery-page-index.js';

const source={namespace:'st-user:synthetic',ownerKey:'char:Alice.png',chatKey:'synthetic-chat'};
// These are fake metadata pointers, NOT proof that original files exist.
const row=index=>({recordId:`image-${String(index).padStart(6,'0')}`,createdAt:index,label:`画面 ${index}`,tags:index%3===0?['厨房','室内']:['室内'],record:{sha256:'a'.repeat(64),bytes:2048}});
const deferred=()=>{let resolve;return {promise:new Promise(yes=>{resolve=yes;}),resolve};};
async function sealed(value){const text=JSON.stringify(value);return {text,reference:{sha256:await vibeDigest(text),bytes:new TextEncoder().encode(text).length}};}
async function fixture(count=260){
  const files=new Map(),descriptions=[],input=Array.from({length:count},(_,i)=>row(count-i));
  for(let at=0;at<input.length;at+=LIMIT.rows){const page=await encodePage(source,input.slice(at,at+LIMIT.rows));files.set(page.reference.sha256,page.text);descriptions.push(page.descriptor);}
  const head=await encodeHead(source,descriptions),calls=[];
  let current=true;
  const options={source,head,guard:async()=>current,readPage:async(ref,{signal})=>{assert.equal(signal.aborted,false);calls.push(ref);return files.get(ref.sha256);}};
  return {files,descriptions,head,input,calls,options,change(){current=false;}};
}

test('bounded metadata pages preserve exact identities/tags and only read the requested page',async()=>{
  const f=await fixture(),reader=await create(f.options);assert.equal(f.calls.length,0);
  const first=await reader.page();assert.equal(first.rows.length,24);assert.equal(first.pagesRead,1);assert.equal(first.scanned,24);assert.equal(first.total,260);
  assert.deepEqual(first.rows,f.input.slice(0,24));assert.equal(first.proof,'integrity-only-not-durable');
  first.rows[0].record.sha256='edited';
  const second=await reader.page({limit:60,cursor:first.cursor});assert.deepEqual(second.rows,f.input.slice(24,84));
  const again=await reader.page();assert.deepEqual(again.rows[0],f.input[0]);reader.close();
});

test('pagination across every boundary returns all records once in narrative-independent chronological order',async()=>{
  const f=await fixture(391),reader=await create(f.options),received=[];let cursor;
  do{const page=await reader.page({limit:57,...(cursor?{cursor}: {})});received.push(...page.rows);cursor=page.cursor;}while(cursor);
  assert.deepEqual(received,f.input);assert.equal(new Set(received.map(row=>row.recordId)).size,391);reader.close();
});

test('multi-keyword filtering uses intersection; empty filtered pages still provide bounded continuation',async()=>{
  const f=await fixture(1300),reader=await create(f.options);
  const both=await reader.page({tags:['室内','厨房'],limit:60});assert.equal(both.rows.length,60);assert.ok(both.rows.every(row=>row.createdAt%3===0));
  f.calls.length=0;const absent=await reader.page({tags:['不存在']});assert.equal(absent.rows.length,0);assert.equal(absent.pagesRead,4);assert.equal(absent.scanned,512);assert.equal(f.calls.length,4);assert.equal(absent.hasMore,true);
  const next=await reader.page({tags:['不存在'],cursor:absent.cursor});assert.equal(next.scanned,512);assert.notDeepEqual(next.cursor,absent.cursor);reader.close();
});

test('empty index performs no page I/O and does not fabricate an absent original or a storage receipt',async()=>{
  const f=await fixture(0),reader=await create(f.options),result=await reader.page();
  assert.deepEqual(result,{rows:[],total:0,scanned:0,pagesRead:0,hasMore:false,cursor:null,proof:'integrity-only-not-durable'});assert.equal(f.calls.length,0);reader.close();
});

test('cursor is pinned to the complete immutable head and filter, but result size can change',async()=>{
  const f=await fixture(),reader=await create(f.options),first=await reader.page();
  for(const cursor of [{...first.cursor,manifest:'b'.repeat(64)},{...first.cursor,offset:128},{...first.cursor,page:999},{...first.cursor,version:2},{...first.cursor,extra:true}])await assert.rejects(reader.page({cursor}),/续页/);
  await assert.rejects(reader.page({cursor:first.cursor,tags:['室内']}),/续页/);
  const next=await reader.page({cursor:first.cursor,limit:1});assert.equal(next.rows[0].recordId,f.input[24].recordId);
  const revised=await fixture(261),other=await create(revised.options);await assert.rejects(other.page({cursor:first.cursor}),/续页/);
  reader.close();other.close();
});

test('invalid metadata is rejected without truncating or silently projecting sensitive fields',async()=>{
  const variants=[{...row(1),prompt:'not allowed'},{...row(1),url:'https://not-allowed/'},{...row(1),snapshot:{}},{...row(1),record:{sha256:'../path',bytes:3}},
    {...row(1),label:'x'.repeat(241)},{...row(1),tags:['室内','室内']},{...row(1),recordId:''},{...row(1),createdAt:-1}];
  for(const item of variants)await assert.rejects(encodePage(source,[item]));
  for(const rows of [[],[row(1),row(2)],[row(2),row(2)],Array.from({length:129},(_,i)=>row(129-i))])await assert.rejects(encodePage(source,rows));
  const input=[row(2),row(1)],before=structuredClone(input);await encodePage(source,input);assert.deepEqual(input,before);
});

test('encoder never invokes getters/toJSON or accepts symbols, holes, hidden fields and lossy scalars',async()=>{
  const cases=[];let invoked=0;
  const getter=row(1);Object.defineProperty(getter,'label',{enumerable:true,get(){invoked++;return 'bad';}});cases.push([getter]);
  const method=row(1);method.toJSON=()=>{invoked++;return row(1);};cases.push([method]);
  const hidden=row(1);Object.defineProperty(hidden,'secret',{value:'bad'});cases.push([hidden]);
  const symbol=row(1);symbol[Symbol('hidden')]='bad';cases.push([symbol]);
  cases.push([,row(1)],[{...row(1),label:'\ud800'}],[{...row(1),createdAt:Infinity}]);
  const circular=row(1);circular.label=circular;cases.push([circular]);
  for(const rows of cases)await assert.rejects(encodePage(source,rows));assert.equal(invoked,0);
});

test('manifest totals, duplicate pages, reversed/overlapping bounds and foreign scope fail closed',async()=>{
  const f=await fixture();
  for(const pages of [[...f.descriptions].reverse(),[f.descriptions[0],f.descriptions[0]],[{...f.descriptions[0],count:129}],Array(513).fill(f.descriptions[0])])await assert.rejects(encodeHead(source,pages));
  const bad=JSON.parse(f.head.text);bad.total--;await assert.rejects(create({...f.options,head:await sealed(bad)}),/总数/);
  for(const change of [{namespace:'st-user:other'},{ownerKey:'char:Other.png'},{chatKey:'other'}])await assert.rejects(create({...f.options,source:{...source,...change}}),/来源/);
});

test('digest, byte length, missing file, duplicate JSON keys and page scope failures never return partial results',async()=>{
  const f=await fixture(),ref=f.descriptions[0];
  for(const replacement of [undefined,f.files.get(ref.sha256)+' ',f.files.get(ref.sha256).replace('画面','修改')]){
    const reader=await create({...f.options,readPage:async()=>replacement});await assert.rejects(reader.page(),/校验/);reader.close();
  }
  const pageValue=JSON.parse(f.files.get(ref.sha256));pageValue.scope.namespace='st-user:other';const foreign=await sealed(pageValue);
  const head=await encodeHead(source,[{...ref,...foreign.reference}]);
  const reader=await create({...f.options,head,readPage:async()=>foreign.text});await assert.rejects(reader.page(),/来源/);reader.close();
  const duplicated=f.head.text.replace('"total":260','"total":260,"total":260');
  await assert.rejects(create({...f.options,head:{text:duplicated,reference:{sha256:await vibeDigest(duplicated),bytes:new TextEncoder().encode(duplicated).length}}}),/JSON/);
  const secondMissing=await create({...f.options,readPage:async ref=>ref.sha256===f.descriptions[0].sha256?f.files.get(ref.sha256):undefined});
  await assert.rejects(secondMissing.page({tags:['不存在']}),/校验/);secondMissing.close();
});

test('page description is checked against decoded count and range, not only its hash',async()=>{
  const f=await fixture(3),wrong={...f.descriptions[0],count:2};const head=await encodeHead(source,[wrong]);
  const reader=await create({...f.options,head});await assert.rejects(reader.page(),/摘要/);reader.close();
});

test('account invalidation and close while an adapter is pending discard late metadata; close aborts the adapter signal',async()=>{
  for(const close of [false,true]){
    const f=await fixture(),gate=deferred(),start=deferred();let signal;
    const reader=await create({...f.options,readPage:async(ref,options)=>{signal=options.signal;start.resolve();await gate.promise;return f.files.get(ref.sha256);}});
    const pending=reader.page(),rejected=assert.rejects(pending,/来源|关闭/);await start.promise;
    if(close){reader.close();assert.equal(signal.aborted,true);}else f.change();gate.resolve();await rejected;reader.close();
  }
});

test('parallel page reads are bounded and failed reads release their slot',async()=>{
  const f=await fixture(),gate=deferred();let entered=0;const start=deferred();
  const reader=await create({...f.options,readPage:async ref=>{if(++entered===4)start.resolve();await gate.promise;return f.files.get(ref.sha256);}});
  const pending=Array.from({length:4},()=>reader.page());await start.promise;
  await assert.rejects(reader.page(),/正忙/);assert.equal(entered,4);gate.resolve();await Promise.all(pending);
  assert.equal((await reader.page()).rows.length,24);reader.close();await assert.rejects(reader.page(),/关闭/);
});

test('input options and descriptors cannot be changed during asynchronous integrity checks',async()=>{
  const f=await fixture(),gate=deferred(),started=deferred();let wait=false;
  const reader=await create({...f.options,guard:async()=>{if(wait){started.resolve();await gate.promise;}return true;}});
  wait=true;const options={limit:1,tags:['厨房']},pending=reader.page(options);await started.promise;
  options.limit=60;options.tags=[];f.options.source={...source,chatKey:'other'};f.descriptions[0].count=1;gate.resolve();
  const result=await pending;assert.equal(result.rows.length,1);assert.equal(result.rows[0].createdAt%3,0);reader.close();
});

test('synthetic 1k/10k/50k indexes keep first paint to one small page, without reading records or media',async()=>{
  for(const count of [1000,10000,50000]){
    const f=await fixture(count),reader=await create(f.options);assert.equal(f.calls.length,0);
    const first=await reader.page();assert.equal(first.total,count);assert.equal(first.rows.length,24);assert.equal(first.scanned,24);assert.equal(first.pagesRead,1);assert.equal(f.calls.length,1);
    assert.ok(f.head.reference.bytes<LIMIT.manifestBytes);assert.ok(f.calls[0].bytes<64*1024);
    assert.deepEqual(first.rows,f.input.slice(0,24));reader.close();
  }
});

test('index contract ships for read-only discovery, without wiring gallery pruning or generation',async()=>{
  const entry=await readFile(new URL('../index.js',import.meta.url),'utf8'),release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));
  const implementation=await readFile(new URL('../qianmu-gallery-page-index.js',import.meta.url),'utf8');
  assert.doesNotMatch(entry,/qianmu-gallery-page-index/);assert.equal(release.files.includes('qianmu-gallery-page-index.js'),true);
  assert.equal(release.files.includes('qianmu-gallery-discovery-service.js'),true);
  assert.doesNotMatch(entry,/pruneStoryboardRetakeGallery\(/,'record count cannot authorize deleting gallery history');
  assert.doesNotMatch(implementation,/\bfetch\s*\(|\bindexedDB\b|\.unlink\(|\.writeFile\(|\.splice\(|\badmit\s*\(/);
});

test('oversized UTF-8 pages and invalid escaped Unicode are rejected, not clipped or substituted',async()=>{
  const tags=Array.from({length:30},(_,index)=>`${String(index).padStart(2,'0')}${'词'.repeat(78)}`);
  await assert.rejects(encodePage(source,Array.from({length:128},(_,i)=>({...row(128-i),tags}))),/上限/);
  const f=await fixture(1),value=JSON.parse(f.files.get(f.descriptions[0].sha256));value.rows[0].label='\ud800';
  const encoded=await sealed(value),head=await encodeHead(source,[{...f.descriptions[0],...encoded.reference}]);
  const reader=await create({...f.options,head,readPage:async()=>encoded.text});await assert.rejects(reader.page(),/JSON/);reader.close();
});

test('bad query shapes and scope metadata fail before the page adapter is called',async()=>{
  const f=await fixture(),reader=await create(f.options);
  for(const input of [{limit:0},{limit:61},{limit:1.2},{tags:[' x']},{tags:Array(31).fill('x')},{search:'not supported'},{cursor:{}}])await assert.rejects(reader.page(input));
  assert.equal(f.calls.length,0);reader.close();
  await assert.rejects(encodePage({...source,ownerKey:'char:../Other.png'},[row(1)]));
  await assert.rejects(encodePage({...source,account:'unrelated'},[row(1)]));
});
