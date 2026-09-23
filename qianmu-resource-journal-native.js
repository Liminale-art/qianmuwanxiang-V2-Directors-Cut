import {createConfiguredStAccountStorage,stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {validateResourceRestoreCheckpoint as validate,prepareResourceCheckpoint,advanceResourceCheckpoint} from './qianmu-resource-journal-contract.js';
import {vibeDigest} from './qianmu-vibe-file.js';

const schema='qianmu.resource-journal.v1',originalSlot='resource-journal-original',same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=message=>{throw Object.assign(Error(message),{code:'resource_journal_native',submissionState:'not_submitted'});};
const slot=kind=>`resource-journal-${kind}`;
const envelope=(namespace,kind,row,legacy=[],closed=false)=>({schema,namespace,kind,row,legacy,closed});

// Two small native heads, not model permissions. Immutable versions and old IDB
// rows remain intact. Optimistic readback is not a cross-device lock or CAS.
export function createNativeResourceJournal({legacy,createStorage=createConfiguredStAccountStorage,now=Date.now}={}){
  let opening,storage,closed=false,busy=false;const known=new Set();
  async function operation(namespace,kind,options,work){
    if(busy||closed)fail('资源恢复记录正在核对或已关闭');
    if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace)||!['characters','bundle'].includes(kind))fail('资源恢复账户或类型无效');
    busy=true;
    const check=async()=>{if(closed||options.signal?.aborted||options.isCurrent&&options.isCurrent()!==true)fail('资源恢复页面或账户已变化');await options.guard?.();
      if(closed||options.signal?.aborted||options.isCurrent&&options.isCurrent()!==true)fail('资源恢复页面或账户已变化');return true;};
    try{
      await check();opening??=Promise.resolve().then(()=>createStorage({isCurrent:()=>!closed,maxBytes:256*1024})).then(value=>{
        if(closed){value.close();fail('资源恢复页面已关闭');}storage=value;return value;
      }).catch(error=>{opening=null;throw error;});
      const client=await opening;await check();if(client.namespace!==namespace)fail('资源恢复记录账户不符');
      const transport={guard:check,signal:options.signal};
      function inspect(value){
        if(!exact(value,['schema','namespace','kind','row','legacy','closed'])||value.schema!==schema||value.namespace!==namespace||value.kind!==kind||typeof value.closed!=='boolean'
          ||!Array.isArray(value.legacy)||value.legacy.length>256)fail('资源恢复目录损坏');
        validate(value.row);if(value.row.namespace!==namespace||value.row.kind!==kind)fail('资源恢复目录归属不符');const seen=new Set();
        for(const source of value.legacy){if(!exact(source,['digest','reference'])||typeof source.digest!=='string'||!/^[a-f0-9]{64}$/.test(source.digest)||seen.has(source.digest))fail('资源恢复旧源目录损坏');
          stAccountImmutableReference(source.reference,{scope:client.scope,slot:originalSlot,maxBytes:256*1024+1024});seen.add(source.digest);}
        return value;
      }
      async function read(){const result=await client.read(slot(kind),transport);await check();if(!result.exists&&known.has(kind))fail('已确认的资源恢复目录缺失，未重建空记录');
        if(result.exists){inspect(result.value);known.add(kind);}return result;}
      async function old(){const row=structuredClone(await legacy.loadResource(namespace,kind));await check();if(row){validate(row);if(row.namespace!==namespace||row.kind!==kind)fail('本机资源恢复记录归属不符');}return row||null;}
      async function write(value,before,baseline){
        inspect(value);const guard=async()=>{await check();if(!same(await old(),baseline))fail('本机旧页面更新了资源恢复记录，未覆盖');return true;};
        await guard();const saved=await client.write(slot(kind),value,{...transport,expectedFingerprint:before.fingerprint,guard});known.add(kind);await check();
        if(!saved.exists||!same(saved.value,value))fail('资源恢复记录尚未完整读回');inspect(saved.value);
        if((await read()).fingerprint!==saved.fingerprint)fail('另一设备已更新资源恢复记录，请重新核对');return saved;
      }
      let found=await read();const baseline=await old();
      if(baseline){
        const digest=await vibeDigest(JSON.stringify(baseline)),source=found.value?.legacy.find(row=>row.digest===digest);await check();
        if(source){const original=await client.readImmutable(source.reference,transport);await check();if(!same(original.value,baseline))fail('本机恢复旧源与保全原件不符');}
        else{
          if(found.exists&&!same(found.value.row,baseline))fail('ST与本机有不同的资源恢复记录，均已保留，请先核对原记录');
          const original=await client.preserveImmutable(originalSlot,baseline,transport);await check();if(!same(original.value,baseline))fail('资源恢复旧源尚未完整保全');
          const value=found.exists?structuredClone(found.value):envelope(namespace,kind,baseline);
          value.legacy.push({digest,reference:original.reference});found=await write(value,found,baseline);
        }
      }
      const state={found,row:found.exists&&!found.value.closed?found.value.row:null,check,
        save:async(row,ended=false)=>{const value=envelope(namespace,kind,row,found.value?.legacy||[],ended);found=await write(value,found,baseline);return structuredClone(row);}};
      const result=await work(state);await check();if(!same(await old(),baseline))fail('本机资源恢复记录已变化，请重新核对');
      if((await read()).fingerprint!==found.fingerprint)fail('资源恢复记录在核对期间已变化');return result;
    }finally{busy=false;}
  }
  return Object.freeze({...legacy,
    loadResource(namespace,kind='characters',options={}){return operation(namespace,kind,options,async state=>structuredClone(state.row));},
    async prepareResource(input,{previous=null,confirmed=false,...options}={}){
      const descriptor=structuredClone(input),approved=structuredClone(previous);
      if(confirmed!==true)fail('请先确认资源恢复');
      // Validate before any migration/network write; malformed requests cannot publish a checkpoint.
      prepareResourceCheckpoint(descriptor,approved,approved,now());
      return operation(descriptor.namespace,descriptor.kind,options,state=>state.save(prepareResourceCheckpoint(descriptor,approved,state.row,now())));
    },
    async updateResource(input,phase,options={}){const previous=structuredClone(validate(input));advanceResourceCheckpoint(previous,previous,phase,now());
      return operation(previous.namespace,previous.kind,options,state=>state.save(advanceResourceCheckpoint(previous,state.row,phase,now())));},
    async dismissResource(input,{confirmed=false,...options}={}){const previous=structuredClone(validate(input));
      if(confirmed!==true)fail('请先确认结束资源恢复核对');
      return operation(previous.namespace,previous.kind,options,async state=>{if(!same(state.row,previous))fail('资源恢复记录已变化，未结束');await state.save(previous,true);return true;});},
    close(){closed=true;storage?.close();legacy.close();},
  });
}
