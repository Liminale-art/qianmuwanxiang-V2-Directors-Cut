import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {imageServiceAccount,imageServiceAccountStillMatches} from './qianmu-image-service-access.js';
import {CHAT_CHARACTER_RECEIPT_LIMITS as LIMIT,chatCharacterReceiptError,chatCharacterReceiptRequest,
  chatCharacterReceiptResponse,chatCharacterCollectionReceiptText} from './qianmu-chat-character-receipt.js';
import {chatGalleryReceiptText,chatGalleryReceiptResponse} from './qianmu-chat-gallery-receipt.js';
import {chatGalleryRecordRequest,projectChatGalleryRecord,chatGalleryRecordResponse} from './qianmu-chat-gallery-record.js';
import {projectChatGalleryDetails,chatGalleryDetailsResponse} from './qianmu-chat-gallery-details.js';

const fail=(code,message,status)=>{throw chatCharacterReceiptError(code,message,status);};
const object=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const child=(root,target)=>{const relative=path.relative(root,target);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
const sameFile=(a,b)=>typeof a?.ino==='bigint'&&a.ino>0n&&typeof a.dev==='bigint'&&a.dev>=0n&&a.ino===b?.ino&&a.dev===b.dev;
const unchanged=(a,b)=>sameFile(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&b.nlink===1n&&b.isFile()&&!b.isSymbolicLink();

// Authenticated, bounded FIRST-LINE read only. No mkdir, chat writer, body scan, global library, or new storage.
export function createChatCharacterReceiptService({dataRoot,io=fs}={}){
  if(typeof dataRoot!=='string'||!dataRoot||dataRoot.includes('\0'))fail('setup','增强服务缺少可信的 ST 数据目录',503);
  const configuredRoot=path.resolve(dataRoot);
  if(configuredRoot===path.parse(configuredRoot).root)fail('setup','增强服务数据目录无效',503);
  let closed=false;const pending=new Set(),lstat=filename=>io.lstat(filename,{bigint:true});
  function capture(req,input,signal){
    let account;try{account=imageServiceAccount(req);}catch{fail('account','请先登录 ST 账户核验聊天',401);}
    const body=chatCharacterReceiptRequest(input);
    if(account.namespace!==body.expectedAccount)fail('account','聊天核验账户已变化',401);
    const originals={root:req.user?.directories?.root,base:req.user?.directories?.[body.target.kind==='group'?'groupChats':'chats']};
    if(Object.values(originals).some(value=>typeof value!=='string'||!value||value.includes('\0')))fail('setup','ST 尚未提供当前账户聊天目录',503);
    const root=path.resolve(originals.root),base=path.resolve(originals.base);
    if(!child(configuredRoot,root)||!child(root,base))fail('path','聊天目录不属于当前账户');
    const folder=body.target.kind==='group'?base:path.join(base,body.target.avatar.replace('.png',''));
    const context={body,account,folder,target:path.join(folder,body.target.chatId+'.jsonl'),directories:new Map(),
      owner:{namespace:`st-user:${req.user.profile.handle}`,chatKey:body.target.chatId},guard(){
        if(closed||signal?.aborted||!imageServiceAccountStillMatches(req,account)||req.user?.directories?.root!==originals.root
          ||req.user?.directories?.[body.target.kind==='group'?'groupChats':'chats']!==originals.base)fail('changed','聊天核验已取消或账户目录已变化');
      }};
    context.guard();return context;
  }
  async function checkedRoots(context){
    context.guard();let cursor=configuredRoot;const directories=[cursor];
    for(const part of path.relative(configuredRoot,context.folder).split(path.sep)){cursor=path.join(cursor,part);directories.push(cursor);}
    for(const directory of directories){
      const stat=await lstat(directory),prior=context.directories.get(directory);
      if(!stat.isDirectory()||stat.isSymbolicLink()||path.resolve(await io.realpath(directory))!==directory||prior&&!sameFile(prior,stat))fail('path','聊天目录为链接或已变化，未继续核验');
      context.directories.set(directory,stat);context.guard();
    }
  }
  async function readHeader(context){
    await checkedRoots(context);const before=await lstat(context.target);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n)fail('path','聊天记录不是独立常规文件，未核验');
    if(before.size<1n)fail('content','聊天记录为空，不能确认人物资料');
    const handle=await io.open(context.target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try{
      context.guard();const opened=await handle.stat({bigint:true});
      if(!unchanged(before,opened))fail('changed','聊天记录在读取前已变化，请重试');
      const chunks=[];let length=0,position=0,found=false;
      while(length<=LIMIT.headerBytes){
        context.guard();const buffer=Buffer.alloc(Math.min(16384,LIMIT.headerBytes+1-length));
        const {bytesRead}=await handle.read(buffer,0,buffer.length,position);context.guard();
        if(!bytesRead)break;
        position+=bytesRead;const data=buffer.subarray(0,bytesRead),end=data.indexOf(10),part=end<0?data:data.subarray(0,end);
        chunks.push(part);length+=part.length;if(end>=0){found=true;break;}
      }
      if(length>LIMIT.headerBytes)fail('size','聊天资料头超过核验上限，已停止核验，未裁剪资料');
      if(!found&&BigInt(position)!==opened.size)fail('changed','聊天记录读取不完整，请重试');
      const after=await handle.stat({bigint:true}),current=await lstat(context.target);
      if(!unchanged(opened,after)||!unchanged(after,current))fail('changed','聊天记录在核验期间已变化，请重试');
      await checkedRoots(context);context.guard();
      let header;try{header=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,length)).replace(/^\uFEFF/,''));}
      catch{fail('content','聊天资料头损坏，未按空记录处理');}
      if(!object(header)||!object(header.chat_metadata)||Object.hasOwn(header,'mes'))fail('content','聊天资料头不兼容，未按空记录处理');
      return header.chat_metadata;
    }finally{await handle.close();}
  }
  async function inspect(req,input,{signal}={},galleryOnly=false,selection=null,detailsOnly=false,recipeSource=false){
    const context=capture(req,input,signal);let metadata;
    try{metadata=await readHeader(context);}catch(error){
      if(error?.code==='ENOENT')fail('missing','原聊天记录不存在或已移动，未确认保存',404);
      throw error;
    }
    context.guard();let collection=null,gallery=null,records;
    if(Object.hasOwn(metadata,'story_director_liminale')){
      const store=metadata.story_director_liminale;
      if(!object(store))fail('content','千幕聊天资料损坏，请保全原记录');
      if(galleryOnly&&Object.hasOwn(store,'storyboardImages')){
        const {text,...fields}=chatGalleryReceiptText(store.storyboardImages);
        gallery={...fields,sha256:createHash('sha256').update(text).digest('hex')};
        records=store.storyboardImages;
      }
      if(!galleryOnly&&Object.hasOwn(store,'characterDrafts')){
        let summary;try{summary=chatCharacterCollectionReceiptText(store.characterDrafts,context.owner);}catch{fail('content','聊天人物资料版本、归属或内容不一致，请保全原记录');}
        const {text,...fields}=summary;collection={...fields,sha256:createHash('sha256').update(text).digest('hex')};
      }
    }
    context.guard();
    if(selection){
      if(!gallery)fail('record_missing','原聊天没有静帧记录；目录引用保留',404);
      if(gallery.sha256!==selection.gallerySha256)fail('record_changed','原聊天画面已变化，请重新打开此画面',409);
      const matches=records.filter(row=>row.id===selection.recordId);
      if(!matches.length)fail('record_missing','原画面记录已不存在；目录引用保留',404);
      if(matches.length!==1)fail('record_ambiguous','原聊天存在重复画面编号，不能猜测原图',409);
      if(matches[0].createdAt!==selection.createdAt)fail('record_changed','原画面生成时间与目录不符，未打开其他画面',409);
      // Internal server consumer only. No generic HTTP route exposes this raw source.
      if(recipeSource)return {expectedAccount:context.account.namespace,target:context.body.target,selection:{...selection},
        unavailable:matches[0].recipeUnavailable===true,snapshot:matches[0].snapshot??null,reference:matches[0].snapshotServerRef??null};
      return (detailsOnly?chatGalleryDetailsResponse:chatGalleryRecordResponse)({ok:true,version:1,expectedAccount:context.account.namespace,target:context.body.target,
        gallerySha256:gallery.sha256,record:(detailsOnly?projectChatGalleryDetails:projectChatGalleryRecord)(matches[0]),proof:detailsOnly?'read-only-details':'read-only-record'});
    }
    if(galleryOnly)return chatGalleryReceiptResponse({ok:true,version:1,expectedAccount:context.account.namespace,target:context.body.target,
      state:gallery?'present':'absent',gallery,proof:'read-only-snapshot'});
    return chatCharacterReceiptResponse({ok:true,version:1,expectedAccount:context.account.namespace,target:context.body.target,
      state:collection?'present':'absent',collection,proof:'read-only-snapshot'});
  }
  function run(req,input,options,galleryOnly=false,selection=null,detailsOnly=false,recipeSource=false){
    if(pending.size>=LIMIT.pending)return Promise.reject(chatCharacterReceiptError('busy','聊天核验正忙，请稍后重试',429));
    const operation=inspect(req,input,options,galleryOnly,selection,detailsOnly,recipeSource);pending.add(operation);void operation.finally(()=>pending.delete(operation)).catch(()=>{});return operation;
  }
  return Object.freeze({inspect:(req,input,options)=>run(req,input,options),inspectGallery:(req,input,options)=>run(req,input,options,true),
    async readGalleryRecord(req,input,options){const body=chatGalleryRecordRequest(input);return run(req,{version:body.version,expectedAccount:body.expectedAccount,target:body.target},options,true,body.selection);},
    async readGalleryDetails(req,input,options){const body=chatGalleryRecordRequest(input);return run(req,{version:body.version,expectedAccount:body.expectedAccount,target:body.target},options,true,body.selection,true);},
    async readGalleryRecipeSource(req,input,options){const body=chatGalleryRecordRequest(input);return run(req,{version:body.version,expectedAccount:body.expectedAccount,target:body.target},options,true,body.selection,false,true);},
    async close(){closed=true;await Promise.allSettled([...pending]);}});
}
