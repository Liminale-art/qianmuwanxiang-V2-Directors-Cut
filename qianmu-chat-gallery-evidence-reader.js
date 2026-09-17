import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {chatCharacterReceiptError} from './qianmu-chat-character-receipt.js';
import {chatGalleryReceiptText} from './qianmu-chat-gallery-receipt.js';
import {createStoryboardChatEvidenceCapture} from './qianmu-storyboard-chat-evidence.js';
import {CHAT_GALLERY_EVIDENCE_LIMITS as LIMIT,chatGalleryEvidenceResponse} from './qianmu-chat-gallery-evidence.js';
const fail=(code,message,status=409)=>{throw chatCharacterReceiptError(code,message,status);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);

// Internal file consumer. Paths/account/roots are borrowed from the existing
// authenticated selector service, never from an HTTP path or current browser chat.
export async function readSavedChatGalleryEvidence(context,gallerySha256,{io,lstat,checkedRoots,unchanged}){
  const started=performance.now();
  const check=()=>{context.guard();if(performance.now()-started>LIMIT.durationMs)fail('evidence_timeout','历史正文读取超时，未返回不完整来源',408);};
  check();await checkedRoots(context);const before=await lstat(context.target);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n)fail('path','聊天记录不是独立常规文件，未读取正文来源');
  if(before.size<1n)fail('content','聊天记录为空，不能确认正文来源');
  if(before.size>BigInt(LIMIT.fileBytes))fail('evidence_size','历史聊天超过 128 MiB，未截断或改写原件',413);
  const handle=await io.open(context.target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{
    check();const opened=await handle.stat({bigint:true});if(!unchanged(before,opened))fail('changed','聊天记录在读取前已变化');
    const capture=createStoryboardChatEvidenceCapture(context.body.target.chatId,{guard:check}),hash=createHash('sha256');
    const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});let parts=[],length=0,lines=0,position=0;
    async function line(){
      check();let value;try{const text=decoder.decode(Buffer.concat(parts,length));value=JSON.parse(lines===0?text.replace(/^\uFEFF/,''):text);}catch{fail('content','历史聊天含损坏或空白行，未跳过楼层');}
      parts=[];length=0;
      if(lines===0){
        if(!object(value)||!object(value.chat_metadata)||Object.hasOwn(value,'mes'))fail('content','聊天资料头不兼容');
        const records=value.chat_metadata.story_director_liminale?.storyboardImages;
        if(records===undefined)fail('record_missing','原聊天没有静帧记录，未生成脱离画面的正文来源',404);
        const summary=chatGalleryReceiptText(records);
        if(!summary||createHash('sha256').update(summary.text).digest('hex')!==gallerySha256)fail('record_changed','原聊天画面快照已变化，请重新读取');
      }else{
        if(!object(value)||typeof value.mes!=='string')fail('content','历史聊天正文行不完整，未按空楼层处理');
        if(lines>LIMIT.messages)fail('evidence_size','历史正文超过十万层，未裁剪');
        try{await capture.append(value);}catch(error){check();if(String(error?.code||'').startsWith('chat_character_receipt_'))throw error;fail('content','历史正文来源字段不兼容，未省略后继续');}
      }
      lines++;check();
    }
    // Each line is assembled once; do not repeatedly concatenate a growing chat.
    while(position<=LIMIT.fileBytes){
      check();const buffer=Buffer.alloc(Math.min(65536,LIMIT.fileBytes+1-position));
      const {bytesRead}=await handle.read(buffer,0,buffer.length,position);check();if(!bytesRead)break;
      position+=bytesRead;if(position>LIMIT.fileBytes)fail('evidence_size','历史聊天超过 128 MiB，未截断',413);
      const chunk=buffer.subarray(0,bytesRead);hash.update(chunk);let start=0;
      while(start<chunk.length){
        const end=chunk.indexOf(10,start),piece=chunk.subarray(start,end<0?chunk.length:end);length+=piece.length;
        if(length>LIMIT.lineBytes)fail('evidence_size','历史聊天单行超过 2 MiB，未截断或跳过',413);
        parts.push(piece);if(end<0)break;await line();start=end+1;
      }
    }
    if(length)await line();if(!lines)fail('content','聊天记录没有有效资料头');
    if(BigInt(position)!==opened.size)fail('changed','历史聊天读取不完整，请重新读取');
    const chatEvidence=await capture.finish();check();
    const after=await handle.stat({bigint:true}),current=await lstat(context.target);
    if(!unchanged(opened,after)||!unchanged(after,current))fail('changed','历史聊天在读取期间已变化，请重新读取');
    await checkedRoots(context);check();
    const result=await chatGalleryEvidenceResponse({ok:true,version:1,expectedAccount:context.account.namespace,target:context.body.target,gallerySha256,
      source:{bytes:position,sha256:hash.digest('hex')},chatEvidence,proof:'read-only-chat-evidence'});check();return result;
  }finally{await handle.close();}
}
