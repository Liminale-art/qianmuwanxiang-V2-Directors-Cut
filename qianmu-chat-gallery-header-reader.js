import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {chatCharacterReceiptError} from './qianmu-chat-character-receipt.js';
import {createChatGalleryHeaderCapture,CHAT_GALLERY_HEADER_LIMITS as LIMIT} from './qianmu-chat-gallery-header.js';

const fail=(code,message,status=409)=>{throw chatCharacterReceiptError(code,message,status);};
// Borrow the authenticated service's already constrained file target/roots.
// No request can provide a path. Do not scan/hash subsequent JSONL body lines;
// the last bounded filesystem chunk may contain unused bytes after the first LF.
export async function readSavedChatGalleryHeader(context,selection,{io,lstat,checkedRoots,unchanged,projectRecord,withIdentity=false,withSource=false,supplement=false}){
  const started=performance.now();
  const check=()=>{context.guard();if(performance.now()-started>LIMIT.durationMs)fail('timeout','聊天画面核验超时，未返回不完整摘要',408);};
  check();await checkedRoots(context);const before=await lstat(context.target);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n)fail('path','聊天记录不是独立常规文件，未核验');
  if(before.size<1n)fail('content','聊天记录为空，不能确认画面资料');
  const handle=await io.open(context.target,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{
    check();const opened=await handle.stat({bigint:true});if(!unchanged(before,opened))fail('changed','聊天记录在读取前已变化，请重试');
    const capture=createChatGalleryHeaderCapture({recordId:selection?.recordId,recordIds:selection?.recordIds,projectRecord,guard:check,supplement}),hash=withSource?createHash('sha256'):null;
    const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});let length=0,position=0,found=false;
    function feed(part,final=false){
      let text;try{text=final?decoder.decode():decoder.decode(part,{stream:true});}catch{fail('content','聊天资料头编码损坏，未按空记录处理');}
      capture.write(text);
    }
    while(length<=LIMIT.bytes){
      check();const buffer=Buffer.alloc(Math.min(16384,LIMIT.bytes+1-length));
      const {bytesRead}=await handle.read(buffer,0,buffer.length,position);check();if(!bytesRead)break;
      position+=bytesRead;const data=buffer.subarray(0,bytesRead),end=data.indexOf(10),part=end<0?data:data.subarray(0,end);
      length+=part.length;if(length>LIMIT.bytes)fail('size','聊天资料头超过流式核验上限，已停止且未裁剪资料',413);
      hash?.update(part);
      feed(part);if(end>=0){found=true;break;}
    }
    if(!found&&BigInt(position)!==opened.size)fail('changed','聊天记录读取不完整，请重试');
    feed(null,true);const result=capture.finish();check();
    const after=await handle.stat({bigint:true}),current=await lstat(context.target);
    if(!unchanged(opened,after)||!unchanged(after,current))fail('changed','聊天记录在核验期间已变化，请重试');
    await checkedRoots(context);check();return {...result,...(withIdentity?{file:current}:{}),
      ...(withSource?{source:{kind:'jsonl-header',bytes:length,sha256:hash.digest('hex')}}:{})};
  }finally{await handle.close();}
}
