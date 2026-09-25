import {createHash} from 'node:crypto';
import {chatCharacterReceiptError} from './qianmu-chat-character-receipt.js';
import {chatGalleryReceiptRecordText,CHAT_GALLERY_RECEIPT_LIMITS,CHAT_GALLERY_STREAM_LIMITS} from './qianmu-chat-gallery-receipt.js';
import {CHAT_GALLERY_SUPPLEMENT_LIMITS} from './qianmu-chat-gallery-supplement.js';
import {GALLERY_SUPPLEMENT_FIELDS} from './qianmu-gallery-continuity.js?v=1.59.378';

// Only the saved JSONL header is scanned. Unrelated metadata is validated but
// never accumulated. One record is materialized at a time; the result retains
// at most two matches per selected id (two means ambiguous), not the complete
// gallery. Internal original batches select up to eight small projections.
export const CHAT_GALLERY_HEADER_LIMITS=Object.freeze({bytes:64*1024*1024,depth:40,nodes:500000,keyLength:4096,keyCharacters:2*1024*1024,numberCharacters:128,durationMs:10000});
const fail=(message,code='content')=>{throw chatCharacterReceiptError(code,message);};
const white=char=>char===' '||char==='\t'||char==='\r'||char==='\n';
const metadataPath=['chat_metadata'],storePath=[...metadataPath,'story_director_liminale'],galleryPath=[...storePath,'storyboardImages'];
const at=(path,wanted)=>path.length===wanted.length&&wanted.every((value,index)=>path[index]===value);

