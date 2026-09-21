// Server-only, add-only original copies. No startup I/O, network, public paths,
// deletion or rename-over. File fsync/readback is not a whole-asset prune receipt.
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {imageServiceAccount,imageServiceAccountStillMatches} from './qianmu-image-service-access.js';
import {IMAGE_RESTORE_MAX_BYTES} from './qianmu-image-restore-contract.js';
import {comfyReferenceStillMime} from './qianmu-comfy-results.js';

export const GALLERY_ORIGINAL_STORE_LIMITS=Object.freeze({bytes:IMAGE_RESTORE_MAX_BYTES,pending:2,bucketFiles:4096,
    reserveBytes:64*1024*1024,chunkBytes:64*1024,timeoutMs:30000});
const LIMIT=GALLERY_ORIGINAL_STORE_LIMITS,folderName='.qianmu-originals-v1';
const fail=(code,message,status=409)=>{throw Object.assign(Error(message),{code:'gallery_original_store_'+code,status});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const id=/^[a-f0-9]{64}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const absolute=value=>typeof value==='string'&&path.isAbsolute(value)&&!value.includes('\0');
const child=(root,target)=>{const relative=path.relative(root,target);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const same=(a,b)=>typeof a?.ino==='bigint'&&a.ino>0n&&typeof a.dev==='bigint'&&a.dev>=0n&&a.ino===b?.ino&&a.dev===b.dev;
const unchanged=(a,b)=>same(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&b.isFile()&&!b.isSymbolicLink()&&b.nlink===1n;
export function galleryOriginalReference(value){
    if(!exact(value,['version','id','sha256','bytes','mime'])||value.version!==1||!id.test(value.id)||!(/^[a-f0-9]{64}$/).test(value.sha256)
        ||!value.id.startsWith(value.sha256+'-')||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>LIMIT.bytes
        ||!['image/png','image/jpeg','image/webp'].includes(value.mime))fail('reference','原图副本引用无效，未猜测磁盘位置',400);
    return Object.freeze({...value});
}
function captureBytes(value){
    if(!exact(value,['bytes','sha256','mime'])||!Buffer.isBuffer(value.bytes)||value.bytes.length<1||value.bytes.length>LIMIT.bytes)
        fail('content','原图副本只接受完整的受限静帧字节',400);
    // Own the bytes across awaits; a caller must not mutate the future file.
    const bytes=Buffer.from(value.bytes);let mime;
    try{mime=comfyReferenceStillMime(bytes);}catch{fail('content','原图副本不是支持的完整静帧容器',400);}
    const hash=sha(bytes);if(hash!==value.sha256||mime!==value.mime)fail('content','原图字节与摘要或格式不一致',400);
    return {bytes,sha256:hash,mime};
}

export function createGalleryOriginalStore({dataRoot,io=fs,timeoutMs=LIMIT.timeoutMs}={}){
    if(!absolute(dataRoot)||path.resolve(dataRoot)===path.parse(dataRoot).root||!Number.isFinite(timeoutMs))fail('setup','原图副本缺少可信的 ST 数据目录',503);
    const configuredRoot=path.resolve(dataRoot),pending=new Set(),writing=new Set(),aborters=new Set();let closed=false;
    const stat=file=>io.lstat(file,{bigint:true});
    function capture(req,expectedAccount,hash,signal){
        let account;try{account=imageServiceAccount(req);}catch{fail('account','请先登录 ST 账户读取原图副本',401);}
        if(account.namespace!==expectedAccount)fail('account','原图副本账户已变化',401);
        const original=req.user?.directories?.root;
        if(!absolute(original)||!child(configuredRoot,path.resolve(original)))fail('path','原图副本目录不属于当前账户');
        const root=path.resolve(original),folder=path.join(root,folderName),bucket=path.join(folder,hash.slice(0,2));
        const context={account,root,folder,bucket,identities:new Map(),guard(){
            if(closed||signal.aborted||!imageServiceAccountStillMatches(req,account)||req.user?.directories?.root!==original)
                fail('changed','原图副本操作已取消或账户目录变化，未确认保存');
        }};context.guard();return context;
    }
    async function roots(context,create=false){
        context.guard();let cursor=configuredRoot;const folders=[cursor];
        for(const part of path.relative(configuredRoot,context.root).split(path.sep)){cursor=path.join(cursor,part);folders.push(cursor);}
        for(const folder of [...folders,context.folder,context.bucket]){
            context.guard();
            if(create&&(folder===context.folder||folder===context.bucket)){
                try{await io.mkdir(folder,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}context.guard();
            }
            const current=await stat(folder);context.guard();
            if(!current.isDirectory()||current.isSymbolicLink()||path.resolve(await io.realpath(folder))!==folder
                ||context.identities.has(folder)&&!same(context.identities.get(folder),current))fail('path','原图副本目录为链接或已被替换');
            context.identities.set(folder,current);context.guard();
        }
    }
    async function inspect(context,ref,returnBytes=false,synchronize=false){
        await roots(context);const target=path.join(context.bucket,ref.id+'.bin'),before=await stat(target);context.guard();
        if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n)fail('path','原图副本不是独立普通文件');
        if(before.size!==BigInt(ref.bytes))fail('corrupt','原图副本长度不符，未覆盖或删除');
        let handle;
        try{
            // Windows fsync requires a writable handle, but this branch never
            // writes bytes. Reused files can be complete leftovers of a failed
            // sync; verify AND sync them before acknowledging preservation.
            handle=await io.open(target,(synchronize?constants.O_RDWR:constants.O_RDONLY)|(constants.O_NOFOLLOW||0));context.guard();
            const opened=await handle.stat({bigint:true});context.guard();if(!unchanged(before,opened))fail('changed','原图副本在打开时变化');
            const buffer=Buffer.alloc(returnBytes?ref.bytes+1:Math.min(ref.bytes+1,LIMIT.chunkBytes)),hash=createHash('sha256');let length=0;
            while(length<=ref.bytes){
                const offset=returnBytes?length:0,want=Math.min(LIMIT.chunkBytes,ref.bytes+1-length,buffer.length-offset);
                context.guard();const result=await handle.read(buffer,offset,want,length);context.guard();
                if(!Number.isSafeInteger(result.bytesRead)||result.bytesRead<0||result.bytesRead>want)fail('corrupt','原图副本读取长度无效');
                if(!result.bytesRead)break;hash.update(buffer.subarray(offset,offset+result.bytesRead));length+=result.bytesRead;
            }
            const after=await handle.stat({bigint:true});context.guard();await roots(context);const current=await stat(target);context.guard();
            if(length!==ref.bytes||!unchanged(opened,after)||!unchanged(after,current)||hash.digest('hex')!==ref.sha256)
                fail('corrupt','原图副本完整校验失败，未修改原文件');
            if(synchronize){await handle.sync();context.guard();await roots(context);if(!unchanged(after,await stat(target)))fail('changed','原图副本在同步期间变化');context.guard();}
            if(returnBytes){
                const bytes=buffer.subarray(0,length);let mime;try{mime=comfyReferenceStillMime(bytes);}catch{fail('corrupt','原图副本不再是完整静帧容器');}
                if(mime!==ref.mime)fail('corrupt','原图副本格式不符');return bytes;
            }
            return true;
        }finally{await handle?.close();}
    }
    async function add(context,content){
        await roots(context,true);let count=0;const matches=[];
        const directory=await io.opendir(context.bucket);
        try{
            context.guard();
            for await(const entry of directory){
                context.guard();if(++count>LIMIT.bucketFiles)fail('capacity','原图分区达到检查上限，未清理任何原件',507);
                if(!entry.isFile()||entry.isSymbolicLink()||!entry.name.endsWith('.bin')||!id.test(entry.name.slice(0,-4))
                    ||!entry.name.startsWith(path.basename(context.bucket)))fail('path','原图分区存在未知文件、链接或目录');
                if(entry.name.startsWith(content.sha256+'-'))matches.push(entry.name.slice(0,-4));
            }
        }finally{try{await directory.close();}catch(error){if(error.code!=='ERR_DIR_CLOSED')throw error;}}
        // Only matching hashes are opened. A new picture never stats/reads the
        // rest of the library; the bounded directory iterator sees one bucket.
        for(const candidate of matches){
            const ref=galleryOriginalReference({version:1,id:candidate,sha256:content.sha256,bytes:content.bytes.length,mime:content.mime});
            try{await inspect(context,ref,false,true);context.guard();await syncFolder(context);return ref;}
            catch(error){if(error.code!=='gallery_original_store_corrupt')throw error;}
        }
        if(count>=LIMIT.bucketFiles)fail('capacity','原图分区达到容量上限，未自动清理',507);
        await roots(context);const free=await io.statfs(context.bucket,{bigint:true});context.guard();
        if(typeof free?.bavail!=='bigint'||typeof free?.bsize!=='bigint'||free.bsize<=0n||free.bavail<0n
            ||free.bavail*free.bsize<BigInt(LIMIT.reserveBytes+content.bytes.length))fail('space','服务器可用空间不足以安全保存原图副本，原件保留',507);
        await roots(context);const ref=galleryOriginalReference({version:1,id:content.sha256+'-'+randomUUID(),sha256:content.sha256,bytes:content.bytes.length,mime:content.mime});
        const target=path.join(context.bucket,ref.id+'.bin');let handle;
        try{
            handle=await io.open(target,'wx',0o600);context.guard();
            const opened=await handle.stat({bigint:true});context.guard();await roots(context);const current=await stat(target);context.guard();
            if(!unchanged(opened,current)||opened.size!==0n)fail('changed','待保存的原图副本已变化');
            let offset=0;
            while(offset<content.bytes.length){
                const want=Math.min(LIMIT.chunkBytes,content.bytes.length-offset);context.guard();
                const result=await handle.write(content.bytes,offset,want,offset);context.guard();
                if(!Number.isSafeInteger(result.bytesWritten)||result.bytesWritten<1||result.bytesWritten>want)fail('write','原图副本写入不完整，未确认保存');
                offset+=result.bytesWritten;
            }
            await handle.sync();context.guard();
        }finally{await handle?.close();}
        await syncFolder(context);
        await inspect(context,ref);context.guard();return ref;
    }
    async function syncFolder(context){
        if(process.platform==='win32')return;
        await roots(context);const folder=await io.open(context.bucket,'r');
        try{context.guard();await folder.sync();context.guard();}finally{await folder.close();}
    }
    function run(req,expectedAccount,raw,{signal}={},write){
        const controller=new AbortController();let context,input;
        try{
            if(closed||signal?.aborted)fail('changed','原图副本操作已取消');
            if(pending.size>=LIMIT.pending)fail('busy','原图副本操作正忙，请稍后重试',429);
            // Validate account before copying up to 24 MiB of caller bytes.
            const account=imageServiceAccount(req);if(account.namespace!==expectedAccount)fail('account','原图副本账户已变化',401);
            if(write&&writing.has(account.namespace))fail('busy','当前账户正在保存原图副本',429);
            input=write?captureBytes(raw):galleryOriginalReference(raw);
            context=capture(req,expectedAccount,input.sha256,controller.signal);
        }catch(error){return Promise.reject(String(error?.code||'').startsWith('gallery_original_store_')?error:
            Object.assign(Error('原图副本账户或输入无效'),{code:'gallery_original_store_request',status:400}));}
        if(write)writing.add(context.account.namespace);
        let reject;const cancelled=new Promise((_,no)=>{reject=no;});
        const abort=()=>{controller.abort();reject(Object.assign(Error('原图副本操作已取消或超时，原资料未改动'),{code:'gallery_original_store_cancelled',status:409}));};
        aborters.add(abort);signal?.addEventListener('abort',abort,{once:true});
        const timer=setTimeout(abort,Math.max(100,Math.min(60000,timeoutMs)));
        const task=Promise.resolve().then(()=>write?add(context,input):inspect(context,input,true)).catch(error=>{
            context.guard();if(String(error?.code||'').startsWith('gallery_original_store_'))throw error;
            if(error?.code==='ENOENT')fail('missing','原图副本不存在，原引用保留',404);
            if(error?.code==='ENOSPC')fail('space','服务器空间不足，未确认副本，原件保留',507);
            fail('storage','原图副本保存或读取未确认，请保留原资料后重试',503);
        }).finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);aborters.delete(abort);pending.delete(task);if(write)writing.delete(context.account.namespace);});
        pending.add(task);
        // Timed-out filesystem operations keep their slot/account lock until
        // settled. Late handles are closed and no late receipt is published.
        return Promise.race([task,cancelled]);
    }
    return Object.freeze({put:(req,expectedAccount,content,options)=>run(req,expectedAccount,content,options,true),
        get:(req,expectedAccount,reference,options)=>run(req,expectedAccount,reference,options,false),
        async close(){closed=true;for(const abort of aborters)abort();await Promise.allSettled([...pending]);}});
}
