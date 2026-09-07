import {novelModelCapabilities,novelReferenceIssue} from './qianmu-image-models.js';
import {VIBE_ENCODING_MODELS} from './qianmu-vibe-asset-ref.js';
import {comfyReferenceStillMime} from './qianmu-comfy-results.js';
export const NOVEL_VIBE_VERSION=1;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code,submissionState:'not_submitted'});};
const amount=(value,fallback,max=1)=>value==null||value===''||!Number.isFinite(Number(value))?fallback:Math.max(0,Math.min(max,Number(value)));
export function normalizeNovelVibeImage(row){
  const raw=row?.data??row?.base64;
  if(typeof raw!=='string'||raw.length>Math.ceil(16*1024*1024/3)*4+256)fail('invalid_reference_size','单张 Vibe 原图须小于 16 MB');
  const data=raw.trim().replace(/^data:image\/(?:png|jpe?g|webp);base64,/i,'').replace(/\s+/g,'');
  if(!data||data.length%4===1||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))fail('invalid_reference','Vibe 原图数据无效');
  let binary;try{binary=atob(data);}catch(_){fail('invalid_reference','Vibe 原图数据无效');}
  if(!binary.length||binary.length>16*1024*1024)fail('invalid_reference_size','单张 Vibe 原图须小于 16 MB');
  if(btoa(binary).replace(/=+$/,'')!==data.replace(/=+$/,''))fail('invalid_reference','Vibe 原图不完整');
  let mime;try{mime=comfyReferenceStillMime(Uint8Array.from(binary,c=>c.charCodeAt(0)));}catch(_){fail('invalid_reference','Vibe 原图须为完整静态 PNG、JPEG 或 WebP');}
  return {kind:'image',data:btoa(binary),mime,strength:amount(row.strength,.6,2),information:amount(row.information,1),byteLength:binary.length};
}
export function normalizeNovelVibeEntries(request){
  const entries=request.vibes??[];
  if(!Array.isArray(entries)||entries.length>16)fail('invalid_vibe_count','Vibe 须为最多 16 项的列表，未提交生成');
  if(Object.hasOwn(request,'novelVibeVersion')&&request.novelVibeVersion!==NOVEL_VIBE_VERSION)fail('novel_vibe_version','Vibe 传输版本不匹配，请同步更新增强服务');
  const capabilities=novelModelCapabilities(request.model,request.capabilityModelId);
  if(!capabilities.ok)fail(capabilities.code,capabilities.message);
  const issue=novelReferenceIssue(capabilities,request.referenceImages||request.references||[],entries,request.parameters?.providerOptions||{});
  if(issue)fail(issue.code,issue.message);
  const options=request.parameters?.providerOptions||{};
  if(['reference_image','reference_image_multiple','reference_image_multiple_cached'].some(name=>options[name]?.length))fail('untyped_vibe','请通过 Vibe 素材选择传入参考，不在绘制参数中混入原始参考数据');
  if(entries.length&&!capabilities.known)fail('novel_vibe_model','请为第三方 NAI 选择明确的模型能力档再使用 Vibe');
  let total=0;
  return entries.map(row=>{
    if(!row||typeof row!=='object'||Array.isArray(row)||!['image','novelai-vibe-encoding',undefined].includes(row.kind))fail('invalid_vibe','Vibe 数据类型无效');
    const encoded=row.kind==='novelai-vibe-encoding';
    if(capabilities.isV4&&!encoded)fail('novel_vibe_requires_encoding','V4 / V4.5 需要已编码 Vibe，请先完成对应档位编码');
    if(!encoded){
      const image=normalizeNovelVibeImage(row);total+=image.byteLength;if(total>48*1024*1024)fail('references_too_large','Vibe 合计须小于 48 MB');return image;
    }
    if(request.novelVibeVersion!==NOVEL_VIBE_VERSION)fail('novel_vibe_version','Vibe 编码缺少传输版本，请同步更新千幕和增强服务');
    if(row.encodingModel!==VIBE_ENCODING_MODELS[capabilities.capabilityModelId]||!VIBE_ENCODING_MODELS[capabilities.capabilityModelId])fail('novel_vibe_model','Vibe 编码与当前模型不匹配');
    if(typeof row.data!=='string'||!row.data||row.data.length>Math.ceil(8*1024*1024/3)*4||row.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(row.data))fail('invalid_vibe_encoding','Vibe 编码损坏或超过 8 MB');
    const estimated=row.data.length/4*3-(row.data.endsWith('==')?2:row.data.endsWith('=')?1:0);
    total+=estimated;if(total>48*1024*1024)fail('references_too_large','Vibe 合计须小于 48 MB');
    let binary;try{binary=atob(row.data);}catch(_){fail('invalid_vibe_encoding','Vibe 编码损坏');}
    if(!binary.length||binary.length>8*1024*1024||btoa(binary)!==row.data)fail('invalid_vibe_encoding','Vibe 编码不完整');
    return {kind:row.kind,data:row.data,encodingModel:row.encodingModel,strength:amount(row.strength,.6,2),information:row.information==null?null:amount(row.information,1),byteLength:binary.length};
  });
}
export function novelVibeParameters(entries){
  if(!entries.length)return {};
  return {reference_image_multiple:entries.map(row=>row.data),reference_strength_multiple:entries.map(row=>amount(row.strength,.6,2)),
    ...(entries[0].kind==='novelai-vibe-encoding'?{}:{reference_information_extracted_multiple:entries.map(row=>amount(row.information,1))})};
}
