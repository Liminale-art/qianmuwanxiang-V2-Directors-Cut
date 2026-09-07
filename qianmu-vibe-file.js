import {comfyReferenceStillMime} from './qianmu-comfy-results.js';
import {VIBE_ENCODING_MODELS} from './qianmu-vibe-asset-ref.js';
export {retainVibeAssetRef,VIBE_ENCODING_MODELS} from './qianmu-vibe-asset-ref.js';

// Independent implementation of the public NovelAI file envelope. No network, DOM or paid encoding.
export const VIBE_FILE_LIMITS=Object.freeze({file:64*1024*1024,image:16*1024*1024,thumbnail:2*1024*1024,encoding:8*1024*1024,items:16,models:32,variants:256});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.hasOwn(value,key);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const key=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value)&&!['__proto__','prototype','constructor'].includes(value);
const fraction=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
export function vibeFileError(code,message){return Object.assign(new Error(message),{code:`vibe_file_${code}`,submissionState:'not_submitted'});}
const fail=(code,message)=>{throw vibeFileError(code,message);};
const string=(value,max,label)=>{if(typeof value!=='string'||value.length>max||/[\u0000-\u001f\u007f]/.test(value))fail('format',`${label}格式无效`);return value;};
function fields(value,allowed,label){if(!object(value)||Object.keys(value).some(name=>!allowed.includes(name)))fail('format',`${label}含未知字段或结构无效，请保留原文件`);}
const utf8=value=>new TextEncoder().encode(value);
export async function vibeDigest(value){
  if(!globalThis.crypto?.subtle)fail('crypto','请使用 HTTPS 或本机地址读取 Vibe');
  const bytes=typeof value==='string'?utf8(value):value;
  if(!(bytes instanceof Uint8Array))fail('format','Vibe 摘要输入无效');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
}

