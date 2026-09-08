import {BUNDLE_CARRIER_LIMITS} from './qianmu-bundle-carrier-contract.js';
import {inspectBundleCarrierProof,verifyBundleCarrierMembers,collectBundleCarrierMembers,inspectBundleCarrierOriginal} from './qianmu-bundle-carrier.js';
import {bundleCarrierKey,bundleCarrierHead,validateBundleCarrierHead,summarizeBundleCarrierStorage,sameCarrierFields,bundleCarrierOriginalHead,validateBundleCarrierOriginalHead,summarizeBundleCarrierOriginals,BUNDLE_CARRIER_ORIGINAL_LIMITS} from './qianmu-bundle-carrier-storage-contract.js';
import {vibeDigest} from './qianmu-vibe-file.js';
import {sameBundleMappingHead} from './qianmu-bundle-mapping-contract.js';

const error=message=>Object.assign(new Error(message),{code:'storyboard_bundle_carrier_storage',submissionState:'not_submitted'});
const fail=message=>{throw error(message);};
// Separate, lazy database: reverting this feature does not downgrade the existing v6 restoration journal.
// Append-only. Membership is rechecked against full original receipts; this store grants no restore permission.
export function createBundleCarrierStore({indexedDB=globalThis.indexedDB,keyRange=globalThis.IDBKeyRange,dbName='qianmu-storyboard-bundle-carriers',timeoutMs=8000}={}){
  let database=null,opening=null,closed=false;const pending=new Set(),timeout=Math.max(100,Math.min(15000,Number(timeoutMs)||8000)),stores=['proofs','heads','originals','originalHeads'];
  const current=isCurrent=>{if(closed)fail('来源关联库会话已结束');if(isCurrent()!==true)fail('来源关联核对的账户或页面已变化');};
  function open(){
    if(closed)return Promise.reject(error('来源关联库会话已结束'));if(database)return Promise.resolve(database);if(opening)return opening;
    const attempt=new Promise((resolve,reject)=>{
      let request,done=false;const finish=(err,value)=>{if(done){value?.close();return;}done=true;clearTimeout(timer);err?reject(err):resolve(value);};
      const timer=setTimeout(()=>finish(error('来源关联库读取超时，请重新核对')),timeout);
      try{request=indexedDB.open(dbName,2);}catch(_){finish(error('无法打开来源关联库'));return;}
      request.onupgradeneeded=()=>{if(done||closed){request.transaction?.abort();return;}for(const name of stores)if(!request.result.objectStoreNames.contains(name)){const store=request.result.createObjectStore(name,{keyPath:'key'});store.createIndex('namespace','namespace');}};
      request.onerror=()=>finish(error('来源关联库不可用'));request.onblocked=()=>finish(error('来源关联库被旧页面占用，请关闭后重试'));
      request.onsuccess=()=>{const db=request.result;if(done||closed){db.close();finish(error('来源关联库会话已结束'));return;}database=db;
        const release=()=>{if(database===db){database=null;opening=null;}};db.onversionchange=()=>{db.close();release();};db.onclose=release;finish(null,db);};
    });opening=attempt;void attempt.catch(()=>{if(opening===attempt)opening=null;});return attempt;
  }
  async function operation(mode,isCurrent,work){
    current(isCurrent);const db=await open();current(isCurrent);
    return new Promise((resolve,reject)=>{
      let tx,result,failure,done=false;const finish=cause=>{if(done)return;done=true;clearTimeout(timer);pending.delete(tx);cause?reject(cause):resolve(result);};
      const abort=cause=>{failure=cause;try{tx.abort();}catch(_){finish(cause);}};
      const timer=setTimeout(()=>{failure=error('来源关联写入结果未确认，请重开核对');try{tx?.abort();}catch(_){}finish(failure);},timeout);
      try{tx=db.transaction(stores,mode);pending.add(tx);}catch(_){finish(error('来源关联库暂不可用'));return;}
      tx.oncomplete=()=>{try{current(isCurrent);finish();}catch(err){finish(err);}};tx.onabort=()=>finish(failure||error('来源关联操作未完成'));tx.onerror=()=>{failure||=error('来源关联储存空间不足或写入失败');};
      const read=(request,receive)=>{request.onsuccess=()=>{if(done)return;try{current(isCurrent);receive(request.result);}catch(err){abort(err);}};};
      try{work(tx,read,value=>{result=value;});}catch(err){abort(err);}
    });
  }
  function census(tx,read,namespace,receive){
    read(tx.objectStore('heads').index('namespace').getAll(keyRange.only(namespace),BUNDLE_CARRIER_LIMITS.count+1),heads=>{
      const storage=summarizeBundleCarrierStorage(heads,namespace),expected=new Set(heads.map(row=>row.key));
      // Only keys cross the index scan: listing must never clone the complete 32 MiB proof collection.
      read(tx.objectStore('proofs').index('namespace').getAllKeys(keyRange.only(namespace),BUNDLE_CARRIER_LIMITS.count+1),keys=>{
        if(keys.length!==expected.size||keys.some(key=>!expected.has(key)))fail('来源关联原记录与目录缺件，请保留资料核对');receive(heads,storage);
      });
    });
  }
  function pair(tx,read,key,receive){read(tx.objectStore('heads').get(key),head=>read(tx.objectStore('proofs').get(key),record=>{
    if(Boolean(head)!==Boolean(record))fail('来源关联原记录与目录缺件');receive(head||null,record||null);
  }));}
  function originalCensus(tx,read,namespace,receive){
    read(tx.objectStore('originalHeads').index('namespace').getAll(keyRange.only(namespace),BUNDLE_CARRIER_ORIGINAL_LIMITS.count+1),heads=>{
      const storage=summarizeBundleCarrierOriginals(heads,namespace),expected=new Set(heads.map(row=>row.key));
      read(tx.objectStore('originals').index('namespace').getAllKeys(keyRange.only(namespace),BUNDLE_CARRIER_ORIGINAL_LIMITS.count+1),keys=>{
        if(keys.length!==expected.size||keys.some(key=>!expected.has(key)))fail('来源成员原文与索引缺件，请保留原包');receive(heads,storage);
      });
    });
  }
  function originalPair(tx,read,key,receive){read(tx.objectStore('originalHeads').get(key),head=>read(tx.objectStore('originals').get(key),record=>{
    if(Boolean(head)!==Boolean(record))fail('来源成员原文与索引缺件');receive(head||null,record||null);
  }));}
  function checkOriginalPair(head,record,namespace){
    if(!head)return null;validateBundleCarrierOriginalHead(head,namespace);
    if(!record||Object.keys(record).length!==3||!['key','namespace','file'].every(key=>Object.hasOwn(record,key))||record.namespace!==namespace||record.key!==head.key||!(record.file instanceof Blob)||record.file.size!==head.bytes||record.file.type!=='application/json')fail('来源成员原文与索引不符');return record.file;
  }
  async function checkPair(head,record,namespace,guard){
    if(!head)return null;validateBundleCarrierHead(head,namespace);
    if(!record||Object.keys(record).length!==3||!['key','namespace','proof'].every(key=>Object.hasOwn(record,key))||record.namespace!==namespace||record.key!==head.key)fail('来源关联原记录归属不符');
    const value=await inspectBundleCarrierProof(record.proof,{namespace,guard});
    if(!sameCarrierFields(head,bundleCarrierHead(value.summary)))fail('来源关联正文与目录不符，未覆盖');return value.proof;
  }
  async function list(namespace,{guard=async()=>{},isCurrent=()=>true}={}){
    current(isCurrent);bundleCarrierKey(namespace,'0'.repeat(64));await guard();
    const result=await operation('readonly',isCurrent,(tx,read,set)=>census(tx,read,namespace,(heads,storage)=>originalCensus(tx,read,namespace,(originals,originalStorage)=>set({heads,storage,originals,originalStorage}))));
    await guard();current(isCurrent);return result;
  }
  async function load(namespace,carrierDigest,{guard=async()=>{},isCurrent=()=>true}={}){
    const check=async()=>{current(isCurrent);await guard();current(isCurrent);};
    current(isCurrent);const key=bundleCarrierKey(namespace,carrierDigest);await check();
    const value=await operation('readonly',isCurrent,(tx,read,set)=>pair(tx,read,key,(head,record)=>set({head,record})));
    const proof=await checkPair(value.head,value.record,namespace,check);await check();return proof;
  }
  async function save(namespace,input,{confirmed=false,load:loadMember,guard=async()=>{},isCurrent=()=>true}={}){
    if(confirmed!==true)fail('请明确确认保全来源关联');
    const check=async()=>{current(isCurrent);await guard();current(isCurrent);};await check();
    const {proof,summary}=await inspectBundleCarrierProof(input,{namespace,guard:check}),head=bundleCarrierHead(summary),record={key:head.key,namespace,proof};
    const {files}=await collectBundleCarrierMembers(proof,{load:loadMember,guard:check}),originals=new Map();
    for(const item of files){const originalHead=bundleCarrierOriginalHead(namespace,item.sha256,item.bytes);originals.set(originalHead.key,{head:originalHead,record:{key:originalHead.key,namespace,file:item.file}});}
    summarizeBundleCarrierOriginals([...originals.values()].map(row=>row.head),namespace);
    // Validate any previous full body before the write transaction, then compare-and-check it again inside it.
    const previous=await load(namespace,proof.carrierDigest,{guard,isCurrent});
    if(previous&&!sameCarrierFields(previous,proof))fail('同一载体已有不同来源证明，原记录未覆盖');
    // Validate pre-existing originals once before the transaction; only Blob handles are compared in the transaction.
    const previousOriginals=new Map();for(const row of originals.values())previousOriginals.set(row.head.key,await loadOriginal(namespace,row.head.sha256,{guard:check,isCurrent}));
    await check();
    await operation('readwrite',isCurrent,(tx,read,set)=>census(tx,read,namespace,(heads)=>originalCensus(tx,read,namespace,(originalHeads)=>pair(tx,read,head.key,(storedHead,storedRecord)=>{
      if(storedHead){
        if(!sameCarrierFields(storedHead,head)||!storedRecord||Object.keys(storedRecord).length!==3||storedRecord.key!==head.key||storedRecord.namespace!==namespace||!sameCarrierFields(storedRecord.proof,proof))fail('来源关联已被另一页面修改，未覆盖');
      }else{
        if(previous)fail('来源关联记录已消失，请重新核对');
        summarizeBundleCarrierStorage([...heads,head],namespace); // Includes full record and index overhead.
      }
      const merged=new Map(originalHeads.map(row=>[row.key,row]));for(const row of originals.values()){
        const prior=merged.get(row.head.key);if(prior&&!sameCarrierFields(prior,row.head))fail('同一来源成员已有不同索引，未覆盖');merged.set(row.head.key,row.head);
      }
      summarizeBundleCarrierOriginals([...merged.values()],namespace);
      const rows=[...originals.values()];let at=0;
      const next=()=>{
        if(at===rows.length){if(!storedHead){tx.objectStore('proofs').add(record);tx.objectStore('heads').add(head);}set(true);return;}
        const row=rows[at++];originalPair(tx,read,row.head.key,(existingHead,existingRecord)=>{
          checkOriginalPair(existingHead,existingRecord,namespace);
          if(existingHead){if(!sameCarrierFields(existingHead,row.head))fail('来源成员在核对期间变化，请重新核对');}
          else{if(previousOriginals.get(row.head.key))fail('来源成员已消失，请重新核对');tx.objectStore('originals').add(row.record);tx.objectStore('originalHeads').add(row.head);}
          next();
        });
      };next();
    }))));
    const saved=await load(namespace,proof.carrierDigest,{guard,isCurrent});if(!sameCarrierFields(saved,proof))fail('来源关联写后核对不符，请保留原包');
    // Read back our immutable original bytes, not a reserialized external journal object.
    await verifyBundleCarrierMembers(saved,{load:({sha256})=>loadOriginal(namespace,sha256,{guard:check,isCurrent}),guard:check});await check();return head;
  }
  async function loadOriginal(namespace,sha256,{guard=async()=>{},isCurrent=()=>true}={}){
    const check=async()=>{current(isCurrent);await guard();current(isCurrent);},key=bundleCarrierKey(namespace,sha256);await check();
    const value=await operation('readonly',isCurrent,(tx,read,set)=>originalPair(tx,read,key,(head,record)=>set({head,record}))),file=checkOriginalPair(value.head,value.record,namespace);await check();
    if(file){const bytes=new Uint8Array(await file.arrayBuffer());await check();if(await vibeDigest(bytes)!==sha256)fail('来源成员原始字节已变化，未覆盖');await check();}return file;
  }
  async function saveOriginalEntry(namespace,file,{head:inputHead,confirmed=false,guard=async()=>{},isCurrent=()=>true}={}){
    if(confirmed!==true)fail('请明确确认保全来源成员原文');const check=async()=>{current(isCurrent);await guard();current(isCurrent);};await check();
    const head=structuredClone(inputHead),member=await inspectBundleCarrierOriginal(file,head,{namespace,guard:check});
    const previous=await loadOriginal(namespace,head.sha256,{guard:check,isCurrent});
    await operation('readwrite',isCurrent,(tx,read,set)=>originalCensus(tx,read,namespace,heads=>originalPair(tx,read,head.key,(existingHead,record)=>{
      checkOriginalPair(existingHead,record,namespace);
      if(existingHead){if(!sameCarrierFields(head,existingHead))fail('来源成员目录冲突，未覆盖');}
      else{
        if(previous)fail('来源成员原文已变化，请重新核对');summarizeBundleCarrierOriginals([...heads,head],namespace);
        tx.objectStore('originals').add({key:head.key,namespace,file:file.slice(0,file.size,'application/json')});tx.objectStore('originalHeads').add(head);
      }set(true);
    })));
    const saved=await loadOriginal(namespace,head.sha256,{guard:check,isCurrent});if(!saved)fail('来源成员写后核对缺失');await check();return {head,member};
  }
  async function saveOriginal(namespace,file,options){return (await saveOriginalEntry(namespace,file,options)).head;}
  // A batch owns its private verified-member map; callers cannot supply or retain a verification bypass.
  // Raw records and individual proofs are atomic, but the batch is deliberately resumable, not all-or-nothing.
  async function saveBatch(namespace,input,{confirmed=false,loadProof,loadOriginal:readOriginal,guard=async()=>{},isCurrent=()=>true}={}){
    if(confirmed!==true)fail('请明确确认保全全部来源记录及原文');
    const check=async()=>{current(isCurrent);await guard();current(isCurrent);};await check();
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==2||!Object.hasOwn(input,'heads')||!Object.hasOwn(input,'originals')||typeof loadProof!=='function'||typeof readOriginal!=='function')fail('来源批次缺少完整目录或原文读取接口');
    summarizeBundleCarrierStorage(input.heads,namespace);summarizeBundleCarrierOriginals(input.originals,namespace);
    const {heads,originals}=structuredClone(input),verified=new Map();
    const merged=(local,wanted)=>{const rows=new Map(local.map(row=>[row.key,row]));for(const head of wanted){if(rows.has(head.key)&&!sameCarrierFields(rows.get(head.key),head))fail('来源批次与已有目录冲突，未覆盖');rows.set(head.key,head);}return [...rows.values()];};
    const before=await list(namespace,{guard:check,isCurrent});
    summarizeBundleCarrierStorage(merged(before.heads,heads),namespace);summarizeBundleCarrierOriginals(merged(before.originals,originals),namespace);
    // Each original is fully parsed/hashed, appended if missing and read back once, even if no proof references it.
    for(const head of originals){await check();const file=await readOriginal(head.sha256);await check();const result=await saveOriginalEntry(namespace,file,{head,confirmed:true,guard:check,isCurrent});verified.set(head.sha256,Object.freeze({...result.member}));}
    for(const head of heads){
      await check();const inputProof=await loadProof({...head});await check();const value=await inspectBundleCarrierProof(inputProof,{namespace,guard:check});
      if(!sameCarrierFields(head,bundleCarrierHead(value.summary)))fail('来源批次证明与目录不符');
      for(const member of value.members)if(!sameBundleMappingHead(verified.get(member.sha256),member.head))fail('来源批次原成员缺失或与目录不符');
      await appendBatchProof(namespace,head,value,{guard:check,isCurrent});
    }
    // Re-read every full proof and unique stored byte sequence after all writes.
    // load verifies the full proof and its digest; no source body or cached Blob substitutes for stored readback.
    for(const head of heads){const saved=await load(namespace,head.carrierDigest,{guard:check,isCurrent});if(!saved||saved.digest!==head.digest)fail('来源批次证明写后核对不符');await check();}
    for(const head of originals){if(!await loadOriginal(namespace,head.sha256,{guard:check,isCurrent}))fail('来源批次原文写后缺失');await check();}
    const after=await list(namespace,{guard:check,isCurrent}),savedHeads=new Map(after.heads.map(row=>[row.key,row])),savedOriginals=new Map(after.originals.map(row=>[row.key,row]));
    if(heads.some(row=>!sameCarrierFields(savedHeads.get(row.key),row))||originals.some(row=>!sameCarrierFields(savedOriginals.get(row.key),row)))fail('来源批次写后目录缺失或变化');
    await check();return {count:heads.length,originalCount:originals.length};
  }
  // Only saveBatch can reach this helper, after full private membership validation.
  async function appendBatchProof(namespace,head,{proof,members},{guard,isCurrent}){
    const previous=await load(namespace,head.carrierDigest,{guard,isCurrent});if(previous&&!sameCarrierFields(previous,proof))fail('同一载体已有不同来源证明，未覆盖');await guard();
    await operation('readwrite',isCurrent,(tx,read,set)=>census(tx,read,namespace,heads=>originalCensus(tx,read,namespace,originalHeads=>pair(tx,read,head.key,(storedHead,storedRecord)=>{
      if(storedHead){if(!sameCarrierFields(storedHead,head)||!storedRecord||Object.keys(storedRecord).length!==3||storedRecord.key!==head.key||storedRecord.namespace!==namespace||!sameCarrierFields(storedRecord.proof,proof))fail('来源证明在批次中已变化，未覆盖');}
      else{if(previous)fail('来源证明已消失，请重新核对');summarizeBundleCarrierStorage([...heads,head],namespace);}
      const raw=new Map(originalHeads.map(row=>[row.sha256,row]));
      for(const member of members)if(!sameCarrierFields(raw.get(member.sha256),bundleCarrierOriginalHead(namespace,member.sha256,member.head.bytes)))fail('来源原文在批次中缺失或变化');
      if(!storedHead){tx.objectStore('proofs').add({key:head.key,namespace,proof});tx.objectStore('heads').add(head);}set(true);
    }))));
  }
  return Object.freeze({list,load,loadOriginal,save,saveOriginal,saveBatch,close(){closed=true;for(const tx of pending)try{tx.abort();}catch(_){}database?.close();database=null;opening=null;}});
}
