import {createChatCharacterReceiptService} from './qianmu-chat-character-receipt-service.js';
import {createRecipeArchiveStore} from './qianmu-recipe-archive-store.js';
import {imageServiceAccountStillMatches} from './qianmu-image-service-access.js';
import {recipeArchiveError,recipeArchiveRequest,recipeArchiveSnapshot,recipeArchiveReference,recipeArchiveResponse,recipeArchiveStorageRequest,recipeArchiveStorageResponse,RECIPE_ARCHIVE_LIMITS} from './qianmu-recipe-archive-contract.js';
import {recipeRestoreRequest,inspectRecipeRestoreRequest,recipeRestoreResponse,recipeVerificationRequest,recipeVerificationResponse} from './qianmu-recipe-restore-contract.js';
import {recipeArchiveBatchRequest,recipeArchiveBatchResponse,recipeArchiveBatchCapabilities,RECIPE_BATCH_LIMITS} from './qianmu-recipe-batch-contract.js';
const fail=(code,message,status)=>{throw recipeArchiveError(code,message,status);};

// Ordinary preserve/read accept only selectors; the saved ST record is authoritative.
// Explicit restore is separate, content-verified and never overwrites a caller-chosen ID.
export function createRecipeArchiveService(options){
  const source=createChatCharacterReceiptService(options),store=createRecipeArchiveStore(options),pending=new Set();let closed=false;
  async function inspect(req,input,signal){
    if(closed||signal?.aborted)fail('changed','配方保全已取消');
    let result;try{result=await source.readGalleryRecipeSource(req,input,{signal});}catch(error){
      const messages={account:'配方核验账户已变化',missing:'原聊天不存在或已移动，未猜测来源',record_changed:'原聊天画面已变化，请重新核对',
        record_missing:'原画面已不存在，未猜测配方',record_ambiguous:'原画面编号重复，无法确认配方来源',size:'原聊天资料头超过读取上限，未截断原件'};
      const code=String(error?.code||'').replace('chat_character_receipt_','');
      fail('source',messages[code]||'原聊天来源无法完整确认，原资料保持不变',error?.status||409);
    }
    if(closed||signal?.aborted)fail('changed','配方保全已取消');
    if(result.unavailable)fail('missing','此画面已明确标为未保留配方，未使用当前配置补齐',404);
    return result;
  }
  async function process(req,input,{signal}={},write){
    const originalRoot=req.user?.directories?.root,base=input.target.kind==='group'?'groupChats':'chats',originalBase=req.user?.directories?.[base];
    const guard=()=>{if(closed||signal?.aborted||!imageServiceAccountStillMatches(req,{namespace:input.expectedAccount})
      ||req.user?.directories?.root!==originalRoot||req.user?.directories?.[base]!==originalBase)fail('changed','配方来源账户或目录已变化，未确认保全');};
    guard();const captured=await inspect(req,input,signal);guard();let reference=null,snapshot,origin;
    if(captured.snapshot!==null){
      snapshot=recipeArchiveSnapshot(captured.snapshot).snapshot;origin='saved-inline';
      if(write)reference=await store.put(req,{version:1,expectedAccount:captured.expectedAccount,
        source:{target:captured.target,recordId:captured.selection.recordId,createdAt:captured.selection.createdAt},snapshot},{signal});
    }else{
      if(captured.reference===null)fail('missing','原聊天只有本机配方引用或未保留配方，未读取其他设备缓存',404);
      reference=recipeArchiveReference(captured.reference);
      const archived=await store.get(req,captured.expectedAccount,reference,{signal});
      // A persisted reference may travel with a renamed/copied chat, but never with a different record or account.
      if(archived.source.recordId!==captured.selection.recordId||archived.source.createdAt!==captured.selection.createdAt)fail('source','配方归档与原画面编号或时间不符');
      snapshot=archived.snapshot;origin='server-archive';
    }
    guard();await inspect(req,input,signal);guard(); // Revalidate the complete saved gallery before returning a usable receipt/body.
    return recipeArchiveResponse({ok:true,version:1,expectedAccount:captured.expectedAccount,target:captured.target,selection:captured.selection,
      reference,...(write?{}:{snapshot,origin}),proof:write?'durable-recipe':'read-only-recipe'});
  }
  function run(req,input,options,write,summary=false){
    let body;try{body=(summary?recipeArchiveStorageRequest:recipeArchiveRequest)(input);if(closed)fail('changed','配方保全服务已关闭');if(pending.size>=RECIPE_ARCHIVE_LIMITS.pending)fail('busy','配方保全请求正忙',429);}
    catch(error){return Promise.reject(error);}
    const originalRoot=req.user?.directories?.root;
    const task=summary?store.usage(req,body.expectedAccount,options).then(value=>{
      if(closed||options?.signal?.aborted||req.user?.directories?.root!==originalRoot||!imageServiceAccountStillMatches(req,{namespace:body.expectedAccount}))fail('changed','配方盘点账户或目录已变化');
      return recipeArchiveStorageResponse({ok:true,...body,...value,limitFiles:RECIPE_ARCHIVE_LIMITS.files,limitBytes:RECIPE_ARCHIVE_LIMITS.totalBytes,proof:'observed-file-sizes'});
    }):process(req,body,options,write);
    pending.add(task);void task.finally(()=>pending.delete(task)).catch(()=>{});return task;
  }
  function batchCapabilities(req,raw){
    const input=recipeArchiveStorageRequest(raw);
    if(closed||!imageServiceAccountStillMatches(req,{namespace:input.expectedAccount}))fail('account','配方批次能力账户已变化',401);
    return recipeArchiveBatchCapabilities({ok:true,...input,selectorOnly:true,maxRecords:RECIPE_BATCH_LIMITS.records,
      maxSnapshotBytes:RECIPE_BATCH_LIMITS.snapshotBytes,proof:'recipe-batch-capabilities',canPrune:false});
  }
  function preserveBatch(req,raw,options={}){
    let input;try{input=recipeArchiveBatchRequest(raw);if(closed||options.signal?.aborted)fail('changed','配方批次已取消');
      if(pending.size>=RECIPE_ARCHIVE_LIMITS.pending)fail('busy','配方保全请求正忙',429);
    }catch(error){return Promise.reject(error);}
    const originalRoot=req.user?.directories?.root,base=input.target.kind==='group'?'groupChats':'chats',originalBase=req.user?.directories?.[base];
    const guard=()=>{if(closed||options.signal?.aborted||!imageServiceAccountStillMatches(req,{namespace:input.expectedAccount})
      ||req.user?.directories?.root!==originalRoot||req.user?.directories?.[base]!==originalBase)fail('changed','配方批次账户或聊天目录已变化');};
    const task=(async()=>{
      guard();
      const result=await source.withGalleryRecipeBatch(req,input,async({records,verify})=>{
        const prepared=[];let bytes=0;
        // Validate every selected recipe before writing any new copy. Only the
        // bounded selection is retained; the complete source is still rehashed.
        for(const record of records){
          guard();await verify();guard();
          if(record.unavailable)fail('missing','批次画面已明确未保留配方，未用当前设置补齐',404);
          let reference=null,value=record.snapshot;
          if(value===null){
            if(record.reference===null)fail('missing','批次原配方只有本机引用或未保留，原记录仍保留',404);
            reference=recipeArchiveReference(record.reference);const saved=await store.get(req,input.expectedAccount,reference,options);guard();await verify();guard();
            if(saved.source.recordId!==record.id||saved.source.createdAt!==record.createdAt)fail('source','批次配方归档与画面编号或时间不符');value=saved.snapshot;
          }
          const captured=recipeArchiveSnapshot(value);bytes+=Buffer.byteLength(captured.text);
          if(bytes>RECIPE_BATCH_LIMITS.snapshotBytes)fail('size','配方批次超过完整保存上限，未裁剪原件',413);
          prepared.push({record,reference,snapshot:captured.snapshot});
        }
        const results=[];
        for(const item of prepared){
          guard();await verify();guard();
          const selection={recordId:item.record.id,createdAt:item.record.createdAt,gallerySha256:input.gallerySha256};
          const reference=item.reference||await store.put(req,{version:1,expectedAccount:input.expectedAccount,
            source:{target:input.target,recordId:selection.recordId,createdAt:selection.createdAt},snapshot:item.snapshot},options);
          guard();await verify();guard();
          results.push(recipeArchiveResponse({ok:true,version:1,expectedAccount:input.expectedAccount,target:input.target,selection,reference,proof:'durable-recipe'}));
        }
        return recipeArchiveBatchResponse({ok:true,...input,records:results,proof:'durable-recipe-batch',canPrune:false});
      },options);
      guard();return result;
    })().catch(error=>{
      if(String(error?.code||'').startsWith('recipe_archive_'))throw error;
      const messages={account:'配方批次账户已变化',changed:'配方批次期间原聊天或账户目录已变化',
        size:'配方批次来源超过完整读取上限，未截断原件',record_changed:'配方批次与已保存的完整图库不符',
        record_ambiguous:'配方批次含缺失、重复或已变化的画面',path:'配方批次来源不是独立常规聊天文件'};
      const code=String(error?.code||'').replace('chat_character_receipt_','');
      fail('source',messages[code]||'配方批次完整来源核验未通过，请保留原聊天及已有副本',error?.status||409);
    });
    pending.add(task);void task.finally(()=>pending.delete(task)).catch(()=>{});return task;
  }
  function restore(req,raw,options={}){
    let input;try{input=recipeRestoreRequest(raw);if(closed||options.signal?.aborted)fail('changed','配方恢复已取消');if(pending.size>=RECIPE_ARCHIVE_LIMITS.pending)fail('busy','配方保全请求正忙',429);}
    catch(error){return Promise.reject(error);}
    const originalRoot=req.user?.directories?.root;
    const guard=()=>{if(closed||options.signal?.aborted||req.user?.directories?.root!==originalRoot||!imageServiceAccountStillMatches(req,{namespace:input.expectedAccount}))fail('changed','配方恢复账户或目录已变化，未确认写入');};
    const task=(async()=>{
      guard();const {envelope}=await inspectRecipeRestoreRequest(input);guard();
      // Import to an immutable generated ID, never overwrite the old ID supplied
      // by a file. Corrupt/missing old files remain untouched for manual recovery.
      const reference=await store.put(req,envelope,options);guard();
      const saved=await store.get(req,input.expectedAccount,reference,options);guard();
      await inspectRecipeRestoreRequest({...input,snapshot:saved.snapshot,source:saved.source});guard();
      return recipeRestoreResponse({ok:true,version:1,expectedAccount:input.expectedAccount,source:input.source,
        originalReference:input.originalReference,reference,proof:'durable-restored-recipe'});
    })();
    pending.add(task);void task.finally(()=>pending.delete(task)).catch(()=>{});return task;
  }
  function verifyRestored(req,raw,options={}){
    let input;try{input=recipeVerificationRequest(raw);if(closed||options.signal?.aborted)fail('changed','配方文件核对已取消');if(pending.size>=RECIPE_ARCHIVE_LIMITS.pending)fail('busy','配方文件核对正忙',429);}
    catch(error){return Promise.reject(error);}
    const originalRoot=req.user?.directories?.root;
    const guard=()=>{if(closed||options.signal?.aborted||req.user?.directories?.root!==originalRoot||!imageServiceAccountStillMatches(req,{namespace:input.expectedAccount}))fail('changed','配方文件核对账户或目录已变化');};
    const task=(async()=>{
      guard();const saved=await store.get(req,input.expectedAccount,input.reference,options);guard();
      if(JSON.stringify(saved.source)!==JSON.stringify(input.source))fail('source','原配方文件不属于此准确聊天和画面');
      return recipeVerificationResponse({ok:true,...input,proof:'read-only-recipe-file'});
    })();pending.add(task);void task.finally(()=>pending.delete(task)).catch(()=>{});return task;
  }
  return Object.freeze({preserve:(req,input,options)=>run(req,input,options,true),read:(req,input,options)=>run(req,input,options,false),
    storage:(req,input,options)=>run(req,input,options,false,true),
    restore,verifyRestored,batchCapabilities,preserveBatch,
    async close(){closed=true;await Promise.allSettled([source.close(),store.close(),...pending]);}});
}
