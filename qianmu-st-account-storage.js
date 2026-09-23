import {parseBoundedJson} from './qianmu-json-input.js';

// ST native files, NOT Data Bank attachments. Heads are deterministic, bodies
// content-addressed and retained. This is optimistic detection, never CAS:
// another device can replace a head after our final read. No delete API is used.
export const ST_ACCOUNT_STORAGE_LIMITS=Object.freeze({bytes:8*1024*1024,maxBytes:64*1024*1024,timeoutMs:15000,slots:96});
const schema='qianmu.st-account-document.v1',headSchema='qianmu.st-account-head.v1',queues=new Map();
const hashPattern=/^[a-f0-9]{64}$/;
let configured=null,configurationEpoch=0,readScope=null;
const error=(code,message)=>Object.assign(new Error(message),{code:`st_account_storage_${code}`,writeState:'not_started'});
const fail=(code,message)=>{throw error(code,message);};
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const slotName=value=>{if(typeof value!=='string'||!/^[a-z][a-z0-9-]{0,95}$/.test(value))fail('slot','储存项目标识无效');return value;};
const namespaceName=value=>{if(typeof value!=='string'||!/^st-user:.+/.test(value)||value.length>512||/[\u0000-\u001f\u007f]/.test(value))fail('account','尚未确认当前 ST 账户');return value;};
const utf8=new TextEncoder();
// A reference identifies one complete version inside the captured ST account.
// It is not authorization and cannot select an external URL or bypass a guard.
export function stAccountImmutableReference(value,{scope,slot,maxBytes=ST_ACCOUNT_STORAGE_LIMITS.maxBytes+1024}={}){
  const names=['version','scope','slot','fingerprint','bytes'];
  if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value))
    ||Reflect.ownKeys(value).length!==names.length||names.some(key=>!Object.getOwnPropertyDescriptor(value,key)?.enumerable
      ||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key)||{},'value')))fail('reference','ST 原件引用格式无效');
  if(value.version!==1||typeof scope!=='string'||!hashPattern.test(scope)||value.scope!==scope
    ||typeof value.fingerprint!=='string'||!hashPattern.test(value.fingerprint)
    ||!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>maxBytes
    ||slot!==undefined&&value.slot!==slot)fail('reference','ST 原件引用与账户或读取范围不一致');
  slotName(value.slot);return Object.freeze(Object.fromEntries(names.map(key=>[key,value[key]])));
}
function jsonText(value,maxBytes){
  const seen=new Set();let nodes=0;
  function check(item,depth=0){
    if(++nodes>500000||depth>32)fail('capacity','储存内容结构过大');
    if(item===null||typeof item==='boolean')return;
    if(typeof item==='string'){
      if(item.includes('\0')||new TextDecoder().decode(utf8.encode(item))!==item)fail('format','储存文字编码无效');return;
    }
    if(typeof item==='number'){if(!Number.isFinite(item))fail('format','储存数值无效');return;}
    if(typeof item!=='object'||seen.has(item)||!Array.isArray(item)&&![Object.prototype,null].includes(Object.getPrototypeOf(item)))fail('format','储存内容必须是独立 JSON 数据');
    seen.add(item);
    if(Array.isArray(item)&&(Object.keys(item).length!==item.length||Object.keys(item).some((key,index)=>key!==String(index))))fail('format','储存数组不完整');
    for(const key of Object.keys(item)){
      const descriptor=Object.getOwnPropertyDescriptor(item,key);if(!descriptor||!Object.hasOwn(descriptor,'value'))fail('format','储存内容不可包含访问器');
      if(['__proto__','prototype','constructor'].includes(key))fail('format','储存字段无效');check(key,depth+1);check(descriptor.value,depth+1);
    }
    if(Object.getOwnPropertySymbols(item).length)fail('format','储存字段无效');seen.delete(item);
  }
  check(value);const text=JSON.stringify(value);if(utf8.encode(text).byteLength>maxBytes)fail('capacity','储存内容超过单文件上限，原内容未截断');return text;
}
const base64=text=>{const bytes=utf8.encode(text),parts=[];for(let at=0;at<bytes.length;at+=16384)parts.push(String.fromCharCode(...bytes.subarray(at,at+16384)));return btoa(parts.join(''));};
function configuration(options){
  if(!options||typeof options.resolveNamespace!=='function'||typeof options.isCurrent!=='function'||typeof options.headers!=='function')fail('setup','ST 储存环境尚未就绪');return {...options};
}
export function configureStAccountStorage(options){configured=configuration(options);configurationEpoch++;readScope=Object.freeze({});}
export function isStAccountStorageConfigured(){return configured!==null;}
// An opaque lifetime token, never an account id or a substitute for a guard.
export function getStAccountStorageReadScope(){return readScope;}
// Narrow Worker handoff: same ST origin/account and CSRF only. The caller must
// still validate the live account on every Worker guard RPC. No API credentials.
export async function captureStAccountStorageWorkerContext(){
  if(!configured)fail('setup','ST 储存环境尚未就绪');const base=configured,epoch=configurationEpoch;
  const check=()=>{if(epoch!==configurationEpoch||base.isCurrent()!==true)fail('scope','ST 储存账户已变化');};
  check();const namespace=namespaceName(await base.resolveNamespace());check();
  const csrf=new Headers(await base.headers()).get('x-csrf-token')||'';check();
  if(await base.resolveNamespace()!==namespace)fail('account','ST 储存账户已变化');check();
  const origin=base.origin||globalThis.location?.origin;let url;try{url=new URL(origin);}catch{fail('setup','ST 储存站点不可用');}
  if(!['https:','http:'].includes(url.protocol)||url.origin!==origin||globalThis.location?.origin&&origin!==globalThis.location.origin)fail('setup','ST 储存只能使用当前站点');
  return {namespace,origin,csrf};
}
export function createConfiguredStAccountStorage(options={}){
  if(!configured)fail('setup','ST 储存环境尚未就绪');const epoch=configurationEpoch,base=configured;
  // A caller cannot replace the account resolver with another account by override.
  const {resolveNamespace:_,isCurrent:callerCurrent,headers:__,...overrides}=options;
  return createStAccountStorage({...base,...overrides,resolveNamespace:base.resolveNamespace,headers:base.headers,
    isCurrent:()=>epoch===configurationEpoch&&base.isCurrent()===true&&(!callerCurrent||callerCurrent()===true)});
}

