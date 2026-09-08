import {validateVibeEncodingReceipt,VIBE_ENCODING_RECEIPT_LIMIT} from './qianmu-vibe-encoding-store.js';

export const VIBE_RECEIPT_FILE_LIMIT=32*1024*1024;
const identifier='qianmu-vibe-receipts',hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=message=>Object.assign(new Error(message),{code:'vibe_receipt_file_invalid',submissionState:'not_submitted'});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])):value;
const fingerprint=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(value))))),b=>b.toString(16).padStart(2,'0')).join('');
async function validatePayload(value,namespace){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['identifier','version','purpose','exportedAt','namespace','receipts'].includes(key))
    ||value.identifier!==identifier||value.version!==1||value.purpose!=='audit-only'||value.namespace!==namespace
    ||!Number.isSafeInteger(value.exportedAt)||value.exportedAt<0||value.exportedAt>8640000000000000
    ||!Array.isArray(value.receipts)||!value.receipts.length||value.receipts.length>VIBE_ENCODING_RECEIPT_LIMIT)throw fail('记录文件格式或账户不符，请选择当前账户的千幕编码记录文件');
  const seen=new Set();
  for(const row of value.receipts){
    await validateVibeEncodingReceipt(row,namespace,row?.cacheKey);
    if(seen.has(row.cacheKey))throw fail('记录文件包含重复请求，未载入');seen.add(row.cacheKey);
  }return value;
}

// An audit snapshot, not a media backup, fee certificate, or restorable request queue.
export async function exportVibeReceiptFile(namespace,receipts,{now=Date.now}={}){
  const payload=await validatePayload({identifier,version:1,purpose:'audit-only',exportedAt:now(),namespace,receipts},namespace);
  // Bound aggregation before constructing a second large serialized payload; no media scan at any point.
  let bytes=2048;for(const row of receipts){bytes+=new TextEncoder().encode(JSON.stringify(row)).byteLength+1;if(bytes>VIBE_RECEIPT_FILE_LIMIT)throw fail('记录文件超过 32 MB，请逐项导出');}
  const serialized=JSON.stringify({...canonical(payload),fingerprint:await fingerprint(payload)}),blob=new Blob([serialized],{type:'application/json'});
  if(blob.size>VIBE_RECEIPT_FILE_LIMIT)throw fail('记录文件超过 32 MB，请逐项导出');return blob;
}

export async function inspectVibeReceiptFile(namespace,file){
  if(!(file instanceof Blob)||file.size<1||file.size>VIBE_RECEIPT_FILE_LIMIT)throw fail('请选择 32 MB 以内的千幕编码记录 JSON 文件');
  let document;try{document=JSON.parse(await file.text());}catch(_){throw fail('记录文件不是完整 JSON，请重新选择原文件');}
  if(!document||typeof document!=='object'||Array.isArray(document)||!hash(document.fingerprint))throw fail('记录文件缺少完整性摘要');
  const {fingerprint:expected,...payload}=document;await validatePayload(payload,namespace);
  if(await fingerprint(payload)!==expected)throw fail('记录文件摘要不符，内容可能已改变；未写入本机');
  return {exportedAt:payload.exportedAt,bytes:file.size,fingerprint:expected,receipts:payload.receipts};
}
