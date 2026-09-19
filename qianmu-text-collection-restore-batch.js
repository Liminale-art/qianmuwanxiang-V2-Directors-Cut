import {validateTextCollectionBackup} from './qianmu-text-collection-backup.js';
import {notesSyncOperationId} from './qianmu-notes-sync-contract.js';
import {textCollectionSyncError as error} from './qianmu-text-collection-sync-contract.js';

// The caller owns the account session and whole-file admission. Keep this handle
// alive for explicit in-page retries; it is not a durable reload/resume journal.
export function createTextCollectionRestoreBatch({backup,session,check,confirm,onProgress=()=>{},uid=notesSyncOperationId}={}){
  if(!session||typeof session.guard!=='function'||typeof session.restoreInfo!=='function'||typeof session.prepareRestore!=='function'
    ||typeof check!=='function'||typeof confirm!=='function'||typeof onProgress!=='function'||typeof uid!=='function')throw TypeError('收藏恢复需要当前账户会话与明确确认');
  const payload=validateTextCollectionBackup(backup),ids=new Set(payload.records.map(record=>record.id));
  const operations=payload.records.map(record=>{const id=uid();if(ids.has(id))throw error('contract','恢复副本编号重复，未写入');ids.add(id);return session.prepareRestore(record,id);});
  const controller=new AbortController();let confirmed=0,authorized=false,closed=false,pending=null,uncertain=false;
  const progress=()=>Object.freeze({total:operations.length,confirmed,uncertain,active:pending!==null});
  const result=status=>Object.freeze({status,total:operations.length,confirmed,uncertain});
  const guard=async()=>{check();if(closed)throw error('cancelled','收藏恢复已停止，已确认副本仍保留');await session.guard();check();if(closed)throw error('cancelled','收藏恢复已停止，已确认副本仍保留');};
  async function execute(){
    await guard();if(confirmed===operations.length)return result('complete');
    const info=await session.restoreInfo({signal:controller.signal});await guard();
    if(!authorized){
      if(operations.length>info.remainingRecords||operations.length>info.remainingMutations)throw error('capacity','收藏剩余额度不足以恢复整包，未开始写入',507);
      const foreign=payload.sourceAccount!==session.expectedAccount;
      const accepted=await confirm('恢复正文收藏',`将向当前登录账户新增 ${operations.length} 条独立副本，不覆盖现有收藏。${foreign?'备份来自其他账户，原始来源标识仍会保留。':''}将保留原正文、姓名、日期和范围。恢复后请勿降级到不支持副本格式的旧后端。中断后请保留此窗口重试，关闭或刷新后不能自动续接。是否继续？`);
      await guard();if(!accepted)return result('cancelled');authorized=true;
    }
    while(confirmed<operations.length){
      await guard();uncertain=true;
      try{await operations[confirmed].submit({signal:controller.signal});}catch(cause){if(cause?.writeState==='not_started')uncertain=false;throw cause;}
      confirmed++;uncertain=false;
      await guard();onProgress(progress());
    }
    return result('complete');
  }
  function run(){
    if(pending)return pending;
    const task=execute().finally(()=>{if(pending===task)pending=null;});pending=task;return task;
  }
  return Object.freeze({run,get progress(){return progress();},close(){closed=true;controller.abort();}});
}
