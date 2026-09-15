import {createCurrentChatCharacterReceiptClient} from './qianmu-chat-character-receipt-client.js';
import {chatCharacterCollectionReceiptText} from './qianmu-chat-character-receipt.js';
import {readChatCharacterCollection,prepareChatCharacterMetadataWrite} from './qianmu-character-chat-batch.js';
import {characterArchiveError} from './qianmu-character-archive.js';

const fail=message=>{throw characterArchiveError('chat_save',message);};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),byte=>byte.toString(16).padStart(2,'0')).join('');
const activeSaves=new WeakMap();

// Write-through to the HOST'S current-chat save only. No direct /api/chats/save, whole-chat copy, or second writer.
// Unconfirmed intent remains in this session until verified; it is not a cross-refresh recovery journal.
export async function createChatCharacterSaveSession({getContext,epoch,account,guard,isCurrent,headers,fetchImpl,timeoutMs=10000}={}){
  if(typeof guard!=='function'||typeof isCurrent!=='function'||!Number.isFinite(timeoutMs))fail('人物保存缺少当前账户、来源及聊天保护');
  const checkGuard=async()=>{if(await guard()===false)fail('当前人物来源检查未通过，未继续保存');};
  const client=await createCurrentChatCharacterReceiptClient({getContext,epoch,account,guard:checkGuard,headers,fetchImpl,timeoutMs});
  client.assertCurrent();const context=getContext(),store=context.chatMetadata?.story_director_liminale,saveHost=context.saveMetadata;
  if(!store||typeof store!=='object'||Array.isArray(store)||typeof saveHost!=='function'){client.close();fail('当前聊天资料或 ST 保存接口尚未就绪');}
  let closed=false,busy=false,hostPending=false,intent=null,cancelOperation=null;const owner=client.owner,token={};
  const release=()=>{if(!busy&&!hostPending&&activeSaves.get(store)===token)activeSaves.delete(store);};
  const check=()=>{
    if(closed||isCurrent()!==true)fail('当前聊天、来源或账户已变化，原保存暂停');
    client.assertCurrent();
    if(getContext().chatMetadata?.story_director_liminale!==store||getContext().saveMetadata!==saveHost)fail('当前聊天资料或保存接口已变化');
    if(closed)fail('人物保存会话已结束');
  };
  const guarded=async()=>{check();await checkGuard();check();};
  const local=()=>{
    const present=Object.hasOwn(store,'characterDrafts'),collection=readChatCharacterCollection(store,owner);
    if(present&&chatCharacterCollectionReceiptText(store.characterDrafts,owner).text!==chatCharacterCollectionReceiptText(collection,owner).text)fail('人物资料包含未识别字段，请先保全，不会规范化后覆盖');
    return {present,collection};
  };
  const localMatches=state=>{const current=local();return current.present===state.present&&equal(current.collection,state.collection);};
  async function receiptMatches(receipt,state){
    if(!state.present)return receipt.state==='absent';
    if(receipt.state!=='present')return false;
    const summary=chatCharacterCollectionReceiptText(state.collection,owner),sha256=await digest(summary.text);
    return receipt.collection.sha256===sha256&&['revision','count','bytes'].every(key=>receipt.collection[key]===summary[key]);
  }
  const pending=()=>intent?structuredClone(intent):null;
  const unknown=reason=>({status:'unconfirmed',reason,pending:pending()});
  async function verifyCurrent(){
    await guarded();if(!localMatches({present:true,collection:intent.after}))fail('本地人物资料已变化，未覆盖新内容');
    const receipt=await client.inspect();const matches=await receiptMatches(receipt,{present:true,collection:intent.after});await guarded();
    if(!localMatches({present:true,collection:intent.after}))fail('核验期间人物资料已变化');
    if(!matches)return unknown('readback_mismatch');
    const revision=intent.after.revision;intent=null;return {status:'saved',revision};
  }
  async function invokeHost(){
    check();hostPending=true;let operation;
    try{operation=Promise.resolve(saveHost.call(context));}catch(error){hostPending=false;operation=Promise.reject(error);}
    const settled=operation.then(()=>{hostPending=false;release();return 'settled';},()=>{hostPending=false;release();return 'failed';});
    let timer;const deadline=new Promise(resolve=>{timer=setTimeout(()=>resolve('timeout'),Math.max(100,Math.min(30000,timeoutMs)));});
    const result=await Promise.race([settled,deadline]);clearTimeout(timer);
    if(result==='timeout')return unknown('host_pending');
    // The host may swallow failures or throw after committing. Only a scoped readback can confirm the expected snapshot.
    return verifyCurrent();
  }
  async function exclusive(work){
    check();if(busy||hostPending||activeSaves.has(store)&&activeSaves.get(store)!==token)fail('上一项人物保存尚未结束，请先核对结果');busy=true;activeSaves.set(store,token);
    let timer;const cancellation=new Promise((_,reject)=>{
      cancelOperation=()=>reject(characterArchiveError('chat_save_cancelled','人物保存等待已结束，请保留当前内容核对'));
      timer=setTimeout(()=>{closed=true;client.close();cancelOperation?.();},Math.max(300,Math.min(30000,timeoutMs*3)));
    });
    try{return await Promise.race([Promise.resolve().then(work),cancellation]);}
    catch(error){if(intent)return unknown('needs_review');throw error;}
    finally{clearTimeout(timer);cancelOperation=null;busy=false;release();}
  }
  return Object.freeze({owner,target:client.target,pending,close(){closed=true;client.close();cancelOperation?.();},
    save(next,{expectedRevision}={}){return exclusive(async()=>{
      if(intent)fail('仍有待核对的人物保存，请先核对原结果');
      await guarded();const before=local(),prepared=prepareChatCharacterMetadataWrite(store,next,{owner,expectedRevision});
      if(!prepared.changed)return {status:'unchanged',revision:before.collection.revision};
      const after=structuredClone(prepared.collection),receipt=await client.inspect();
      const baseline=await receiptMatches(receipt,before);await guarded();
      if(!baseline||!localMatches(before))fail('服务器或当前人物资料已变化，未覆盖，请先重新核对');
      // Synchronous final guard, field assignment and host invocation. Never assign a captured draft after an await.
      check();intent={owner:{...owner},target:{...client.target},before:structuredClone(before),after};
      store.characterDrafts=structuredClone(after);
      return invokeHost();
    });},
    verify(){return exclusive(async()=>{if(!intent)return {status:'idle'};return verifyCurrent();});},
    retry({confirmed=false}={}){return exclusive(async()=>{
      if(confirmed!==true)fail('请先确认重试此聊天尚未核对的人物保存');
      if(!intent)return {status:'idle'};await guarded();
      if(!localMatches({present:true,collection:intent.after}))fail('本地人物资料已变化，不会补写旧内容');
      const receipt=await client.inspect();
      if(await receiptMatches(receipt,{present:true,collection:intent.after}))return verifyCurrent();
      if(!await receiptMatches(receipt,intent.before))fail('原聊天在服务器上已变化，不会重发旧资料');
      await guarded();if(!localMatches({present:true,collection:intent.after}))fail('重试前人物资料已变化');
      return invokeHost();
    });},
  });
}
