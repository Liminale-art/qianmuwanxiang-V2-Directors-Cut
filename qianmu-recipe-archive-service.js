import {createChatCharacterReceiptService} from './qianmu-chat-character-receipt-service.js';
import {createRecipeArchiveStore} from './qianmu-recipe-archive-store.js';
import {imageServiceAccountStillMatches} from './qianmu-image-service-access.js';
import {recipeArchiveError,recipeArchiveRequest,recipeArchiveSnapshot,recipeArchiveReference,recipeArchiveResponse,recipeArchiveStorageRequest,recipeArchiveStorageResponse,RECIPE_ARCHIVE_LIMITS} from './qianmu-recipe-archive-contract.js';
import {recipeRestoreRequest,inspectRecipeRestoreRequest,recipeRestoreResponse,recipeVerificationRequest,recipeVerificationResponse} from './qianmu-recipe-restore-contract.js';
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
    restore,verifyRestored,
    async close(){closed=true;await Promise.allSettled([source.close(),store.close(),...pending]);}});
}
