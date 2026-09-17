import {createChatCharacterReceiptService} from './qianmu-chat-character-receipt-service.js';
import {createRecipeArchiveStore} from './qianmu-recipe-archive-store.js';
import {imageServiceAccountStillMatches} from './qianmu-image-service-access.js';
import {recipeArchiveError,recipeArchiveRequest,recipeArchiveSnapshot,recipeArchiveReference,recipeArchiveResponse,RECIPE_ARCHIVE_LIMITS} from './qianmu-recipe-archive-contract.js';
const fail=(code,message,status)=>{throw recipeArchiveError(code,message,status);};

// Accepts selectors, never client recipes/paths/owners. The saved ST record is authoritative.
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
  function run(req,input,options,write){
    let body;try{body=recipeArchiveRequest(input);if(closed)fail('changed','配方保全服务已关闭');if(pending.size>=RECIPE_ARCHIVE_LIMITS.pending)fail('busy','配方保全请求正忙',429);}
    catch(error){return Promise.reject(error);}
    const task=process(req,body,options,write);pending.add(task);void task.finally(()=>pending.delete(task)).catch(()=>{});return task;
  }
  return Object.freeze({preserve:(req,input,options)=>run(req,input,options,true),read:(req,input,options)=>run(req,input,options,false),
    async close(){closed=true;await Promise.allSettled([source.close(),store.close(),...pending]);}});
}
