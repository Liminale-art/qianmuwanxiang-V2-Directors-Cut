import {captureCurrentChatSource} from './qianmu-current-chat-source.js';
import {createCurrentGalleryArchiveSession} from './qianmu-gallery-archive-source.js?v=1.59.389';
import {createGalleryArchiveStorage} from './qianmu-gallery-archive-storage.js?v=1.59.389';
import {createGalleryRestoreSource} from './qianmu-gallery-restore-source.js';
import {createGalleryRestorePlanStorage} from './qianmu-gallery-restore-plan.js';
import {prepareGalleryRestore} from './qianmu-gallery-restore-preparation.js';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// Explicit preparation preserves the current baseline but never calls a host
// writer, restores image paths, generates content, or modifies current metadata.
export async function prepareCurrentGalleryRestore({selection,archive,getContext,epoch,account,headers,guard,isCurrent,canPrepare,
  signal,onProgress=()=>{},fetchImpl,createStorage}={}){
  if(typeof guard!=='function'||typeof isCurrent!=='function'||typeof canPrepare!=='function')throw Error('恢复准备环境尚未就绪');
  const current=captureCurrentChatSource({getContext,epoch}),owned=new Set([current]);let closed=false,preservationStarted=false;
  function close(){closed=true;for(const resource of owned)resource.close();owned.clear();}
  function live(){if(closed||signal?.aborted||isCurrent()!==true||canPrepare()!==true)throw Error('当前聊天仍在处理、页面变化或恢复准备已取消');current.assertCurrent();return true;}
  async function check(){live();if(await guard()!==true)throw Error('恢复准备账户已变化');live();return true;}
  async function own(promise){const resource=await promise;if(closed){resource.close();throw Error('恢复准备已取消');}owned.add(resource);await check();return resource;}
  signal?.addEventListener('abort',close,{once:true});
  try{
    await check();
    if(selection?.scope?.namespace!==await account()||!same({ownerKey:selection.scope.ownerKey,chatKey:selection.scope.chatKey},current.source))throw Error('请先打开此版本的准确原聊天，再准备恢复');
    const source=await own(createGalleryRestoreSource({selection,archive,guard:check,signal})),sourceMeta=await source.metadata();
    if(!same(sourceMeta.supplement.target,current.target))throw Error('所选版本不属于当前原聊天');
    await onProgress({phase:'preserving',completed:0,total:0});await check();
    const session=await own(createCurrentGalleryArchiveSession({getContext,epoch,account,headers,fetchImpl,createStorage,guard:live,
      preserveOriginals:false,preserveSupplements:true,preserveEvidence:true}));
    preservationStarted=true;const saved=await session.preserveAll();await check();
    if(saved.supplements?.state!=='complete'||saved.evidences?.state!=='complete')throw Error('当前聊天的关联资料或正文尚未完整保全，请保存聊天后重试；原资料未修改');
    const baselineSelection={schema:'qianmu.gallery.source-version.v3',scope:session.scope,sourceReceipt:saved.sourceReceipt,manifest:saved.reference,supplement:saved.supplement,evidence:saved.evidence};
    const baselineArchive=await own(createGalleryArchiveStorage({scope:session.scope,guard:live,verifyRecord:()=>false,createStorage}));
    const baseline=await own(createGalleryRestoreSource({selection:baselineSelection,archive:baselineArchive,guard:check,signal}));
    const metadata=await baseline.metadata(),planStorage=await own(createGalleryRestorePlanStorage({scope:session.scope,guard:check,createStorage}));
    return await prepareGalleryRestore({source,baseline,planStorage,guard:check,signal,onProgress,verifyCurrent:async()=>{
      const now=await session.verifySavedSource();await check();
      // Restored evidence normalizes JSON key order. Compare the authenticated
      // content digests and sizes, not incidental serialization property order.
      const equalRef=(a,b)=>a?.bytes===b?.bytes&&a?.sha256===b?.sha256;
      return same(now.sourceReceipt,saved.sourceReceipt)&&now.supplement.sha256===metadata.supplement.sha256
        &&equalRef(now.supplement.source,metadata.supplement.source)&&equalRef(now.evidence.source,metadata.evidence.source)
        &&equalRef(now.evidence.header,metadata.evidence.header)&&now.evidence.chatEvidence.digest===metadata.evidence.chatEvidence.digest
        &&now.evidence.chatEvidence.messages.length===metadata.evidence.chatEvidence.messages.length;
    }});
  }catch(error){if(preservationStarted)error.writeState='unconfirmed';throw error;}
  finally{signal?.removeEventListener('abort',close);close();}
}
