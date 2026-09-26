import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createAccountDocumentFiles} from './qianmu-account-document-files.js';
import {imageServiceAccount,imageServiceAccountStillMatches} from './qianmu-image-service-access.js';
import {parseBoundedJson} from './qianmu-json-input.js';
import {stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {TEXT_COLLECTION_SYNC_LIMITS,textCollectionSyncError as error} from './qianmu-text-collection-sync-contract.js';

const schema='qianmu.st-account-document.v1',headSchema='qianmu.st-account-head.v1';
const sha=text=>createHash('sha256').update(text).digest('hex');
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const child=(root,target)=>{const relative=path.relative(root,target);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const sameFile=(a,b)=>a?.ino>0n&&a.dev>=0n&&a.ino===b?.ino&&a.dev===b?.dev;
const sameVersion=(a,b)=>sameFile(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const regular=stat=>stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1n;
const fail=(code,message,status=409)=>{throw error('native_'+code,message,status);};

// A server-local transport for exactly the two existing ST-native collection
// slots. It never accepts a filename, root, namespace or arbitrary transform
// from an HTTP body. Native browser uploads do not share this lock: head checks
// remain optimistic, not a cross-transport CAS or a new database.
export function createTextCollectionNativeFileStore({dataRoot,request,expectedAccount,io=fs,signal,isCurrent=()=>true,deadline=Infinity,processStatus}={}){
  if(typeof dataRoot!=='string'||!path.isAbsolute(dataRoot)||dataRoot.includes('\0')||path.resolve(dataRoot)===path.parse(dataRoot).root
    ||typeof isCurrent!=='function')fail('setup','收藏保存环境尚未就绪',503);
  let account;try{account=imageServiceAccount(request);}catch{throw error('account','请先登录 ST 账户使用收藏',401);}
  if(account.namespace!==expectedAccount)throw error('account','收藏账户已变化，请重新打开',401);
  const original={root:request.user?.directories?.root,files:request.user?.directories?.files};
  if(Object.values(original).some(value=>typeof value!=='string'||!path.isAbsolute(value)||value.includes('\0')))fail('path','ST 账户文件目录不可用',503);
  const root=path.resolve(dataRoot),accountRoot=path.resolve(original.root),folder=path.resolve(original.files);
  if(!child(root,accountRoot)||!child(accountRoot,folder))fail('path','收藏文件目录不属于当前账户',403);
  const namespace=`st-user:${request.user.profile.handle}`,scope=sha(`${schema}\0${namespace}`),lstat=file=>io.lstat(file,{bigint:true});
  const context={folder,roots:new Map(),writeState:'not_started',guard(){
    if(signal?.aborted||isCurrent()!==true||Date.now()>=deadline)fail('closed','收藏保存已停止，请保留当前内容');
    if(!imageServiceAccountStillMatches(request,account)||request.user?.directories?.root!==original.root||request.user?.directories?.files!==original.files)
      throw error('account','收藏账户或文件目录已变化，请重新打开',401);
  }};
  context.guard();
  // Only the established lock primitive is used. Its checksum-bearing document
  // read/write methods must never write the native head/body protocol.
  const locking=createAccountDocumentFiles({root,filename:'.qianmu-native-collections-unused.json',lockname:'.qianmu-native-collections.lock',
    temporaryPrefix:'.qianmu-native-collections-unused-',bytes:TEXT_COLLECTION_SYNC_LIMITS.bytes,errorFactory:error,label:'收藏',validate:value=>value,empty:()=>null,io,processStatus});
  async function roots(authorize=true){
    if(authorize)context.guard();let cursor=root;const directories=[cursor];
    for(const segment of path.relative(root,folder).split(path.sep)){cursor=path.join(cursor,segment);directories.push(cursor);}
    for(const directory of directories){
      const current=await lstat(directory),prior=context.roots.get(directory);
      if(!current.isDirectory()||current.isSymbolicLink()||path.resolve(await io.realpath(directory))!==directory||prior&&!sameFile(prior,current))
        fail('path','收藏文件目录为链接或已变化，未继续保存');
      context.roots.set(directory,current);if(authorize)context.guard();
    }
  }
  const prefix=slot=>{if(!['collections','collection-record'].includes(slot))fail('slot','收藏保存范围无效',400);return `qianmu-v2-${scope}-${slot}`;};
  function json(value,maxBytes){
    const seen=new Set();let nodes=0;
    function inspect(item,depth=0){
      if(++nodes>500000||depth>32)fail('capacity','收藏内容结构超过保存上限',507);
      if(item===null||typeof item==='boolean')return;
      if(typeof item==='string'){if(item.includes('\0')||Buffer.from(item,'utf8').toString('utf8')!==item)fail('content','收藏文字编码无效',503);return;}
      if(typeof item==='number'){if(!Number.isFinite(item))fail('content','收藏数值无效',503);return;}
      if(typeof item!=='object'||seen.has(item)||!Array.isArray(item)&&![Object.prototype,null].includes(Object.getPrototypeOf(item)))fail('content','收藏内容不是独立 JSON 数据',503);
      seen.add(item);
      if(Array.isArray(item)&&(Object.keys(item).length!==item.length||Object.keys(item).some((key,index)=>key!==String(index))))fail('content','收藏数组不完整',503);
      for(const key of Object.keys(item)){
        const descriptor=Object.getOwnPropertyDescriptor(item,key);
        if(!descriptor||!Object.hasOwn(descriptor,'value')||['__proto__','prototype','constructor'].includes(key))fail('content','收藏字段无效',503);
        inspect(key,depth+1);inspect(descriptor.value,depth+1);
      }
      if(Object.getOwnPropertySymbols(item).length)fail('content','收藏字段无效',503);seen.delete(item);
    }
    inspect(value);
    const text=JSON.stringify(value);
    if(typeof text!=='string'||Buffer.byteLength(text)>maxBytes)fail('capacity','收藏内容超过保存上限，未截断',507);
    try{parseBoundedJson(text,{maxBytes,maxDepth:36,maxNodes:500100,label:'收藏原件'});}catch{fail('content','收藏内容格式无效，未覆盖原件',503);}
    return text;
  }
  async function readFile(name,maxBytes,allowMissing=false){
    await roots();const target=path.join(folder,name);let before;
    try{before=await lstat(target);}catch(cause){if(allowMissing&&cause?.code==='ENOENT'){await roots();return null;}throw cause;}
    if(!regular(before)||before.size<1n||before.size>BigInt(maxBytes))fail('content','收藏文件为链接、损坏或超过读取上限',503);
    const handle=await io.open(target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try{
      context.guard();const opened=await handle.stat({bigint:true});if(!regular(opened)||!sameVersion(before,opened))fail('changed','收藏文件读取前已变化');
      const buffer=Buffer.alloc(Number(opened.size)+1);let length=0;
      while(length<buffer.length){context.guard();const part=await handle.read(buffer,length,buffer.length-length,length);context.guard();if(!part.bytesRead)break;length+=part.bytesRead;}
      const after=await handle.stat({bigint:true}),current=await lstat(target);
      if(BigInt(length)!==opened.size||!regular(after)||!regular(current)||!sameVersion(opened,after)||!sameVersion(after,current))fail('changed','收藏文件核对期间已变化');
      let text,value;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length));value=parseBoundedJson(text,{maxBytes,maxDepth:36,maxNodes:500100,label:'收藏原件'});}
      catch{fail('content','收藏文件损坏，未覆盖原件',503);}
      await roots();return {text,value,identity:current};
    }finally{await handle.close();}
  }
  async function syncFolder(){if(process.platform==='win32')return;const handle=await io.open(folder,'r');try{await handle.sync();}finally{await handle.close();}}
  async function discard(stage){
    await roots(false);let current;
    try{current=await lstat(stage.path);}catch(cause){if(cause?.code==='ENOENT')return;throw cause;}
    if(!sameFile(stage.identity,current)||!current.isFile()||current.isSymbolicLink()||![1n,2n].includes(current.nlink))fail('path','收藏临时文件已变化，未清理',503);
    if(current.nlink===2n){
      let linked;try{linked=await lstat(stage.link);}catch{fail('path','收藏临时文件关联已变化，未清理',503);}
      if(!sameFile(current,linked)||!linked.isFile()||linked.isSymbolicLink()||linked.nlink!==2n)fail('path','收藏临时文件关联无效，未清理',503);
    }
    await io.unlink(stage.path);
  }
  async function staged(text,work){
    const stage={path:path.join(folder,`.qianmu-native-collection-${randomUUID()}.tmp`),identity:null,link:null};let handle;
    try{
      await roots();context.guard();context.writeState='unconfirmed';handle=await io.open(stage.path,'wx',0o600);stage.identity=await handle.stat({bigint:true});
      await handle.writeFile(text);await handle.sync();stage.identity=await handle.stat({bigint:true});await handle.close();handle=null;
      await roots();const current=await lstat(stage.path);
      if(!regular(current)||!sameVersion(stage.identity,current))fail('changed','收藏待保存文件已变化，未发布',503);
      context.guard();return await work(stage);
    }finally{if(handle)await handle.close();if(stage.identity)await discard(stage);}
  }
  const result=(value,fingerprint)=>Object.freeze({exists:fingerprint!==null,value,fingerprint});
  async function readHead(){
    const saved=await readFile(`${prefix('collections')}.json`,4096,true);if(!saved)return null;
    const value=saved.value;
    if(!exact(value,['schema','scope','slot','fingerprint'])||value.schema!==headSchema||value.scope!==scope||value.slot!=='collections'||!/^[a-f0-9]{64}$/.test(value.fingerprint||''))
      fail('content','收藏目录入口损坏或账户不一致',503);
    return saved;
  }
  async function readImmutable(input,allowMissing=false){
    const reference=stAccountImmutableReference(input,{scope,maxBytes:TEXT_COLLECTION_SYNC_LIMITS.bytes+1024});prefix(reference.slot);
    const saved=await readFile(`${prefix(reference.slot)}-${reference.fingerprint}.json`,reference.bytes,allowMissing);
    if(!saved){if(allowMissing)return null;fail('missing','收藏原件已不可读取，请保留当前内容',404);}
    const value=saved.value;
    if(Buffer.byteLength(saved.text)!==reference.bytes||sha(saved.text)!==reference.fingerprint||!exact(value,['schema','scope','slot','value'])
      ||value.schema!==schema||value.scope!==scope||value.slot!==reference.slot)fail('content','收藏原件版本或账户校验失败',503);
    json(value.value,TEXT_COLLECTION_SYNC_LIMITS.bytes);
    context.guard();return Object.freeze({...result(value.value,reference.fingerprint),reference});
  }
  async function readDocument(){
    const head=await readHead();if(!head)return result(null,null);
    const saved=await readFile(`${prefix('collections')}-${head.value.fingerprint}.json`,TEXT_COLLECTION_SYNC_LIMITS.bytes+1024);
    const value=saved.value;
    if(!exact(value,['schema','scope','slot','value'])||value.schema!==schema||value.scope!==scope||value.slot!=='collections'||sha(saved.text)!==head.value.fingerprint)
      fail('content','收藏目录完整性校验失败，未覆盖',503);
    json(value.value,TEXT_COLLECTION_SYNC_LIMITS.bytes);
    const final=await readHead();if(!final||final.text!==head.text)fail('changed','收藏目录读取期间已变化');
    context.guard();return result(value.value,head.value.fingerprint);
  }
  async function preserveImmutable(slot,value){
    const text=json({schema,scope,slot,value},TEXT_COLLECTION_SYNC_LIMITS.bytes+1024),reference=stAccountImmutableReference({version:1,scope,slot,fingerprint:sha(text),bytes:Buffer.byteLength(text)},
      {scope,slot,maxBytes:TEXT_COLLECTION_SYNC_LIMITS.bytes+1024});prefix(slot);
    const prior=await readImmutable(reference,true);if(prior)return prior;
    await staged(text,async stage=>{
      stage.link=path.join(folder,`${prefix(slot)}-${reference.fingerprint}.json`);await roots();context.guard();
      try{await io.link(stage.path,stage.link);}catch(cause){if(cause?.code!=='EEXIST')throw cause;await readImmutable(reference);}
      // Atomic no-replace publication; remove only our verified temporary link.
      // A competing or corrupt file is never overwritten or auto-repaired.
      await discard(stage);await syncFolder();context.guard();
    });
    return readImmutable(reference);
  }
  async function writeDocument(value,expectedFingerprint){
    const text=json({schema,scope,slot:'collections',value},TEXT_COLLECTION_SYNC_LIMITS.bytes+1024),fingerprint=sha(text);
    const previous=await readHead();if((previous?.value.fingerprint??null)!==expectedFingerprint)throw error('conflict','收藏已在其他设备更新，未覆盖');
    if(previous?.value.fingerprint===fingerprint)return readDocument();
    await preserveImmutable('collections',value);
    const headText=JSON.stringify({schema:headSchema,scope,slot:'collections',fingerprint});
    await staged(headText,async stage=>{
      const current=await readHead();if((current?.value.fingerprint??null)!==expectedFingerprint)throw error('conflict','保存期间收藏目录已有更新，副本保留');
      await roots();context.guard();await io.rename(stage.path,path.join(folder,`${prefix('collections')}.json`));await syncFolder();context.guard();
    });
    const verified=await readDocument();if(verified.fingerprint!==fingerprint)throw error('conflict','保存后检测到其他更新，本次副本保留');return verified;
  }
  return Object.freeze({namespace,scope,guard:()=>context.guard(),get writeState(){return context.writeState;},
    read(slot){if(slot!=='collections')fail('slot','收藏目录范围无效',400);return readDocument();},
    readImmutable:input=>readImmutable(input),preserveImmutable,
    async update(slot,transform){if(slot!=='collections'||typeof transform!=='function')fail('slot','收藏更新范围无效',400);
      const prior=await readDocument();context.guard();const next=transform(structuredClone(prior.value),prior);context.guard();return writeDocument(next,prior.fingerprint);},
    exclusive:operation=>locking.exclusive(context,operation),
  });
}
