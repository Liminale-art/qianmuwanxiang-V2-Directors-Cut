import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeComfyLibraryDocument,inspectComfyLibraryDocument,createComfyWorkflowStore} from '../qianmu-comfy-library.js';
import * as codec from '../qianmu-comfy-library-backup.js';
import {renderComfyLibrary} from '../qianmu-comfy-library-view.js';
const namespace='st-user:source',target='st-user:target';
const graph={one:{class_type:'CLIPTextEncode',inputs:{text:'%qianmu_prompt%'}},two:{class_type:'SaveImage',inputs:{images:['one',0]}}};
function rows(id='workflow',count=2){
  let totalBytes=0;const versions=Array.from({length:count},(_,i)=>{
    const document=normalizeComfyLibraryDocument({workflow:graph,parameters:{seed:0,width:832},positivePrompt:`version ${i+1}`,...(i?{classification:{version:1,visualKinds:['object'],castSizes:['none'],maxSubjects:0}}:{})}),inspected=inspectComfyLibraryDocument(document);totalBytes+=inspected.bytes;
    const meta={id,name:'Workflow',revision:`rev${i+1}`,version:i+1,createdAt:1,updatedAt:i+1,archived:false,bytes:inspected.bytes,totalBytes,nodes:inspected.nodes,slots:inspected.slots,issue:inspected.issue,
      ...(document.classification?{classification:document.classification}:{}),parentRevision:i?`rev${i}`:''};
    return {meta,document};
  });const {parentRevision,...head}=versions.at(-1).meta;return {head,versions};
}
const packet=(workflows=[rows()],owner=namespace)=>({schema:codec.COMFY_LIBRARY_BACKUP_SCHEMA,namespace:owner,credentialsIncluded:false,workflows});
test('complete workflow backup preserves all immutable versions, classification absence/zero values and archive state',()=>{
  const value=packet();value.workflows[0].head.archived=true;value.workflows[0].head.updatedAt=4;const before=JSON.stringify(value),summary=codec.validateComfyLibraryBackup(value);
  assert.equal(summary.count,1);assert.equal(summary.versions,2);assert.ok(summary.bytes>0);assert.equal(JSON.stringify(value),before);
  const row=codec.unpackComfyLibraryRecord(target,value.workflows[0]);assert.equal(row.head.namespace,target);assert.equal(row.versions[0].document.document.parameters.seed,'0');assert.equal(Object.hasOwn(row.versions[0].document.document,'classification'),false);
  assert.equal(row.versions[1].document.document.classification.maxSubjects,0);assert.equal(row.versions[1].meta.parentRevision,'rev1');assert.equal(row.head.archived,true);
});
test('missing, duplicated, branched, wrong-size, mismatched-head and foreign fields reject the whole backup',()=>{
  for(const change of [v=>v.workflows[0].versions.pop(),v=>v.workflows.push(v.workflows[0]),v=>v.workflows[0].versions[1].meta.parentRevision='alien',v=>v.workflows[0].versions[0].meta.bytes++,
    v=>v.workflows[0].head.name='other',v=>v.workflows[0].versions[0].document.apiKey='never-copy',v=>v.workflows[0].versions[0].document.workflow=JSON.stringify({node:{class_type:'X',inputs:{api_key:'secret'}}}),
    v=>v.serverGrants=[],v=>v.credentialsIncluded=true,v=>v.workflows[0].versions[1].meta.classification.maxSubjects=1,v=>v.workflows[0].versions[0].meta.archived=true,v=>v.workflows[0].head.updatedAt=0]){
    const value=JSON.parse(JSON.stringify(packet()));change(value);assert.throws(()=>codec.validateComfyLibraryBackup(value));
  }
});
test('restoration appends only a matching version chain, keeps newer local heads, and refuses divergent history',()=>{
  const local=packet([rows('same',1),rows('unrelated',1)],target),incoming=packet([rows('same',2),rows('new',2)]),before=JSON.stringify([local,incoming]);
  const plan=codec.planComfyLibraryRestore(local,incoming);assert.equal(plan.summary.added,1);assert.equal(plan.summary.extended,1);assert.equal(plan.summary.addedVersions,3);assert.equal(plan.writes[0].versions.length,1);assert.equal(JSON.stringify([local,incoming]),before);
  const newer=packet([rows('same',3)],target);newer.workflows[0].head.archived=true;assert.equal(codec.planComfyLibraryRestore(newer,packet([rows('same',2)])).writes.length,0);
  const branch=packet([rows('same',1)]);branch.workflows[0].versions[0].meta.revision='branch';branch.workflows[0].head.revision='branch';assert.throws(()=>codec.planComfyLibraryRestore(local,branch),/同编号/);
  branch.workflows[0].head.name='<img src=x onerror=alert(1)>';branch.workflows[0].versions[0].meta.name=branch.workflows[0].head.name;
  assert.throws(()=>codec.planComfyLibraryRestore(local,branch),error=>error.message.includes('同编号')&&!error.message.includes('<img'));
});
test('capacity is checked for the merged library before any write and not achieved by evicting current rows',()=>{
  const local=packet([rows('local')],target),incoming=packet([rows('new')]);assert.throws(()=>codec.planComfyLibraryRestore(local,incoming,{maxBytes:1}),/容量/);
  assert.throws(()=>codec.planComfyLibraryRestore(packet(Array.from({length:128},(_,i)=>rows(`w${i}`,1)),target),incoming),/数量/);
});
test('storage records round trip with original IDs/revisions and target-only storage keys',()=>{
  const original=packet(),records=original.workflows.map(row=>codec.unpackComfyLibraryRecord(target,row));
  const restored=codec.packComfyLibraryRecords(target,records.map(row=>({head:row.head,versions:row.versions.map(v=>({meta:v.meta,document:v.document.document}))})));
  assert.deepEqual(restored.workflows,original.workflows);assert.equal(restored.namespace,target);assert.equal(original.namespace,namespace);
  records[0].head.unrecognized='preserve elsewhere';assert.throws(()=>codec.packComfyLibraryRecords(target,records),/未知/);
});
test('strict file reader rejects oversized input, duplicate decoded fields, malformed UTF8 and unknown schema',async()=>{
  const value=packet(),file=new Blob([JSON.stringify(value)]);assert.deepEqual(await codec.readComfyLibraryBackup(file),value);
  class Oversized extends Blob {get size(){return codec.COMFY_LIBRARY_BACKUP_BYTES+1;}arrayBuffer(){assert.fail('must not read');}}
  for(const bad of [new Oversized(['x']),new Blob([Uint8Array.of(0xc3,0x28)]),new Blob([JSON.stringify(value).replace('"credentialsIncluded":false','"credentialsIncluded":true,"\\u0063redentialsIncluded":false')]),new Blob([JSON.stringify({...value,schema:'future'})])])await assert.rejects(()=>codec.readComfyLibraryBackup(bad));
});
test('approval digests bind the complete metadata history and do not depend on JSON key order',async()=>{
  const original=packet(),reordered=Object.fromEntries(Object.entries(original).reverse());assert.equal(await codec.comfyLibraryBackupDigest(original),await codec.comfyLibraryBackupDigest(reordered));
  reordered.workflows=structuredClone(original.workflows);reordered.workflows[0].head.archived=true;assert.notEqual(await codec.comfyLibraryBackupDigest(original),await codec.comfyLibraryBackupDigest(reordered));
});
test('restore requires explicit approval before opening storage; no backup work happens on constructor/disposal',async()=>{
  let opens=0;const store=createComfyWorkflowStore({indexedDB:{open(){opens++;throw Error('offline');}}});assert.equal(opens,0);
  await assert.rejects(()=>store.restoreBackup(target,packet(),{expectedDigest:'a'.repeat(64)}),/确认/);assert.equal(opens,0);store.close();assert.equal(opens,0);
});
test('actual library UI exposes whole-library backup separately from one-version export and apply',async()=>{
  const html=renderComfyLibrary({rows:[]});for(const action of ['backup-library','restore-library'])assert.match(html,new RegExp(`data-comfy-action="${action}"`));assert.match(html,/data-comfy-backup-file/);
  const source=await readFile(new URL('../qianmu-comfy-library-view.js',import.meta.url),'utf8');assert.match(source,/store\.restoreBackup[\s\S]*expectedDigest,confirmed:true,isCurrent:isSame/);
  const release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));assert.ok(release.files.includes('qianmu-comfy-library-backup.js'));
});
