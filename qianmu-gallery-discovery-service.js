import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {imageServiceAccount,imageServiceAccountStillMatches} from './qianmu-image-service-access.js';
import {galleryDiscoveryRequest,galleryDiscoveryResponse,galleryDiscoveryError,GALLERY_DISCOVERY_LIMITS as LIMIT} from './qianmu-gallery-discovery-contract.js';
import {parseBoundedJson} from './qianmu-json-input.js';

const sha=text=>createHash('sha256').update(text).digest('hex');
const fail=(code,message,status)=>{throw galleryDiscoveryError(code,message,status);};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const child=(root,target)=>{const relative=path.relative(root,target);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const sameFile=(a,b)=>a?.ino>0n&&a.dev>=0n&&a.ino===b?.ino&&a.dev===b?.dev;
const sameVersion=(a,b)=>sameFile(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const regular=stat=>stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1n;
const stamp=stat=>sha([stat.dev,stat.ino,stat.mtimeNs,stat.ctimeNs].join(':'));

// Read-only discovery of already-published ST-native source versions. No chat,
// record, recipe, image, mutable registry, write, repair or recursive traversal.
// HTTP adapter supplies the authenticated ST request, never caller-owned roots.
export function createGalleryDiscoveryService({dataRoot,io=fs,timeoutMs=LIMIT.timeoutMs}={}){
  if(typeof dataRoot!=='string'||!dataRoot||dataRoot.includes('\0')||!Number.isFinite(timeoutMs)||timeoutMs<100||timeoutMs>30000)fail('setup','图库发现环境未就绪',503);
  const root=path.resolve(dataRoot);if(root===path.parse(root).root)fail('setup','图库发现数据范围无效',503);
  let closed=false;const pending=new Set(),lstat=file=>io.lstat(file,{bigint:true});
  function capture(req,input,signal){
    let account;try{account=imageServiceAccount(req);}catch{fail('account','请先登录 ST 账户读取图库目录',401);}
    const query=galleryDiscoveryRequest(input);if(query.expectedAccount!==account.namespace)fail('account','图库目录账户已变化',401);
    const original={root:req.user?.directories?.root,files:req.user?.directories?.files};
    if(Object.values(original).some(value=>typeof value!=='string'||!value||value.includes('\0')))fail('setup','ST 尚未提供账户文件目录',503);
    const accountRoot=path.resolve(original.root),folder=path.resolve(original.files);
    if(!child(root,accountRoot)||!child(accountRoot,folder))fail('path','图库文件目录不属于当前账户',403);
    const namespace=`st-user:${req.user.profile.handle}`,scope=sha(`qianmu.st-account-document.v1\0${namespace}`),deadline=Date.now()+timeoutMs;
    const context={query,account,namespace,scope,folder,directories:new Map(),guard(){
      if(closed||signal.aborted||Date.now()>=deadline||!imageServiceAccountStillMatches(req,account)||req.user?.directories?.root!==original.root||req.user?.directories?.files!==original.files)fail('changed','图库发现已停止或账户已变化');
    }};context.guard();return context;
  }
  async function roots(context){
    context.guard();let at=root;const paths=[at];
    for(const part of path.relative(root,context.folder).split(path.sep)){at=path.join(at,part);paths.push(at);}
    for(const directory of paths){
      const stat=await lstat(directory),prior=context.directories.get(directory);
      if(!stat.isDirectory()||stat.isSymbolicLink()||path.resolve(await io.realpath(directory))!==directory||prior&&!sameFile(prior,stat))fail('path','图库文件目录为链接或已更换');
      context.directories.set(directory,stat);context.guard();
    }
    return context.directories.get(context.folder);
  }
  async function read(context,name,maxBytes){
    await roots(context);const filename=path.join(context.folder,name),before=await lstat(filename);
    if(!regular(before)||before.size<1n||before.size>BigInt(maxBytes))fail('content','图库目录文件为链接、非常规文件或超过上限');
    const handle=await io.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try{
      context.guard();const opened=await handle.stat({bigint:true});if(!regular(opened)||!sameVersion(before,opened))fail('changed','图库目录文件读取前已变化');
      const buffer=Buffer.alloc(Number(opened.size)+1);let length=0;
      while(length<buffer.length){context.guard();const part=await handle.read(buffer,length,buffer.length-length,length);context.guard();if(!part.bytesRead)break;length+=part.bytesRead;}
      const after=await handle.stat({bigint:true}),current=await lstat(filename);
      if(BigInt(length)!==opened.size||!regular(after)||!regular(current)||!sameVersion(opened,after)||!sameVersion(after,current))fail('changed','图库目录文件核对期间已变化');
      let text,value;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length));value=parseBoundedJson(text,{maxBytes,maxDepth:16,maxNodes:1024,label:'图库版本目录'});}
      catch{fail('content','图库目录文件损坏，未当成空库或修复');}
      await roots(context);context.guard();return {text,value};
    }finally{await handle.close();}
  }
  async function inspect(req,input,signal){
    const context=capture(req,input,signal),initial=await roots(context),generation=stamp(initial),query=context.query;
    if(query.cursor&&query.cursor.stamp!==generation)fail('stale','图库目录在翻页期间已变化，请刷新列表');
    const prefix=`qianmu-v2-${context.scope}-gallery-source`,pattern=new RegExp(`^${prefix}(2)?-([a-f0-9]{64})\\.json$`),selected=[];
    const directory=await io.opendir(context.folder);let scanned=0;
    try{for await(const entry of directory){
      context.guard();if(++scanned>LIMIT.scan)fail('capacity','账户文件数量超过本次发现范围，未截断为完整目录');
      const match=pattern.exec(entry.name);if(!match||match[1]&&query.version===1||match[2]<=(query.cursor?.after||''))continue;
      if(!entry.isFile()||entry.isSymbolicLink())fail('path','图库目录入口不是独立常规文件');
      // Only keep this page plus one sentinel, not every native filename.
      selected.push({key:match[2],slot:`gallery-source${match[1]||''}-${match[2]}`});selected.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);if(selected.length>query.limit+1)selected.pop();
    }}finally{try{await directory.close();}catch(error){if(error.code!=='ERR_DIR_CLOSED')throw error;}}
    if(stamp(await roots(context))!==generation)fail('stale','图库目录扫描期间已变化，请刷新列表');
    const entries=[];
    for(const {key,slot} of selected.slice(0,query.limit)){
      const base=`qianmu-v2-${context.scope}-${slot}`,head=await read(context,`${base}.json`,4096),pointer=head.value;
      if(!exact(pointer,['schema','scope','slot','fingerprint'])||pointer.schema!=='qianmu.st-account-head.v1'||pointer.scope!==context.scope||pointer.slot!==slot
        ||typeof pointer.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(pointer.fingerprint))fail('content','图库目录入口校验失败');
      const body=await read(context,`${base}-${pointer.fingerprint}.json`,12288),document=body.value;
      if(sha(body.text)!==pointer.fingerprint||!exact(document,['schema','scope','slot','value'])||document.schema!=='qianmu.st-account-document.v1'
        ||document.scope!==context.scope||document.slot!==slot)fail('content','图库目录正文校验失败');
      if((await read(context,`${base}.json`,4096)).text!==head.text)fail('changed','图库目录入口读取期间已变化');
      entries.push({key,value:document.value});context.guard();
    }
    const nextCursor=selected.length>query.limit?{version:query.version,account:context.account.namespace,stamp:generation,after:entries.at(-1).key}:null;
    const result=await galleryDiscoveryResponse({ok:true,version:query.version,expectedAccount:context.account.namespace,entries,nextCursor,proof:'read-only-directory'},
      {namespace:context.namespace,request:query});
    if(stamp(await roots(context))!==generation)fail('stale','图库目录返回前已变化，请刷新列表');context.guard();return result;
  }
  return Object.freeze({list(req,input,{signal}={}){
    if(closed||pending.size>=LIMIT.pending)return Promise.reject(galleryDiscoveryError('busy','图库发现服务正忙或已关闭',503));
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    let rejectStop;const stopped=new Promise((_,reject)=>{rejectStop=reject;}),stop=()=>{controller.abort();rejectStop(galleryDiscoveryError('changed','图库发现已取消或超时'));};
    controller.signal.addEventListener('abort',()=>rejectStop(galleryDiscoveryError('changed','图库发现已取消或超时')),{once:true});
    const timer=setTimeout(stop,timeoutMs);pending.add(stop);
    const work=inspect(req,input,controller.signal);
    // A timed-out filesystem call can still be alive. Keep its queue slot until
    // cleanup actually settles; repeated retries must not multiply hung I/O.
    void work.finally(()=>pending.delete(stop)).catch(()=>{});
    return Promise.race([work,stopped]).catch(error=>{
      if(/^gallery_discovery_/.test(error?.code||''))throw error;
      if(error?.code==='ENOENT')fail('missing','图库目录文件不存在或已移动，未作为空库',404);
      fail('unavailable','图库目录暂不可读取，原文件未修改',503);
    }).finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();});
  },async close(){closed=true;for(const stop of pending)stop();}});
}