// JSON.parse is permissive about repeated keys. Reject them before they can discard an encoding.
function uniqueKeys(text){
  const stack=[];let nodes=0;
  for(let at=0;at<text.length;at++){
    const char=text[at],parent=stack.at(-1);
    if(char==='"'){
      const start=at;let end=at;
      do{end=text.indexOf('"',end+1);if(end<0)fail('json','Vibe JSON 不完整');let back=end-1;while(text[back]==='\\')back--;if((end-1-back)%2===0)break;}while(true);
      if(parent?.object&&parent.expectKey){const name=JSON.parse(text.slice(start,end+1));if(parent.keys.has(name))fail('duplicate','Vibe 文件含重复字段，未导入任何条目');if(['__proto__','prototype','constructor'].includes(name))fail('format','Vibe 文件字段不安全');parent.keys.add(name);}
      at=end;
    }else if(char==='{'||char==='['){if(stack.length>=20||++nodes>100000)fail('size','Vibe 文件结构过大');stack.push({object:char==='{',keys:new Set(),expectKey:true});}
    else if(char==='}'||char===']')stack.pop();
    else if(char===':'&&parent)parent.expectKey=false;
    else if(char===','&&parent){if(++nodes>100000)fail('size','Vibe 文件结构过大');parent.expectKey=true;}
  }
}
function decodeBase64(value,limit,label){
  if(typeof value!=='string'||!value||value.length>Math.ceil(limit/3)*4||value.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))fail('data',`${label}不是有效的 Base64 或超出大小限制`);
  let binary;try{binary=atob(value);}catch(_){fail('data',`${label}编码损坏`);}
  if(!binary.length||binary.length>limit||btoa(binary)!==value)fail('data',`${label}编码不完整`);
  return Uint8Array.from(binary,c=>c.charCodeAt(0));
}
function image(value,limit,label,thumbnail=false){
  let data=value,mime='';
  if(thumbnail){const match=typeof value==='string'&&value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);if(!match)fail('image',`${label}须为内嵌 PNG、JPEG 或 WebP`);[,mime,data]=match;}
  const bytes=decodeBase64(data,limit,label);let detected;
  try{detected=comfyReferenceStillMime(bytes);}catch(_){fail('image',`${label}须为完整静态 PNG、JPEG 或 WebP`);}
  if(mime&&mime!==detected)fail('image',`${label}类型与内容不符`);
  // Bound decode dimensions before a later UI can turn this file into a preview.
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.length),tag=at=>String.fromCharCode(...bytes.subarray(at,at+4));let width=0,height=0;
  if(detected==='image/png'){
    if(bytes.length<45||view.getUint32(8)!==13||tag(12)!=='IHDR')fail('image',`${label}缺少图片尺寸信息`);
    width=view.getUint32(16);height=view.getUint32(20);let content=false;
    for(let at=8;at+12<=bytes.length;at+=view.getUint32(at)+12)if(tag(at+4)==='IDAT'&&view.getUint32(at)>0)content=true;
    if(!content)fail('image',`${label}缺少图片正文`);
  }else if(detected==='image/jpeg'){
    let at=2;
    while(at<bytes.length){while(bytes[at]===255)at++;const marker=bytes[at++];if(marker===218||marker===217)break;
      const size=view.getUint16(at);if(marker>=192&&marker<=207&&![196,200,204].includes(marker)){if(size<8)fail('image',`${label}尺寸信息损坏`);height=view.getUint16(at+3);width=view.getUint16(at+5);break;}at+=size;
    }
  }else{
    for(let at=12;at+8<=bytes.length;at+=8+view.getUint32(at+4,true)+(view.getUint32(at+4,true)%2)){
      const kind=tag(at),size=view.getUint32(at+4,true),dataAt=at+8;
      if(kind==='VP8L'&&size>=5&&bytes[dataAt]===47){const packed=view.getUint32(dataAt+1,true);width=(packed&16383)+1;height=((packed>>>14)&16383)+1;break;}
      if(kind==='VP8 '&&size>=10&&bytes[dataAt+3]===157&&bytes[dataAt+4]===1&&bytes[dataAt+5]===42){width=view.getUint16(dataAt+6,true)&16383;height=view.getUint16(dataAt+8,true)&16383;break;}
    }
  }
  if(!width||!height||width>16384||height>16384||width*height>(thumbnail?4:64)*1024*1024)fail('image',`${label}尺寸无效或过大`);
  return {data,mime:detected,bytes:bytes.length,width,height};
}
export function vibeFilePreview(document,{original=false}={}){
  if(document.thumbnail){const info=image(document.thumbnail,VIBE_FILE_LIMITS.thumbnail,'Vibe 缩略图',true);return new Blob([decodeBase64(info.data,VIBE_FILE_LIMITS.thumbnail,'Vibe 缩略图')],{type:info.mime});}
  if(original&&document.type==='image'){const info=image(document.image,VIBE_FILE_LIMITS.image,'Vibe 原图');return new Blob([decodeBase64(info.data,VIBE_FILE_LIMITS.image,'Vibe 原图')],{type:info.mime});}
  return null;
}
function validateParams(params){
  if(params==null)return;
  if(!object(params)||Object.keys(params).length>16)fail('params','Vibe 编码参数无效');
  for(const [name,value] of Object.entries(params)){
    if(!key(name))fail('params','Vibe 编码参数名无效');
    if(name==='information_extracted'&&!fraction(value))fail('params','Vibe 信息提取值须在 0～1');
    if(name==='mask'&&value!=null&&value!==''){image(value,VIBE_FILE_LIMITS.image,'Vibe 蒙版');continue;}
    if(value!==null&&typeof value!=='boolean'&&!(typeof value==='number'&&Number.isFinite(value))&&!(typeof value==='string'&&value.length<=4096))fail('params','Vibe 编码参数超出支持范围，请保留原文件');
  }
}
function validateDocument(doc){
  fields(doc,['identifier','version','type','image','id','encodings','name','thumbnail','createdAt','importInfo'],'Vibe');
  if(doc.identifier!=='novelai-vibe-transfer'||doc.version!==1||!['image','encoding'].includes(doc.type)||!hash(doc.id))fail('version','不是受支持的 NovelAI Vibe v1 文件');
  if(own(doc,'name'))string(doc.name,100,'Vibe 名称');
  if(own(doc,'createdAt')&&!(typeof doc.createdAt==='number'&&Number.isFinite(doc.createdAt)&&doc.createdAt>=0)&&!(typeof doc.createdAt==='string'&&doc.createdAt.length<=80&&Number.isFinite(Date.parse(doc.createdAt))))fail('format','Vibe 日期无效');
  if(doc.type==='image')image(doc.image,VIBE_FILE_LIMITS.image,'Vibe 原图');
  else if(doc.image||doc.thumbnail)fail('image','纯编码 Vibe 不应包含伪装的原图或缩略图');
  if(doc.thumbnail)image(doc.thumbnail,VIBE_FILE_LIMITS.thumbnail,'Vibe 缩略图',true);
  if(!object(doc.encodings)||Object.keys(doc.encodings).length>VIBE_FILE_LIMITS.models)fail('format','Vibe 模型编码列表无效');
  let count=0;
  for(const [model,group] of Object.entries(doc.encodings)){
    if(!key(model)||!object(group)||!Object.keys(group).length)fail('format','Vibe 模型编码组无效');
    for(const [variant,row] of Object.entries(group)){
      if(!key(variant)||++count>VIBE_FILE_LIMITS.variants)fail('size','Vibe 编码档位无效或过多');
      fields(row,['encoding','params'],'Vibe 编码');decodeBase64(row.encoding,VIBE_FILE_LIMITS.encoding,'Vibe 编码');validateParams(row.params);
    }
  }
  if(doc.type==='encoding'&&!count)fail('data','纯编码 Vibe 没有可用编码');
  if(own(doc,'importInfo')){
    fields(doc.importInfo,['model','information_extracted','strength','mask'],'Vibe 导入设置');
    if(own(doc.importInfo,'model'))string(doc.importInfo.model,240,'Vibe 模型');
    for(const name of ['information_extracted','strength'])if(own(doc.importInfo,name)&&!fraction(doc.importInfo[name]))fail('params','Vibe 导入数值须在 0～1');
    if(doc.importInfo.mask)image(doc.importInfo.mask,VIBE_FILE_LIMITS.image,'Vibe 导入蒙版');
  }
  return doc;
}
export function vibeVariants(document){
  return Object.entries(document.encodings).flatMap(([model,group])=>Object.entries(group).map(([variant,row])=>({model,variant,
    information:fraction(row.params?.information_extracted)?row.params.information_extracted:null,
    customParams:Object.entries(row.params||{}).some(([name,value])=>name!=='information_extracted'&&value!=null),
  })));
}
async function prepare(doc){
  validateDocument(doc);
  // Official IDs hash the base64 TEXT, not the decoded bytes; internal assets hash the whole file.
  const basis=doc.type==='image'?doc.image:Object.values(Object.values(doc.encodings)[0])[0].encoding;
  if(await vibeDigest(basis)!==doc.id)fail('digest','Vibe 内容摘要与文件编号不符，未导入');
  // Keep encoding-group order: official encoded-only files derive their ID from the first encoding.
  const serialized=JSON.stringify(doc),assetId=await vibeDigest(serialized);
  return {assetId,document:doc,serialized,bytes:utf8(serialized).length,summary:{assetId,sourceId:doc.id,type:doc.type,name:doc.name||'Vibe',hasImage:doc.type==='image',hasThumbnail:Boolean(doc.thumbnail),variants:vibeVariants(doc)}};
}
export async function parseNovelVibeFile(input){
  if(typeof input!=='string'||input.length>VIBE_FILE_LIMITS.file||utf8(input).length>VIBE_FILE_LIMITS.file)fail('size','Vibe 文件须在 64 MB 以内');
  let root;try{root=JSON.parse(input);}catch(_){fail('json','Vibe 文件不是有效 JSON');}
  uniqueKeys(input);
  let docs;
  if(root?.identifier==='novelai-vibe-transfer-bundle'){
    fields(root,['identifier','version','vibes'],'Vibe 合集');
    if(root.version!==1||!Array.isArray(root.vibes)||root.vibes.length<1||root.vibes.length>VIBE_FILE_LIMITS.items)fail('size','Vibe 合集须为 v1 且包含 1～16 项');docs=root.vibes;
  }else docs=[root];
  const result=[];for(const doc of docs)result.push(await prepare(doc));
  // No partial success: callers receive every complete asset only after all validation succeeds.
  return result;
}
export async function exportNovelVibeFile(documents,{bundle=documents?.length!==1}={}){
  if(!Array.isArray(documents)||documents.length<1||documents.length>16||!bundle&&documents.length!==1)fail('size','请选择 1～16 项 Vibe 导出');
  const text=JSON.stringify(bundle?{identifier:'novelai-vibe-transfer-bundle',version:1,vibes:documents}:documents[0]);
  await parseNovelVibeFile(text);return text;
}
export function selectNovelVibeEncoding(document,capabilityModelId,information){
  const model=VIBE_ENCODING_MODELS[capabilityModelId];
  if(!model)fail('model','当前模型没有已确认的 Vibe 编码能力');
  if(!fraction(information))fail('params','Vibe 信息提取值无效');
  const choices=vibeVariants(document).filter(row=>row.model===model&&!row.customParams&&
    (row.information===information||document.type==='encoding'&&row.information===null));
  if(!choices.length)fail('missing_encoding',document.type==='image'?'此模型或信息档位尚未编码':'纯编码 Vibe 不具备此模型或信息档位，且没有原图可重新编码');
  const encodings=new Set(choices.map(row=>document.encodings[model][row.variant].encoding));
  if(encodings.size!==1)fail('ambiguous','同一档位存在不同编码，请明确选择后再使用');
  return {model,variant:choices[0].variant,encoding:encodings.values().next().value,information:choices[0].information};
}
