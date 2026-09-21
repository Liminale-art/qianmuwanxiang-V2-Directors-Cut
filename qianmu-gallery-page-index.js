// Phase 1 paging foundation ONLY. No runtime import, migration, storage writes,
// gallery pruning, generation gate, network or original-media access. Hashes
// prove byte integrity, not durable storage, authenticated ownership or deletion
// authority. A future adapter must establish those separately before adoption.
import {parseBoundedJson} from './qianmu-json-input.js';
import {vibeDigest} from './qianmu-vibe-file.js';
import {galleryCatalogAccount,galleryCatalogSource,galleryCatalogTags} from './qianmu-gallery-catalog-contract.js';

export const GALLERY_PAGE_INDEX_LIMITS=Object.freeze({rows:128,pages:512,pageBytes:512*1024,manifestBytes:384*1024,recordBytes:2*1024*1024,result:60,scanPages:4,pending:4});
const LIMIT=GALLERY_PAGE_INDEX_LIMITS,utf8=new TextEncoder();
const schemas={page:'qianmu.gallery.index-page.v1',manifest:'qianmu.gallery.index-manifest.v1'};
const fail=message=>{throw Object.assign(new Error(message),{code:'gallery_page_index'});};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const text=(value,max,empty=false)=>typeof value==='string'&&(empty||value.length>0)&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);

function scope(value){
  if(!exact(value,['namespace','ownerKey','chatKey']))fail('分页目录来源不完整');
  return {namespace:galleryCatalogAccount(value.namespace),...galleryCatalogSource({ownerKey:value.ownerKey,chatKey:value.chatKey})};
}
function reference(value,maxBytes){
  if(!exact(value,['sha256','bytes'])||!hash(value.sha256)||!integer(value.bytes,2,maxBytes))fail('分页目录引用不完整');
  return {sha256:value.sha256,bytes:value.bytes};
}
function key(value){
  if(!Array.isArray(value)||value.length!==2||!integer(value[0],0,Number.MAX_SAFE_INTEGER)||!text(value[1],240))fail('分页目录顺序标识无效');
  return [...value];
}
const compare=(left,right)=>left[0]===right[0]?(left[1]<right[1]?-1:left[1]>right[1]?1:0):(left[0]<right[0]?-1:1);
const rowKey=row=>[row.createdAt,row.recordId];
function entry(value){
  if(!exact(value,['recordId','createdAt','label','tags','record']))fail('分页目录仅接受轻量字段，不接受画面正文或额外数据');
  key(rowKey(value));if(!text(value.label,240,true))fail('分页目录标题无效，未截断');
  const tags=galleryCatalogTags(value.tags);if(!same(tags,value.tags))fail('分页目录关键词须去重并按固定顺序保存');
  return {recordId:value.recordId,createdAt:value.createdAt,label:value.label,tags,record:reference(value.record,LIMIT.recordBytes)};
}
function descriptor(value){
  if(!exact(value,['sha256','bytes','count','first','last'])||!integer(value.count,1,LIMIT.rows))fail('分页目录页摘要无效');
  const result={...reference({sha256:value.sha256,bytes:value.bytes},LIMIT.pageBytes),count:value.count,first:key(value.first),last:key(value.last)};
  const order=compare(result.first,result.last);
  if(result.count===1?order!==0:order<=0)fail('分页目录页范围无效');
  return result;
}
function page(value,expectedScope){
  if(!exact(value,['schema','scope','rows'])||value.schema!==schemas.page||!Array.isArray(value.rows)||!integer(value.rows.length,1,LIMIT.rows))fail('分页目录内容不兼容');
  const source=scope(value.scope);if(!same(source,expectedScope))fail('分页目录账户或聊天来源不符');
  const rows=value.rows.map(entry),ids=new Set();
  for(let index=0;index<rows.length;index++){
    const row=rows[index];
    if(ids.has(row.recordId)||index&&compare(rowKey(rows[index-1]),rowKey(row))<=0)fail('分页目录重复或顺序不符');
    ids.add(row.recordId);
  }
  return {schema:schemas.page,scope:source,rows};
}
function manifest(value,expectedScope){
  if(!exact(value,['schema','scope','total','pages'])||value.schema!==schemas.manifest||!Array.isArray(value.pages)
    ||value.pages.length>LIMIT.pages||!integer(value.total,0,LIMIT.rows*LIMIT.pages))fail('分页目录清单不兼容');
  const source=scope(value.scope);if(!same(source,expectedScope))fail('分页目录清单账户或聊天来源不符');
  const pages=value.pages.map(descriptor),ids=new Set();let total=0;
  for(let index=0;index<pages.length;index++){
    const current=pages[index];total+=current.count;
    if(ids.has(current.sha256)||index&&compare(pages[index-1].last,current.first)<=0)fail('分页目录页范围重叠或重复');
    ids.add(current.sha256);
  }
  if(total!==value.total)fail('分页目录总数不一致，未接受部分清单');
  return {schema:schemas.manifest,scope:source,total,pages};
}

