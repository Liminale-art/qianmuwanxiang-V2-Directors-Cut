import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createVibeVariantAccumulator,createVibeAggregationOperations} from '../qianmu-vibe-aggregate.js';
import {parseNovelVibeFile as parse,vibeDigest,selectNovelVibeEncoding} from '../qianmu-vibe-file.js';
import {createVibeStorageActions} from '../qianmu-vibe-storage.js';
import {createVibeAssetOperations} from '../qianmu-vibe-assets-worker.js';
const namespace='st-user:aggregate';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const row=(n,info,extra={})=>({encoding:Buffer.alloc(160,n).toString('base64'),params:{information_extracted:info,...extra}});
async function fixture(encodings={},overrides={}){return (await parse(JSON.stringify({identifier:'novelai-vibe-transfer',version:1,type:'image',id:await vibeDigest(png),image:png,
  name:'基准',createdAt:1,thumbnail:`data:image/png;base64,${png}`,importInfo:{model:'nai-diffusion-4-full',strength:0,information_extracted:0},encodings,...overrides})))[0];}
async function reparse(doc){return (await parse(JSON.stringify(doc)))[0];}
function storeFixture(assets){
  const files=new Map(assets.map(a=>[a.assetId,a])),loads=[];let active=0,peak=0;
  const headers=()=>[...files.values()].map(a=>({namespace,assetId:a.assetId,bytes:a.bytes,summary:a.summary,createdAt:1}));
  const store={head:async(ns,id)=>{assert.equal(ns,namespace);return headers().find(h=>h.assetId===id)||null;},list:async ns=>{assert.equal(ns,namespace);return headers();},
    load:async(ns,id)=>{assert.equal(ns,namespace);active++;peak=Math.max(peak,active);await Promise.resolve();loads.push(id);active--;return files.get(id)||null;},
    put:()=>assert.fail('must not write'),remove:()=>assert.fail('must not delete')};
  return {files,loads,store,peak:()=>peak,ops:createVibeAggregationOperations({store})};
}

test('all model/IE/custom variants survive a round trip, while base envelope and zero defaults are retained',async()=>{
  const base=await fixture({v4full:{zero:row(1,0)}}),next=await fixture({'v4-5full':{one:row(2,1)},futuremodel:{custom:row(3,.5,{focus_seed:0,mask:png})}},
    {name:'Other envelope',createdAt:2,importInfo:{strength:1}}),before=JSON.stringify([base,next]);
  const a=createVibeVariantAccumulator(base);a.add(next);a.add(base);
  const report=a.report();assert.equal(report.fileCount,2);assert.equal(report.variantCount,3);assert.equal(report.conflictCount,0);
  assert.equal(report.metadataDifferenceCount,1);assert.deepEqual(report.metadataDifferences[0].fields,['name','createdAt','importInfo']);
  assert.ok(!JSON.stringify(report).includes(png));assert.ok(!JSON.stringify(report).includes(row(1,0).encoding));
  const [out]=await parse(await (await a.file()).text());assert.equal(out.document.id,base.document.id);assert.notEqual(out.assetId,base.assetId);
  assert.deepEqual(out.document.encodings,{...base.document.encodings,...next.document.encodings});assert.deepEqual(out.document.importInfo,base.document.importInfo);
  for(const key of ['name','createdAt','thumbnail'])assert.equal(out.document[key],base.document[key]);
  assert.equal(selectNovelVibeEncoding(out.document,'nai-diffusion-4-full',0).encoding,row(1,0).encoding);
  assert.equal(selectNovelVibeEncoding(out.document,'nai-diffusion-4-5-full',1).encoding,row(2,1).encoding);
  assert.equal(JSON.stringify([base,next]),before,'source files not mutated');
});

test('identical files/slots are deduplicated, parameter object ordering does not invent conflicts, distinct aliases stay intact',async()=>{
  const r=row(1,0,{focus_seed:4}),base=await fixture({v4full:{first:r}}),other=await fixture({v4full:{first:{encoding:r.encoding,params:{focus_seed:4,information_extracted:0}},alias:r}},{name:'copy'});
  const a=createVibeVariantAccumulator(base);a.add(other);a.add(other);const report=a.report();assert.equal(report.fileCount,2);assert.equal(report.duplicateCount,1);
  assert.equal(report.variantCount,2);assert.equal(report.conflictCount,0);assert.deepEqual((await parse(await (await a.file()).text()))[0].document.encodings.v4full,{first:r,alias:r});
});

test('same slot with altered encoding or parameters is reported without overwriting either input',async()=>{
  const base=await fixture({v4full:{first:row(1,0)}});
  for(const changed of [row(2,0),row(1,.1),row(1,0,{focus_seed:1})]){
    const next=await fixture({v4full:{first:changed}}),a=createVibeVariantAccumulator(base);a.add(next);const report=a.report();
    assert.equal(report.conflictCount,1);assert.equal(report.conflicts[0].kind,'slot');assert.equal(report.conflicts[0].first,base.assetId);assert.equal(report.conflicts[0].second,next.assetId);
    assert.equal(report.variants[0].information,0);await assert.rejects(()=>a.file(),{code:'vibe_file_aggregate',submissionState:'not_submitted'});
  }
});

