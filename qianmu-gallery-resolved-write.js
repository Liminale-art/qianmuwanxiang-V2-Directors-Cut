import {galleryRecipeResolution,GALLERY_WRITE_PLAN_LIMITS} from './qianmu-gallery-write-plan.js';
import {createChatGalleryDigest} from './qianmu-chat-gallery-digest.js';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),fail=message=>{throw Object.assign(Error(message),{code:'gallery_resolved_write',submissionState:'not_submitted'});};
// One exact original record -> its same-content new server reference. Never
// inflate server recipes inline or normalize unknown gallery fields. A kept
// duplicate is resolved at its original baseline position, not appended twice.
export async function scanResolvedGalleryWrite({source,resolutions,guard,signal,visit=async()=>{}}={}){
  if(!Array.isArray(resolutions)||resolutions.length>10000||typeof guard!=='function'||typeof visit!=='function')fail('复位画面缺少完整配方列表或来源保护');
  const rows=new Map(),used=new Set(),selected=new Set(),digest=createChatGalleryDigest();let output=0;
  async function check(){if(signal?.aborted||await guard()!==true||signal?.aborted)fail('复位画面已取消或来源变化');return true;}
  for(const raw of resolutions){const row=galleryRecipeResolution(raw);if(rows.has(row.recordId))fail('复位配方包含重复画面');rows.set(row.recordId,row);}
  try{
    await source.scan({visit:async item=>{
      await check();let record=item.record;const row=rows.get(record.id);
      if(item.origin==='source'&&record.snapshot==null){if(!row)fail('原服务器配方尚未完整复位');selected.add(record.id);}
      if(row){
        if(record.snapshot!=null||record.createdAt!==row.createdAt||!same(item.reference,row.record)||!same(record.snapshotServerRef,row.originalReference))fail('复位配方与原画面不符');
        record={...record,snapshotServerRef:structuredClone(row.reference)};used.add(record.id);
      }
      if(item.origin==='source'&&item.kept)return;
      if(item.outputIndex!==output)fail('复位画面顺序不符');digest.append(record);await visit(structuredClone(record),output++);await check();
    }});
    if(used.size!==rows.size||selected.size!==rows.size||output!==source.metadata.plan.gallery.count)fail('复位配方或画面范围不完整');
    await check();return {gallery:digest.finish(),resolutions:rows.size};
  }finally{digest.close();}
}

// Explicit orchestration through real dependency restore and ST file storage.
// Produces a durable write artifact; no chat assignment or host save happens here.
export async function resolvePreparedGalleryWrite({source,assets,writeStorage,preview,confirmed=false,guard,verifyCurrent,signal,onProgress=()=>{}}={}){
  if(confirmed!==true||!preview?.ready||typeof guard!=='function'||typeof verifyCurrent!=='function')fail('请核对并确认所选原图和配方的恢复');
  const wanted=structuredClone(preview),metadata=source.metadata,resolutions=[],pages=[];let batch=[],start=0;
  if(!same(wanted.preparation,metadata.reference))fail('原件确认不属于此准确恢复准备');
  async function check(){if(signal?.aborted||await guard()!==true||signal?.aborted)fail('写回准备已取消或来源变化');return true;}
  async function verify(){await check();if(await verifyCurrent()!==true||await source.verify()!==true)fail('写回准备的聊天或归档已变化');await check();return true;}
  async function flush(){if(!batch.length)return;const staged=await writeStorage.stagePage(batch,start);await check();pages.push(staged);start+=batch.length;batch=[];}
  await verify();
  const receipt=await assets.restore({confirmed:true,scope:wanted.scope,expectedDigest:wanted.digest,onRecipeResolved:async raw=>{
    await check();const row=galleryRecipeResolution(raw);
    const bytes=new TextEncoder().encode(JSON.stringify({schema:'qianmu.gallery.write-page.v1',scope:metadata.plan.scope,start,rows:[...batch,row]})).length;
    if(batch.length&&bytes>GALLERY_WRITE_PLAN_LIMITS.pageBytes)await flush();
    resolutions.push(row);batch.push(row);if(batch.length===GALLERY_WRITE_PLAN_LIMITS.rows)await flush();
  }});await check();
  if(receipt.proof!=='prepared-assets-readback-only'||receipt.recipesResolved!==resolutions.length||!same(receipt.preparation,metadata.reference))fail('原图与配方复位回执不完整');
  await flush();const checked=await scanResolvedGalleryWrite({source,resolutions,guard:check,signal});await verify();
  await onProgress({phase:'write-plan',completed:checked.gallery.count,total:checked.gallery.count});await check();
  const stored=await writeStorage.publish({preparation:metadata.reference,gallery:checked.gallery,pages,resolutions:checked.resolutions},{verify});
  await verify();return {...stored,originalsVerified:receipt.originalsVerified,recipesResolved:receipt.recipesResolved};
}

// Re-open after refresh without re-restoring files. Returns only light overrides
// and a verified full-gallery digest; the host writer can then stream materialize.
export async function readResolvedGalleryWrite({reference,source,writeStorage,guard,signal}={}){
  const rows=[];const stored=await writeStorage.scan(reference,{visit:row=>rows.push(row)}),metadata=source.metadata;
  if(!same(stored.plan.scope,metadata.plan.scope)||!same(stored.plan.preparation,metadata.reference))fail('写回方案不是当前准确恢复准备');
  const result=await scanResolvedGalleryWrite({source,resolutions:rows,guard,signal});
  if(!same(result.gallery,stored.plan.gallery)||result.resolutions!==stored.plan.resolutions)fail('写回方案完整画面摘要不符');
  return {...stored,resolutions:rows};
}
