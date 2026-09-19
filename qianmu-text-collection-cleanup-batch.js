import {textCollectionCleanupPlanResponse,partitionTextCollectionMutations} from './qianmu-text-collection-bulk-contract.js';
import {textCollectionSyncError as error} from './qianmu-text-collection-sync-contract.js';

// The plan is fixed before confirmation. Never refresh IDs or rebase revisions on retry.
export function createTextCollectionCleanupBatch({plan,session,check,confirm,onProgress=()=>{},otherModules=0}={}){
  const selected=textCollectionCleanupPlanResponse(plan,{version:1,expectedAccount:session.expectedAccount});
  const controller=new AbortController();let pending=null,closed=false,authorized=false,batches=null,index=0,confirmed=0,uncertain=false;
  const operations=selected.items.map(item=>session.prepareDelete(item.id,item.revision).request);
  const progress=()=>Object.freeze({total:operations.length,confirmed,uncertain,active:pending!==null});
  const guard=async()=>{check();if(closed)throw error('cancelled','收藏清理已停止');await session.guard();check();if(closed)throw error('cancelled','收藏清理已停止');};
  async function execute(){
    await guard();if(confirmed===operations.length)return {...progress(),status:'complete'};
    const info=await session.batchInfo({signal:controller.signal});await guard();
    if(!authorized){
      if(operations.length>info.remainingMutations)throw error('capacity','收藏同步回执额度不足，请先导出并核对后端；未开始清理',507);
      batches=partitionTextCollectionMutations(operations,{expectedAccount:session.expectedAccount,maxItems:info.maxItems,maxBytes:info.maxBytes}).map(items=>session.prepareBatch(items));
      const accepted=await confirm('清理正文收藏',`将不可恢复地删除当前账户本次列出的 ${operations.length} 条收藏原件。请先导出备份；不删除聊天或其他模块。${otherModules>0?`同时勾选的其他 ${otherModules} 个模块本次不执行，需重新选择。`:''}若条目版本变化则停止，不强行删除。删除后保留同步回执和删除标记，文件不一定归零或变小。中断请保留本窗口重试；关闭后不能续接。确定清理吗？`);
      await guard();if(accepted!==true)return {...progress(),status:'cancelled'};authorized=true;
    }
    while(confirmed<operations.length){
      await guard();const batch=batches[index];uncertain=true;
      try{await batch.submit({signal:controller.signal});}catch(cause){if(cause?.writeState==='not_started')uncertain=false;throw cause;}
      confirmed+=batch.request.mutations.length;index++;uncertain=false;await guard();onProgress(progress());
    }
    return {...progress(),status:'complete'};
  }
  return Object.freeze({run(){if(pending)return pending;const task=execute().finally(()=>{if(pending===task)pending=null;});pending=task;return task;},get progress(){return progress();},close(){closed=true;controller.abort();}});
}
