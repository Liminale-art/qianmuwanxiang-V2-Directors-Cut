import {createConfiguredStAccountStorage,stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {createVibeReceiptOriginals,captureVibeReceiptOriginal,VIBE_RECEIPT_ORIGINAL_SLOT,VIBE_RECEIPT_ORIGINAL_LIMITS} from './qianmu-vibe-receipt-original.js';
import {resolveVibeReceiptHeads,vibeReceiptFollows} from './qianmu-vibe-receipt-lineage.js';

export const VIBE_RECEIPT_CATALOGUE_SLOT='vibe-receipt-catalogue';
const schema='qianmu.vibe.receipt-catalogue.v1',maxIndex=8*1048576;
const fail=message=>{throw Object.assign(Error(message),{code:'vibe_receipt_catalogue',submissionState:'not_submitted'});};
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const empty=namespace=>({schema,namespace,revision:0,entries:[]});
const leaves=entry=>{const used=new Set(entry.versions.flatMap(v=>v.parents));return entry.versions.filter(v=>!used.has(v.digest));};
function validateIndex(value,namespace,scope){
  if(!exact(value,['schema','namespace','revision','entries'])||value.schema!==schema||value.namespace!==namespace||!Number.isSafeInteger(value.revision)||value.revision<0
    ||!Array.isArray(value.entries)||value.entries.length>18432||new TextEncoder().encode(JSON.stringify(value)).length>maxIndex)fail('费用目录归属、结构或容量无效');
  const keys=new Set();let current=0,archived=0;
  for(const entry of value.entries){
    if(!exact(entry,['cacheKey','section','versions'])||!hash(entry.cacheKey)||keys.has(entry.cacheKey)||!['current','archived'].includes(entry.section)
      ||!Array.isArray(entry.versions)||!entry.versions.length||entry.versions.length>8192)fail('费用目录存在重复或无效记录');keys.add(entry.cacheKey);
    entry.section==='current'?current++:archived++;
    const seen=new Set();for(const version of entry.versions){
      if(!exact(version,['digest','section','reference','parents'])||!hash(version.digest)||seen.has(version.digest)||!['current','archived'].includes(version.section)
        ||!Array.isArray(version.parents)||new Set(version.parents).size!==version.parents.length||version.parents.some(p=>!seen.has(p)))fail('费用原件前后依据不完整');
      stAccountImmutableReference(version.reference,{scope,slot:VIBE_RECEIPT_ORIGINAL_SLOT,maxBytes:VIBE_RECEIPT_ORIGINAL_LIMITS.manifest+1024});seen.add(version.digest);
    }
  }
  if(current>2048||archived>16384)fail('费用目录超过原有当前或历史数量上限，未裁剪');return value;
}

// Same-account complete evidence catalogue. Legacy reads never mutate IDB.
// publish records a validated predecessor edge, NOT a paid reservation/lock.
// Optimistic heads cannot supply cross-device CAS or authorize an upstream call.
export function createVibeReceiptCatalogue({legacy,createStorage=createConfiguredStAccountStorage,onProgress=()=>{}}={}){
  if(typeof legacy?.census!=='function'||typeof legacy?.close!=='function'||typeof onProgress!=='function')fail('费用账本环境未就绪');
  let client,opening,closed=false,owner='',known=false,queue=Promise.resolve();
  function operation(namespace,options,work,deferredDigest=''){
    const captured={...options};
    if(typeof namespace!=='string'||!/^st-user:.+/.test(namespace)||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace))fail('费用目录账户无效');
    const check=async()=>{if(closed||captured.signal?.aborted||captured.isCurrent&&captured.isCurrent()!==true)fail('费用目录页面或账户已变化');
      if(await captured.guard?.()===false)fail('费用目录守卫未通过');if(closed||captured.signal?.aborted||captured.isCurrent&&captured.isCurrent()!==true)fail('费用目录页面或账户已变化');return true;};
    const task=queue.catch(()=>{}).then(async()=>{
      await check();if(owner&&owner!==namespace)fail('费用目录会话不能切换账户');owner=namespace;
      opening??=Promise.resolve().then(()=>createStorage({maxBytes:maxIndex,isCurrent:()=>!closed})).then(value=>{
        if(closed||value.namespace!==namespace){value.close();fail('费用目录账户不符');}client=value;return value;
      }).catch(error=>{opening=null;throw error;});await opening;await check();
      const transport={guard:check,signal:captured.signal},originals=createVibeReceiptOriginals(client,{...transport,onProgress});
      async function read(){const result=await client.read(VIBE_RECEIPT_CATALOGUE_SLOT,transport);await check();
        if(!result.exists&&known)fail('已确认的费用目录缺失，未重建空账本');if(result.exists){validateIndex(result.value,namespace,client.scope);known=true;}return result;}
      async function census(){const source=await legacy.census(namespace);await check();if(source.namespace!==namespace)fail('旧费用账本账户不符');
        const groups=new Map();for(const segment of source.reviewSegments){const rows=groups.get(segment.cacheKey)||[];rows.push(segment);groups.set(segment.cacheKey,rows);}
        const items=[];for(const section of ['current','archived'])for(const receipt of source[section]){
          const capturedOriginal=await captureVibeReceiptOriginal({namespace,section,receipt,segments:groups.get(receipt.cacheKey)||[]},namespace);await check();items.push(capturedOriginal);
        }
        return {items,signature:JSON.stringify({items:items.map(item=>item.digest),archiveUsage:source.archiveUsage,reviewUsage:source.reviewUsage})};
      }
      let found=await read(),value=found.exists?structuredClone(found.value):empty(namespace);const baseline=await census();
      const combined=new Map(value.entries.map(entry=>[entry.cacheKey,entry.section]));for(const item of baseline.items)if(!combined.has(item.snapshot.receipt.cacheKey))combined.set(item.snapshot.receipt.cacheKey,item.snapshot.section);
      const sections=[...combined.values()];if(sections.filter(s=>s==='current').length>2048||sections.filter(s=>s==='archived').length>16384)fail('合并费用目录超过原有上限，双方记录保留，未裁剪');
      const unchanged=async()=>{await check();if((await census()).signature!==baseline.signature)fail('旧页面修改了费用记录，请重新核对；未授权新请求');return true;};
      async function save(next){validateIndex(next,namespace,client.scope);await unchanged();
        const saved=await client.write(VIBE_RECEIPT_CATALOGUE_SLOT,next,{...transport,expectedFingerprint:found.fingerprint});known=true;await check();
        if(!same(saved.value,next))fail('费用目录尚未完整读回');found=saved;value=structuredClone(next);await unchanged();if((await read()).fingerprint!==found.fingerprint)fail('另一端修改了费用目录');
        await onProgress({kind:'vibe-receipt-catalogue',stage:'verified'});await check();
      }
      const snapshots=new Map();
      async function load(entry,version){
        let snapshot=snapshots.get(version.digest);if(!snapshot){snapshot=await originals.read(version.reference,{cacheKey:entry.cacheKey,section:version.section});await check();
          const capturedOriginal=await captureVibeReceiptOriginal(snapshot,namespace);await check();if(capturedOriginal.digest!==version.digest)fail('费用原件与目录依据不符');snapshots.set(version.digest,snapshot);}
        return {digest:version.digest,snapshot};
      }
      async function resolve(entry){
        if(!entry)return {kind:'empty',selected:null,conflicts:[],heads:[]};const heads=leaves(entry),items=[];
        // Verify every explicit edge, including older predecessors: a forged
        // child must not hide a different uncertain attempt from the resolver.
        const attempts=new Set();for(const version of entry.versions){const child=await load(entry,version);let newAttempt=false;
          for(const id of version.parents){const parent=await load(entry,entry.versions.find(v=>v.digest===id));if(!await vibeReceiptFollows(parent.snapshot,child.snapshot,{explicit:true}))fail('费用目录前后状态衔接不符');
            if(parent.snapshot.receipt.attemptId!==child.snapshot.receipt.attemptId)newAttempt=true;}
          if(newAttempt&&attempts.has(child.snapshot.receipt.attemptId))fail('新费用尝试复用了历史请求编号');attempts.add(child.snapshot.receipt.attemptId);
        }
        const predecessors=new Map(),byId=new Map(entry.versions.map(v=>[v.digest,v]));
        for(const version of heads){items.push(await load(entry,version));const seen=new Set(),pending=[...version.parents],prior=[];
          while(pending.length){const id=pending.pop();if(seen.has(id))continue;seen.add(id);const parent=byId.get(id);prior.push(await load(entry,parent));pending.push(...parent.parents);}
          predecessors.set(version.digest,prior);
        }
        const resolution=await resolveVibeReceiptHeads(items,{predecessors});await check();
        return {...resolution,heads:heads.map(v=>v.digest)};
      }
      const sectionOf=resolution=>resolution.kind==='resolved'?resolution.selected.snapshot.section:resolution.conflicts.every(v=>v.snapshot.section==='archived')?'archived':'current';
      // Preserve a migration batch first, then publish its single index. Avoid
      // N complete account re-censuses and head rewrites for N old receipts.
      const adopted=structuredClone(value);let adoptionChanged=false;
      for(const old of baseline.items){const receipt=old.snapshot.receipt,existing=adopted.entries.find(e=>e.cacheKey===receipt.cacheKey),version=existing?.versions.find(v=>v.digest===old.digest);
        // A just-committed local mutation is not an unrelated legacy root.
        // Only this exact captured candidate is deferred; it stays in every
        // census change check and is published below with validated parents.
        if(old.digest===deferredDigest&&!version)continue;
        if(version){const checked=await load(existing,version);if(checked.digest!==old.digest)fail('旧费用原件核对不符');continue;}
        const saved=await originals.preserve(old.snapshot);await check();const entry=existing||{cacheKey:receipt.cacheKey,section:old.snapshot.section,versions:[]};
        entry.versions.push({digest:old.digest,section:old.snapshot.section,reference:saved.reference,parents:[]});snapshots.set(old.digest,old.snapshot);
        entry.section=sectionOf(await resolve(entry));if(!existing)adopted.entries.push(entry);adoptionChanged=true;
      }
      if(adoptionChanged){adopted.revision=value.revision+1;await save(adopted);}
      const find=key=>value.entries.find(entry=>entry.cacheKey===key);
      const inspect=async key=>{const entry=find(key),result=await resolve(entry);if(entry&&entry.section!==sectionOf(result))fail('费用目录分区与原件不符');return {entry,result};};
      const result=await work({find,inspect,resolve,sectionOf,load,originals,snapshots,check,baseline,get value(){return value;},save:async next=>{next.revision=value.revision+1;await save(next);}});
      await unchanged();if((await read()).fingerprint!==found.fingerprint)fail('费用目录在读取期间变化');return structuredClone(result);
    });queue=task;return task;
  }
  const validKey=key=>{if(!hash(key))fail('费用记录编号无效');};
  return Object.freeze({
    checkout(namespace,cacheKey,options={}){validKey(cacheKey);return operation(namespace,options,async state=>{
      const {result}=await state.inspect(cacheKey);if(result.kind==='conflict')fail('不同来源的编码费用记录尚未核对，未授权新请求');
      return {snapshot:result.selected?.snapshot||null,heads:result.heads,local:state.baseline.items.find(item=>item.snapshot.receipt.cacheKey===cacheKey)?.snapshot||null};
    });},
    readAll(namespace,options={}){return operation(namespace,options,async state=>{
      const rows=[];for(const entry of state.value.entries){const {result}=await state.inspect(entry.cacheKey);if(result.kind==='conflict')fail('费用目录存在未核对分歧，未提供不完整清单');rows.push(result.selected.snapshot);}
      return {rows,metadata:{count:1,bytes:new TextEncoder().encode(JSON.stringify(state.value)).length}};
    });},
    list(namespace,options={}){return operation(namespace,options,state=>state.value.entries.map(entry=>({cacheKey:entry.cacheKey,section:entry.section,versions:entry.versions.length,heads:leaves(entry).map(v=>v.digest)})));},
    inspect(namespace,cacheKey,options={}){validKey(cacheKey);return operation(namespace,options,async state=>{const {entry,result}=await state.inspect(cacheKey);
      return {...result,versions:entry?.versions.map(v=>({digest:v.digest,section:v.section,reference:v.reference,parents:v.parents}))||[]};});},
    get(namespace,cacheKey,options={}){validKey(cacheKey);return operation(namespace,options,async state=>{const {result}=await state.inspect(cacheKey);
      if(result.kind==='conflict')fail('不同来源的编码费用记录尚未核对，未授权新请求');return result.selected?.snapshot||null;});},
    readVersion(namespace,cacheKey,digest,options={}){validKey(cacheKey);if(!hash(digest))fail('费用原件版本无效');return operation(namespace,options,async state=>{
      const entry=state.find(cacheKey),version=entry?.versions.find(v=>v.digest===digest);if(!version)fail('指定费用原件版本不存在');return (await state.load(entry,version)).snapshot;});},
    async publish(namespace,input,expectedHeads,options={}){
      // Capture candidate + predecessor selection before yielding to any guard.
      const expected=structuredClone(expectedHeads),capturedOptions={...options},capturedOriginal=await captureVibeReceiptOriginal(input,namespace);
      if(!Array.isArray(expected)||expected.length>8192||expected.some(id=>!hash(id))||new Set(expected).size!==expected.length)fail('费用前序选择无效');
      return operation(namespace,capturedOptions,async state=>{
        const cacheKey=capturedOriginal.snapshot.receipt.cacheKey,{entry,result}=await state.inspect(cacheKey);
        if(!same([...result.heads].sort(),[...expected].sort()))fail('费用前序记录已变化，未覆盖');
        if(result.kind==='conflict')fail('费用原始记录存在分歧，不能直接覆盖');
        const candidate=capturedOriginal.snapshot;
        if(result.selected&&!await vibeReceiptFollows(result.selected.snapshot,candidate,{explicit:true}))fail('费用状态不能沿此前序推进');
        if(!result.selected&&!(candidate.section==='current'&&['reserved','ready'].includes(candidate.receipt.status)))fail('首条费用记录必须有明确的准备或已存结果依据');
        const prior=entry?.versions.find(v=>v.digest===capturedOriginal.digest);if(prior)return {digest:prior.digest,reference:prior.reference,changed:false};
        if(result.selected&&result.selected.snapshot.receipt.attemptId!==candidate.receipt.attemptId)for(const version of entry.versions){
          if((await state.load(entry,version)).snapshot.receipt.attemptId===candidate.receipt.attemptId)fail('新费用尝试不能复用任何历史请求编号');}
        // Link direct valid predecessors. Other stale roots are already proven
        // covered by the selected branch's validated ancestry; do not invent a
        // direct uncertain -> fresh-attempt edge for those older sources.
        const parents=[];for(const id of expected){const parent=await state.load(entry,entry.versions.find(v=>v.digest===id));if(await vibeReceiptFollows(parent.snapshot,candidate,{explicit:true}))parents.push(id);}
        const saved=await state.originals.preserve(candidate);await state.check();const next=structuredClone(state.value),target=next.entries.find(e=>e.cacheKey===cacheKey)||{cacheKey,section:candidate.section,versions:[]};
        target.versions.push({digest:capturedOriginal.digest,section:candidate.section,reference:saved.reference,parents});target.section=candidate.section;
        if(!entry)next.entries.push(target);await state.save(next);return {digest:capturedOriginal.digest,reference:saved.reference,changed:true};
      },capturedOriginal.digest);
    },
    close(){closed=true;client?.close();legacy.close();},
  });
}
