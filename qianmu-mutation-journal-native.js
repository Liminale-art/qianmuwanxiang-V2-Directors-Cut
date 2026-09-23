import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {validateStoryboardMutation as validate} from './qianmu-storyboard-package-mutation.js';
import {createMutationJournalBody,validateMutationBodyReference,assertMutationBodyValue} from './qianmu-mutation-journal-body.js';
import {vibeDigest} from './qianmu-vibe-file.js';

const slot='configuration-mutation-journal',schema='qianmu.configuration-mutation-journal.v1',same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=message=>{throw Object.assign(Error(message),{code:'mutation_journal_native',submissionState:'not_submitted'});};
const bodyOf=({namespace,chatHash,fileHash,version,createdAt,patch})=>({namespace,chatHash,fileHash,version,createdAt,patch});
const sameRow=(a,b)=>Boolean(a&&b&&a.phase===b.phase&&a.revision===b.revision&&same(bodyOf(a),bodyOf(b)));
const envelope=(row,reference,closed=false)=>({schema,namespace:row.namespace,reference,phase:row.phase,revision:row.revision,closed});
const markerSlot=digest=>`mutation-journal-ended-${digest}`;

// A complete before/after journal, not approval to mutate live settings. Existing
// callers must obtain fresh confirmation and verify their live objects as before.
export function createNativeMutationJournal({legacy,createStorage=createConfiguredStAccountStorage}={}){
  let opening,storage,closed=false,busy=false,known=false;
  async function operation(namespace,options,work,presenceOnly=false){
    if(closed||busy)fail('配置恢复记录正在核对或已关闭');
    if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace))fail('配置恢复账户无效');
    busy=true;
    const check=async()=>{if(closed||options.signal?.aborted||options.isCurrent&&options.isCurrent()!==true)fail('配置恢复页面或账户已变化');await options.guard?.();
      if(closed||options.signal?.aborted||options.isCurrent&&options.isCurrent()!==true)fail('配置恢复页面或账户已变化');return true;};
    try{
      await check();opening??=Promise.resolve().then(()=>createStorage({isCurrent:()=>!closed,maxBytes:512*1024})).then(value=>{
        if(closed){value.close();fail('配置恢复页面已关闭');}storage=value;return value;
      }).catch(error=>{opening=null;throw error;});
      const client=await opening;await check();if(client.namespace!==namespace)fail('配置恢复账户不符');
      const transport={guard:check,signal:options.signal},bodies=createMutationJournalBody(client,transport,check);
      function inspect(value){
        if(!exact(value,['schema','namespace','reference','phase','revision','closed'])||value.schema!==schema||value.namespace!==namespace||typeof value.closed!=='boolean'
          ||!['prepared','applied','uncertain'].includes(value.phase)||!Number.isSafeInteger(value.revision)||value.revision<1)fail('配置恢复目录损坏');
        validateMutationBodyReference(value.reference,client.scope);return value;
      }
      async function read(){const saved=await client.read(slot,transport);await check();if(!saved.exists&&known)fail('已确认的配置恢复目录缺失，未重建空记录');
        if(saved.exists){inspect(saved.value);known=true;}return saved;}
      async function unpack(value){inspect(value);const body=await bodies.read(value.reference);await check();
        if(!exact(body,['namespace','chatHash','fileHash','version','createdAt','patch'])||body.namespace!==namespace)fail('配置恢复完整原件归属不符');
        return validate({...body,phase:value.phase,revision:value.revision});}
      async function old(){const row=structuredClone(await legacy.loadMutation(namespace));await check();if(row){validate(row);assertMutationBodyValue(bodyOf(row));if(row.namespace!==namespace)fail('本机配置恢复记录账户不符');}return row||null;}
      let found=await read();
      // High-floor archive writers only need the pending flag. With no legacy
      // row, do not download/decode a potentially 64 MiB before/after body.
      if(presenceOnly&&typeof legacy.hasConfigurationMutation==='function'&&!await legacy.hasConfigurationMutation(namespace)){
        await check();const present=found.exists&&!found.value.closed;
        if(await legacy.hasConfigurationMutation(namespace)||(await read()).fingerprint!==found.fingerprint)fail('配置恢复待办在检查期间变化');return present;
      }
      const baseline=await old();
      async function unchanged(){await check();if(!same(await old(),baseline))fail('本机旧页面更新了配置恢复记录，未覆盖');return true;}
      async function write(value){inspect(value);await unchanged();const saved=await client.write(slot,value,{...transport,guard:unchanged,expectedFingerprint:found.fingerprint});known=true;await check();
        if(!saved.exists||!same(saved.value,value))fail('配置恢复记录尚未完整读回');found=saved;return unpack(saved.value);}
      if(baseline){
        const digest=await vibeDigest(JSON.stringify(bodyOf(baseline)));await check();let ended=false;
        if(found.exists&&found.value.reference.digest===digest){
          if(baseline.revision>found.value.revision||baseline.revision===found.value.revision&&baseline.phase!==found.value.phase)fail('本机配置恢复记录比ST更新，双方已保留');
        }else{
          const receipt=await client.read(markerSlot(digest),transport);await check();
          if(receipt.exists){const value=inspect(receipt.value);
            if(!value.closed||value.reference.digest!==digest||baseline.revision>value.revision||baseline.revision===value.revision&&baseline.phase!==value.phase)fail('本机配置恢复结束依据不符');
            // Verify retained original bytes, not merely a marker that could hide a lost source.
            if(!same(bodyOf(await unpack(value)),bodyOf(baseline)))fail('本机配置恢复结束原件不符');ended=true;
          }
          if(!ended&&found.exists)fail('ST与本机有两份不同的配置恢复记录，均已保留，请先核对');
        }
        if(!found.exists&&!ended){const reference=await bodies.preserve(bodyOf(baseline));await write(envelope(baseline,reference));}
      }
      let original=found.exists?await unpack(found.value):null;
      const result=await work({row:found.value?.closed?null:original,check,
        async save(row,{ended=false,replace=false}={}){
          if(replace&&found.exists){const marker=envelope(original,found.value.reference,true),name=markerSlot(marker.reference.digest),before=await client.read(name,transport);await check();
            if(before.exists){inspect(before.value);if(!before.value.closed||before.value.reference.digest!==marker.reference.digest||before.value.revision>marker.revision
              ||before.value.revision===marker.revision&&before.value.phase!==marker.phase)fail('原配置恢复结束依据发生变化');}
            if(!before.exists||!same(before.value,marker))await client.write(name,marker,{...transport,expectedFingerprint:before.fingerprint,guard:unchanged});await check();}
          // Bundle previews intentionally use createdAt=0. A later explicit run
          // can have the exact same body; do not reset its revision below an old
          // retained IDB row or make the next ending marker ambiguous.
          if(replace&&original&&same(bodyOf(original),bodyOf(row)))row=validate({...row,revision:Math.max(row.revision,original.revision+1)});
          const body=bodyOf(row),reference=original&&same(bodyOf(original),body)?found.value.reference:await bodies.preserve(body);
          await options.nativeHistoricalCheck?.();await check();const saved=await write(envelope(row,reference,ended));
          await options.nativeHistoricalCheck?.();await check();original=saved;return structuredClone(saved);
        }});
      await unchanged();if((await read()).fingerprint!==found.fingerprint)fail('配置恢复目录在核对期间已变化');return result;
    }finally{busy=false;}
  }
  return Object.freeze({...legacy,
    hasConfigurationMutation(namespace,options={}){return operation(namespace,options,async state=>Boolean(state.row),true);},
    loadMutation(namespace,options={}){return operation(namespace,options,async state=>structuredClone(state.row));},
    async prepareMutation(input,options={}){const row=structuredClone(validate(input));if(row.phase!=='prepared'||row.revision!==1)fail('配置恢复必须从准备阶段开始');
      return operation(row.namespace,options,async state=>{if(state.row)fail('本账户已有待核对的分镜导入，请先处理恢复记录');await options.nativeHistoricalCheck?.();return state.save(row,{replace:true});});},
    async updateMutation(input,phase,options={}){const previous=structuredClone(validate(input));if(!['applied','uncertain'].includes(phase))fail('配置恢复阶段无效');
      return operation(previous.namespace,options,state=>{if(!sameRow(state.row,previous))fail('配置恢复记录已变化，请重新核对');return state.save(validate({...previous,phase,revision:previous.revision+1}));});},
    async dismissMutation(input,{confirmed=false,...options}={}){const previous=structuredClone(validate(input));if(confirmed!==true)fail('请明确确认结束配置恢复核对');
      return operation(previous.namespace,options,async state=>{if(!sameRow(state.row,previous))fail('配置恢复记录已变化，未结束');await state.save(previous,{ended:true});return true;});},
    close(){closed=true;storage?.close();legacy.close();},
  });
}
