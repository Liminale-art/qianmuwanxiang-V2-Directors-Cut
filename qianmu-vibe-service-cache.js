import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {checkPrivateResultDirectory as directory,readPrivateResultFile as read,replacePrivateResultFile as replace,syncPrivateResultDirectory as sync} from './qianmu-image-service-results.js';
import {validateVibeEncodingIdentity,validateVibeServiceDelivery} from './qianmu-vibe-encoding-store.js';
import {VIBE_ENCODING_LIMIT} from './qianmu-vibe-encoding.js';

const HASH=/^[a-f0-9]{64}$/,MAX_FILE=12*1024*1024,SCHEMA='qianmu.vibe-result.v1';
const sha=value=>createHash('sha256').update(value).digest('hex');
const fail=(code,message)=>Object.assign(new Error(message),{code:`image_service_vibe_cache_${code}`,submissionState:'unknown',status:409});
const missing=error=>error?.code==='ENOENT';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function identity(value){
  const result={};for(const name of ['namespace','channelKey','attemptId','requestDigest','fence']){
    const raw=value?.[name];if(typeof raw!=='string'||!raw||raw.length>240||/[\u0000-\u001f\u007f]/.test(raw)
      ||['channelKey','requestDigest'].includes(name)&&!HASH.test(raw))throw fail('identity','Vibe 暂存身份无效');result[name]=raw;
  }return result;
}
const slot=value=>sha(JSON.stringify(identity(value)));
async function checkedResult(value,owner){
  if(!value||value.version!==1||value.cacheKey!==owner.requestDigest||Object.keys(value).some(key=>!['version','cacheKey','identity','encoding','durationMs','serviceDelivery'].includes(key)))throw fail('result','Vibe 编码暂存结构不完整');
  if(value.serviceDelivery!==undefined)validateVibeServiceDelivery(value.serviceDelivery);
  await validateVibeEncodingIdentity(value.identity,value.cacheKey);
  if(typeof value.encoding!=='string'||!value.encoding||value.encoding.length>Math.ceil(VIBE_ENCODING_LIMIT/3)*4||value.encoding.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.encoding))throw fail('result','Vibe 编码暂存内容无效');
  const bytes=Buffer.from(value.encoding,'base64');if(!bytes.length||bytes.length>VIBE_ENCODING_LIMIT||bytes.toString('base64')!==value.encoding)throw fail('result','Vibe 编码暂存大小或内容无效');
  if(!Number.isFinite(value.durationMs)||value.durationMs<0)throw fail('result','Vibe 编码耗时无效');return value;
}
export {checkedResult as validateVibeServiceResult};

