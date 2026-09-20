import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {createNotesSyncClient} from './qianmu-notes-sync-client.js';
import {NOTES_SYNC_LIMITS,notesSyncError,notesSyncMutationId,notesSyncWriteRequest,notesSyncListResponse,notesSyncWriteResponse,notesSyncConflictResponse} from './qianmu-notes-sync-contract.js';

const schema='qianmu.notes-native.v1';
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const fail=(code,message)=>{throw notesSyncError(code,message);};
const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');

// Contract-compatible note transport, but NOT the old backend's atomic CAS.
// Legacy access is read-only and only before the native migration marker exists.
export async function createNotesNativeClient({namespace,headers,guard=()=>true,store=null,legacyClient=null,fetchImpl=globalThis.fetch,now=Date.now}={}){
  if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||typeof guard!=='function')fail('account','便笺账户环境无效');
  const expectedAccount='st-user:'+await hash(namespace.slice(8));let closed=false,tail=Promise.resolve(),owned=!store;
  async function check(){if(closed||await guard()===false||closed)fail('account','便笺账户或页面已变化');return true;}
  await check();store ||= await createConfiguredStAccountStorage({maxBytes:NOTES_SYNC_LIMITS.bytes,isCurrent:()=>!closed});
  if(store.namespace!==namespace){if(owned)store.close();fail('account','便笺储存账户不一致');}
  const options=signal=>({signal,guard:check});
  function validate(value){
    if(!exact(value,['schema','expectedAccount','revision','notes','legacyRevision','mutations'])||value.schema!==schema||value.expectedAccount!==expectedAccount
      ||!integer(value.legacyRevision)||!Array.isArray(value.mutations)||value.mutations.length>NOTES_SYNC_LIMITS.mutations||value.revision!==value.legacyRevision+value.mutations.length)fail('corrupt','便笺原生资料格式或账户不一致，未覆盖');
    notesSyncListResponse({ok:true,version:1,expectedAccount,revision:value.revision,notes:value.notes});
    const seen=new Set();
    for(let at=0;at<value.mutations.length;at++){
      const row=value.mutations[at];if(!exact(row,['mutationId','hash','revision','updatedAt'])||!notesSyncMutationId(row.mutationId)||seen.has(row.mutationId)
        ||typeof row.hash!=='string'||!/^[a-f0-9]{64}$/.test(row.hash)||row.revision!==value.legacyRevision+at+1||!integer(row.updatedAt))fail('corrupt','便笺保存凭据无效，未覆盖');seen.add(row.mutationId);
    }
    return value;
  }
  async function migrate(signal){
    await check();const prior=await store.read('notes',options(signal));await check();if(prior.exists)return validate(prior.value);
    let legacy,legacyStatus=0,client=legacyClient;
    if(!client)client=createNotesSyncClient({namespace,headers,guard:check,fetchImpl:async(url,request)=>{
      if(request.method!=='GET')fail('migration','迁移只允许读取旧便笺');const response=await fetchImpl(url,request);legacyStatus=response.status;return response;
    }});
    try{legacy=notesSyncListResponse(await client.list({signal}));if(legacy.expectedAccount!==expectedAccount)fail('account','旧便笺不属于当前账户');}
    catch(cause){if(cause?.code==='notes_sync_unavailable'&&(legacyStatus===404||cause.status===404))legacy={ok:true,version:1,expectedAccount,revision:0,notes:[]};else throw cause;}
    finally{if(!legacyClient)client.close();}
    await check();const value={schema,expectedAccount,revision:legacy.revision,notes:legacy.notes,legacyRevision:legacy.revision,mutations:[]};
    const saved=await store.write('notes',value,{...options(signal),expectedFingerprint:null});await check();return validate(saved.value);
  }
  function serial(work){
    const operation=tail.catch(()=>{}).then(async()=>{await check();try{return await work();}catch(cause){
      if(String(cause?.code||'').startsWith('notes_sync_'))throw cause;
      const result=notesSyncError('storage',cause?.code==='st_account_storage_conflict'?'便笺已有其他更新，本次内容已保留，将重新核对':'ST 便笺保存未确认，内容已保留');
      result.writeState=cause?.writeState==='unconfirmed'?'unconfirmed':'not_started';throw result;
    }});tail=operation;return operation;
  }
  const rowFor=(body,revision,updatedAt)=>({id:body.id,...(body.deleted?{title:'',body:'',pinned:false,createdAt:body.note.createdAt}:body.note),updatedAt,revision,deleted:body.deleted});
  const response=note=>notesSyncWriteResponse({ok:true,version:1,expectedAccount,revision:note.revision,note});
  return Object.freeze({concurrency:'optimistic-non-cas',
    list({signal}={}){return serial(async()=>{const value=await migrate(signal);await check();return notesSyncListResponse({ok:true,version:1,expectedAccount,revision:value.revision,notes:value.notes});});},
    write(input,{signal}={}){
      let body;try{body=notesSyncWriteRequest({...input,version:1,expectedAccount});}catch(cause){return Promise.reject(cause);}
      return serial(async()=>{
        await migrate(signal);const fingerprint=await hash(JSON.stringify(body));await check();let outcome,failure;
        const saved=await store.update('notes',raw=>{
          try{
            const value=validate(raw),receipt=value.mutations.find(row=>row.mutationId===body.mutationId),previous=value.notes.find(row=>row.id===body.id);
            if(receipt){if(receipt.hash!==fingerprint)fail('mutation_conflict','便笺请求编号已用于其他内容，未覆盖');outcome=response(rowFor(body,receipt.revision,receipt.updatedAt));return value;}
            if((previous?.revision||0)!==body.baseRevision||previous?.deleted){
              outcome=notesSyncConflictResponse({ok:false,version:1,code:'notes_sync_conflict',message:'便笺已有其他更新，本页内容会保留为副本',writeState:'not_started',expectedAccount,revision:value.revision,note:previous||null});return value;
            }
            if(previous&&previous.createdAt!==body.note.createdAt)fail('contract','便笺创建时间不可更改');
            if(!previous&&value.notes.length>=NOTES_SYNC_LIMITS.notes||value.mutations.length>=NOTES_SYNC_LIMITS.mutations)fail('capacity','便笺达到储存上限，原内容未截断');
            const revision=value.revision+1,updatedAt=Math.max(now(),(previous?.updatedAt||0)+1);
            if(!integer(revision)||!integer(updatedAt))fail('clock','便笺保存时间或版本无效');
            const note=rowFor(body,revision,updatedAt);outcome=response(note);
            return {...value,revision,notes:previous?value.notes.map(row=>row.id===note.id?note:row):[...value.notes,note],mutations:[...value.mutations,{mutationId:body.mutationId,hash:fingerprint,revision,updatedAt}]};
          }catch(cause){failure=cause;return raw;}
        },options(signal));
        await check();if(failure)throw failure;validate(saved.value);return outcome;
      });
    },
    close(){closed=true;if(owned)store.close();legacyClient?.close?.();},
  });
}