export async function createStAccountStorage({resolveNamespace,isCurrent,headers,fetchImpl=globalThis.fetch,origin=globalThis.location?.origin,
  cryptoImpl=globalThis.crypto,maxBytes=ST_ACCOUNT_STORAGE_LIMITS.bytes,timeoutMs=ST_ACCOUNT_STORAGE_LIMITS.timeoutMs}={}){
  configuration({resolveNamespace,isCurrent,headers});
  if(typeof fetchImpl!=='function'||!cryptoImpl?.subtle?.digest||!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>ST_ACCOUNT_STORAGE_LIMITS.maxBytes
    ||!Number.isFinite(timeoutMs)||timeoutMs<100||timeoutMs>60000)fail('setup','ST 储存参数或安全连接不可用');
  let site;try{site=new URL(origin);if(!['https:','http:'].includes(site.protocol)||site.origin!==origin||site.username||site.password||globalThis.location?.origin&&site.origin!==globalThis.location.origin)throw Error();}
  catch{fail('setup','储存仅可连接当前 ST 站点');}
  const digest=async text=>Array.from(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',utf8.encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
  let closed=false,namespace,scope;const operations=new Set(),transformErrors=new WeakSet();
  async function operation(work,{signal,guard=()=>true}={}){
    if(typeof guard!=='function')fail('setup','储存来源校验无效');
    const controller=new AbortController(),readers=new Set();let rejectCancellation,started=false;
    const cancellation=new Promise((_,reject)=>{rejectCancellation=reject;});
    const abort=(code='cancelled',message='储存操作已停止，未确认的内容仍需保留')=>{
      controller.abort();for(const reader of readers)try{void reader.cancel().catch(()=>{});}catch{}
      rejectCancellation(error(code,message));
    };
    const onAbort=()=>abort();operations.add(abort);signal?.addEventListener('abort',onAbort,{once:true});
    const timer=setTimeout(()=>abort('timeout','ST 保存确认超时，原内容仍需保留'),timeoutMs);
    const check=async()=>{
      if(closed||controller.signal.aborted||isCurrent()!==true)fail('closed','储存页面或会话已结束');
      if(await guard()!==true)fail('scope','储存来源已变化');
      const owner=namespaceName(await resolveNamespace());
      if(namespace!==undefined&&owner!==namespace)fail('account','ST 账户已变化，未继续储存');
      if(closed||controller.signal.aborted||isCurrent()!==true||await guard()!==true)fail('scope','储存来源已变化');
      return owner;
    };
    async function call(path,{body=null,limit=maxBytes,allowMissing=false}={}){
      await check();const supplied=new Headers(await headers()),requestHeaders={Accept:'application/json'};
      if(supplied.has('x-csrf-token'))requestHeaders['X-CSRF-Token']=supplied.get('x-csrf-token');
      if(body!==null)requestHeaders['Content-Type']='application/json';await check();
      if(body!==null)started=true;
      let response,reader;
      try{
        response=await fetchImpl(new URL(path,site).href,{method:body===null?'GET':'POST',headers:requestHeaders,
          ...(body===null?{}:{body}),credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});
        await check();
        if(response.redirected||response.type==='opaqueredirect'||response.status>=300&&response.status<400)fail('path','ST 储存接口跳转，未采用返回');
        if(response.url&&response.url!==new URL(path,site).href)fail('path','ST 储存返回路径不一致');
        if([401,403].includes(response.status))fail('account','ST 登录已失效，请重新登录');
        if(allowMissing&&response.status===404)return null;
        if(!response.ok)fail('service','ST 文件储存暂不可用');
        if(!/^(application\/json|text\/plain|application\/octet-stream)\b/i.test(response.headers.get('content-type')||'')||Number(response.headers.get('content-length'))>limit)fail('format','ST 储存返回格式或大小无效');
        reader=response.body?.getReader();if(!reader)fail('format','ST 储存返回不完整');readers.add(reader);
        const decoder=new TextDecoder('utf-8',{fatal:true});let text='',bytes=0;
        while(true){const part=await reader.read();await check();if(part.done)break;bytes+=part.value.byteLength;if(bytes>limit)fail('capacity','ST 储存返回超过读取上限');text+=decoder.decode(part.value,{stream:true});}
        text+=decoder.decode();let value;try{value=parseBoundedJson(text,{maxBytes:limit,maxDepth:36,maxNodes:500100,label:'ST 储存'});}catch{fail('format','ST 储存文件损坏，未覆盖原件');}
        return {text,value};
      }finally{
        if(reader){readers.delete(reader);try{void reader.cancel().catch(()=>{});}catch{}try{reader.releaseLock();}catch{}}
        else try{void response?.body?.cancel?.().catch(()=>{});}catch{}
      }
    }
    try{
      if(signal?.aborted||closed)abort();
      return await Promise.race([Promise.resolve().then(()=>work({check,call})),cancellation]);
    }catch(cause){const known=String(cause?.code||'').startsWith('st_account_storage_')||cause instanceof Error&&transformErrors.has(cause)?cause:error('connection','ST 储存未确认，请保留当前内容');known.writeState=started?'unconfirmed':'not_started';throw known;}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);operations.delete(abort);controller.abort();}
  }
  await operation(async({check})=>{namespace=await check();scope=await digest(`${schema}\0${namespace}`);await check();});
  const prefix=slot=>`qianmu-v2-${scope}-${slot}`;
  const path=name=>`/user/files/${name}`;
  const result=(value,fingerprint)=>Object.freeze({exists:fingerprint!==null,value,fingerprint,persistence:'st-account-file',concurrency:'optimistic-non-cas'});
  async function readHead(slot,op){
    const head=await op.call(path(`${prefix(slot)}.json`),{limit:4096,allowMissing:true});if(!head)return null;
    const value=head.value;if(!exact(value,['schema','scope','slot','fingerprint'])||value.schema!==headSchema||value.scope!==scope||value.slot!==slot||!hashPattern.test(value.fingerprint))fail('format','ST 储存目录损坏或不属于当前账户');return value;
  }
  async function readDocument(slot,op){
    const head=await readHead(slot,op);if(!head)return result(null,null);
    const body=await op.call(path(`${prefix(slot)}-${head.fingerprint}.json`),{limit:maxBytes+1024});
    const value=body.value;
    if(!exact(value,['schema','scope','slot','value'])||value.schema!==schema||value.scope!==scope||value.slot!==slot||await digest(body.text)!==head.fingerprint)fail('format','ST 储存正文校验失败，未采用内容');
    jsonText(value.value,maxBytes);await op.check();return result(value.value,head.fingerprint);
  }
  async function upload(name,text,op){
    const receipt=await op.call('/api/files/upload',{body:JSON.stringify({name,data:base64(text)}),limit:4096});
    if(!exact(receipt.value,['path'])||![path(name),path(name).slice(1)].includes(receipt.value.path))fail('path','ST 保存回执路径无效，未确认保存');
  }
  async function readImmutable(reference,op,allowMissing=false){
    const body=await op.call(path(`${prefix(reference.slot)}-${reference.fingerprint}.json`),{limit:reference.bytes,allowMissing:true});
    if(!body){if(allowMissing)return null;fail('missing','ST 原件已不可读，未使用其他版本替代');}
    const value=body.value;
    if(utf8.encode(body.text).byteLength!==reference.bytes||!exact(value,['schema','scope','slot','value'])||value.schema!==schema
      ||value.scope!==scope||value.slot!==reference.slot||await digest(body.text)!==reference.fingerprint)fail('format','ST 原件版本或内容校验失败，未采用内容');
    jsonText(value.value,maxBytes);await op.check();
    return Object.freeze({...result(value.value,reference.fingerprint),reference});
  }
  async function preserveImmutable(slot,value,op){
    const text=jsonText({schema,scope,slot,value},maxBytes+1024);
    const reference=stAccountImmutableReference({version:1,scope,slot,fingerprint:await digest(text),bytes:utf8.encode(text).byteLength},{scope,slot,maxBytes:maxBytes+1024});
    await op.check();
    const existing=await readImmutable(reference,op,true);if(existing)return existing;
    // Never publishes/replaces a mutable head. Even after a lost upload receipt,
    // a caller retry first verifies the exact body instead of uploading blindly.
    await upload(`${prefix(slot)}-${reference.fingerprint}.json`,text,op);
    return readImmutable(reference,op);
  }
  async function writeDocument(slot,value,expectedFingerprint,op){
    const text=jsonText({schema,scope,slot,value},maxBytes+1024),fingerprint=await digest(text);await op.check();
    const previous=await readHead(slot,op);
    if((previous?.fingerprint??null)!==expectedFingerprint)fail('conflict','内容已在其他页面更新，未覆盖新版本');
    if(previous?.fingerprint===fingerprint)return readDocument(slot,op);
    // Retained immutable bodies protect old copies. No fallback transport, deletion
    // or blind retry occurs after an upload whose acknowledgement was lost.
    await upload(`${prefix(slot)}-${fingerprint}.json`,text,op);
    const beforeCommit=await readHead(slot,op);
    if((beforeCommit?.fingerprint??null)!==expectedFingerprint)fail('conflict','保存期间内容已有更新，原副本保留');
    await upload(`${prefix(slot)}.json`,JSON.stringify({schema:headSchema,scope,slot,fingerprint}),op);
    const verified=await readDocument(slot,op);
    if(verified.fingerprint!==fingerprint)fail('conflict','保存后检测到其他更新，本次副本仍保留');return verified;
  }
  function queue(slot,work,options){
    slotName(slot);const key=`${site.origin}/${scope}/${slot}`,prior=queues.get(key)||Promise.resolve();
    const task=prior.catch(()=>{}).then(()=>operation(op=>work(op),options));queues.set(key,task);
    void task.finally(()=>{if(queues.get(key)===task)queues.delete(key);}).catch(()=>{});return task;
  }
  return Object.freeze({namespace,scope,
    read(slot,options){return queue(slot,op=>readDocument(slot,op),options);},
    readImmutable(reference,options){
      try{const captured=stAccountImmutableReference(reference,{scope,maxBytes:maxBytes+1024});return queue(captured.slot,op=>readImmutable(captured,op),options);}
      catch(cause){return Promise.reject(cause);}
    },
    readImmutableBatch(references,options={}){
      try{
        if(!Array.isArray(references)||!references.length||references.length>4)fail('reference','ST 原件读取批次须为1至4份');
        const captured=Array.from(references,reference=>stAccountImmutableReference(reference,{scope,maxBytes:maxBytes+1024})),slot=captured[0].slot;
        if(captured.some(reference=>reference.slot!==slot)||captured.reduce((sum,reference)=>sum+reference.bytes,0)>maxBytes+1024)fail('capacity','ST 原件批次范围或总大小超过读取上限');
        // One queued, read-only operation: at most four complete immutable
        // bodies in flight, with the existing slot write order preserved.
        // Missing/corrupt bodies are item failures; lost account/page guards
        // still reject the entire batch before any result is returned.
        return queue(slot,async op=>{const results=await Promise.allSettled(captured.map(reference=>readImmutable(reference,op)));await op.check();return results;},{...options});
      }catch(cause){return Promise.reject(cause);}
    },
    preserveImmutable(slot,value,options){
      try{slotName(slot);const captured=JSON.parse(jsonText(value,maxBytes));return queue(slot,op=>preserveImmutable(slot,captured,op),options);}
      catch(cause){return Promise.reject(cause);}
    },
    write(slot,value,{expectedFingerprint,signal,guard}={}){
      try{
        if(expectedFingerprint!==null&&!hashPattern.test(expectedFingerprint||''))fail('conflict','保存需要先读取当前版本');
        const captured=JSON.parse(jsonText(value,maxBytes));return queue(slot,op=>writeDocument(slot,captured,expectedFingerprint,op),{signal,guard});
      }catch(cause){return Promise.reject(cause);}
    },
    update(slot,transform,options){
      if(typeof transform!=='function')return Promise.reject(error('setup','储存更新函数无效'));
      return queue(slot,async op=>{
        const prior=await readDocument(slot,op);let next;
        try{next=transform(structuredClone(prior.value),prior);}catch(cause){if(cause instanceof Error)transformErrors.add(cause);throw cause;}
        // No asynchronous or network work inside a read-modify-write transformation.
        const captured=JSON.parse(jsonText(next,maxBytes));await op.check();return writeDocument(slot,captured,prior.fingerprint,op);
      },options);
    },
    close(){closed=true;for(const abort of operations)abort();},
  });
}
