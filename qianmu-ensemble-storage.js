import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {ENSEMBLE_LIBRARY_SCHEMA,ENSEMBLE_SELECTION_SCHEMA,normalizeEnsembleLibrary,normalizeEnsembleChatSelection} from './qianmu-ensemble-selection.js?v=1.59.315';

const MAX_BYTES=1024*1024;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const fail=message=>{throw Object.assign(Error(message),{code:'ensemble_storage',writeState:'not_started'});};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

// Global descriptive library plus one selected set per chat. Native ST owns
// same-account portability; no backend plugin, file-list scan or local fallback.
// Cache is instance-local and guarded even when no file GET is necessary.
export async function createEnsembleStorage({namespace,chatKey,isCurrent,resolveNamespace,createStorage=createConfiguredStAccountStorage}={}){
  const emptyLibrary=normalizeEnsembleLibrary({schema:ENSEMBLE_LIBRARY_SCHEMA,namespace,schemes:[]});
  const hasChat=chatKey!==null&&chatKey!==undefined&&chatKey!=='';
  const emptySelection=hasChat?normalizeEnsembleChatSelection({schema:ENSEMBLE_SELECTION_SCHEMA,namespace,chatKey,revision:'initial',enabled:false,schemeIds:[],styleLock:true},{namespace,chatKey}):null;
  if(typeof isCurrent!=='function'||typeof resolveNamespace!=='function'||typeof createStorage!=='function'||!globalThis.crypto?.subtle)fail('镜组储存环境尚未就绪');
  let closed=false,storage;
  const current=()=>{try{return !closed&&isCurrent()===true;}catch(_){return false;}};
  const check=async()=>{if(!current()||await resolveNamespace()!==namespace||!current())fail('镜组账户、聊天或页面已变化');return true;};
  await check();
  const bytes=hasChat?await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([namespace,chatKey]))):null;await check();
  const slots={library:'ensemble-library',selection:hasChat?'ensemble-chat-'+[...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join(''):null};
  try{storage=await createStorage({isCurrent:current,maxBytes:MAX_BYTES});await check();if(storage.namespace!==namespace)fail('镜组保存账户不一致');}
  catch(error){storage?.close();throw error;}
  const cache=new Map(),pending=new Map(),writing=new Set(),epochs={library:0,selection:0},issued=new WeakMap();
  const normalize=(kind,value)=>{
    const result=kind==='library'?normalizeEnsembleLibrary(value):normalizeEnsembleChatSelection(value,{namespace,chatKey});
    if(result.namespace!==namespace)fail('镜组资料属于另一账户');return result;
  };
  function view(kind,receipt){
    if(receipt?.persistence!=='st-account-file'||receipt.concurrency!=='optimistic-non-cas'||typeof receipt.exists!=='boolean'
      ||(receipt.exists?!/^[a-f0-9]{64}$/.test(receipt.fingerprint||''):receipt.fingerprint!==null||receipt.value!==null))fail('镜组储存回执未通过核对');
    const value=receipt.exists?normalize(kind,receipt.value):structuredClone(kind==='library'?emptyLibrary:emptySelection);
    const result=freeze({value,exists:receipt.exists,persistence:'st-account-file',concurrency:'optimistic-non-cas'});
    issued.set(result,{kind,fingerprint:receipt.fingerprint});return result;
  }
  function invalidate(kind){epochs[kind]++;cache.delete(kind);pending.delete(kind);}
  async function read(kind,{fresh=false}={}){
    if(!slots[kind])fail('请先进入聊天，再选择本聊天的风格方案');
    await check();if(writing.has(kind))fail('镜组资料正在保存，请稍后读取');
    if(!fresh&&cache.has(kind)){await check();return cache.get(kind);}
    if(pending.has(kind)){const result=await pending.get(kind);await check();return result;}
    const epoch=epochs[kind],valid=async()=>{await check();if(epoch!==epochs[kind])fail('镜组读取已被新的操作替代');return true;};
    const task=(async()=>{const receipt=await storage.read(slots[kind],{guard:valid});await valid();const result=view(kind,receipt);cache.set(kind,result);return result;})();
    pending.set(kind,task);
    try{return await task;}catch(error){if(epoch===epochs[kind])cache.delete(kind);throw error;}
    finally{if(pending.get(kind)===task)pending.delete(kind);}
  }
  async function write(kind,value,expected){
    // Capture all user edits before the first await; never borrow a later edit
    // or silently refresh/merge against a newer remote document.
    if(!slots[kind])fail('请先进入聊天，再选择本聊天的风格方案');
    const next=normalize(kind,value),prior=issued.get(expected);
    if(!prior||prior.kind!==kind)fail('请先读取本页当前镜组版本，再保存');
    if(writing.has(kind))fail('镜组资料正在保存，请勿重复提交');
    if(kind==='selection'&&next.revision===expected.value.revision&&!equal(next,expected.value))fail('镜组选择修改需要新的版本编号');
    if(kind==='library')for(const row of next.schemes){
      const old=expected.value.schemes.find(item=>item.id===row.id);
      if(old&&old.revision===row.revision&&!equal(old,row))fail('风格方案修改需要新的版本编号');
    }
    writing.add(kind);invalidate(kind);
    try{
      await check();const receipt=await storage.write(slots[kind],next,{expectedFingerprint:prior.fingerprint,guard:check});await check();
      const result=view(kind,receipt);if(!result.exists||!equal(result.value,next))fail('镜组保存读回不一致，未确认保存');cache.set(kind,result);return result;
    }catch(error){invalidate(kind);throw error;}
    finally{writing.delete(kind);}
  }
  return Object.freeze({namespace,chatKey,persistence:'st-account-file',concurrency:'optimistic-non-cas',
    readLibrary:options=>read('library',options),readSelection:options=>read('selection',options),
    saveLibrary:(value,expected)=>write('library',value,expected),saveSelection:(value,expected)=>write('selection',value,expected),
    close(){if(closed)return;closed=true;invalidate('library');invalidate('selection');storage.close();},
  });
}
