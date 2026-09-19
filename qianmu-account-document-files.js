import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const sha = text => createHash('sha256').update(text).digest('hex');
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key=>keys.includes(key));
const sameFile = (a,b) => a?.ino > 0n && a?.dev >= 0n && a.ino === b?.ino && a.dev === b?.dev;
const sameVersion = (a,b) => sameFile(a,b) && a.size === b.size && a.mtimeNs === b.mtimeNs;
const child = (root,target) => {const relative=path.relative(root,target);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const localProcessStatus = pid => {try{process.kill(pid,0);return 'alive';}catch(error){return error?.code==='ESRCH'?'dead':'unknown';}};

// Internal file transactions shared by account-scoped originals. Callers own schema and authorization.
// No user-supplied filenames or paths may reach this factory. Existing files are never auto-repaired.
export function createAccountDocumentFiles({root,filename,lockname,temporaryPrefix,bytes,errorFactory,label,validate,empty,io=fs,processStatus=localProcessStatus}={}) {
  if(typeof root!=='string'||!path.isAbsolute(root)||root.includes('\0')||path.resolve(root)===path.parse(root).root
    ||![filename,lockname,temporaryPrefix].every(value=>typeof value==='string'&&/^\.[a-z0-9][a-z0-9.-]*$/.test(value))
    ||filename===lockname||!Number.isSafeInteger(bytes)||bytes<1||typeof errorFactory!=='function'||typeof label!=='string'||!label
    ||typeof validate!=='function'||typeof empty!=='function'||typeof processStatus!=='function')throw new TypeError('Invalid account document storage configuration');
  root=path.resolve(root);
  const fail=(code,message,status)=>{throw errorFactory(code,message.replaceAll('账户资料',label),status);};
  const contractCode=errorFactory('contract','',400).code,stat=file=>io.lstat(file,{bigint:true});
  async function checkedRoots(context,authorize=true) {
    if(typeof context?.folder!=='string'||!path.isAbsolute(context.folder)||!child(root,context.folder))fail('path','账户资料目录不属于可信数据范围',403);
    if(authorize)context.guard();let cursor=root;
    const directories=[cursor];for(const segment of path.relative(root,context.folder).split(path.sep)){cursor=path.join(cursor,segment);directories.push(cursor);}
    for(const directory of directories){
      const before=await stat(directory),prior=context.roots.get(directory);
      if(!before.isDirectory()||before.isSymbolicLink()||path.resolve(await io.realpath(directory))!==directory||prior&&!sameFile(before,prior))fail('path','账户资料目录为链接或已变化，未继续操作',409);
      context.roots.set(directory,before);if(authorize)context.guard();
    }
  }
  async function read(context) {
    await checkedRoots(context);const target=path.join(context.folder,filename);let before;
    try{before=await stat(target);}catch(error){if(error?.code==='ENOENT'){await checkedRoots(context);return {state:empty(context),fingerprint:null};}throw error;}
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size<1n||before.size>BigInt(bytes))fail('corrupt','账户资料文件为链接、非常规文件或超出安全读取上限，未覆盖',503);
    const handle=await io.open(target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try{
      const opened=await handle.stat({bigint:true});if(!sameVersion(before,opened)||opened.nlink!==1n)fail('changed','账户资料在读取时已变化，请重新同步');
      const buffer=Buffer.alloc(Number(opened.size)+1);let length=0;
      while(length<buffer.length){context.guard();const result=await handle.read(buffer,length,buffer.length-length,length);if(!result.bytesRead)break;length+=result.bytesRead;}
      const after=await handle.stat({bigint:true}),current=await stat(target);
      if(BigInt(length)!==opened.size||!sameVersion(opened,after)||!sameVersion(after,current)||!current.isFile()||current.isSymbolicLink()||current.nlink!==1n)fail('changed','账户资料在核对期间已变化，请重新同步');
      let raw;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length)));}catch(_){fail('corrupt','账户资料文件无法完整读取，请保留原文件核对',503);}
      let state;try{state=validate(raw,context);}catch(error){if(error?.code===contractCode)fail('corrupt','账户资料文件内容或保存凭据损坏，未覆盖原文件',503);throw error;}
      await checkedRoots(context);return {state,fingerprint:current};
    }finally{await handle.close();}
  }
  async function syncFolder(context){if(process.platform==='win32')return;const handle=await io.open(context.folder,'r');try{await handle.sync();}finally{await handle.close();}}
  async function targetUnchanged(context,prior){
    const target=path.join(context.folder,filename);let current;
    try{current=await stat(target);}catch(error){if(error?.code==='ENOENT'&&!prior)return;throw error;}
    if(!prior||!sameVersion(current,prior)||!current.isFile()||current.isSymbolicLink()||current.nlink!==1n)fail('changed','账户资料已由其他操作更改，未覆盖');
  }
  async function writeAtomic(context,state,prior){
    const json=JSON.stringify(state),body=JSON.stringify({...state,checksum:sha(json)});
    if(Buffer.byteLength(body)>bytes)fail('capacity','账户资料同步库已达安全容量上限，未截断或清理任何内容',507);
    const temporary=path.join(context.folder,`${temporaryPrefix}${randomUUID()}.tmp`);let handle,identity,renamed=false;
    try{
      await checkedRoots(context);handle=await io.open(temporary,'wx',0o600);identity=await handle.stat({bigint:true});
      await handle.writeFile(body);await handle.sync();identity=await handle.stat({bigint:true});await handle.close();handle=null;
      await checkedRoots(context);await targetUnchanged(context,prior);
      const staged=await stat(temporary);
      if(!sameVersion(identity,staged)||!staged.isFile()||staged.isSymbolicLink()||staged.nlink!==1n)fail('changed','待保存账户资料文件已变化，未替换原文',503);
      context.guard();
      context.writeState='unconfirmed';await io.rename(temporary,path.join(context.folder,filename));renamed=true;await syncFolder(context);
      const confirmed=await read(context);
      if(JSON.stringify(confirmed.state)!==json)fail('changed','账户资料写入尚未确认，请保留本机内容后重试',503);
    }finally{
      if(handle)await handle.close();
      if(identity&&!renamed){
        await checkedRoots(context,false);
        try{const current=await stat(temporary);if(!sameFile(identity,current)||!current.isFile()||current.isSymbolicLink()||current.nlink!==1n)fail('path','账户资料临时文件发生变化，未清理',503);await io.unlink(temporary);}
        catch(error){if(error?.code!=='ENOENT')throw error;}
      }
    }
  }
  async function occupiedLock(context,file){
    // Do not auto-unlink even a dead PID: stat+unlink is not an atomic identity-conditional delete.
    // Another ST process could replace the lock between those calls. Preserve originals and report the precise condition.
    await checkedRoots(context);let before;
    try{before=await stat(file);}catch(error){if(error?.code==='ENOENT')fail('busy','账户资料保存锁刚刚变化，请重新同步',423);throw error;}
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>512n)fail('lock_unverifiable','账户资料保存锁异常，已保留原文；请由服务器管理员核对后恢复',503);
    if(before.size===0n)fail('busy','账户资料保存锁正在初始化或曾异常中断；如持续不可用，请核对服务器保存锁',423);
    const handle=await io.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try{
      const opened=await handle.stat({bigint:true});if(!sameVersion(before,opened)||opened.nlink!==1n)fail('busy','账户资料保存锁正在变化，请重新同步',423);
      const buffer=Buffer.alloc(513);let length=0;
      while(length<buffer.length){context.guard();const chunk=await handle.read(buffer,length,buffer.length-length,length);if(!chunk.bytesRead)break;length+=chunk.bytesRead;}
      let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length)));}catch(_){fail('lock_unverifiable','账户资料保存锁无法识别，已保留原文；请由服务器管理员核对后恢复',503);}
      if(BigInt(length)!==opened.size||!fields(value,['version','owner','pid'])||value.version!==1||typeof value.owner!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.owner)
        ||!Number.isSafeInteger(value.pid)||value.pid<1||value.pid>0x7fffffff)fail('lock_unverifiable','账户资料保存锁格式未知，已保留原文；请由服务器管理员核对后恢复',503);
      const status=await processStatus(value.pid),after=await handle.stat({bigint:true}),current=await stat(file);
      await checkedRoots(context);
      if(!sameVersion(opened,after)||!sameVersion(after,current)||!current.isFile()||current.isSymbolicLink()||current.nlink!==1n)fail('busy','账户资料保存锁已变化，未自动清理，请重新同步',423);
      if(status==='dead')fail('stale_lock','检测到上次中断留下的账户资料保存锁；已保留原文，请由服务器管理员核对后恢复',503);
      if(status!=='alive')fail('lock_unverifiable','无法确认账户资料保存进程状态，已保留原文；请由服务器管理员核对后恢复',503);
      fail('busy','账户资料正在其他设备保存，请稍后重试',423);
    }finally{await handle.close();}
  }
  async function exclusive(context,operation){
    await checkedRoots(context);const file=path.join(context.folder,lockname);let handle,identity;
    try{handle=await io.open(file,'wx',0o600);}catch(error){if(error?.code==='EEXIST')return occupiedLock(context,file);throw error;}
    try{identity=await handle.stat({bigint:true});await handle.writeFile(JSON.stringify({version:1,owner:randomUUID(),pid:process.pid}));return await operation();}
    finally{
      await handle.close();await checkedRoots(context,false);const current=await stat(file);
      if(!sameFile(identity,current)||!current.isFile()||current.isSymbolicLink()||current.nlink!==1n)fail('path','账户资料保存锁发生变化，请保留文件核对',503);
      await io.unlink(file);
    }
  }
  return Object.freeze({read,writeAtomic,exclusive});
}