test('different names do not bypass ambiguous ordinary model/IE detection, while custom variants are not conflated',async()=>{
  const base=await fixture({v4full:{first:row(1,.5)}}),a=createVibeVariantAccumulator(base);
  a.add(await fixture({v4full:{second:row(2,.5)}}));assert.equal(a.report().conflicts[0].kind,'information');await assert.rejects(()=>a.file(),/冲突/);
  const b=createVibeVariantAccumulator(base);b.add(await fixture({v4full:{advanced:row(2,.5,{focus_seed:0}),same:row(1,.5)}}));
  assert.equal(b.report().conflictCount,0);const [asset]=await parse(await (await b.file()).text());assert.equal(asset.summary.variants.length,3);
  assert.equal(selectNovelVibeEncoding(asset.document,'nai-diffusion-4-full',.5).encoding,row(1,.5).encoding);
});

test('unverifiable pure encodings and mismatched originals fail; an interrupted accumulator can never export a partial family',async()=>{
  const base=await fixture(),encoding=row(2,0).encoding,pure=await reparse({identifier:'novelai-vibe-transfer',version:1,type:'encoding',id:await vibeDigest(encoding),encodings:{v4full:{first:{encoding}}}});
  assert.throws(()=>createVibeVariantAccumulator(pure),/纯编码/);
  for(const wrong of [pure,{...base,assetId:'bad'},{...base,document:{...base.document,id:'f'.repeat(64)}},{...base,document:{...base.document,image:'other'}}]){
    const a=createVibeVariantAccumulator(base);assert.throws(()=>a.add(wrong));assert.throws(()=>a.add(base));await assert.rejects(()=>a.file());
  }
});

test('bounded reports count every conflict even when only the first 64 are displayed',async()=>{
  const base=await fixture({v4full:{first:row(1,0)}}),a=createVibeVariantAccumulator(base);
  for(let i=2;i<72;i++)a.add(await fixture({v4full:{first:row(i,0)}},{name:String(i)}));
  assert.equal(a.report().conflictCount,70);assert.equal(a.report().conflicts.length,64);assert.equal(a.report().metadataDifferenceCount,70);assert.equal(a.report().metadataDifferences.length,40);
  await assert.rejects(()=>a.file(),/冲突/);
});

test('model and unique variant limits fail instead of truncating the exported family',async()=>{
  const base=await fixture(Object.fromEntries(Array.from({length:32},(_,i)=>[`model${i}`,{first:row(i,0)}]))),a=createVibeVariantAccumulator(base);
  const extra=await fixture({extra:{first:row(1,0)}});assert.throws(()=>a.add(extra),/32/);await assert.rejects(()=>a.file(),/32/);
  const b=createVibeVariantAccumulator(await fixture({v4full:Object.fromEntries(Array.from({length:256},(_,i)=>[`var${i}`,row(1,0)]))}));
  assert.throws(()=>b.add({...base,assetId:'f'.repeat(64),document:{...base.document,encodings:{v4full:{another:row(1,0)}}}}),/256/);await assert.rejects(()=>b.file(),/256/);
});

test('combined content is bounded before giant final serialization, despite individually valid large input files',async()=>{
  const encoding=Buffer.alloc(6*1024*1024,2).toString('base64');
  const asset=await fixture({v4full:{first:{encoding,params:{information_extracted:0}}}}),a=createVibeVariantAccumulator(asset);
  // Each validated file contains one 8 MiB base64 string; eight copies exceed the single-file 64 MiB limit.
  let error;
  for(let i=1;i<=8;i++){
    const next=await fixture({v4full:{[`slot${i}`]:{encoding,params:{information_extracted:i/10}}}});
    try{a.add(next);}catch(e){error=e;break;}
  }
  assert.match(error?.message||'',/64 MiB/);await assert.rejects(()=>a.file(),/64 MiB/);
});

test('read-only family operations load one body at a time, use only the selected source, and recheck exact metadata',async()=>{
  const base=await fixture({v4full:{first:row(1,0)}}),next=await fixture({'v4-5full':{one:row(2,1)}}),pure=await reparse({identifier:'novelai-vibe-transfer',version:1,type:'encoding',id:await vibeDigest(row(3,0).encoding),encodings:{v4full:{first:row(3,0)}}});
  const e=storeFixture([base,next,pure]),plan=await e.ops.prepare(namespace,base.assetId);assert.equal(e.peak(),1);assert.equal(e.loads[0],base.assetId);
  assert.equal(e.loads.length,2);assert.equal(plan.report.fileCount,2);assert.ok(plan.file instanceof Blob);assert.deepEqual(await e.ops.verify(namespace,plan.id,plan.fingerprint),{verified:true});
  assert.equal(e.loads.length,2,'confirmation reads no media');
  e.files.set('unused',await fixture({v4full:{new:row(3,.3)}}));await assert.rejects(()=>e.ops.verify(namespace,plan.id,plan.fingerprint),/已变化/);
});

