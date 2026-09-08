import test from 'node:test';
import assert from 'node:assert/strict';
import {mappingFixture,namespace} from './fixtures/storyboard-mappings.mjs';
import {mappingHead,mappingBytes,validateMappingList,validateMappingDetail,validateMappingExport,validateMappingStorage} from '../qianmu-storyboard-mapping-contract.js';
import {runMappingRegistry} from '../qianmu-storyboard-mapping-registry.js';
import {runRestoreStorage,collectStoryboardMappingStorage} from '../qianmu-storyboard-restore-storage-runtime.js';
import {renderMappingRegistry} from '../qianmu-storyboard-mapping-view.js';
import {inspectStoryboardSubjectMapReview} from '../qianmu-storyboard-subject-map.js';
const query={kind:'all',query:'',offset:0};
async function fixture(){
  const records=await mappingFixture(),heads=Object.entries(records).map(([kind,row])=>mappingHead(kind,row)),e={reads:0,guards:0,valid:true,heads,records};
  const journal={listMappingHeads:async ns=>{assert.equal(ns,namespace);return structuredClone(e.heads);},loadMappingReceipt:async(ns,kind,id)=>{
    assert.equal(ns,namespace);e.reads++;const row=e.records[kind];assert.equal(id,row.review.digest);if(kind==='subjects')await inspectStoryboardSubjectMapReview(row.review);e.afterRead?.();return structuredClone(row);
  }};
  const options={journal,namespace,guard:async()=>{e.guards++;if(!e.valid)throw Error('account changed');}};return {e,options};
}
test('mapping inventory and search use only compact heads and count receipt bodies and heads once',async()=>{
  const {e,options}=await fixture(),summary=await runMappingRegistry('mappings',options),list=await runMappingRegistry('mapping-list',{...options,input:query});
  assert.equal(summary.count,2);assert.equal(summary.recordBytes,Object.values(e.records).reduce((sum,row)=>sum+mappingBytes(row),0));assert.equal(summary.indexBytes,e.heads.reduce((sum,row)=>sum+mappingBytes(row),0));
  assert.equal(summary.bytes,summary.recordBytes+summary.indexBytes);assert.equal(e.reads,0);assert.equal(list.rows[0].kind,'subjects');assert.equal(list.rows[0].createdAt,2);
  assert.doesNotMatch(JSON.stringify(list),/Private narrative|source-24|<chat>|lineage|instanceId/);assert.deepEqual(validateMappingStorage(summary,namespace),summary);
  assert.equal((await runMappingRegistry('mapping-list',{...options,input:{kind:'subjects',query:e.records.subjects.review.digest.toUpperCase().slice(0,16),offset:0}})).total,1);
});
test('empty registry is explicit zero while stale pages, bad filters, extra payloads, duplicate and alien heads fail',async()=>{
  const {e,options}=await fixture();
  for(const input of [{...query,offset:24},{...query,kind:'mutations'},{...query,query:'x'.repeat(161)},{...query,profile:'private'}])await assert.rejects(runMappingRegistry('mapping-list',{...options,input}));
  e.heads.push(e.heads[0]);await assert.rejects(runMappingRegistry('mappings',options));e.heads=[];
  assert.equal((await runMappingRegistry('mappings',options)).bytes,0);assert.equal((await runMappingRegistry('mapping-list',{...options,input:query})).total,0);
});
test('detail pages revalidate whole lineage but reveal only 24 pairs and retain null/default/chat distinctions',async()=>{
  const {e,options}=await fixture(),input={kind:'subjects',digest:e.records.subjects.review.digest,offset:0};
  const first=await runMappingRegistry('mapping-detail',{...options,input}),last=await runMappingRegistry('mapping-detail',{...options,input:{...input,offset:24}});
  assert.equal(first.rows.length,24);assert.equal(first.total,25);assert.equal(last.rows.length,1);assert.equal(e.reads,2);
  assert.equal(first.rows[0].source.scope,'default');assert.equal(first.rows[1].source.archiveId,'');assert.equal(first.rows[1].source.scope,'chat');assert.equal(first.rows[1].target.archiveId,'');
  assert.doesNotMatch(JSON.stringify(first),/Private narrative|Changed narrative/);assert.equal(first.rows[0].source.revision,'source-0');
  assert.throws(()=>validateMappingDetail({...first,patch:'private'},namespace,input));
  await assert.rejects(runMappingRegistry('mapping-detail',{...options,input:{...input,offset:48}}));
});
test('environment detail shows both installation labels but makes no authenticated identity claim',async()=>{
  const {e,options}=await fixture(),input={kind:'environment',digest:e.records.environment.review.digest,offset:0},detail=await runMappingRegistry('mapping-detail',{...options,input});
  assert.equal(detail.rows.length,1);assert.equal(detail.rows[0].sourceInstance,e.records.environment.review.source.instanceId);assert.notEqual(detail.rows[0].sourceInstance,detail.rows[0].targetInstance);
});
test('export verifies the original receipt and serializes all lineage in a Blob, without replay or trimming',async()=>{
  const {e,options}=await fixture(),input={kind:'subjects',digest:e.records.subjects.review.digest},before=structuredClone(e.records),result=await runMappingRegistry('mapping-export',{...options,input});
  const exported=JSON.parse(await result.file.text());assert.equal(exported.schema,'qianmu.storyboard.mapping-receipt.v1');assert.deepEqual(exported.receipt,before.subjects);assert.equal(exported.receipt.review.lineage.length,25);assert.deepEqual(e.records,before);
  assert.deepEqual(validateMappingExport(result,namespace,input),result);assert.throws(()=>validateMappingExport({...result,filename:'bad.json'},namespace,input));
  assert.throws(()=>validateMappingExport({...result,file:new Blob(['private'],{type:'text/plain'})},namespace,input));
});
test('corrupt bodies, valid but replaced metadata and changed account guard all stop export',async()=>{
  const {e,options}=await fixture(),input={kind:'subjects',digest:e.records.subjects.review.digest};
  e.records.subjects.review.lineage[0].target.archiveId='wrong';await assert.rejects(runMappingRegistry('mapping-export',{...options,input}),/谱系/);
  e.records=await mappingFixture();e.records.subjects.createdAt=99;await assert.rejects(runMappingRegistry('mapping-export',{...options,input}),/目录不符/);
  e.valid=false;await assert.rejects(runMappingRegistry('mappings',options),/account changed/);
});
test('a late account switch during full receipt verification discards the export before returning a Blob',async()=>{
  const {e,options}=await fixture();e.afterRead=()=>{e.valid=false;};
  await assert.rejects(runMappingRegistry('mapping-export',{...options,input:{kind:'subjects',digest:e.records.subjects.review.digest}}),/account changed/);assert.equal(e.reads,1);
});
test('maximum binding count keeps the final eight rows and all 2048 original pairs in the export',async()=>{
  const records=await mappingFixture({bindings:2048}),head=mappingHead('subjects',records.subjects),journal={listMappingHeads:async()=>[head],loadMappingReceipt:async()=>records.subjects};
  const input={kind:'subjects',digest:head.digest},options={journal,namespace};
  const detail=await runMappingRegistry('mapping-detail',{...options,input:{...input,offset:2040}});assert.equal(detail.rows.length,8);assert.equal(detail.rows[7].source.revision,'source-2047');
  const result=await runMappingRegistry('mapping-export',{...options,input});assert.equal(JSON.parse(await result.file.text()).receipt.review.lineage.length,2048);
});
class WorkerFixture{
  static handler;static instances=[];constructor(){this.events={};this.sent=[];WorkerFixture.instances.push(this);}
  addEventListener(key,fn){this.events[key]=fn;}postMessage(value){this.sent.push(structuredClone(value));queueMicrotask(()=>WorkerFixture.handler(this,value));}
  emit(value){this.events.message({data:value});}terminate(){this.closed=true;}
}
test('registry Worker RPC accepts only scoped queries and validated metadata and terminates after completion',async()=>{
  const {options}=await fixture(),list=await runMappingRegistry('mapping-list',{...options,input:query});let guards=0;
  WorkerFixture.handler=(w,value)=>{if(value.action){w.id=value.id;w.emit({id:w.id,guard:1});}else w.emit({id:w.id,result:list});};
  const result=await runRestoreStorage('mapping-list',{namespace,guard:async()=>guards++,input:query,WorkerClass:WorkerFixture});assert.deepEqual(result,list);assert.ok(guards>=3);
  const worker=WorkerFixture.instances.at(-1);assert.deepEqual(Object.keys(worker.sent[0]).sort(),['action','id','input','namespace']);assert.equal(worker.closed,true);
  WorkerFixture.handler=(w,value)=>w.emit({id:value.id,result:{...list,patch:'private'}});await assert.rejects(runRestoreStorage('mapping-list',{namespace,guard:async()=>{},input:query,WorkerClass:WorkerFixture}));
  assert.throws(()=>validateMappingList({...list,query:'wrong'},namespace,query));
});
test('a cancelled registry request terminates its Worker and does not retry or claim a download succeeded',async()=>{
  WorkerFixture.handler=()=>{};const abort=new AbortController();
  const request=runRestoreStorage('mapping-list',{namespace,guard:async()=>{},input:query,signal:abort.signal,WorkerClass:WorkerFixture});await new Promise(resolve=>setImmediate(resolve));abort.abort();
  await assert.rejects(request,/取消.*原映射记录未修改/);assert.equal(WorkerFixture.instances.at(-1).closed,true);
});
test('failed accounting remains unavailable, and late account changes discard even successful results',async()=>{
  const {options}=await fixture(),summary=await runMappingRegistry('mappings',options);let current=namespace;
  const unavailable=await collectStoryboardMappingStorage({resolveNamespace:async()=>namespace,call:async()=>{throw Error('bad index');}});assert.equal(unavailable.status,'unavailable');assert.equal(unavailable.bytes,null);
  await assert.rejects(collectStoryboardMappingStorage({resolveNamespace:async()=>current,call:async()=>{current='st-user:other';return summary;}}),/账户/);
});
test('registry UI preserves escaped full identities, explicit unset bindings, and states export is not a restore',async()=>{
  const {e,options}=await fixture(),detail=await runMappingRegistry('mapping-detail',{...options,input:{kind:'subjects',digest:e.records.subjects.review.digest,offset:0}});
  const html=renderMappingRegistry({detail,list:null,busy:false,notice:'<error>',kind:'all',query:''},bytes=>`${bytes} B`);
  assert.match(html,/&lt;chat&gt;/);assert.doesNotMatch(html,/<chat>/);assert.match(html,/不使用档案（显式解除）/);assert.match(html,/不代表恢复已经完成/);assert.match(html,/&lt;error&gt;/);assert.match(html,/data-mapping-action="export"/);
  assert.doesNotMatch(html,/data-mapping-action="delete"|自动恢复/);
});
