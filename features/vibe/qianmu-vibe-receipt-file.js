import {validateVibeEncodingReceipt,VIBE_ENCODING_RECEIPT_LIMIT} from './qianmu-vibe-encoding-store.js';
import {resolveVibeReviewHistory,checkCombinedVibeReviews} from './qianmu-vibe-history.js';

export const VIBE_RECEIPT_FILE_LIMIT=32*1024*1024;
const identifier='qianmu-vibe-receipts',hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=message=>Object.assign(new Error(message),{code:'vibe_receipt_file_invalid',submissionState:'not_submitted'});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])):value;
const fingerprint=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(value))))),b=>b.toString(16).padStart(2,'0')).join('');
async function validatePayload(value,namespace){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['identifier','version','purpose','exportedAt','namespace','receipts','reviewSegments'].includes(key))
    ||value.identifier!==identifier||![1,2].includes(value.version)||value.purpose!=='audit-only'||value.namespace!==namespace
    ||!Number.isSafeInteger(value.exportedAt)||value.exportedAt<0||value.exportedAt>8640000000000000
    ||!Array.isArray(value.receipts)||!value.receipts.length||value.receipts.length>VIBE_ENCODING_RECEIPT_LIMIT)throw fail('记录文件格式或账户不符，请选择当前账户的千幕编码记录文件');
  if(value.version===1&&value.reviewSegments!==undefined||value.version===2&&(!Array.isArray(value.reviewSegments)||!value.reviewSegments.length||value.reviewSegments.length>4096))throw fail('核查明细文件版本或数量不符');
  const seen=new Set(),segments=new Map(),histories={};
  for(const segment of value.reviewSegments||[]){if(!segment||segment.namespace!==namespace||!hash(segment.cacheKey))throw fail('核查明细归属不符');
    if(!segments.has(segment.cacheKey))segments.set(segment.cacheKey,[]);segments.get(segment.cacheKey).push(segment);}
  for(const row of value.receipts){
    await validateVibeEncodingReceipt(row,namespace,row?.cacheKey);
    if(seen.has(row.cacheKey))throw fail('记录文件包含重复请求，未载入');seen.add(row.cacheKey);
    if(row.reviewArchive&&value.version!==2)throw fail('旧版记录文件缺少核查明细，未载入');
    const reviews=await resolveVibeReviewHistory(namespace,row.cacheKey,row.reviewArchive,segments.get(row.cacheKey)||[]);checkCombinedVibeReviews(row,reviews);
    if(reviews.length)histories[row.cacheKey]=reviews;segments.delete(row.cacheKey);
  }if(segments.size)throw fail('记录文件包含未关联核查明细');return histories;
}

// An audit snapshot, not a media backup, fee certificate, or restorable request queue.
export async function exportVibeReceiptFile(namespace,receipts,{now=Date.now,reviewSegments=[]}={}){
  const payload={identifier,version:reviewSegments.length?2:1,purpose:'audit-only',exportedAt:now(),namespace,receipts,...(reviewSegments.length?{reviewSegments}:{})};await validatePayload(payload,namespace);
  // Bound aggregation before constructing a second large serialized payload; no media scan at any point.
  let bytes=2048;for(const row of [...receipts,...reviewSegments]){bytes+=new TextEncoder().encode(JSON.stringify(row)).byteLength+1;if(bytes>VIBE_RECEIPT_FILE_LIMIT)throw fail('记录文件超过 32 MB，请逐项导出');}
  const serialized=JSON.stringify({...canonical(payload),fingerprint:await fingerprint(payload)}),blob=new Blob([serialized],{type:'application/json'});
  if(blob.size>VIBE_RECEIPT_FILE_LIMIT)throw fail('记录文件超过 32 MB，请逐项导出');return blob;
}

export async function inspectVibeReceiptFile(namespace,file){
  if(!(file instanceof Blob)||file.size<1||file.size>VIBE_RECEIPT_FILE_LIMIT)throw fail('请选择 32 MB 以内的千幕编码记录 JSON 文件');
  let document;try{document=JSON.parse(await file.text());}catch(_){throw fail('记录文件不是完整 JSON，请重新选择原文件');}
  if(!document||typeof document!=='object'||Array.isArray(document)||!hash(document.fingerprint))throw fail('记录文件缺少完整性摘要');
  const {fingerprint:expected,...payload}=document;const reviewHistories=await validatePayload(payload,namespace);
  if(await fingerprint(payload)!==expected)throw fail('记录文件摘要不符，内容可能已改变；未写入本机');
  return {exportedAt:payload.exportedAt,bytes:file.size,fingerprint:expected,receipts:payload.receipts,...(payload.version===2?{reviewHistories}:{})};
}
