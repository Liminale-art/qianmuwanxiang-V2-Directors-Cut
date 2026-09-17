// Lossless JSON recipe transport. This is not proof that a model/workflow can still run.
import {chatGalleryReceiptText} from './qianmu-chat-gallery-receipt.js';
import {chatGalleryRecordRequest} from './qianmu-chat-gallery-record.js';
import {chatCharacterReceiptTarget} from './qianmu-chat-character-receipt.js';

export const RECIPE_ARCHIVE_LIMITS=Object.freeze({recipeBytes:1024*1024,fileBytes:1100*1024,files:4096,totalBytes:256*1024*1024,pending:4});
export const recipeArchiveError=(code,message,status=409)=>Object.assign(new Error(message),{code:`recipe_archive_${code}`,status});
const fail=(code,message,status)=>{throw recipeArchiveError(code,message,status);};
const object=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const exact=(value,fields)=>object(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const id=value=>typeof value==='string'&&/^[a-f0-9]{64}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const canonical=value=>chatGalleryReceiptText([value]).text.slice(1,-1);
export function recipeArchiveRequest(value){
  try{return chatGalleryRecordRequest(value);}catch{fail('contract','配方请求必须是准确的账户、聊天和单张画面定位',400);}
}

export function recipeArchiveStorageRequest(value){
  if(!exact(value,['version','expectedAccount'])||value.version!==1||typeof value.expectedAccount!=='string'||!/^st-user:[a-f0-9]{64}$/.test(value.expectedAccount))
    fail('contract','配方占用请求只接受当前账户核对，不接受路径或聊天范围',400);
  return {...value};
}
export function recipeArchiveStorageResponse(value){
  if(!exact(value,['ok','version','expectedAccount','state','files','bytes','limitFiles','limitBytes','proof'])||value.ok!==true
    ||value.proof!=='observed-file-sizes'||!['absent','present'].includes(value.state)
    ||!Number.isSafeInteger(value.files)||value.files<0||value.files>RECIPE_ARCHIVE_LIMITS.files
    ||!Number.isSafeInteger(value.bytes)||value.bytes<0||value.files===0&&value.bytes!==0
    ||value.state==='absent'&&(value.files!==0||value.bytes!==0)
    ||value.limitFiles!==RECIPE_ARCHIVE_LIMITS.files||value.limitBytes!==RECIPE_ARCHIVE_LIMITS.totalBytes)
    fail('contract','配方占用返回不完整，未以零值替代',400);
  recipeArchiveStorageRequest({version:value.version,expectedAccount:value.expectedAccount});
  return {...value};
}

export function recipeArchiveSnapshot(value){
  if(!object(value)||typeof value.source!=='string'||!value.source||value.source.length>120
    ||typeof value.prompt!=='string'||typeof value.negative!=='string'||!object(value.profile)||!object(value.payload))fail('content','原聊天未保留完整配方结构，未用当前设置补齐');
  let text;try{text=canonical(value);}catch{fail('content','原配方不是可完整保存的受限 JSON，未截断或改写');}
  if(new TextEncoder().encode(text).byteLength>RECIPE_ARCHIVE_LIMITS.recipeBytes)fail('size','原配方超过单份保存上限，原内容仍保留',413);
  function check(row){
    if(!row||typeof row!=='object')return;
    for(const [key,item] of Object.entries(row)){
      const field=key.toLowerCase().replace(/[-_.\s]/g,'');
      const segments=key.replace(/([a-z0-9])([A-Z])/g,'$1-$2').toLowerCase();
      const credentialSegment=!/^(?:credential|secret)[-_.]?id$/.test(segments)
        &&/(^|[-_.])(?:api[-_.]?key|access[-_.]?key|secret[-_.]?key|private[-_.]?key|access[-_.]?token|refresh[-_.]?token|secret|authorization|auth|cookie|cookies|password|passphrase|credential|credentials)(?:$|[-_.])/.test(segments);
      if(['__proto__','prototype','constructor'].includes(key.toLowerCase()))fail('content','原配方包含不支持的对象字段');
      if(credentialSegment||/^(?:apikey|xapikey|accesskey|secretkey|privatekey|token|accesstoken|refreshtoken|authorization|proxyauthorization|auth|password|passwd|passphrase|secret|clientsecret|credential|credentials|cookie|cookies|setcookie|bearertoken|sessiontoken)$/.test(field))
        fail('credentials','原配方包含凭据字段，请先在原聊天处理；未另存或返回这些字段');
      if(typeof item==='string'&&/(?:url|endpoint)$/i.test(key)&&/^https?:/i.test(item)){
        let url;try{url=new URL(item);}catch{fail('content','原配方连接地址无效，未修改原记录');}
        if(url.username||url.password||[...url.searchParams.keys()].some(name=>/(?:^|[-_])(?:api[-_]?key|access[-_]?token|token|secret|password|signature|sig|credential)(?:$|[-_])/i.test(name)))
          fail('credentials','原配方地址包含访问凭据，未另存或返回');
      }
      check(item);
    }
  }
  check(value);return {snapshot:JSON.parse(text),text};
}
export function recipeArchiveReference(value){
  if(!exact(value,['version','id','sha256','bytes'])||value.version!==1||!id(value.id)||!hash(value.sha256)||!value.id.startsWith(value.sha256+'-')
    ||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>RECIPE_ARCHIVE_LIMITS.fileBytes)fail('reference','服务器配方引用无效，未猜测归档位置');
  return {...value};
}
export function recipeArchiveEnvelope(value){
  if(!exact(value,['version','expectedAccount','source','snapshot'])||value.version!==1||typeof value.expectedAccount!=='string'||!/^st-user:[a-f0-9]{64}$/.test(value.expectedAccount)
    ||!exact(value.source,['target','recordId','createdAt']))fail('content','服务器配方来源结构不兼容');
  const target=chatCharacterReceiptTarget(value.source.target);
  recipeArchiveRequest({version:1,expectedAccount:value.expectedAccount,target,selection:{recordId:value.source.recordId,createdAt:value.source.createdAt,gallerySha256:'0'.repeat(64)}});
  const {snapshot}=recipeArchiveSnapshot(value.snapshot),out={version:1,expectedAccount:value.expectedAccount,source:{target,recordId:value.source.recordId,createdAt:value.source.createdAt},snapshot};
  const text=canonical(out);if(new TextEncoder().encode(text).byteLength>RECIPE_ARCHIVE_LIMITS.fileBytes)fail('size','服务器配方封装超过上限',413);
  return {value:JSON.parse(text),text};
}
export function recipeArchiveResponse(value){
  const write=value?.proof==='durable-recipe',fields=['ok','version','expectedAccount','target','selection','reference','proof'];
  if(!exact(value,write?fields:[...fields,'snapshot','origin'])||value.ok!==true||!write&&value.proof!=='read-only-recipe')fail('contract','配方保全返回格式不兼容',400);
  const request=recipeArchiveRequest({version:value.version,expectedAccount:value.expectedAccount,target:value.target,selection:value.selection});
  const reference=value.reference===null?null:recipeArchiveReference(value.reference);
  if(write&&!reference||!write&&(!['saved-inline','server-archive'].includes(value.origin)||(value.origin==='server-archive')!==Boolean(reference)))fail('contract','配方来源与保存凭据不一致',400);
  const result={...value,...request,reference,...(write?{}:{snapshot:recipeArchiveSnapshot(value.snapshot).snapshot})};
  if(new TextEncoder().encode(JSON.stringify(result)).byteLength>RECIPE_ARCHIVE_LIMITS.fileBytes)fail('size','配方返回超过安全大小，未截断',413);
  return result;
}
export function recipeArchiveErrorPayload(error){
  const known=typeof error?.code==='string'&&/^recipe_archive_[a-z_]+$/.test(error.code);
  return {status:known&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:503,
    body:{ok:false,version:1,code:known?error.code:'recipe_archive_unavailable',message:known?error.message:'配方保全暂未确认，请保留原聊天及本机副本后重试'}};
}