// Separate from generated images; a completed binary is recoverable even if writing its lightweight ready manifest failed.
export function createVibeServiceCache({dataRoot,store,maxSlots=128,maxBytes=512*1024*1024}={}){
  if(!store?.exclusive||!store?.readOnly||typeof dataRoot!=='string'||!path.isAbsolute(dataRoot)||dataRoot.includes('\0')||path.resolve(dataRoot)===path.parse(path.resolve(dataRoot)).root)throw fail('root','缺少可信的 Vibe 服务储存');
  const slots=Math.max(1,Math.min(128,Math.trunc(maxSlots)||128)),limit=Math.max(MAX_FILE,Math.min(512*1024*1024,Math.trunc(maxBytes)||512*1024*1024));
  async function locate(create=false){
    const root=await fs.realpath(dataRoot);let current=root;
    for(const segment of ['.qianmu-service','vibe-results-v1']){
      current=path.join(current,segment);if(create)try{await fs.mkdir(current,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
      try{await directory(current);}catch(error){if(!create&&missing(error))return null;throw error;}
    }return current;
  }
  async function manifest(folder,owner){
    await directory(folder);let doc;
    try{doc=JSON.parse((await read(path.join(folder,'manifest.json'),16384)).toString());}catch(error){if(missing(error))throw error;throw fail('manifest','Vibe 暂存清单无法读取');}
    if(doc.schema!==SCHEMA||!same(identity(doc.identity),owner)||!['reserved','ready'].includes(doc.status)||!Number.isSafeInteger(doc.bytes)||doc.bytes<0||doc.bytes>MAX_FILE
      ||!Number.isFinite(doc.createdAt)||doc.createdAt<0||doc.status==='reserved'&&doc.bytes!==0)throw fail('manifest','Vibe 暂存归属或大小不符');
    return doc;
  }
  async function resultFile(folder,owner){
    let data;try{data=await read(path.join(folder,'result.json'),MAX_FILE);}catch(error){if(missing(error))return null;throw error;}
    let envelope;try{envelope=JSON.parse(data.toString());}catch(_){throw fail('corrupt','Vibe 暂存编码损坏，请保留原请求');}
    if(envelope.schema!==SCHEMA||!same(identity(envelope.owner),owner)||envelope.checksum!==sha(JSON.stringify(envelope.result)))throw fail('corrupt','Vibe 暂存编码校验失败');
    return {result:await checkedResult(envelope.result,owner),bytes:data.length};
  }
  async function usage(root){
    let count=0,bytes=0;const stream=await fs.opendir(root);
    for await(const entry of stream){
      if(++count>slots||!entry.isDirectory()||!HASH.test(entry.name))throw fail('capacity','Vibe 暂存目录需要整理');
      const folder=path.join(root,entry.name);await directory(folder);let doc;
      try{doc=JSON.parse((await read(path.join(folder,'manifest.json'),16384)).toString());}
      catch(error){if(!missing(error))throw error;bytes+=MAX_FILE;continue;}
      const owner=identity(doc.identity);if(slot(owner)!==entry.name)throw fail('identity','Vibe 暂存目录归属不符');doc=await manifest(folder,owner);
      if(doc.status==='ready'){
        const stat=await fs.lstat(path.join(folder,'result.json'));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==doc.bytes)throw fail('corrupt','Vibe 暂存容量不符');
      }
      let files=0,physical=0;const entries=await fs.opendir(folder);
      for await(const file of entries){
        if(++files>8||!file.isFile()||!/^(?:manifest\.json|result\.json|\.(?:result|manifest)-[a-f0-9-]{36}\.tmp)$/.test(file.name))throw fail('corrupt','Vibe 暂存含未知文件，请先核查');
        const stat=await fs.lstat(path.join(folder,file.name));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>MAX_FILE)throw fail('corrupt','Vibe 暂存文件异常');physical+=stat.size;
      }
      // An interrupted final manifest write still occupies its full reserved budget, including partial temporary files.
      bytes+=Math.max(physical,doc.status==='ready'?doc.bytes:MAX_FILE);
    }return {count,bytes};
  }
  const protect=work=>Promise.resolve().then(work).catch(error=>{if(/^(vibe_|image_service_)/.test(error?.code||''))throw error;throw fail('storage','Vibe 服务暂存不可用，请核查原编码，勿重复提交');});
  return {
    reserve(raw){const owner=identity(raw);return protect(()=>store.exclusive(async()=>{
      const root=await locate(true),used=await usage(root),folder=path.join(root,slot(owner));
      if(used.count>=slots||used.bytes+MAX_FILE>limit)throw fail('capacity','Vibe 服务暂存已满，请先导出或清理');
      try{await fs.lstat(folder);throw fail('exists','原 Vibe 暂存已存在，请领取原结果');}catch(error){if(!missing(error))throw error;}
      await fs.mkdir(folder,{mode:0o700});await replace(folder,'manifest.json',JSON.stringify({schema:SCHEMA,identity:owner,status:'reserved',bytes:0,createdAt:Date.now()}),'manifest');await sync(folder);await sync(root);
    }));},
    save(raw,value){const owner=identity(raw),captured=structuredClone(value);return protect(()=>store.exclusive(async()=>{
      const result=await checkedResult(captured,owner),root=await locate();if(!root)throw fail('missing','原 Vibe 暂存未预留');
      const folder=path.join(root,slot(owner)),meta=await manifest(folder,owner),existing=await resultFile(folder,owner);
      if(existing){if(!same(existing.result,result))throw fail('conflict','原 Vibe 编码已保存，未覆盖');return existing.result;}
      const body=JSON.stringify({schema:SCHEMA,owner,result,checksum:sha(JSON.stringify(result))});if(Buffer.byteLength(body)>MAX_FILE)throw fail('size','Vibe 编码暂存过大');
      await replace(folder,'result.json',body,'result');await sync(folder);
      await replace(folder,'manifest.json',JSON.stringify({...meta,status:'ready',bytes:Buffer.byteLength(body)}),'manifest');await sync(folder);return result;
    }));},
    load(raw,{metadataOnly=false}={}){const owner=identity(raw);return protect(()=>store.readOnly(async()=>{
      const root=await locate();if(!root)return null;const folder=path.join(root,slot(owner));let meta;
      try{meta=await manifest(folder,owner);}catch(error){if(missing(error))return null;throw error;}
      if(metadataOnly){let stat;try{stat=await fs.lstat(path.join(folder,'result.json'));}catch(error){if(!missing(error))throw error;}
        if(stat&&(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>MAX_FILE))throw fail('corrupt','Vibe 暂存文件异常');
        return {available:Boolean(stat),bytes:stat?.size||0,createdAt:meta.createdAt};}
      const saved=await resultFile(folder,owner);if(!saved&&meta.status==='ready')throw fail('missing','原 Vibe 编码已缺失，未重新提交');return saved?.result||null;
    }));},
  };
}