test('mid-prepare changes, a missing body or failed integrity read produce no downloadable partial file',async()=>{
  const base=await fixture(),next=await fixture({v4full:{first:row(1,0)}});
  for(const mode of ['new','missing','corrupt']){
    const e=storeFixture([base,next]),load=e.store.load;
    e.store.load=async(ns,id)=>{if(id===next.assetId){if(mode==='missing')return null;if(mode==='corrupt')throw Error('corrupt digest');e.files.set('new',await fixture({v4full:{second:row(2,1)}}));}return load(ns,id);};
    await assert.rejects(()=>e.ops.prepare(namespace,base.assetId),/已变化|缺失|corrupt/);
  }
});

test('invalid or foreign selection/proof cannot authorize aggregate export',async()=>{
  const base=await fixture(),e=storeFixture([base]);for(const [ns,id] of [['bad',base.assetId],[namespace,'bad']])await assert.rejects(()=>e.ops.prepare(ns,id));
  for(const proof of [undefined,'invalid','0'.repeat(64)])await assert.rejects(()=>e.ops.verify(namespace,base.assetId,proof));
  e.store.list=async()=>[{namespace:'st-user:foreign',assetId:base.assetId,summary:base.summary}];await assert.rejects(()=>e.ops.prepare(namespace,base.assetId),/账户不符/);
});

test('actual Worker aggregation route never invokes fee stores, mutation operations or generation locks',async()=>{
  const base=await fixture(),e=storeFixture([base]),encodings=new Proxy({},{get:()=>assert.fail('no fee access')}),locks={request:()=>assert.fail('no generation lock')};
  const run=createVibeAssetOperations(e.store,{encodings,locks}),plan=await run({type:'aggregate-prepare',namespace,id:base.assetId});
  assert.deepEqual(await run({type:'aggregate-verify',namespace,id:base.assetId,proof:plan.fingerprint}),{verified:true});
});

test('UI actions require explicit consent and valid account, keeping prepared identity/blob fixed across confirmation',async()=>{
  const base=await fixture(),e=storeFixture([base]),plan=await e.ops.prepare(namespace,base.assetId),snapshot={namespace,items:[{id:base.assetId,type:'image'}]},calls=[];let live=true;
  const actions=createVibeStorageActions({namespace,guard:async()=>{if(!live)throw Error('account changed');},call:async(type,args)=>{calls.push([type,args]);return type==='aggregate-prepare'?plan:e.ops.verify(args.namespace,args.id,args.proof);}});
  assert.equal(await actions.aggregate(snapshot,base.assetId),plan);await assert.rejects(()=>actions.aggregate({...snapshot,namespace:'st-user:other'},base.assetId));
  for(const yes of [false,undefined,1,'true'])assert.equal(await actions.exportAggregate(plan,async()=>yes),null);assert.equal(calls.length,1);
  await assert.rejects(()=>actions.exportAggregate(plan,async()=>{live=false;return true;}),/account changed/);live=true;
  const original=plan.file,proof=plan.fingerprint,id=plan.id,result=await actions.exportAggregate(plan,async(title,text)=>{
    assert.match(title,/导出/);assert.match(text,/不能代替原文件备份/);assert.match(text,/不会修改原文件/);
    plan.id='f'.repeat(64);plan.fingerprint='e'.repeat(64);plan.file=new Blob(['other']);return true;});
  assert.equal(result,original);assert.deepEqual(calls.at(-1),['aggregate-verify',{namespace,id,proof}]);
});

test('conflicts, bad prepared files and stale manifests never reach a download',async()=>{
  const base=await fixture(),e=storeFixture([base]),plan=await e.ops.prepare(namespace,base.assetId);let verifies=0;
  const actions=createVibeStorageActions({namespace,guard:async()=>{},call:async()=>{verifies++;return {verified:false};}});
  for(const bad of [{...plan,namespace:'st-user:other'},{...plan,report:{conflictCount:1}},{...plan,file:new Blob([])},{...plan,file:'text'}])await assert.rejects(()=>actions.exportAggregate(bad,async()=>assert.fail('invalid plan confirmation')));
  assert.equal(verifies,0);await assert.rejects(()=>actions.exportAggregate(plan,async()=>true),/未确认/);assert.equal(verifies,1);
});

test('aggregate implementation is lazy and included in the release without adding private development files',async()=>{
  const release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url)));assert.ok(release.files.includes('qianmu-vibe-aggregate.js'));
  const worker=await readFile(new URL('../qianmu-vibe-assets-worker.js',import.meta.url),'utf8');assert.match(worker,/await import\('\.\/qianmu-vibe-aggregate.js'\)/);
  assert.ok(!release.files.some(name=>name.includes('local-qa')||name.includes('开发')||name.includes('实测')));
});
