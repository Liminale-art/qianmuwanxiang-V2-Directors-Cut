// Hash-only capture: the same complete canonical record and strict JSON limits,
// without constructing a detached object that the caller will immediately discard.
// This is not an original-record reader, ownership proof or cached source check.
import {GALLERY_PAGE_INDEX_LIMITS} from './qianmu-gallery-page-index.js';
import {CHAT_GALLERY_RECEIPT_LIMITS} from './qianmu-chat-gallery-receipt.js';
const utf8=new TextEncoder(),limit=Math.min(GALLERY_PAGE_INDEX_LIMITS.recordBytes,CHAT_GALLERY_RECEIPT_LIMITS.bytes);
const fail=message=>{throw Object.assign(Error(message),{code:'chat_gallery_digest'});};
function wellFormed(value){
  if(!/[\uD800-\uDFFF]/.test(value))return true;
  for(let at=0;at<value.length;at++){
    const code=value.charCodeAt(at);
    if(code>=0xD800&&code<=0xDBFF){const next=value.charCodeAt(++at);if(!(next>=0xDC00&&next<=0xDFFF))return false;}
    else if(code>=0xDC00&&code<=0xDFFF)return false;
  }
  return true;
}
export function galleryRecordFingerprintText(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('聊天静帧条目不完整，不能确认来源');
  const seen=new Set();let captureNodes=0,nodes=0,characters=0,quotedCharacters=0;
  function inspectString(value){
    characters+=value.length;if(characters>limit||!wellFormed(value))fail('分页目录文字过大或编码无效');
  }
  function quote(value){
    const text=JSON.stringify(value);quotedCharacters+=text.length;
    if(quotedCharacters>limit)fail('聊天静帧资料超过核验上限，请保全原件');return text;
  }
  function visit(value,depth=0){
    // Detached capture counts keys too; receipt accounting counts only values.
    // Its implicit enclosing array also consumes one node and two encoded bytes.
    if(++captureNodes>100000||depth>24||++nodes+1>CHAT_GALLERY_RECEIPT_LIMITS.nodes)fail('分页目录结构过大');
    if(typeof value==='string'){inspectString(value);return quote(value);}
    if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return quote(value);
    const array=Array.isArray(value);
    if(typeof value!=='object'||seen.has(value)||!array&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('分页目录必须是独立 JSON');
    seen.add(value);const keys=Reflect.ownKeys(value);
    if(keys.some(name=>typeof name!=='string'))fail('分页目录含不支持字段');
    if(array&&(keys.length!==value.length+1||keys.some((name,index)=>index===value.length?name!=='length':name!==String(index))))fail('分页目录数组不完整');
    const parts=[];
    for(const name of array?keys.slice(0,-1):keys.sort()){
      if(['__proto__','prototype','constructor'].includes(name))fail('分页目录字段不安全');
      const property=Object.getOwnPropertyDescriptor(value,name);
      if(!property?.enumerable||!Object.hasOwn(property,'value'))fail('分页目录不能包含访问器或隐藏字段');
      if(++captureNodes>100000||depth+1>24)fail('分页目录结构过大');inspectString(name);
      const prefix=array?'':quote(name)+':';parts.push(prefix+visit(property.value,depth+1));
    }
    seen.delete(value);return (array?'[':'{')+parts.join(',')+(array?']':'}');
  }
  const text=visit(raw),bytes=utf8.encode(text).length;
  if(bytes+2>limit)fail('聊天静帧资料超过核验上限，请保全原件');
  return {text,bytes,nodes};
}