// Detached JSON capture rejects getters/toJSON, symbols, unsafe keys, missing
// array entries and lossy scalar conversions before any caller code can run.
function capture(value,maxBytes){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>LIMIT.recordBytes)fail('分页目录读取预算无效');
  const seen=new Set();let nodes=0,characters=0;
  function visit(item,depth=0){
    if(++nodes>100000||depth>24)fail('分页目录结构过大');
    if(typeof item==='string'){
      characters+=item.length;if(characters>maxBytes||new TextDecoder().decode(utf8.encode(item))!==item)fail('分页目录文字过大或编码无效');return;
    }
    if(item===null||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return;
    if(typeof item!=='object'||seen.has(item)||!Array.isArray(item)&&![Object.prototype,null].includes(Object.getPrototypeOf(item)))fail('分页目录必须是独立 JSON');
    seen.add(item);const keys=Reflect.ownKeys(item);
    if(keys.some(name=>typeof name!=='string'))fail('分页目录含不支持字段');
    if(Array.isArray(item)&&keys.filter(name=>name!=='length').some((name,index)=>name!==String(index))
      ||Array.isArray(item)&&keys.length!==item.length+1)fail('分页目录数组不完整');
    for(const name of keys){
      if(Array.isArray(item)&&name==='length')continue;
      if(['__proto__','prototype','constructor'].includes(name))fail('分页目录字段不安全');
      const property=Object.getOwnPropertyDescriptor(item,name);
      if(!property?.enumerable||!Object.hasOwn(property,'value'))fail('分页目录不能包含访问器或隐藏字段');
      visit(name,depth+1);visit(property.value,depth+1);
    }
    seen.delete(item);
  }
  visit(value);const content=JSON.stringify(value);
  if(utf8.encode(content).length>maxBytes)fail('分页目录超过单页上限，未裁剪');
  return JSON.parse(content);
}
// Shared strict JSON capture for the separately staged record store. It does
// not validate ownership, recipe availability, storage receipts or file paths.
export const captureGalleryArchiveJson=capture;
async function encode(value,maxBytes){
  const content=JSON.stringify(value),bytes=utf8.encode(content).length;if(bytes>maxBytes)fail('分页目录超过单页上限，未裁剪');
  return {text:content,reference:{sha256:await vibeDigest(content),bytes}};
}
export async function encodeGalleryIndexPage(source,rows){
  const input=capture({schema:schemas.page,scope:source,rows},LIMIT.pageBytes),value=page(input,scope(input.scope)),encoded=await encode(value,LIMIT.pageBytes);
  return {...encoded,descriptor:{...encoded.reference,count:value.rows.length,first:rowKey(value.rows[0]),last:rowKey(value.rows.at(-1))}};
}
export async function encodeGalleryIndexManifest(source,pages){
  const input=capture({schema:schemas.manifest,scope:source,total:0,pages},LIMIT.manifestBytes);
  input.total=input.pages.reduce((sum,row)=>sum+row.count,0);
  return encode(manifest(input,scope(input.scope)),LIMIT.manifestBytes);
}
async function decode(content,ref,maxBytes){
  reference(ref,maxBytes);
  if(typeof content!=='string'||content.length>ref.bytes||utf8.encode(content).length!==ref.bytes||await vibeDigest(content)!==ref.sha256)fail('分页目录内容校验失败，请保留原副本');
  try{return capture(parseBoundedJson(content,{maxBytes,maxDepth:24,maxNodes:100000,label:'分页目录'}),maxBytes);}catch{fail('分页目录 JSON 无效，未修复或覆盖');}
}

