import {parseBoundedJson} from './qianmu-json-input.js';
import {STORYBOARD_PACKAGE_LIMITS,inspectStoryboardVibePackage} from './qianmu-storyboard-package-assets.js';
import {vibeDigest} from './qianmu-vibe-file.js';
import {comfyReferenceStillMime} from './qianmu-comfy-results.js';
import {STORYBOARD_IMPORT_FIELDS} from './qianmu-storyboard-package-mutation.js';

// Export and import share one limit until segmented packages are supported.
export const STORYBOARD_PACKAGE_INPUT_LIMIT=STORYBOARD_PACKAGE_LIMITS.total;
const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_package_input',submissionState:'not_submitted'});};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value);

// Bounded public media read; no API key/header is accepted. A theme/gallery URL is not a size guarantee.
export async function readStoryboardPackageImage(url,{guard,fetch:request=globalThis.fetch,timeoutMs=25000}={}){
  if(typeof guard!=='function')fail('缺少成片读取环境核对');await guard();
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(100,Math.min(60000,timeoutMs))),limit=24*1024*1024;
  let reader;
  try{
    const response=await request(url,{signal:controller.signal,credentials:'same-origin'});await guard();
    if(!response.ok||!response.body?.getReader)fail('成片原图读取失败');
    const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>limit))fail('成片原图超过 24 MiB 或大小无效');
    reader=response.body.getReader();const chunks=[];let bytes=0;
    while(true){const part=await reader.read();await guard();if(part.done)break;bytes+=part.value.byteLength;if(bytes>limit)fail('成片原图超过 24 MiB');chunks.push(part.value);}
    if(!bytes)fail('成片原图为空');const blob=new Blob(chunks),mime=comfyReferenceStillMime(new Uint8Array(await blob.arrayBuffer()));await guard();
    return new Blob([blob],{type:mime});
  }finally{clearTimeout(timer);controller.abort();if(reader){try{await reader.cancel();}catch(_){}reader.releaseLock();}}
}

// Scan before JSON.parse: duplicate escaped keys would otherwise silently replace data.
export function parseStrictStoryboardJson(text,{maxBytes=STORYBOARD_PACKAGE_INPUT_LIMIT}={}){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>STORYBOARD_PACKAGE_INPUT_LIMIT)fail('分镜包读取上限无效');
  try { return parseBoundedJson(text,{maxBytes,maxDepth:STORYBOARD_PACKAGE_LIMITS.depth,maxNodes:STORYBOARD_PACKAGE_LIMITS.nodes,label:'分镜包'}); }
  catch(error) { fail(error.message); }
}
export function parseStoryboardPackageText(text,{legacy=false,auto=false}={}){
  const payload=parseStrictStoryboardJson(text);
  return validateStoryboardPackagePayload(payload,{legacy,auto});
}
export function validateStoryboardPackagePayload(payload,{legacy=false,auto=false}={}){
  if(auto)legacy=payload?.version!==7;
  const supported=legacy?(payload?.version===undefined||Number.isInteger(payload?.version)&&payload.version>=1&&payload.version<=6):payload?.version===7;
  if(!object(payload)||payload.type!=='qianmu-storyboard'||!supported||!object(payload.settings)||!object(payload.chat))fail(legacy?'当前版本不支持此分镜包格式，请保留原包':'请选择新版 v7 分镜包；旧版恢复仍使用原入口');
  if(payload.credentialsIncluded!==false&&!(legacy&&payload.credentialsIncluded===undefined))fail('分镜包未声明排除凭据，请先重新安全导出');
  if(!legacy){
    if(Object.keys(payload).some(key=>!['type','version','exportedAt','credentialsIncluded','settings','chat','media','vibeAccount','vibeAssets'].includes(key))
      ||Object.keys(payload.settings).some(key=>key!=='schemaVersion'&&!STORYBOARD_IMPORT_FIELDS.includes(key))
      ||Object.keys(payload.chat).some(key=>!['images','collections'].includes(key)))fail('分镜包包含尚不支持恢复的内容，请保留原包；未忽略未知资料');
  }
  return payload;
}

export function validateStoryboardPackageMedia(payload,{legacy=false}={}){
  const images=payload.chat.images??[],media=payload.media??[];
  if(!Array.isArray(images)||images.length>400||!Array.isArray(media)||media.length>400)fail('分镜成片或媒体清单超限');
  const ids=new Set(),embedded=new Set();
  for(const row of images){if(!object(row)||!id(row.id)||ids.has(row.id))fail('分镜成片编号无效或重复');ids.add(row.id);}
  for(const row of media){
    if(!object(row)||!id(row.id)||!ids.has(row.id)||embedded.has(row.id))fail('分镜媒体编号重复或没有对应成片');embedded.add(row.id);
    const inferMime=legacy&&(!row.mime||row.mime==='application/octet-stream');
    if(!inferMime&&!['image/png','image/jpeg','image/webp'].includes(row.mime)||typeof row.b64!=='string'||!row.b64.length||row.b64.length>32*1024*1024||row.b64.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(row.b64))fail('分镜媒体须为 24 MiB 以内的 PNG、JPEG 或 WebP');
    let binary;try{binary=atob(row.b64);}catch(_){fail('分镜媒体编码损坏');}
    if(btoa(binary)!==row.b64)fail('分镜媒体编码不完整');
    let mime;try{mime=comfyReferenceStillMime(Uint8Array.from(binary,c=>c.charCodeAt(0)));}catch(_){fail('分镜媒体不是完整的静态图片');}
    if(inferMime)row.mime=mime;else if(mime!==row.mime)fail('分镜媒体类型与实际内容不符');
  }
}

// Read-only input gate. A parsed packet is not permission to apply settings or replay jobs.
export async function inspectStoryboardPackageFile(file,{legacy=false,auto=false}={}){
  if(!(file instanceof Blob)||file.size<1||file.size>STORYBOARD_PACKAGE_INPUT_LIMIT)fail('请选择 128 MiB 以内的分镜包；大包分片恢复尚未开放');
  const expectedSize=file.size,bytes=new Uint8Array(await file.arrayBuffer());let text;
  if(bytes.byteLength!==expectedSize||bytes.byteLength>STORYBOARD_PACKAGE_INPUT_LIMIT)fail('分镜包读取大小不符，请重新选择原文件');
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch(_){fail('分镜包不是完整的 UTF-8 文件');}
  const payload=parseStoryboardPackageText(text,{legacy,auto});if(auto)legacy=payload.version!==7;validateStoryboardPackageMedia(payload,{legacy});
  const inspection=legacy?{}:await inspectStoryboardVibePackage(payload);
  return {payload,...inspection,fingerprint:await vibeDigest(bytes),fileBytes:bytes.byteLength};
}
