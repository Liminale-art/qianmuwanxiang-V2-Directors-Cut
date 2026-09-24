import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {collectAssistantHistoryPage} from './qianmu-assistant-storage-client.js?v=1.59.367';
import {assistantCatalogueResponse} from './qianmu-assistant-storage-contract.js';
import {proseAssistantAccountForNamespace} from './qianmu-prose-assistant-source.js';
import {proseAssistantHistoryKey,validateProseAssistantHistory,PROSE_ASSISTANT_HISTORY_LIMITS as LIMIT} from './qianmu-prose-assistant-history-contract.js';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=(code,message)=>{throw Object.assign(Error(message),{code:'assistant_history_manager_'+code});};
const publicError=cause=>String(cause?.code||'').startsWith('assistant_history_manager_')||cause?.code==='assistant_history_catalogue_unavailable'?cause:Object.assign(Error('助手记录操作未确认，原件保留；请核对账户或刷新重试。'),{code:'assistant_history_manager_unavailable'});
const sha=async text=>Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),v=>v.toString(16).padStart(2,'0')).join('');

// One explicitly opened page, at most eight complete histories. No startup
// scan, cross-page selection, local migration, content truncation or file delete.
export async function createAssistantHistoryManager({resolveNamespace,isCurrent,headers,fetchImpl,loadPage=collectAssistantHistoryPage,
 storageFactory=createConfiguredStAccountStorage,now=Date.now}={}){
 let closed=false,busy=false,store=null,namespace,account,pending=null;const rows=new Map(),controller=new AbortController();
 const check=()=>{if(closed||isCurrent()!==true)fail('scope','助手历史管理页面或账户已变化');};
 const guard=async()=>{check();if(await resolveNamespace()!==namespace)fail('scope','助手历史管理账户已变化');check();return true;};
 const close=()=>{closed=true;controller.abort();store?.close();rows.clear();pending=null;};
 try{check();namespace=await resolveNamespace();check();account=await proseAssistantAccountForNamespace(namespace);await guard();
  store=await storageFactory({maxBytes:LIMIT.bytes+2048,isCurrent:()=>!closed&&isCurrent()===true});await guard();if(store.namespace!==namespace)fail('scope','助手历史存储账户不一致');
 }catch(cause){close();throw publicError(cause);}
 const options={guard,signal:controller.signal};
 async function execute(work){check();if(busy)fail('busy','请等待当前助手历史操作完成');busy=true;try{await guard();return await work();}catch(cause){throw publicError(cause);}finally{busy=false;}}
 async function checkedState(result,reference){
  const value=result?.value,key=proseAssistantHistoryKey(value?.namespace,account);validateProseAssistantHistory(value,key);
  if('assistant-'+await sha(key)!==reference.slot||result.fingerprint!==reference.fingerprint)fail('content','助手记录身份与文件引用不一致');await guard();return structuredClone(value);
 }
 function selected(ids){
  if(!Array.isArray(ids)||ids.length<1||ids.length>8||new Set(ids).size!==ids.length)fail('selection','请选择本页已完整读取的助手记录');
  const found=ids.map(id=>rows.get(id));if(found.some(row=>!row||row.status!=='ready'))fail('selection','所选助手记录尚未完整读取');return found;
 }
 function describe(row){
  if(row.status!=='ready')return {id:row.reference.slot,status:'unavailable',title:'记录暂未读取',count:null,bytes:row.reference.bytes};
  const tuple=JSON.parse(row.state.namespace),offstage=tuple.length===2;
  return {id:row.reference.slot,status:'ready',title:offstage?'场外会话':tuple[3].chatId,
   owner:offstage?'独立对话':tuple[3].kind==='character'?tuple[3].avatar.replace(/\.png$/,''):'群组 '+tuple[2].slice(6),
   updatedAt:row.state.updatedAt,count:row.state.rows.length,bytes:row.reference.bytes};
 }
 const progress=()=>pending?{total:pending.items.length,confirmed:pending.items.filter(item=>item.done).length,uncertain:pending.items.some(item=>item.attempted&&!item.done)}:null;
 async function readCurrent(item){const value=await store.read(item.reference.slot,options);await guard();if(!value.exists)fail('changed','助手记录入口已变化，未覆盖新版本');return value;}
 async function unchanged(item){const current=await readCurrent(item);if(current.fingerprint!==item.reference.fingerprint||!same(current.value,item.state))fail('changed','助手记录在选择后已变化，请刷新核对；未清空新版本');return current;}
 return Object.freeze({close,guard,progress,
  page(offset=0,snapshot=null){return execute(async()=>{
   if(pending)fail('pending','清空进度尚未结束，请重试当前批次或关闭后重新核对');
   const received=await loadPage({resolveNamespace,isCurrent:()=>!closed&&isCurrent()===true,headers,fetchImpl,offset,snapshot,signal:controller.signal});await guard();
   const {namespace:raw,status,...wire}=received;if(raw!==namespace||status!=='ready')fail('scope','助手目录账户不一致');
   const page=assistantCatalogueResponse(wire,{version:1,expectedAccount:account,offset,snapshot});if(page.scope!==store.scope)fail('scope','助手目录与存储账户不一致');
   const loaded=[];
   for(let at=0;at<page.entries.length;at+=4){
    const chunk=await Promise.all(page.entries.slice(at,at+4).map(async reference=>{
     try{return {reference,state:await checkedState(await store.readImmutable(reference,options),reference),status:'ready'};}
     catch(cause){await guard();return {reference,status:'unavailable'};}
    }));await guard();loaded.push(...chunk);
   }
   rows.clear();for(const row of loaded)rows.set(row.reference.slot,row);
   return {offset:page.offset,nextOffset:page.nextOffset,total:page.total,snapshot:page.snapshot,rows:loaded.map(describe)};
  });},
  view(id){return execute(async()=>{const row=selected([id])[0];return structuredClone(row.state);});},
  backup(ids){return execute(async()=>{
   const items=selected(ids).map(row=>({reference:structuredClone(row.reference),history:structuredClone(row.state)}));
   const text=JSON.stringify({schema:'qianmu.assistant-history-backup.v1',account,createdAt:now(),items},null,2);
   if(new TextEncoder().encode(text).byteLength>48*1024*1024)fail('capacity','所选完整备份过大，请减少本次选择；未截断内容');await guard();return text;
  });},
  clear(ids,confirm){return execute(async()=>{
   if(typeof confirm!=='function')fail('confirmation','缺少明确的清空确认');
   if(!pending){
    const chosen=selected(ids);for(const row of chosen)await unchanged(row);
    const items=chosen.filter(row=>row.state.rows.length).map(row=>({...structuredClone(row),done:false,attempted:false}));
    if(!items.length)return {status:'empty',confirmed:0,total:0};
    for(const item of items)item.next=validateProseAssistantHistory({...item.state,rows:[],revision:item.state.revision+1,updatedAt:now()},item.state.namespace);
    if(await confirm('清空选中的 ST 助手会话',`将清空选中的 ${items.length} 份会话、${items.reduce((n,item)=>n+item.state.rows.length,0)} 轮问答。请先备份需要的内容；不删除ST聊天、收藏、API设置或其他助手会话。旧不可变版本仍保留，本操作不释放其磁盘空间；不保证多端同时写入时强一致，请避免同时编辑。确认后新增或变化的版本不会被强制覆盖。确定清空吗？`)!==true){await guard();return {status:'cancelled'};}
    await guard();for(const item of items)await unchanged(item);pending={ids:[...ids],items};
   }else if(!same(pending.ids,ids))fail('pending','请先处理原清空范围，不追加新的记录');
   for(const item of pending.items){
    if(item.done)continue;let current=await readCurrent(item);
    if(item.attempted&&same(current.value,item.next)){item.done=true;continue;}
    await unchanged(item);item.attempted=true;
    try{
     const saved=await store.write(item.reference.slot,item.next,{expectedFingerprint:item.reference.fingerprint,...options});await guard();
     if(!same(saved.value,item.next))fail('receipt','助手清空回执未确认，请保留本窗口重试');item.done=true;
    }catch(cause){
     await guard();current=await readCurrent(item);
     if(same(current.value,item.next))item.done=true;else throw cause;
    }
   }
   const result={status:'complete',...progress(),retainedVersions:true};pending=null;rows.clear();return result;
  });}
 });
}
