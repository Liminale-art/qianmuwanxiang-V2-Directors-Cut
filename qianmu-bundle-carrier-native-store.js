import {createConfiguredStAccountStorage} from './qianmu-st-account-storage.js';
import {inspectBundleCarrierProof,collectBundleCarrierMembers,inspectBundleCarrierOriginal} from './qianmu-bundle-carrier.js';
import {bundleCarrierKey,bundleCarrierHead,bundleCarrierOriginalHead,sameCarrierFields,summarizeBundleCarrierStorage,summarizeBundleCarrierOriginals,validateBundleCarrierOriginalHead} from './qianmu-bundle-carrier-storage-contract.js';
import {sameBundleMappingHead} from './qianmu-bundle-mapping-contract.js';
import {CARRIER_NATIVE_SLOT,CARRIER_PROOF_SLOT,CARRIER_NATIVE_BYTES,carrierNativeFail as fail,carrierExact,emptyCarrierNativeIndex,validateCarrierNativeIndex,carrierCatalog,mergeCarrierHeads,mergeCarrierDescriptors} from './qianmu-bundle-carrier-native-contract.js';
import {preserveCarrierNativeRaw,readCarrierNativeRaw} from './qianmu-bundle-carrier-native-raw.js';

// Same account files, never model attachments. Immutable originals first, then
// a light append-only catalog. No delete, implicit consent or cross-device CAS.
export function createNativeBundleCarrierStore({legacy,createStorage=createConfiguredStAccountStorage}={}){
  let opening,storage,closed=false,known=false;
  async function operation(namespace,options,work){
    bundleCarrierKey(namespace,'0'.repeat(64));const current=options?.isCurrent??(()=>true),guard=options?.guard??(async()=>{});
    if(typeof current!=='function'||typeof guard!=='function')fail('来源储存缺少账户保护');
    const check=async()=>{if(closed||options?.signal?.aborted||current()!==true)fail('来源储存页面或账户已变化');await guard();if(closed||options?.signal?.aborted||current()!==true)fail('来源储存页面或账户已变化');return true;};
    await check();if(!opening)opening=Promise.resolve().then(()=>createStorage({isCurrent:()=>!closed,maxBytes:CARRIER_NATIVE_BYTES})).then(value=>{
      if(closed){value.close();fail('来源储存会话已结束');}storage=value;return value;
    }).catch(error=>{opening=null;throw error;});
    const client=await opening;await check();if(client.namespace!==namespace)fail('来源储存不属于当前ST账户');
    const transport={guard:check,signal:options?.signal},validate=value=>validateCarrierNativeIndex(value,{namespace,scope:client.scope});
    let index,committed=false;
    const read=await client.read(CARRIER_NATIVE_SLOT,transport);await check();if(!read.exists&&known)fail('已确认的ST来源目录缺失，未重建空库');
    index=validate(read.exists?read.value:emptyCarrierNativeIndex(namespace));if(read.exists)known=true;
    const preflight=(heads,originals)=>{
      summarizeBundleCarrierStorage(mergeCarrierHeads(index.proofs.map(row=>row.head),heads),namespace);
      summarizeBundleCarrierOriginals(mergeCarrierHeads(index.originals.map(row=>row.head),originals),namespace);
    };
    const publish=async(proofs,originals,sourceGuard=check,required=[])=>{
      const result=await client.update(CARRIER_NATIVE_SLOT,value=>{
        if(value===null&&known)fail('ST来源目录已消失，未覆盖');const next=validate(value??emptyCarrierNativeIndex(namespace));
        for(const row of required){const found=next.originals.find(item=>item.head.key===row.head.key);
          if(!found||!sameCarrierFields(found.head,row.head)||!sameCarrierFields(found.reference,row.reference))fail('来源原件在发布证明前已变化，未发布');}
        const p=mergeCarrierDescriptors(next.proofs,proofs),o=mergeCarrierDescriptors(next.originals,originals);
        if(p.length!==next.proofs.length||o.length!==next.originals.length){next.proofs=p;next.originals=o;next.revision++;}return validate(next);
      },{...transport,guard:sourceGuard});committed=true;known=true;index=validate(result.value);await check();
      for(const [wanted,rows] of [[proofs,index.proofs],[originals,index.originals]])for(const row of wanted){
        const saved=rows.find(item=>item.head.key===row.head.key);if(!saved||!sameCarrierFields(saved.head,row.head)||!sameCarrierFields(saved.reference,row.reference))fail('ST来源目录读回不符');
      }
    };
    const verifyPublished=async(heads,originals)=>{
      const latest=await client.read(CARRIER_NATIVE_SLOT,transport);await check();if(!latest.exists)fail('ST来源目录读回缺失');const checked=validate(latest.value);
      for(const [wanted,rows,prior] of [[heads,checked.proofs,index.proofs],[originals,checked.originals,index.originals]])for(const head of wanted){
        const saved=rows.find(row=>row.head.key===head.key),before=prior.find(row=>row.head.key===head.key);
        if(!saved||!before||!sameCarrierFields(saved.head,head)||!sameCarrierFields(saved.reference,before.reference))fail('ST来源在保存后变化，请重新核对');
      }index=checked;
    };
    const loadProof=async row=>{const result=await client.readImmutable(row.reference,transport);await check();const value=await inspectBundleCarrierProof(result.value,{namespace,guard:check});
      if(!sameCarrierFields(row.head,bundleCarrierHead(value.summary)))fail('来源证明原文与目录不符');return value;};
    const putOriginal=async(file,head,sourceGuard=check)=>{
      preflight([],[head]);await check();const old=index.originals.find(row=>row.head.key===head.key);
      if(old)return (await readCarrierNativeRaw(client,old,transport)).member;
      const value=await preserveCarrierNativeRaw(client,file,head,transport);await publish([],[value.descriptor],sourceGuard);return value.member;
    };
    const putProof=async(head,input,verified,sourceGuard=check)=>{
      const value=await inspectBundleCarrierProof(input,{namespace,guard:check});if(!sameCarrierFields(head,bundleCarrierHead(value.summary)))fail('来源证明与目录不符');preflight([head],[]);
      for(const member of value.members)if(!sameBundleMappingHead(verified.get(member.sha256),member.head))fail('来源证明成员不完整，未发布');
      const old=index.proofs.find(row=>row.head.key===head.key);
      if(old){const saved=await loadProof(old);if(!sameCarrierFields(saved.proof,value.proof))fail('同一载体已有不同证明，未覆盖');return;}
      const saved=await client.preserveImmutable(CARRIER_PROOF_SLOT,value.proof,transport),checked=await inspectBundleCarrierProof(saved.value,{namespace,guard:check});
      const required=value.members.map(member=>index.originals.find(row=>row.head.sha256===member.sha256));if(required.some(row=>!row))fail('来源证明缺少已保存原件');
      if(!sameCarrierFields(checked.proof,value.proof))fail('来源证明读回不符');await publish([{head,reference:saved.reference}],[],sourceGuard,required);
    };
    try{
      // Only local heads/keys on repeated opens. Old raw/proof records are read
      // once when missing; migration guards recheck an atomic readonly census.
      const local=await legacy.list(namespace,{guard:check,isCurrent:current});await check();preflight(local.heads,local.originals);
      const pendingRaw=local.originals.filter(head=>!index.originals.some(row=>sameCarrierFields(row.head,head))),pendingProof=local.heads.filter(head=>!index.proofs.some(row=>sameCarrierFields(row.head,head)));
      if(pendingRaw.length||pendingProof.length){
        if(typeof legacy.createCarrierMigrationGuard!=='function')fail('旧来源库缺少只读迁移保护');
        const source=await legacy.createCarrierMigrationGuard(namespace,local,{isCurrent:current,guard:check}),sourceGuard=async()=>{await check();await source();await check();return true;},verified=new Map();
        for(const head of pendingRaw){await sourceGuard();const file=await legacy.loadOriginal(namespace,head.sha256,{guard:check,isCurrent:current});await check();verified.set(head.sha256,await putOriginal(file,head,sourceGuard));}
        for(const head of pendingProof){
          await sourceGuard();const proof=await legacy.load(namespace,head.carrierDigest,{guard:check,isCurrent:current});await check();
          const inspected=await inspectBundleCarrierProof(proof,{namespace,guard:check});
          for(const member of inspected.members)if(!verified.has(member.sha256)){
            const row=index.originals.find(row=>row.head.sha256===member.sha256);if(!row)fail('旧来源证明缺少原始成员');verified.set(member.sha256,(await readCarrierNativeRaw(client,row,transport)).member);
          }
          await putProof(head,proof,verified,sourceGuard);
        }await sourceGuard();await verifyPublished(local.heads,local.originals);
      }
      const result=await work({client,index:()=>index,check,transport,preflight,publish,loadProof,putOriginal,putProof,verifyPublished});await check();return result;
    }catch(error){if(committed&&error instanceof Error)error.writeState='unconfirmed';throw error;}
  }
  async function saveBatch(namespace,input,{confirmed=false,loadProof,loadOriginal,...options}={}){
    if(confirmed!==true)fail('请明确确认保全全部来源记录及原文');
    if(!carrierExact(input,['heads','originals'])||typeof loadProof!=='function'||typeof loadOriginal!=='function')fail('来源批次缺少完整目录或原文读取接口');
    const {heads,originals}=structuredClone(input);summarizeBundleCarrierStorage(heads,namespace);summarizeBundleCarrierOriginals(originals,namespace);
    return operation(namespace,options,async ctx=>{
      ctx.preflight(heads,originals);const verified=new Map();
      for(const head of originals){await ctx.check();const file=await loadOriginal(head.sha256);await ctx.check();
        // Validate caller bytes even when this SHA already exists in native storage.
        await inspectBundleCarrierOriginal(file,head,{namespace,guard:ctx.check});
        verified.set(head.sha256,await ctx.putOriginal(file,head));
      }
      for(const head of heads){await ctx.check();const proof=await loadProof({...head});await ctx.check();await ctx.putProof(head,proof,verified);}
      await ctx.verifyPublished(heads,originals);await ctx.check();return {count:heads.length,originalCount:originals.length};
    });
  }
  return Object.freeze({persistence:'st-account-file',concurrency:'optimistic-non-cas',
    list(namespace,options){return operation(namespace,options,async ctx=>structuredClone(carrierCatalog(ctx.index())));},
    load(namespace,id,options){const key=bundleCarrierKey(namespace,id);return operation(namespace,options,async ctx=>{const row=ctx.index().proofs.find(row=>row.head.key===key);return row?(await ctx.loadProof(row)).proof:null;});},
    loadOriginal(namespace,id,options){const key=bundleCarrierKey(namespace,id);return operation(namespace,options,async ctx=>{const row=ctx.index().originals.find(row=>row.head.key===key);return row?(await readCarrierNativeRaw(ctx.client,row,ctx.transport)).file:null;});},
    async saveOriginal(namespace,file,{head:inputHead,confirmed=false,...options}={}){
      if(confirmed!==true)fail('请明确确认保全来源成员原文');const head=structuredClone(inputHead);validateBundleCarrierOriginalHead(head,namespace);
      return operation(namespace,options,async ctx=>{await inspectBundleCarrierOriginal(file,head,{namespace,guard:ctx.check});await ctx.putOriginal(file,head);await ctx.verifyPublished([],[head]);return head;});
    },
    async save(namespace,input,{confirmed=false,load,...options}={}){
      if(confirmed!==true)fail('请明确确认保全来源关联');const proof=structuredClone(input);
      return operation(namespace,options,async ctx=>{
        const collected=await collectBundleCarrierMembers(proof,{load,guard:ctx.check}),head=bundleCarrierHead(collected.summary),originals=collected.files.map(row=>bundleCarrierOriginalHead(namespace,row.sha256,row.bytes));
        ctx.preflight([head],originals);const verified=new Map();
        for(const [at,row] of collected.files.entries())verified.set(row.sha256,await ctx.putOriginal(row.file,originals[at]));
        await ctx.putProof(head,proof,verified);await ctx.verifyPublished([head],originals);return head;
      });
    },saveBatch,
    close(){closed=true;storage?.close();legacy.close();}
  });
}