// Incremental JSON grammar, not a brace/regex extractor: duplicates, trailing
// garbage, malformed skipped fields and incomplete tails invalidate the receipt.
// Input is decoded with fatal streaming UTF-8 by the file reader.
export function createChatGalleryHeaderCapture({recordId,recordIds,projectRecord=value=>value,guard=()=>{},supplement=false}={}){
  if(recordIds!==undefined&&(recordId!==undefined||!Array.isArray(recordIds)||recordIds.length<1||recordIds.length>8
    ||recordIds.some(id=>typeof id!=='string'||!id||id.length>240)||new Set(recordIds).size!==recordIds.length))fail('聊天批次选择超出核验范围');
  if(typeof projectRecord!=='function')fail('聊天条目投影无效');
  if(typeof supplement!=='boolean')fail('分镜补充资料核验模式无效');
  const selected=new Set(recordIds??(recordId===undefined?[]:[recordId])),counts=new Map();
  const frames=[],matches=[],hash=createHash('sha256');hash.update('[');
  const saved={},order=[],orderedIds=new Set();let extra=null,extraCharacters=0;
  let root=false,metadata=false,present=false,finished=false,failed=false,nodes=0,galleryNodes=0,keyCharacters=0;
  let count=0,bytes=2,token=null,capture=null,offset=0;
  function check(){if(finished||failed)fail('聊天资料头核验已结束');guard();}
  function begin(kind){
    const parent=frames.at(-1);let path;
    if(!parent){if(root)fail('聊天资料头含额外内容');root=true;path=[];}
    else{
      if(parent.kind==='object'){
        if(parent.state!=='value')fail('聊天资料头对象不完整');path=[...parent.path,parent.key];
      }else{
        if(parent.state!=='first'&&parent.state!=='value')fail('聊天资料头数组不完整');path=[...parent.path,parent.index++];
      }
      parent.state='end';
    }
    if(++nodes>CHAT_GALLERY_HEADER_LIMITS.nodes||path.length>CHAT_GALLERY_HEADER_LIMITS.depth)fail('聊天资料头结构超过核验范围','size');
    if(path.length===0&&kind!=='object')fail('聊天资料头不是对象');
    if(at(path,metadataPath)){if(kind!=='object')fail('聊天元数据不是对象');metadata=true;}
    if(at(path,storePath)&&kind!=='object')fail('千幕聊天资料损坏，请保全原记录');
    if(path.length===1&&path[0]==='mes')fail('聊天正文不能代替资料头');
    if(at(path,galleryPath)){if(kind!=='array')fail('聊天静帧记录不是数组');present=true;}
    if(supplement&&path.length===storePath.length+1&&storePath.every((value,index)=>path[index]===value)
      &&GALLERY_SUPPLEMENT_FIELDS.includes(path.at(-1))){
      const field=path.at(-1);if(kind!==(field==='characterDrafts'?'object':'array'))fail('分镜补充资料类型无效','supplement_content');
      extra={field,depth:frames.length+1,parts:[],chars:[],length:0};
    }
    if(path.length>=galleryPath.length&&galleryPath.every((value,index)=>path[index]===value)){
      if(++galleryNodes>CHAT_GALLERY_STREAM_LIMITS.nodes)fail('聊天静帧资料结构过大，请保留原件');
      if(path.length===galleryPath.length+1){
        if(kind!=='object'||count>=CHAT_GALLERY_RECEIPT_LIMITS.records)fail('聊天静帧条目不完整或数量超过核验范围');
        capture={depth:frames.length+1,parts:[],chars:[],length:0};
      }
    }
    return path;
  }
  function append(char){
    if(extra){
      extraCharacters+=char.length;if(extraCharacters>CHAT_GALLERY_SUPPLEMENT_LIMITS.bytes)fail('分镜补充资料超过单独核验上限，未截断','supplement_content');
      extra.chars.push(char);if(extra.chars.length>=4096){extra.parts.push(extra.chars.join(''));extra.chars=[];}
    }
    if(!capture)return;
    capture.length+=char.length;
    if(capture.length>CHAT_GALLERY_RECEIPT_LIMITS.bytes)fail('聊天静帧条目超过核验上限，未裁剪资料');
    capture.chars.push(char);
    if(capture.chars.length>=4096){capture.parts.push(capture.chars.join(''));capture.chars=[];}
  }
  function record(){
    let value;try{value=JSON.parse(capture.parts.join('')+capture.chars.join(''));}catch{fail('聊天静帧条目损坏');}
    capture=null;const summary=chatGalleryReceiptRecordText(value);
    bytes+=summary.bytes+(count?1:0);
    if(bytes>CHAT_GALLERY_STREAM_LIMITS.bytes)fail('聊天静帧资料超过核验上限，请保全原件');
    if(count)hash.update(',');hash.update(summary.text);count++;
    if(supplement){
      if(typeof value.id!=='string'||!value.id||value.id.length>240||/[\u0000-\u001f\u007f]/.test(value.id)||orderedIds.has(value.id))
        fail('原画面编号缺失或重复，不能恢复准确顺序','supplement_content');
      order.push(value.id);orderedIds.add(value.id);
    }
    if(selected.has(value.id)&&(counts.get(value.id)||0)<2){
      counts.set(value.id,(counts.get(value.id)||0)+1);matches.push(projectRecord(value));
    }
  }
  function close(kind){
    const frame=frames.at(-1);
    if(!frame||frame.kind!==kind||!['first','end'].includes(frame.state))fail('聊天资料头括号或逗号不完整');
    if(capture?.depth===frames.length)record();
    if(extra?.depth===frames.length){
      const text=extra.parts.join('')+extra.chars.join('');saved[extra.field]=JSON.parse(text);extra=null;
      if(Buffer.byteLength(JSON.stringify(saved))>CHAT_GALLERY_SUPPLEMENT_LIMITS.bytes)fail('分镜补充资料超过字节上限，未截断','supplement_content');
    }
    frames.pop();
  }
  function endScalar(){
    if(token.kind==='number'){
      if(!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token.text)||!Number.isFinite(Number(token.text)))fail('聊天资料头数字无效');
    }else if(token.text!==token.expected)fail('聊天资料头值不完整');
    token=null;
  }
  function step(char){
    if(token){
      if(token.kind==='string'){
        append(char);
        if(token.key){token.text+=char;if(token.text.length>CHAT_GALLERY_HEADER_LIMITS.keyLength)fail('聊天资料头字段名过长','size');}
        if(token.unicode){if(!/[a-f\d]/i.test(char))fail('聊天资料头转义无效');token.unicode--;return;}
        if(token.escape){token.escape=false;if(char==='u')token.unicode=4;else if(!'"\\/bfnrt'.includes(char))fail('聊天资料头转义无效');return;}
        if(char==='\\'){token.escape=true;return;}
        if(char.charCodeAt(0)<32)fail('聊天资料头字符串含控制字符');
        if(char!=='"')return;
        if(token.key){
          const frame=frames.at(-1),key=JSON.parse(token.text);
          keyCharacters+=key.length;
          if(keyCharacters>CHAT_GALLERY_HEADER_LIMITS.keyCharacters)fail('聊天资料头字段过多','size');
          if(frame.keys.has(key))fail('聊天资料头含重复字段，不能猜测来源');
          frame.keys.add(key);frame.key=key;frame.state='colon';
        }
        token=null;return;
      }
      if(!white(char)&&!',]}'.includes(char)){
        append(char);token.text+=char;
        if(token.text.length>CHAT_GALLERY_HEADER_LIMITS.numberCharacters)fail('聊天资料头值过长');return;
      }
      endScalar(); // Reprocess the delimiter; it belongs to the enclosing frame.
    }
    if(white(char)){append(char);return;}
    const frame=frames.at(-1);
    if(char==='}'||char===']'){append(char);close(char==='}'?'object':'array');return;}
    if(char===','){
      if(!frame||frame.state!=='end')fail('聊天资料头逗号位置无效');
      append(char);frame.state=frame.kind==='object'?'key':'value';return;
    }
    if(char===':'){
      if(!frame||frame.state!=='colon')fail('聊天资料头冒号位置无效');append(char);frame.state='value';return;
    }
    if(char==='"'&&frame?.kind==='object'&&['first','key'].includes(frame.state)){
      append(char);token={kind:'string',key:true,text:'"',unicode:0,escape:false};return;
    }
    const kind=char==='{'?'object':char==='['?'array':char==='"'?'string':char==='-'||/\d/.test(char)?'number':'literal';
    const path=begin(kind);append(char);
    if(kind==='object'||kind==='array'){frames.push({kind,path,state:'first',index:0,keys:kind==='object'?new Set():null});return;}
    if(kind==='string'){token={kind,key:false,unicode:0,escape:false};return;}
    if(kind==='number'){token={kind,text:char};return;}
    const expected={t:'true',f:'false',n:'null'}[char];if(!expected)fail('聊天资料头值无效');token={kind,text:char,expected};
  }
  return Object.freeze({
    write(text){
      check();if(typeof text!=='string')fail('聊天资料头分块类型无效');
      try{for(const char of text){if(offset++===0&&char==='\uFEFF')continue;step(char);}guard();}
      catch(error){failed=true;throw error;}
    },
    finish(){
      check();try{
        if(token&&token.kind!=='string')endScalar();
        if(token||frames.length||!root||!metadata||capture||extra)fail('聊天资料头不完整，未按空记录处理');
        hash.update(']');const sha256=hash.digest('hex');finished=true;
        return {gallery:present?{count,bytes,sha256}:null,records:matches,...(supplement?{saved,order}:{})};
      }catch(error){failed=true;throw error;}
    },
  });
}
