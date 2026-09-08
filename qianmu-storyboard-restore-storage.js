import { vibeDigest } from './qianmu-vibe-file.js';

const fail = message => { throw Object.assign(new Error(message), { code: 'storyboard_restore_storage', submissionState: 'not_submitted' }); };
const account = value => typeof value === 'string' && /^st-user:.+/.test(value) && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const kinds = ['configuration','vibes','characters','bundle'];
const clone = structuredClone;
const identity = row => JSON.stringify([row?.kind,row?.key]);
async function readRows(journal, namespace, guard) {
  await guard(); const stages = await journal.list(namespace); await guard();
  const mutation = await journal.loadMutation(namespace); await guard();
  const characters = await journal.loadResource(namespace,'characters'); await guard();
  const bundle = await journal.loadResource(namespace,'bundle'); await guard();
  if (stages.length > 8) fail('恢复记录超出支持范围，请先保全核对');
  return [...stages.map(record=>({kind:'vibes',record})),...(mutation?[{kind:'configuration',record:mutation}]:[]),...(characters?[{kind:'characters',record:characters}]:[]),...(bundle?[{kind:'bundle',record:bundle}]:[])];
}
async function summarize(rows, namespace, guard) {
  const items = [];
  for (const {kind,record} of rows) {
    if (record.namespace !== namespace) fail('恢复记录账户不符');
    const text = JSON.stringify(record), fingerprint = await vibeDigest(text); await guard();
    items.push({ kind, key: kind==='configuration'?namespace:record.key, fingerprint, bytes:new Blob([text]).size, revision:record.revision,
      phase:record.phase, chatHash:record.chatHash||'', fileHash:record.fileHash||record.sourceDigest, updatedAt:record.updatedAt??record.createdAt });
  }
  return { version:1, status:'ready', namespace, bytes:items.reduce((sum,row)=>sum+row.bytes,0), count:items.length, items };
}

// Run in a short-lived Worker: a configuration before/after body can be large and must never reach the DOM/main thread.
export async function collectRestoreStorage({ journal, namespace, guard }) {
  if (!account(namespace) || typeof guard !== 'function') fail('缺少恢复记录账户核对');
  return summarize(await readRows(journal,namespace,guard),namespace,guard);
}

export async function clearRestoreStorage({ journal, namespace, selected, confirmed=false, recoveryLossAccepted=false, guard, isCurrent,
  locks=globalThis.navigator?.locks }) {
  if (!account(namespace) || typeof guard!=='function' || typeof isCurrent!=='function') fail('缺少恢复记录清理范围');
  if (confirmed!==true || recoveryLossAccepted!==true) fail('请明确确认失去所选恢复记录；这不会回滚配置或删除原图');
  if (!Array.isArray(selected) || !selected.length || selected.length>11 || new Set(selected.map(identity)).size!==selected.length
    || selected.some(row=>!row||Object.keys(row).some(key=>!['kind','key','fingerprint'].includes(key))||!kinds.includes(row.kind)||typeof row.key!=='string'||!/^([a-f0-9]{64})$/.test(row.fingerprint))) fail('请重新选择有效的恢复记录');
  const choices=clone(selected);
  const check=async()=>{if(isCurrent()!==true)fail('清理页面已变化');await guard();if(isCurrent()!==true)fail('清理页面已变化');};
  if(!locks?.request)fail('浏览器不支持跨页核对锁，未清理恢复记录');
  const locked=(name,work)=>locks.request(name,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)fail('另一页面正在导入或恢复，请稍后清理');await check();return work();});
  return locked(`qianmu:package-import:${namespace}`,()=>locked(`qianmu:character-restore:${namespace}`,async()=>{
    const rows=await readRows(journal,namespace,check), summary=await summarize(rows,namespace,check);
    const current=new Map(summary.items.map((row,index)=>[identity(row),{summary:row,...rows[index]}]));
    // Reject the entire stale selection before clearing anything. Journal CAS checks again at each actual deletion.
    for(const row of choices)if(current.get(identity(row))?.summary.fingerprint!==row.fingerprint)fail('所选恢复记录已变化，请重新盘点；未删除任何记录');
    const removed=[];let removedBytes=0;
    for(const choice of choices){
      try{
        await check(); const row=current.get(identity(choice)),options={confirmed:true,isCurrent};
        if(row.kind==='configuration')await journal.dismissMutation(row.record,options);
        else if(row.kind==='vibes')await journal.dismissCheckpoint(row.record,options);
        else await journal.dismissResource(row.record,options);
        removed.push(choice);removedBytes+=row.summary.bytes;await check();
      }catch(error){return {version:1,namespace,removed,bytes:removedBytes,complete:false,error:String(error?.message||'清理未确认；请重新盘点'),remaining:choices.length-removed.length};}
    }
    return {version:1,namespace,removed,bytes:removedBytes,complete:true,remaining:0};
  }));
}

export function validateRestoreStorageSummary(value,namespace){
  const integer=v=>Number.isSafeInteger(v)&&v>=0;
  if(!account(namespace)||!value||Object.keys(value).some(key=>!['version','status','namespace','bytes','count','items'].includes(key))||value.version!==1||value.status!=='ready'||value.namespace!==namespace||!Array.isArray(value.items)||value.items.length>11||value.count!==value.items.length||!integer(value.bytes))fail('恢复记录计值无效');
  const seen=new Set();
  for(const row of value.items){
    if(!row||Object.keys(row).some(key=>!['kind','key','fingerprint','bytes','revision','phase','chatHash','fileHash','updatedAt'].includes(key))||!kinds.includes(row.kind)||typeof row.key!=='string'||row.key.length>2048
      ||!integer(row.bytes)||!integer(row.revision)||row.revision<1||!integer(row.updatedAt)||!(/^[a-f0-9]{64}$/).test(row.fingerprint)||!(/^[a-f0-9]{64}$/).test(row.fileHash)
      ||!(row.chatHash===''||/^[a-f0-9]{64}$/.test(row.chatHash))||!['prepared','staging','assets_ready','applied','uncertain','originals','workflows','pools','metadata','vibes','verified'].includes(row.phase)||seen.has(identity(row)))fail('恢复记录摘要不完整');
    const key=row.kind==='configuration'?namespace:row.kind==='vibes'?JSON.stringify([namespace,row.chatHash,row.fileHash]):JSON.stringify([namespace,row.kind]);
    if(row.key!==key)fail('恢复记录摘要归属不符');
    seen.add(identity(row));
  }
  if(value.bytes!==value.items.reduce((sum,row)=>sum+row.bytes,0))fail('恢复记录占用合计不符');
  return clone(value);
}
