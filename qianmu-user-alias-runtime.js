import {planUserAliases,projectAliasBindings} from './qianmu-user-alias.js';
import {validateAliasInput,validateAliasTargets,validateAliasPage,validateAliasResult} from './qianmu-user-alias-contract.js';
import {comfyLibraryBackupDigest as digest} from './qianmu-comfy-library-backup.js';
const fail=message=>{throw Object.assign(new Error(message),{code:'character_archive_alias'});};
export async function runUserAliasOperation(action,{journal,store,namespace,chatHash,input,guard=async()=>{},resolveTargets,locks=globalThis.navigator?.locks,isCurrent=()=>true}={}){
  validateAliasInput(action,input);
  const inspect=async()=>{
    await guard();const [bindings,heads]=await Promise.all([store.bindings(namespace),store.list(namespace)]);await guard();
    const plan=await planUserAliases({namespace,chatHash,bindings,choices:input.choices,resolveTargets:async targets=>{await guard();const rows=targets.length?await resolveTargets(targets):[];await guard();return rows;}});
    const headById=new Map(heads.map(head=>[head.id,head]));
    for(const row of plan.display)if(row.archiveId&&headById.get(row.archiveId)?.category!=='user')fail('USER原绑定存在缺档，请先保全核对');
    plan.digest=await digest({plan:plan.digest,heads:heads.map(({id,revision,name,category})=>({id,revision,name,category})).sort((a,b)=>a.id.localeCompare(b.id))});
    await guard();return {plan,bindings,heads,headById};
  };
  if(action==='user-alias-preview'){
    const {plan,headById}=await inspect(),present=new Map(plan.targets.map(row=>[row.subjectKey,row.present]));
    return validateAliasPage({version:1,namespace,chatHash,digest:plan.digest,offset:input.offset,total:plan.display.length,groups:plan.groups,unresolved:plan.unresolved,missing:plan.targets.filter(row=>!row.present).length,ready:plan.ready,
      rows:plan.display.slice(input.offset,input.offset+24).map(row=>({...row,archiveName:headById.get(row.archiveId)?.name||'',present:present.get(row.targetKey)}))},namespace,chatHash,input);
  }
  if(!locks?.request)fail('浏览器不支持跨页恢复锁，USER绑定未修改');
  const locked=(name,work)=>locks.request(name,{mode:'exclusive',ifAvailable:true},async lock=>{if(!lock)fail('另一页面正在恢复或整理角色，请稍后重新核对');return work();});
  return locked(`qianmu:package-import:${namespace}`,()=>locked(`qianmu:character-restore:${namespace}`,async()=>{
    const {plan,bindings,heads}=await inspect();if(!plan.ready||plan.digest!==input.digest)fail('USER关系、目录或选择已变化，请重新核对');
    if(!(await journal.inspectSubjectMap(plan.review)).fits)fail('来源凭据空间不足，未修改USER绑定');
    await guard();await journal.prepareSubjectMap(plan.review,{confirmed:true,isCurrent});await guard();
    if(!(await journal.inspectSubjectMap(plan.review)).receipt)fail('原USER绑定凭据尚未保存，未修改绑定');
    const verifyTargets=async()=>{await guard();const expected=plan.targets.map(row=>row.subjectKey),rows=validateAliasTargets(await resolveTargets(expected),expected);if(rows.some(row=>!row.present))fail('目标人设已移除，请先在ST核对');await guard();};
    await verifyTargets();let mayHaveChanged=false;
    try{
      mayHaveChanged=true;await store.applyUserAliasReview(namespace,plan.review,{expectedBindings:bindings,expectedHeads:heads,confirmed:true,isCurrent});await verifyTargets();
      if(await digest(projectAliasBindings(await store.bindings(namespace),namespace))!==await digest(plan.after))fail('USER整理写入结果与预览不符');
      if(!(await journal.inspectSubjectMap(plan.review)).receipt)fail('USER原绑定凭据无法读回');await guard();
      return validateAliasResult({version:1,namespace,chatHash,digest:input.digest,receiptDigest:plan.review.digest,before:plan.affected.length,after:plan.writes.length,status:'verified'},namespace,chatHash,input);
    }catch(error){if(!mayHaveChanged)throw error;fail(`USER整理结果未全部确认：${error?.message||'请刷新核对'}。原关系凭据保留，请重新打开核对，不会自动重试或回滚。`);}
  }));
}
