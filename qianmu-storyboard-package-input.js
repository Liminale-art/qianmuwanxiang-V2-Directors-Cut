import {STORYBOARD_PACKAGE_LIMITS,inspectStoryboardVibePackage} from './qianmu-storyboard-package-assets.js';
import {vibeDigest} from './qianmu-vibe-file.js';
import {comfyReferenceStillMime} from './qianmu-comfy-results.js';

// Until the segmented importer is available, do not allocate a 768 MiB packet on a phone.
export const STORYBOARD_PACKAGE_INPUT_LIMIT=128*1024*1024;
const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_package_input',submissionState:'not_submitted'});};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value);

// Scan before JSON.parse: duplicate escaped keys would otherwise silently replace data.
export function parseStoryboardPackageText(text,{legacy=false}={}){
  if(typeof text!=='string'||!text.length||text.length>STORYBOARD_PACKAGE_INPUT_LIMIT||new TextEncoder().encode(text).length>STORYBOARD_PACKAGE_INPUT_LIMIT)fail('分镜包须在 128 MiB 以内，请分批备份');
  const stack=[];let nodes=0;
  for(let at=0;at<text.length;at++){
    const char=text[at],parent=stack.at(-1);
    if(char==='"'){
      const start=at;let end=at;
      do{end=text.indexOf('"',end+1);if(end<0)fail('分镜包 JSON 不完整');let back=end-1;while(text[back]==='\\')back--;if((end-1-back)%2===0)break;}while(true);
      if(parent?.object&&parent.key){
        let name;try{name=JSON.parse(text.slice(start,end+1));}catch(_){fail('分镜包字段格式无效');}
        if(parent.keys.has(name))fail('分镜包含重复字段，未接受覆盖后的内容');
        if(['__proto__','prototype','constructor'].includes(name))fail('分镜包字段不安全');parent.keys.add(name);
      }at=end;
    }else if(char==='{'||char==='['){
      if(stack.length>=STORYBOARD_PACKAGE_LIMITS.depth||++nodes>STORYBOARD_PACKAGE_LIMITS.nodes)fail('分镜包结构过深或过大');
      stack.push({object:char==='{',keys:new Set(),key:true});
    }else if(char==='}'||char===']')stack.pop();
    else if(char===':'&&parent)parent.key=false;
    else if(char===','&&parent){if(++nodes>STORYBOARD_PACKAGE_LIMITS.nodes)fail('分镜包条目过多');parent.key=true;}
  }
  let payload;try{payload=JSON.parse(text);}catch(_){fail('分镜包 JSON 无效');}
  const finite=value=>{if(typeof value==='number'&&!Number.isFinite(value))fail('分镜包数值超出有效范围');if(value&&typeof value==='object')for(const item of Object.values(value))finite(item);};finite(payload);
  const supported=legacy?(payload?.version===undefined||Number.isInteger(payload?.version)&&payload.version>=1&&payload.version<=6):payload?.version===7;
  if(!object(payload)||payload.type!=='qianmu-storyboard'||!supported||!object(payload.settings)||!object(payload.chat))fail(legacy?'当前版本不支持此分镜包格式，请保留原包':'请选择新版 v7 分镜包；旧版恢复仍使用原入口');
  if(payload.credentialsIncluded!==false&&!(legacy&&payload.credentialsIncluded===undefined))fail('分镜包未声明排除凭据，请先重新安全导出');
  return payload;
}

function validateMedia(payload,{legacy=false}={}){
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
export async function inspectStoryboardPackageFile(file,{legacy=false}={}){
  if(!(file instanceof Blob)||file.size<1||file.size>STORYBOARD_PACKAGE_INPUT_LIMIT)fail('请选择 128 MiB 以内的分镜包；大包分片恢复尚未开放');
  const expectedSize=file.size,bytes=new Uint8Array(await file.arrayBuffer());let text;
  if(bytes.byteLength!==expectedSize||bytes.byteLength>STORYBOARD_PACKAGE_INPUT_LIMIT)fail('分镜包读取大小不符，请重新选择原文件');
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch(_){fail('分镜包不是完整的 UTF-8 文件');}
  const payload=parseStoryboardPackageText(text,{legacy});validateMedia(payload,{legacy});
  const inspection=legacy?{}:await inspectStoryboardVibePackage(payload);
  return {payload,...inspection,fingerprint:await vibeDigest(bytes),fileBytes:bytes.byteLength};
}
