// Private, add-only immutable files. No startup writes, rename-over, original deletion or public image paths.
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {imageServiceAccount,imageServiceAccountStillMatches} from './qianmu-image-service-access.js';
import {RECIPE_ARCHIVE_LIMITS as LIMIT,recipeArchiveError,recipeArchiveEnvelope,recipeArchiveReference} from './qianmu-recipe-archive-contract.js';

const folderName='.qianmu-recipes-v1',sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,message,status)=>{throw recipeArchiveError(code,message,status);};
const child=(base,target)=>{const relative=path.relative(base,target);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const sameFile=(a,b)=>a?.ino>0n&&a.dev>=0n&&a.ino===b?.ino&&a.dev===b.dev;
const unchanged=(a,b)=>sameFile(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&b.nlink===1n&&b.isFile()&&!b.isSymbolicLink();

export function createRecipeArchiveStore({dataRoot,io=fs}={}){
  if(typeof dataRoot!=='string'||!path.isAbsolute(dataRoot)||dataRoot.includes('\0')||path.resolve(dataRoot)===path.parse(dataRoot).root)fail('setup','配方保全缺少可信的 ST 数据目录',503);
  const root=path.resolve(dataRoot),pending=new Set(),writing=new Set(),stat=file=>io.lstat(file,{bigint:true});let closed=false;
  function capture(req,expectedAccount,signal){
    let account;try{account=imageServiceAccount(req);}catch{fail('account','请先登录 ST 账户保全配方',401);}
    const original=req.user?.directories?.root;
    if(account.namespace!==expectedAccount)fail('account','配方保全账户已变化',401);
    if(typeof original!=='string'||!path.isAbsolute(original)||original.includes('\0'))fail('path','ST 未提供可信的账户目录',503);
    const accountRoot=path.resolve(original),folder=path.join(accountRoot,folderName);
    if(!child(root,accountRoot))fail('path','配方目录不属于当前账户',403);
    const context={account,folder,accountRoot,roots:new Map(),guard(){
      if(closed||signal?.aborted||!imageServiceAccountStillMatches(req,account)||req.user?.directories?.root!==original)fail('changed','配方保全已取消或账户目录变化，请保留原副本');
    }};context.guard();return context;
  }
  async function roots(context,create=false,includeFolder=true){
    context.guard();let cursor=root;const directories=[cursor];
    for(const part of path.relative(root,context.accountRoot).split(path.sep)){cursor=path.join(cursor,part);directories.push(cursor);}
    for(const directory of [...directories,...(includeFolder?[context.folder]:[])]){
      if(directory===context.folder&&create){context.guard();try{await io.mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}}
      const current=await stat(directory),prior=context.roots.get(directory);
      if(!current.isDirectory()||current.isSymbolicLink()||path.resolve(await io.realpath(directory))!==directory||prior&&!sameFile(prior,current))fail('path','配方目录为链接或已被替换，未继续操作');
      context.roots.set(directory,current);context.guard();
    }
  }
  async function storage(context){
    // Count every regular file, including interrupted/unreferenced versions. No
    // content reads, attribution guesses, repair, mkdir, deletion or symlink following.
    await roots(context,false,false);
    try{await roots(context);}catch(error){
      if(error.code!=='ENOENT')throw error;
      await roots(context,false,false);
      try{await stat(context.folder);}catch(missing){if(missing.code==='ENOENT'){context.guard();return {state:'absent',files:0,bytes:0};}throw missing;}
      fail('changed','配方目录在盘点期间出现，请重新读取');
    }
    const before=await stat(context.folder),files=new Map();let bytes=0;
    const directory=await io.opendir(context.folder);
    for await(const item of directory){
      context.guard();if(files.size>=LIMIT.files||files.has(item.name))fail('capacity','配方目录超过可完整盘点的数量上限，未返回部分合计',507);
      const current=await stat(path.join(context.folder,item.name));
      if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1n||current.size<0n||current.size>BigInt(Number.MAX_SAFE_INTEGER))fail('path','配方目录含链接、子目录或不支持的文件，未返回不完整占用');
      bytes+=Number(current.size);if(!Number.isSafeInteger(bytes))fail('capacity','配方占用超出可精确计值的范围',507);
      files.set(item.name,current);
    }
    await roots(context);
    for(const [name,prior] of files){context.guard();if(!unchanged(prior,await stat(path.join(context.folder,name))))fail('changed','配方文件在盘点期间变化，请重读');}
    await roots(context);const after=await stat(context.folder);
    if(!sameFile(before,after)||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)fail('changed','配方目录在盘点期间变化，请重读');
    context.guard();return {state:'present',files:files.size,bytes};
  }
  async function read(context,reference){
    const ref=recipeArchiveReference(reference);await roots(context);const target=path.join(context.folder,ref.id+'.json'),before=await stat(target);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size!==BigInt(ref.bytes))fail('corrupt','原配方文件不完整或为链接，未读取或覆盖');
    const handle=await io.open(target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try{
      context.guard();const opened=await handle.stat({bigint:true});if(!unchanged(before,opened))fail('changed','配方读取前已变化');
      const bytes=Buffer.alloc(ref.bytes+1);let length=0;
      while(length<bytes.length){context.guard();const result=await handle.read(bytes,length,bytes.length-length,length);if(!result.bytesRead)break;length+=result.bytesRead;}
      const after=await handle.stat({bigint:true}),current=await stat(target);await roots(context);
      if(length!==ref.bytes||!unchanged(opened,after)||!unchanged(after,current)||sha(bytes.subarray(0,length))!==ref.sha256)fail('corrupt','配方文件校验失败，未修改原件');
      let parsed;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length)));}catch{fail('corrupt','配方文件不是完整 JSON');}
      const envelope=recipeArchiveEnvelope(parsed);if(envelope.value.expectedAccount!==context.account.namespace||envelope.text!==bytes.subarray(0,length).toString('utf8'))fail('corrupt','配方账户或完整内容不符');
      context.guard();return envelope.value;
    }finally{await handle.close();}
  }
  async function add(context,envelope){
    const {text}=recipeArchiveEnvelope(envelope),bytes=Buffer.byteLength(text),hash=sha(text);
    if(envelope.expectedAccount!==context.account.namespace)fail('account','配方内容属于另一账户',401);
    await roots(context,true);let count=0,total=0;const directory=await io.opendir(context.folder);
    for await(const item of directory){
      context.guard();if(++count>LIMIT.files)fail('capacity','配方库数量超过安全检查上限，请先保全原资料',507);
      const file=await stat(path.join(context.folder,item.name));
      if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1n)fail('path','配方目录存在链接或未知子目录，未继续写入');
      total+=Number(file.size);if(total>LIMIT.totalBytes)fail('capacity','配方库达到安全容量上限，未自动清理原件',507);
      if(item.name.startsWith(hash+'-')&&item.name.endsWith('.json')){
        const ref={version:1,id:item.name.slice(0,-5),sha256:hash,bytes};
        // Interrupted, unacknowledged files remain untouched. Only a fully verified file is reusable.
        try{const existing=await read(context,ref);if(recipeArchiveEnvelope(existing).text===text)return ref;}
        catch(error){if(!['recipe_archive_corrupt','recipe_archive_reference'].includes(error.code))throw error;}
      }
    }
    if(count>=LIMIT.files||total+bytes>LIMIT.totalBytes)fail('capacity','配方库达到安全容量上限，原聊天副本保留',507);
    await roots(context);const ref={version:1,id:hash+'-'+randomUUID(),sha256:hash,bytes},target=path.join(context.folder,ref.id+'.json');
    // The unpredictable reference is published only after fsync and readback. A crash leaves
    // an unreferenced file, never a replacement of a previously acknowledged recipe.
    const handle=await io.open(target,'wx',0o600);
    try{
      const opened=await handle.stat({bigint:true});await roots(context);const current=await stat(target);
      if(!unchanged(opened,current))fail('changed','待保存配方文件已变化，未继续写入');
      context.guard();await handle.writeFile(text);await handle.sync();context.guard();
    }finally{await handle.close();}
    if(process.platform!=='win32'){const folder=await io.open(context.folder,'r');try{await folder.sync();}finally{await folder.close();}}
    await read(context,ref);context.guard();return ref;
  }
  function run(req,expectedAccount,input,options,write,summary=false){
    let context;try{context=capture(req,expectedAccount,options?.signal);if(pending.size>=LIMIT.pending)fail('busy','配方保全正忙，请稍后重试',429);
      if((write||summary)&&writing.has(context.account.namespace))fail('busy','当前账户正在保全另一份配方，请稍后重试',429);
    }catch(error){return Promise.reject(error);}
    if(write)writing.add(context.account.namespace);
    const task=(async()=>{try{return await (summary?storage(context):write?add(context,input):read(context,input));}catch(error){
      context.guard();if(String(error?.code||'').startsWith('recipe_archive_'))throw error;
      if(error?.code==='ENOENT')fail('missing','服务器配方原件不存在，原引用保留',404);
      fail('storage','配方保存或读取未确认，已保留原聊天及旧归档',503);
    }})();pending.add(task);void task.finally(()=>{pending.delete(task);if(write)writing.delete(context.account.namespace);}).catch(()=>{});return task;
  }
  return Object.freeze({put:(req,envelope,options)=>run(req,envelope?.expectedAccount,envelope,options,true),
    get:(req,expectedAccount,reference,options)=>run(req,expectedAccount,reference,options,false),
    usage:(req,expectedAccount,options)=>run(req,expectedAccount,null,options,false,true),
    async close(){closed=true;await Promise.allSettled([...pending]);}});
}
