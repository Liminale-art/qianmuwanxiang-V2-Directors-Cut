// Server-only, selected original bytes. No network, writes, public routes or
// persistence claims. The eventual archive writer must verify the returned bytes
// again before publishing its own durable receipt.
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createChatCharacterReceiptService} from './qianmu-chat-character-receipt-service.js';
import {chatGalleryRecordRequest,chatGalleryRecordResponse} from './qianmu-chat-gallery-record.js';
import {imageServiceAccount,imageServiceAccountStillMatches} from './qianmu-image-service-access.js';
import {imageRestoreReceipt,IMAGE_RESTORE_MAX_BYTES} from './qianmu-image-restore-contract.js';
import {comfyReferenceStillMime} from './qianmu-comfy-results.js';

export const GALLERY_ORIGINAL_SOURCE_LIMITS=Object.freeze({bytes:IMAGE_RESTORE_MAX_BYTES,pending:2,chunkBytes:64*1024,timeoutMs:30000});
const LIMIT=GALLERY_ORIGINAL_SOURCE_LIMITS;
const fail=(code,message,status=409)=>{throw Object.assign(Error(message),{code:'gallery_original_'+code,status});};
const child=(root,target)=>{const relative=path.relative(root,target);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const same=(a,b)=>typeof a?.ino==='bigint'&&a.ino>0n&&typeof a.dev==='bigint'&&a.dev>=0n&&a.ino===b?.ino&&a.dev===b.dev;
const unchanged=(a,b)=>same(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs
    &&b.isFile()&&!b.isSymbolicLink()&&b.nlink===1n;
const absolute=value=>typeof value==='string'&&path.isAbsolute(value)&&!value.includes('\0');

export function createGalleryOriginalSource({dataRoot,io=fs,timeoutMs=LIMIT.timeoutMs}={}){
    if(!absolute(dataRoot)||path.resolve(dataRoot)===path.parse(dataRoot).root||!Number.isFinite(timeoutMs))fail('setup','原图核验缺少可信的 ST 数据目录',503);
    const configuredRoot=path.resolve(dataRoot),source=createChatCharacterReceiptService({dataRoot,io});
    const pending=new Set(),controllers=new Set();let closed=false;
    const stat=file=>io.lstat(file,{bigint:true});
    function capture(req,input,signal){
        let account;try{account=imageServiceAccount(req);}catch{fail('account','请先登录 ST 账户核验原图',401);}
        if(account.namespace!==input.expectedAccount)fail('account','原图核验账户已变化',401);
        const keys=['root','userImages',input.target.kind==='group'?'groupChats':'chats'];
        const original=keys.map(key=>req.user?.directories?.[key]);
        if(!original.every(absolute))fail('path','ST 未提供完整的当前账户目录');
        const root=path.resolve(original[0]),images=path.resolve(original[1]);
        if(!child(configuredRoot,root)||!child(root,images)||!child(root,path.resolve(original[2])))fail('path','原图或聊天不属于当前账户目录');
        function guard(){
            if(closed||signal.aborted||!imageServiceAccountStillMatches(req,account)||keys.some((key,index)=>req.user?.directories?.[key]!==original[index]))
                fail('changed','原图核验已取消或账户/聊天目录变化，未确认原件');
        }
        guard();return {images,guard,identities:new Map()};
    }
    async function saved(req,input,context,signal){
        context.guard();let result;
        try{result=chatGalleryRecordResponse(await source.readGalleryRecord(req,input,{signal}));}
        catch(error){
            const kind=String(error?.code||'').replace('chat_character_receipt_','');
            const messages={missing:'原聊天不存在或已移动，未猜测原图',record_missing:'原画面已不存在，未猜测原图',
                record_ambiguous:'原画面编号重复，无法确认原图来源',record_changed:'原聊天画面已变化，请重新核对',
                record_url:'原画面不是当前 ST 的可读取静帧，未请求外部链接'};
            fail('source',messages[kind]||'原聊天来源尚未完整核实，未读取或保存猜测的原图');
        }
        context.guard();
        if(result.expectedAccount!==input.expectedAccount||JSON.stringify(result.target)!==JSON.stringify(input.target)
            ||result.record.id!==input.selection.recordId||result.record.createdAt!==input.selection.createdAt||result.gallerySha256!==input.selection.gallerySha256)
            fail('source','原图返回的账户、聊天或画面不一致');
        return result.record;
    }
    async function roots(context,target){
        context.guard();let cursor=configuredRoot;const folders=[cursor];
        for(const part of path.relative(configuredRoot,path.dirname(target)).split(path.sep)){cursor=path.join(cursor,part);folders.push(cursor);}
        for(const folder of folders){
            const current=await stat(folder);context.guard();
            if(!current.isDirectory()||current.isSymbolicLink()||path.resolve(await io.realpath(folder))!==folder
                ||context.identities.has(folder)&&!same(context.identities.get(folder),current))fail('path','原图目录为链接或已被替换');
            context.identities.set(folder,current);context.guard();
        }
    }
    async function readBytes(context,target){
        await roots(context,target);const before=await stat(target);context.guard();
        if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||typeof before.size!=='bigint'||before.size<1n||before.size>BigInt(LIMIT.bytes))
            fail('file','原图为空、超过 24 MiB 或不是独立普通文件');
        let handle;
        try{
            handle=await io.open(target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));context.guard();
            const opened=await handle.stat({bigint:true});context.guard();if(!unchanged(before,opened))fail('changed','原图在打开时已变化');
            const buffer=Buffer.alloc(Number(before.size)+1),hash=createHash('sha256');let length=0;
            while(length<buffer.length){
                context.guard();const part=await handle.read(buffer,length,Math.min(LIMIT.chunkBytes,buffer.length-length),length);context.guard();
                if(!Number.isSafeInteger(part.bytesRead)||part.bytesRead<0||part.bytesRead>Math.min(LIMIT.chunkBytes,buffer.length-length))fail('file','原图读取不完整');
                if(!part.bytesRead)break;hash.update(buffer.subarray(length,length+part.bytesRead));length+=part.bytesRead;
            }
            const after=await handle.stat({bigint:true});context.guard();await roots(context,target);const current=await stat(target);context.guard();
            if(length!==Number(before.size)||!unchanged(opened,after)||!unchanged(after,current))fail('changed','原图在读取期间变化，未接受部分内容');
            const bytes=buffer.subarray(0,length);let mime;
            try{mime=comfyReferenceStillMime(bytes);}catch{fail('format','原图不是支持的完整静帧容器，未保全');}
            return {bytes,mime,sha256:hash.digest('hex'),file:after};
        }finally{await handle?.close();}
    }
    async function process(req,input,signal){
        const context=capture(req,input,signal),record=await saved(req,input,context,signal);
        // Validate portable recovery-safe path syntax before touching the image
        // filesystem. Placeholder digest/size only validate syntax, never escape.
        const extension=record.url.split('.').at(-1).toLowerCase(),mime=['jpg','jpeg'].includes(extension)?'image/jpeg':'image/'+extension;
        let location;try{location=imageRestoreReceipt({url:record.url,mime,bytes:1,sha256:'0'.repeat(64)}).url;}
        catch{fail('path','原图路径不兼容安全保全，请保留原文件');}
        const target=path.join(context.images,...location.slice('/user/images/'.length).split('/').map(decodeURIComponent));
        if(!child(context.images,target))fail('path','原图路径超出当前账户');
        const result=await readBytes(context,target);context.guard();
        if(result.mime!==mime)fail('format','原图扩展名与内容不符');
        const again=await saved(req,input,context,signal);context.guard();
        if(JSON.stringify(again)!==JSON.stringify(record))fail('source','读取期间原画面已变化');
        await roots(context,target);const current=await stat(target);context.guard();
        if(!unchanged(result.file,current))fail('changed','原图在来源复核时变化，未确认原件');
        const receipt=imageRestoreReceipt({url:location,mime,bytes:result.bytes.length,sha256:result.sha256});
        return Object.freeze({version:1,expectedAccount:input.expectedAccount,target:input.target,selection:input.selection,
            receipt,bytes:result.bytes,proof:'read-only-original-bytes',originalVerified:false,canPrune:false});
    }
    function read(req,raw,{signal}={}){
        let input;try{input=chatGalleryRecordRequest(raw);if(closed||signal?.aborted)fail('changed','原图核验已取消');
            if(pending.size>=LIMIT.pending)fail('busy','原图核验正忙，请稍后重试',429);
        }catch(error){return Promise.reject(String(error?.code||'').startsWith('gallery_original_')?error:Object.assign(Error('原图核验只接受准确聊天和画面选择'),{code:'gallery_original_request',status:400}));}
        const controller=new AbortController();let reject;
        const cancellation=new Promise((_,no)=>{reject=no;});
        const abort=()=>{controller.abort();reject(Object.assign(Error('原图核验已取消或超时，原资料未改动'),{code:'gallery_original_cancelled',status:409}));};
        controllers.add(abort);
        signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,Math.max(100,Math.min(60000,timeoutMs)));
        const operation=Promise.resolve().then(()=>process(req,input,controller.signal)).catch(error=>{
            if(String(error?.code||'').startsWith('gallery_original_'))throw error;
            fail(error?.code==='ENOENT'?'missing':'read',error?.code==='ENOENT'?'原图文件不存在，原记录仍保留':'原图读取未确认，请保留原资料后重试');
        }).finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);controllers.delete(abort);pending.delete(operation);});
        pending.add(operation);
        // A timed-out OS operation keeps its slot until it really finishes; its
        // late result is rejected by guard and its file handle is still closed.
        return Promise.race([operation,cancellation]);
    }
    return Object.freeze({read,async close(){closed=true;for(const abort of controllers)abort();await Promise.allSettled([source.close(),...pending]);}});
}
