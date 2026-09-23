import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {COMFY_POOL_LIMITS} from './qianmu-comfy-pool-store.js';
import {normalizeComfyAutoPool} from './qianmu-comfy-selection.js';
import {validateComfyPoolBackup,comfyPoolBackupDigest,planComfyPoolRestore} from './qianmu-comfy-pool-backup.js';
import {prepareComfyLegacy,exportComfyLegacy} from './qianmu-comfy-native-migration.js';
import {comfyNativeBytes as bytes,comfyNativeSame as same,comfyNativeId as validId,comfyNativeAccount as account} from './qianmu-comfy-native-contract.js';
import {COMFY_POOL_NATIVE_SLOT as slot,COMFY_POOL_ORIGINAL_SLOT,COMFY_POOL_ORIGINAL_BYTES,comfyPoolNativeFail as fail,emptyComfyPoolNativeIndex,validateComfyPoolNativeIndex,
  comfyPoolNativePacket as packet,storedComfyPoolHead as storedHead,storedComfyPoolVersion as storedVersion,createComfyPoolNativeOriginals} from './qianmu-comfy-pool-native-contract.js';

// A saved participation/style flag is configuration, not an execution grant.
// Original workflow/connection/reference bindings remain unchanged and must
// pass the ordinary generation preflight on every device.
export function createNativeComfyPoolStore({createStorage=createConfiguredStAccountStorage,legacy=null,now=Date.now,randomUUID=()=>crypto.randomUUID(),maxBytes=COMFY_POOL_LIMITS.totalBytes,requireExisting=false}={}){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>COMFY_POOL_LIMITS.totalBytes)fail('候选方案库容量配置无效');
  const family={key:'pools',limit:COMFY_POOL_LIMITS.plans,validate:validateComfyPoolBackup,pack:packet,fail,title:'候选方案',originalSlot:COMFY_POOL_ORIGINAL_SLOT,originalBytes:COMFY_POOL_ORIGINAL_BYTES};
  let client,opening,closed=false,known=requireExisting===true,queue=Promise.resolve();
  const id=value=>{if(!validId(value))fail('候选方案或版本编号无效');return value;},fresh=()=>id(randomUUID());
  const name=value=>{if(typeof value!=='string'||!value.trim()||value.trim().length>80||/[\u0000-\u001f\u007f]/.test(value))fail('请填写1至80字的候选方案名');return value.trim();};
  const clock=previous=>{const at=now();if(!Number.isSafeInteger(at)||at<0||at<(previous||0))fail('本机时间发生回退，请校准后再保存');return at;};
  const poolOf=(value,namespace)=>{const pool=normalizeComfyAutoPool(value);if(pool.namespace!==account(namespace))fail('候选方案属于另一账户，请重新绑定');if(bytes(pool)>COMFY_POOL_LIMITS.documentBytes)fail('候选方案超过原有256KiB容量上限');return pool;};
  function operation(namespace,options,work,{inventory=false}={}){
    account(namespace);const captured={...options},current=captured.isCurrent||(()=>true);
    const check=async()=>{if(closed||captured.signal?.aborted||current()!==true)fail('候选方案页面或账户已变化');if(await captured.guard?.()===false)fail('候选方案核对已取消');if(closed||captured.signal?.aborted||current()!==true)fail('候选方案页面或账户已变化');return true;};
    const task=queue.then(async()=>{
      await check();opening??=Promise.resolve().then(()=>createStorage({maxBytes:8*1048576,isCurrent:()=>!closed})).then(value=>{if(closed||value.namespace!==namespace){value.close();fail('候选方案库账户不符');}client=value;return value;}).catch(error=>{opening=null;throw error;});await opening;await check();if(client.namespace!==namespace)fail('候选方案会话不能切换账户');
      const transport={guard:check,signal:captured.signal},originals=createComfyPoolNativeOriginals(client),validate=value=>validateComfyPoolNativeIndex(value,namespace,client.scope,{maxBytes});
      const read=async()=>{const result=await client.read(slot,transport);await check();if(!result.exists&&known)fail('已确认的ST候选方案目录缺失，未建立空库');if(result.exists){validate(result.value);known=true;}return result;};
      let found=await read(),index=validate(found.exists?structuredClone(found.value):emptyComfyPoolNativeIndex(namespace)),stable=async()=>{};
      const save=async next=>{next.revision=index.revision+1;validate(next);await stable();await check();const saved=await client.write(slot,next,{...transport,expectedFingerprint:found.fingerprint});known=true;await check();if(!same(saved.value,next))fail('候选方案目录尚未读回');found=saved;index=validate(structuredClone(saved.value));};
      const ctx={get index(){return index;},get exists(){return found.exists;},originals,transport,check,save,validate};
      if(!inventory)stable=await prepareComfyLegacy({legacy,namespace,ctx,current:()=>!closed&&!captured.signal?.aborted&&current()===true,maxBytes,family});
      const result=await work(ctx);await stable();await check();if((await read()).fingerprint!==found.fingerprint)fail('候选方案库在读取期间变化，请重新核对');return structuredClone(result);
    });queue=task.then(()=>{},()=>{});return task;
  }
  const find=(index,value)=>index.pools.find(row=>row.head.id===value);
  const usage=index=>({count:index.pools.length,archived:index.pools.filter(row=>row.head.archived).length,versions:index.pools.reduce((n,row)=>n+row.versions.length,0),bytes:index.pools.reduce((n,row)=>n+row.head.totalBytes,0),limit:maxBytes,persistence:'st-account-file'});
  const list=(index,namespace,archived)=>index.pools.filter(row=>row.head.archived===Boolean(archived)).map(row=>storedHead(namespace,row.head)).sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id));
  const recovery=index=>({revision:index.revision,sources:index.sources.map(source=>({census:source.census,count:source.pools.length,versions:source.pools.reduce((n,row)=>n+row.versions.length,0),pending:source.pools.filter(row=>source.pending.includes(row.head.id)).map(row=>row.head)})),retired:index.retired.map(row=>row.head)});
  const loaded=version=>({id:version.meta.id,revision:version.meta.revision,version:version.meta.version,name:version.meta.name,pool:normalizeComfyAutoPool(version.pool)});
  const backup=async(ctx,namespace)=>{const rows=[];for(const row of ctx.index.pools){rows.push(await ctx.originals.readRow(row,ctx.transport));await ctx.check();}const result=packet(namespace,rows);validateComfyPoolBackup(result);return result;};
  return Object.freeze({
    persistence:'st-account-file',concurrency:'optimistic-non-cas',
    async view(namespace,{archived=false,...options}={}){return operation(namespace,options,async ctx=>({rows:list(ctx.index,namespace,archived),usage:usage(ctx.index),recovery:recovery(ctx.index)}));},
    async list(namespace,{archived=false,...options}={}){return operation(namespace,options,async ctx=>list(ctx.index,namespace,archived));},
    async versions(namespace,value,options={}){id(value);return operation(namespace,options,async ctx=>(find(ctx.index,value)?.versions||[]).map(row=>storedVersion(namespace,row.meta)).sort((a,b)=>b.version-a.version));},
    async load(namespace,value,revision,options={}){id(value);id(revision);return operation(namespace,options,async ctx=>{const version=find(ctx.index,value)?.versions.find(row=>row.meta.revision===revision);return version?loaded(await ctx.originals.read(version,ctx.transport)):null;});},
    async readVersion(namespace,value,revision,options={}){id(value);id(revision);return operation(namespace,options,async ctx=>{const row=find(ctx.index,value),version=row?.versions.find(row=>row.meta.revision===revision);return {head:row?storedHead(namespace,row.head):null,version:version?storedVersion(namespace,version.meta):null,value:version&&!row.head.archived?loaded(await ctx.originals.read(version,ctx.transport)):null};});},
    async save(namespace,{id:requested='',expectedRevision='',name:label,pool}={},options={}){
      account(namespace);label=name(label);const captured=poolOf(pool,namespace);if(requested){id(requested);id(expectedRevision);if(captured.id!==requested||captured.revision!==expectedRevision)fail('草稿与原候选方案版本不符，请重新载入或另存');}else if(expectedRevision)fail('新候选方案不能覆盖已有版本');
      const value=requested||fresh(),revision=fresh(),saved=poolOf({...captured,id:value,revision},namespace),documentBytes=bytes(saved);
      return operation(namespace,options,async ctx=>{
        const before=find(ctx.index,value),old=before?.head;if(requested&&!old||old&&old.revision!==expectedRevision||!requested&&(old||ctx.index.retired.some(row=>row.head.id===value)))fail('候选方案版本已变化，未覆盖');if(old?.archived)fail('请先恢复已归档的候选方案');
        if(old?.version>=COMFY_POOL_LIMITS.versions||!old&&ctx.index.pools.length>=COMFY_POOL_LIMITS.plans||usage(ctx.index).bytes+documentBytes>maxBytes)fail('候选方案达到原有数量、版本或容量上限');
        const at=clock(old?.updatedAt),head={id:value,revision,version:(old?.version||0)+1,name:label,createdAt:old?.createdAt??at,updatedAt:at,archived:false,bytes:documentBytes,totalBytes:(old?.totalBytes||0)+documentBytes,candidateCount:saved.candidates.length,enabled:saved.enabled,styleLock:saved.styleLock};
        const preserved=await ctx.originals.preserve({meta:head,pool:saved},ctx.transport),next=structuredClone(ctx.index);next.pools=next.pools.filter(row=>row.head.id!==value);next.pools.push({head,versions:[...(before?.versions||[]),preserved]});await ctx.save(next);return storedHead(namespace,head);
      });
    },
    async archive(namespace,value,expectedRevision,archived=true,options={}){id(value);id(expectedRevision);if(typeof archived!=='boolean')fail('归档状态无效');return operation(namespace,options,async ctx=>{const row=find(ctx.index,value);if(!row||row.head.revision!==expectedRevision)fail('候选方案已变化');const next=structuredClone(ctx.index),target=find(next,value);target.head.archived=archived;target.head.updatedAt=clock(target.head.updatedAt);await ctx.save(next);return storedHead(namespace,target.head);});},
    async purge(namespace,value,expectedRevision,options={}){id(value);id(expectedRevision);return operation(namespace,options,async ctx=>{const row=find(ctx.index,value);if(!row||row.head.revision!==expectedRevision||!row.head.archived)fail('仅可移出未变化的归档候选方案');const next=structuredClone(ctx.index);next.pools=next.pools.filter(row=>row.head.id!==value);next.retired.push(row);await ctx.save(next);return {removed:row.versions.length,bytes:row.head.totalBytes,retained:true};});},
    async usage(namespace,options={}){return operation(namespace,options,async ctx=>usage(ctx.index));},
    async storageSummary(namespace,options={}){return operation(namespace,options,async ctx=>{
      if(legacy){const census=await legacy.census(namespace,{isCurrent:()=>!closed}),digest=await comfyPoolBackupDigest(census);await ctx.check();if(census.heads.length&&!ctx.index.sources.some(row=>row.census===digest))fail('本机旧候选方案库尚有未接入内容，请先打开候选方案完成核对');}
      const u=usage(ctx.index),indexBytes=ctx.exists?bytes(ctx.index):0;return {status:'ready',count:u.count,archived:u.archived,versions:u.versions,documentBytes:u.bytes,indexBytes,bytes:u.bytes+indexBytes};
    },{inventory:true});},
    async backup(namespace,options={}){return operation(namespace,options,ctx=>backup(ctx,namespace));},
    async recoverySources(namespace,options={}){return operation(namespace,options,async ctx=>recovery(ctx.index));},
    async exportLegacy(namespace,census,options={}){return operation(namespace,options,ctx=>exportComfyLegacy(ctx,namespace,census,family));},
    async resolveLegacy(namespace,{census,id:value,choice,expectedRevision,confirmed=false},options={}){
      id(value);if(confirmed!==true||!['keep','copy'].includes(choice)||!Number.isSafeInteger(expectedRevision))fail('请先核对旧候选方案来源');
      return operation(namespace,options,async ctx=>{
        if(ctx.index.revision!==expectedRevision)fail('旧方案核对期间目录已变化');const next=structuredClone(ctx.index),source=next.sources.find(row=>row.census===census);if(!source?.pending.includes(value))fail('旧方案已核对或不存在');
        if(choice==='copy'){
          const original=await ctx.originals.readRow(source.pools.find(row=>row.head.id===value),ctx.transport),newId=fresh(),at=clock(original.head.updatedAt);
          if(next.pools.length>=COMFY_POOL_LIMITS.plans||[...next.pools,...next.retired].some(row=>row.head.id===newId))fail('候选方案副本数量或编号不符');
          const copies=[];let totalBytes=0;for(const version of original.versions){const revision=fresh(),pool=poolOf({...version.pool,id:newId,revision},namespace),size=bytes(pool);totalBytes+=size;
            copies.push({meta:{...version.meta,id:newId,revision,name:version.meta.name.slice(0,75)+' 副本',bytes:size,totalBytes},pool});}
          if(usage(next).bytes+totalBytes>maxBytes)fail('另存完整候选方案副本超出容量');const versions=[];for(const version of copies)versions.push(await ctx.originals.preserve(version,ctx.transport));
          next.pools.push({head:{...copies.at(-1).meta,archived:original.head.archived,updatedAt:at},versions});
        }
        source.pending=source.pending.filter(id=>id!==value);await ctx.save(next);return {resolved:true,choice};
      });
    },
    async restoreRetired(namespace,value,{expectedRevision,confirmed=false,...options}={}){id(value);if(confirmed!==true)fail('请先确认恢复移出的候选方案');return operation(namespace,options,async ctx=>{const row=ctx.index.retired.find(row=>row.head.id===value);if(!row||ctx.index.revision!==expectedRevision)fail('移出的候选方案已变化');await ctx.originals.readRow(row,ctx.transport);const next=structuredClone(ctx.index);next.retired=next.retired.filter(row=>row.head.id!==value);next.pools.push(row);await ctx.save(next);return storedHead(namespace,row.head);});},
    async restoreBackup(namespace,input,{confirmed=false,expectedDigest,...options}={}){
      account(namespace);if(confirmed!==true||typeof expectedDigest!=='string'||!/^[a-f0-9]{64}$/.test(expectedDigest))fail('请先核对并确认候选方案库恢复');const incoming=structuredClone(input);validateComfyPoolBackup(incoming);if(incoming.namespace!==namespace)fail('候选方案备份属于另一ST账户，不自动重绑');
      return operation(namespace,options,async ctx=>{const local=await backup(ctx,namespace);if(await comfyPoolBackupDigest(local)!==expectedDigest)fail('候选方案库在确认后已变化');const plan=planComfyPoolRestore(local,incoming,{maxBytes}),next=structuredClone(ctx.index);
        for(const row of plan.writes){if(next.retired.some(item=>item.head.id===row.head.id))fail('此候选方案已移出目录，请从保留原件恢复，未因旧备份复活');const previous=find(next,row.head.id),versions=[...(previous?.versions||[])];for(const version of row.versions)versions.push(await ctx.originals.preserve(version,ctx.transport));next.pools=next.pools.filter(item=>item.head.id!==row.head.id);next.pools.push({head:row.head,versions});}
        if(plan.writes.length)await ctx.save(next);return plan.summary;
      });
    },
    close(){closed=true;client?.close();legacy?.close();},
  });
}
