import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {normalizeComfyLibraryDocument,inspectComfyLibraryDocument} from './qianmu-comfy-library.js';
import {validateComfyLibraryBackup,comfyLibraryBackupDigest,planComfyLibraryRestore} from './qianmu-comfy-library-backup.js';
import {prepareComfyLegacy,exportComfyLegacy} from './qianmu-comfy-native-migration.js';
import {COMFY_NATIVE_SLOT,comfyNativeFail as fail,comfyNativeSame as same,comfyNativeBytes as bytes,comfyNativeId as id,
  comfyNativeAccount,emptyComfyNativeIndex,validateComfyNativeIndex,comfyNativePacket,comfyNativeStoredHead as storedHead,
  comfyNativeStoredVersion as storedVersion,createComfyNativeOriginals} from './qianmu-comfy-native-contract.js';

// Complete same-account versioned library. ST file heads provide optimistic
// conflict detection, NOT cross-device CAS or permission to execute workflows.
export function createNativeComfyWorkflowStore({createStorage=createConfiguredStAccountStorage,legacy=null,now=Date.now,randomUUID=()=>crypto.randomUUID(),maxBytes=64*1048576,requireExisting=false}={}){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>64*1048576)fail('工作流库容量配置无效');
  let client,opening,closed=false,known=requireExisting===true,queue=Promise.resolve();
  const fresh=()=>{const value=randomUUID();if(!id(value))fail('工作流编号无效');return value;};
  const clock=previous=>{const value=now();if(!Number.isSafeInteger(value)||value<0)fail('工作流保存时间无效');return Math.max(value,previous||0);};
  const checkId=value=>{if(!id(value))fail('工作流方案或版本编号无效');};
  function operation(namespace,options,work){
    comfyNativeAccount(namespace);const captured={...options},current=captured.isCurrent||(()=>true);
    const check=async()=>{if(closed||captured.signal?.aborted||current()!==true)fail('工作流页面或账户已变化');if(await captured.guard?.()===false)fail('工作流核对已取消');if(closed||captured.signal?.aborted||current()!==true)fail('工作流页面或账户已变化');return true;};
    const task=queue.then(async()=>{
      await check();opening??=Promise.resolve().then(()=>createStorage({maxBytes:8*1048576,isCurrent:()=>!closed})).then(value=>{
        if(closed||value.namespace!==namespace){value.close();fail('工作流库账户不符');}client=value;return value;
      }).catch(error=>{opening=null;throw error;});await opening;await check();if(client.namespace!==namespace)fail('工作流会话不能切换账户');
      const transport={guard:check,signal:captured.signal},originals=createComfyNativeOriginals(client),validate=value=>validateComfyNativeIndex(value,namespace,client.scope,{maxBytes});
      async function read(){const result=await client.read(COMFY_NATIVE_SLOT,transport);await check();if(!result.exists&&known)fail('已确认的ST工作流目录缺失，未建立空库');if(result.exists){validate(result.value);known=true;}return result;}
      let found=await read(),index=validate(found.exists?structuredClone(found.value):emptyComfyNativeIndex(namespace)),stable=async()=>{};
      async function save(next){
        next.revision=index.revision+1;validate(next);await stable();await check();const saved=await client.write(COMFY_NATIVE_SLOT,next,{...transport,expectedFingerprint:found.fingerprint});known=true;await check();
        if(!same(saved.value,next))fail('ST工作流目录尚未读回');found=saved;index=validate(structuredClone(saved.value));
      }
      const ctx={get index(){return index;},get exists(){return found.exists;},originals,transport,check,save,validate};
      if(!captured.inventoryOnly)stable=await prepareComfyLegacy({legacy,namespace,ctx,current:()=>!closed&&!captured.signal?.aborted&&current()===true,maxBytes});
      const result=await work(ctx);await stable();
      await check();if((await read()).fingerprint!==found.fingerprint)fail('工作流库在读取期间变化，请重新核对');return structuredClone(result);
    });queue=task.then(()=>{},()=>{});return task;
  }
  const find=(index,value)=>index.workflows.find(row=>row.head.id===value);
  async function backup(ctx,namespace){const rows=[];for(const row of ctx.index.workflows){rows.push(await ctx.originals.readRow(row,ctx.transport));await ctx.check();}const value=comfyNativePacket(namespace,rows);validateComfyLibraryBackup(value);return value;}
  const usage=index=>({count:index.workflows.length,archived:index.workflows.filter(row=>row.head.archived).length,versions:index.workflows.reduce((n,row)=>n+row.versions.length,0),bytes:index.workflows.reduce((n,row)=>n+row.head.totalBytes,0),limit:maxBytes});
  const recovery=index=>({revision:index.revision,sources:index.sources.map(source=>({census:source.census,count:source.workflows.length,versions:source.workflows.reduce((n,row)=>n+row.versions.length,0),pending:source.workflows.filter(row=>source.pending.includes(row.head.id)).map(row=>row.head)})),retired:index.retired.map(row=>row.head)});
  const rows=(index,namespace,archived)=>index.workflows.filter(row=>row.head.archived===Boolean(archived)).map(row=>storedHead(namespace,row.head)).sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id));
  return Object.freeze({
    persistence:'st-account-file',concurrency:'optimistic-non-cas',
    async view(namespace,{archived=false,...options}={}){return operation(namespace,options,async ctx=>({rows:rows(ctx.index,namespace,archived),usage:{...usage(ctx.index),persistence:'st-account-file'},recovery:recovery(ctx.index)}));},
    async list(namespace,{archived=false,...options}={}){return operation(namespace,options,async ctx=>rows(ctx.index,namespace,archived));},
    async versions(namespace,value,options={}){checkId(value);return operation(namespace,options,async ctx=>(find(ctx.index,value)?.versions||[]).map(row=>storedVersion(namespace,row.meta)).sort((a,b)=>b.version-a.version));},
    async readVersion(namespace,value,revision,options={}){checkId(value);checkId(revision);return operation(namespace,options,async ctx=>{
      const row=find(ctx.index,value),version=row?.versions.find(item=>item.meta.revision===revision);
      return {head:row?storedHead(namespace,row.head):null,version:version?storedVersion(namespace,version.meta):null,
        document:version&&!row.head.archived?normalizeComfyLibraryDocument((await ctx.originals.read(version,ctx.transport)).document):null};
    });},
    async load(namespace,value,revision,options={}){checkId(value);checkId(revision);return operation(namespace,options,async ctx=>{
      const row=find(ctx.index,value),version=row?.versions.find(item=>item.meta.revision===revision);if(!version)return null;
      const original=await ctx.originals.read(version,ctx.transport);return normalizeComfyLibraryDocument(original.document);
    });},
    async save(namespace,{id:requested='',expectedRevision='',name,document},options={}){
      if(requested)checkId(requested);if(expectedRevision)checkId(expectedRevision);name=String(name??'').trim().slice(0,80);if(!name)fail('请填写方案名');
      const normalized=normalizeComfyLibraryDocument(document),inspected=inspectComfyLibraryDocument(normalized),value=requested||fresh(),revision=fresh();
      return operation(namespace,options,async ctx=>{
        const before=find(ctx.index,value),old=before?.head;
        if(requested&&!old||old&&old.revision!==expectedRevision||!requested&&(expectedRevision||old||ctx.index.retired.some(row=>row.head.id===value)))fail('工作流版本已变化，未覆盖');
        if(old?.archived)fail('请先恢复已归档的方案');if(old?.version>=64||!old&&ctx.index.workflows.length>=128||usage(ctx.index).bytes+inspected.bytes>maxBytes)fail('工作流库达到原有数量、版本或容量上限');
        const at=clock(old?.updatedAt),head={id:value,name,revision,version:(old?.version||0)+1,createdAt:old?.createdAt??at,updatedAt:at,archived:false,bytes:inspected.bytes,totalBytes:(old?.totalBytes||0)+inspected.bytes,nodes:inspected.nodes,slots:inspected.slots,issue:inspected.issue,
          ...(Object.hasOwn(normalized,'classification')?{classification:normalized.classification}:{})};
        const version={meta:{...head,parentRevision:old?.revision||''},document:normalized};
        const preserved=await ctx.originals.preserve(version,ctx.transport),next=structuredClone(ctx.index),row={head,versions:[...(before?.versions||[]),preserved]};
        next.workflows=next.workflows.filter(item=>item.head.id!==value);next.workflows.push(row);await ctx.save(next);return storedHead(namespace,head);
      });
    },
    async archive(namespace,value,expectedRevision,archived=true,options={}){checkId(value);checkId(expectedRevision);return operation(namespace,options,async ctx=>{
      const row=find(ctx.index,value);if(!row||row.head.revision!==expectedRevision)fail('方案已变化，请刷新后操作');const next=structuredClone(ctx.index),target=find(next,value);target.head.archived=Boolean(archived);target.head.updatedAt=clock(target.head.updatedAt);await ctx.save(next);return storedHead(namespace,target.head);
    });},
    async purge(namespace,value,expectedRevision,options={}){checkId(value);checkId(expectedRevision);return operation(namespace,options,async ctx=>{
      const row=find(ctx.index,value);if(!row||row.head.revision!==expectedRevision||!row.head.archived)fail('仅可移出未变化的归档方案');
      const next=structuredClone(ctx.index);next.workflows=next.workflows.filter(item=>item.head.id!==value);next.retired.push(row);await ctx.save(next);return {removed:row.versions.length,bytes:row.head.totalBytes,retained:true};
    });},
    async usage(namespace,options={}){return operation(namespace,options,async ctx=>({...usage(ctx.index),persistence:'st-account-file'}));},
    async storageSummary(namespace,options={}){return operation(namespace,{...options,inventoryOnly:true},async ctx=>{const totals=usage(ctx.index),documentBytes=totals.bytes,indexBytes=ctx.exists?bytes(ctx.index):0;
      if(legacy){const census=await legacy.census(namespace,{isCurrent:()=>!closed}),digest=await comfyLibraryBackupDigest(census);await ctx.check();if(census.heads.length&&!ctx.index.sources.some(row=>row.census===digest)){
        // A read-only inventory does not silently migrate or report zero for a
        // nonempty unregistered old library.
        fail('本机旧工作流库尚有未接入内容，请先打开工作流库完成核对');
      }}
      return {status:'ready',count:totals.count,archived:totals.archived,versions:totals.versions,documentBytes,indexBytes,bytes:documentBytes+indexBytes};
    });},
    async backup(namespace,options={}){return operation(namespace,options,ctx=>backup(ctx,namespace));},
    async recoverySources(namespace,options={}){return operation(namespace,options,async ctx=>recovery(ctx.index));},
    async exportLegacy(namespace,census,options={}){return operation(namespace,options,ctx=>exportComfyLegacy(ctx,namespace,census));},
    async resolveLegacy(namespace,{census,id:value,choice,expectedRevision,confirmed=false},options={}){
      checkId(value);if(confirmed!==true||!['keep','copy'].includes(choice)||!Number.isSafeInteger(expectedRevision))fail('请先核对旧工作流来源');
      return operation(namespace,options,async ctx=>{
        if(ctx.index.revision!==expectedRevision)fail('旧库核对期间目录已变化');const next=structuredClone(ctx.index),source=next.sources.find(item=>item.census===census);
        if(!source?.pending.includes(value))fail('旧库条目已核对或不存在');
        if(choice==='copy'){
          const original=await ctx.originals.readRow(source.workflows.find(row=>row.head.id===value),ctx.transport),newId=fresh();
          if(next.workflows.length>=128||usage(next).bytes+original.head.totalBytes>maxBytes||[...next.workflows,...next.retired].some(row=>row.head.id===newId))fail('另存完整副本超出容量或编号已存在');
          const versions=[];let parent='';for(const version of original.versions){const revision=fresh(),meta={...version.meta,id:newId,revision,parentRevision:parent,name:(version.meta.name.slice(0,75)+' 副本')};
            versions.push(await ctx.originals.preserve({meta,document:version.document},ctx.transport));parent=revision;}
          const {parentRevision,...tail}=versions.at(-1).meta;next.workflows.push({head:{...tail,archived:original.head.archived,updatedAt:clock(original.head.updatedAt)},versions});
        }
        source.pending=source.pending.filter(id=>id!==value);await ctx.save(next);return {resolved:true,choice};
      });
    },
    async restoreRetired(namespace,value,{expectedRevision,confirmed=false,...options}={}){checkId(value);if(confirmed!==true)fail('请先确认恢复移出的工作流');return operation(namespace,options,async ctx=>{
      const row=ctx.index.retired.find(row=>row.head.id===value);if(!row||ctx.index.revision!==expectedRevision)fail('移出目录的工作流已变化');
      await ctx.originals.readRow(row,ctx.transport);const next=structuredClone(ctx.index);next.retired=next.retired.filter(row=>row.head.id!==value);next.workflows.push(row);await ctx.save(next);return storedHead(namespace,row.head);
    });},
    async restoreBackup(namespace,input,{confirmed=false,expectedDigest,...options}={}){
      if(confirmed!==true||typeof expectedDigest!=='string'||!/^[a-f0-9]{64}$/.test(expectedDigest))fail('请先核对并确认工作流库恢复');const incoming=structuredClone(input);validateComfyLibraryBackup(incoming);
      return operation(namespace,options,async ctx=>{
        const local=await backup(ctx,namespace);if(await comfyLibraryBackupDigest(local)!==expectedDigest)fail('工作流库在确认后已变化');
        const plan=planComfyLibraryRestore(local,incoming,{maxBytes}),next=structuredClone(ctx.index);
        for(const row of plan.writes){if(next.retired.some(item=>item.head.id===row.head.id))fail('此工作流已移出目录，请核对保留原件后恢复，未因旧备份复活');
          const previous=find(next,row.head.id),versions=[...(previous?.versions||[])];for(const version of row.versions)versions.push(await ctx.originals.preserve(version,ctx.transport));
          next.workflows=next.workflows.filter(item=>item.head.id!==row.head.id);next.workflows.push({head:row.head,versions});
        }
        if(plan.writes.length)await ctx.save(next);return plan.summary;
      });
    },
    close(){closed=true;client?.close();legacy?.close();},
  });
}