export async function createGalleryPageIndexReader({source,head,readPage,guard}={}){
  if(typeof readPage!=='function'||typeof guard!=='function')fail('分页目录缺少只读适配器或来源守卫');
  const frozen=capture({source,head},LIMIT.manifestBytes+4096),expected=scope(frozen.source),headRef=reference(frozen.head.reference,LIMIT.manifestBytes);
  if(!exact(frozen.head,['text','reference']))fail('分页目录清单封装无效');
  let closed=false;const pending=new Set();
  const check=async()=>{if(closed)fail('分页目录已关闭');if(await guard()===false)fail('分页目录来源已变化');if(closed)fail('分页目录已关闭');};
  await check();const header=manifest(await decode(frozen.head.text,headRef,LIMIT.manifestBytes),expected);await check();
  async function query(input={}){
    const options=capture(input,16384);
    if(!object(options)||Object.keys(options).some(name=>!['tags','limit','cursor'].includes(name)))fail('分页目录筛选条件无效');
    const tags=galleryCatalogTags(options.tags),limit=options.limit??24,signature=JSON.stringify(tags),cursor=options.cursor??null;
    if(!integer(limit,1,LIMIT.result))fail('分页目录每页数量无效');
    let pageIndex=0,offset=0;
    if(cursor!==null){
      if(!exact(cursor,['version','manifest','filter','page','offset'])||cursor.version!==1||cursor.manifest!==headRef.sha256||cursor.filter!==signature
        ||!integer(cursor.page,0,header.pages.length-1)||!integer(cursor.offset,0,header.pages[cursor.page]?.count-1))fail('分页目录续页失效，请返回第一页');
      pageIndex=cursor.page;offset=cursor.offset;
    }
    const rows=[];let pagesRead=0,scanned=0;
    await check();
    if(pending.size>=LIMIT.pending)fail('分页目录读取正忙，请稍后重试');
    const controller=new AbortController();pending.add(controller);
    try{
      while(pageIndex<header.pages.length&&rows.length<limit&&pagesRead<LIMIT.scanPages){
        const description=header.pages[pageIndex],ref={sha256:description.sha256,bytes:description.bytes};
        await check();const raw=await readPage({...ref},{signal:controller.signal});await check();
        const value=page(await decode(raw,ref,LIMIT.pageBytes),expected);await check();pagesRead++;
        if(value.rows.length!==description.count||!same(rowKey(value.rows[0]),description.first)||!same(rowKey(value.rows.at(-1)),description.last))fail('分页目录页摘要与正文不符');
        while(offset<value.rows.length&&rows.length<limit){
          const row=value.rows[offset++];scanned++;
          if(tags.every(tag=>row.tags.includes(tag)))rows.push(row);
        }
        if(offset===value.rows.length){pageIndex++;offset=0;}
      }
      await check();
      return {rows,total:header.total,scanned,pagesRead,hasMore:pageIndex<header.pages.length,
        cursor:pageIndex<header.pages.length?{version:1,manifest:headRef.sha256,filter:signature,page:pageIndex,offset}:null,
        proof:'integrity-only-not-durable'};
    }finally{pending.delete(controller);controller.abort();}
  }
  return Object.freeze({page:query,close(){closed=true;for(const controller of pending)controller.abort();}});
}
