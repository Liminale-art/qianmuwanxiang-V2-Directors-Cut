import {captureCurrentChatSource} from './qianmu-current-chat-source.js';
import {createGalleryRestorePlanStorage} from './qianmu-gallery-restore-plan.js';
import {createGalleryWritePlanStorage} from './qianmu-gallery-write-plan.js';
import {openPreparedGallerySource} from './qianmu-gallery-prepared-source.js';
import {createPreparedGalleryAssets} from './qianmu-gallery-restore-assets.js';
import {resolvePreparedGalleryWrite,readResolvedGalleryWrite} from './qianmu-gallery-resolved-write.js';
import {createPagedGallerySaveSession} from './qianmu-gallery-chat-save.js';
import {createStoryboardPackageJournal} from './qianmu-storyboard-package-journal.js';
import {inspectHistoricalChatMutation} from './qianmu-historical-chat-journal.js';
import {chatGalleryDigest} from './qianmu-chat-gallery-digest.js';
import {captureGallerySupplement} from './qianmu-gallery-archive-supplement.js';
import {chatGalleryReceiptText} from './qianmu-chat-gallery-receipt.js';
import {projectStoryboardChatMessages,storyboardChatProjectionMatches} from './qianmu-storyboard-chat-evidence.js';
import {scanGalleryEvidenceSource} from './qianmu-gallery-evidence-source.js';
import {verifyPreparedGalleryFiles} from './qianmu-gallery-write-files.js';
import {vibeDigest} from './qianmu-vibe-file.js';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),equal=(a,b)=>chatGalleryReceiptText([{value:a}]).text===chatGalleryReceiptText([{value:b}]).text;
const fail=message=>{throw Error(message);};
// Actual archive entry coordinator. Fresh restoration requires a durable
// preparation; recovery uses the existing account journal, never a fresh plan.
export async function createGalleryRestoreExecution({selection,preparation,archive,getContext,epoch,account,headers,guard,isCurrent,canPrepare,
  signal,onProgress=()=>{},fetchImpl=globalThis.fetch,createStorage,createJournal=createStoryboardPackageJournal,locks=globalThis.navigator?.locks}={}){
  const current=captureCurrentChatSource({getContext,epoch}),owned=new Set([current]);let closed=false,busy=false,preview=null,assets,source,writeStorage,journal,baseline,messages,pending,lastWrite;
  function close(){if(closed)return;closed=true;preview=null;for(const item of owned)item.close();owned.clear();signal?.removeEventListener('abort',close);}
  function live(){if(closed||signal?.aborted||isCurrent()!==true||canPrepare()!==true)fail('恢复页面变化或仍有分镜任务在处理');current.assertCurrent();return true;}
  async function check(){live();if(await guard()!==true||await account()!==selection.scope.namespace)fail('恢复账户已变化');live();return true;}
  async function own(promise){const value=await promise;if(closed){value.close();fail('恢复已取消');}owned.add(value);await check();return value;}
  const summary=receipt=>({count:receipt.count,bytes:receipt.bytes,sha256:receipt.sha256});
  function localSaved(){const store=getContext().chatMetadata.story_director_liminale,saved={};
    for(const field of ['storyboardCollections','characterDrafts']){const d=Object.getOwnPropertyDescriptor(store,field);if(d){if(!Object.hasOwn(d,'value'))fail('当前资料字段不可读取');saved[field]=d.value;}}
    return {gallery:chatGalleryDigest(store.storyboardImages),saved:captureGallerySupplement(saved)};
  }
  async function verifyCurrent({deep=true}={}){await check();if(!deep)return true;
    const now=localSaved();if(!same(now.gallery,baseline.gallery)||!equal(now.saved,baseline.saved)||!storyboardChatProjectionMatches(messages,getContext().chat))fail('当前聊天基线已改变，未继续恢复');await check();return true;}
  async function writer(reference){return own(createPagedGallerySaveSession({source,writeStorage,writeReference:reference,getContext,epoch,account,headers,guard:check,isCurrent:live,journal,fetchImpl,onProgress}));}
  async function readonlyPending(reference){const session=await writer(reference);try{return await session.recover();}finally{session.close();owned.delete(session);}}
  async function operation(work){await check();if(busy)fail('恢复核对正在处理');busy=true;try{return await work();}finally{busy=false;}}
  signal?.addEventListener('abort',close,{once:true});
  try{
    await check();if(!same(current.source,{ownerKey:selection.scope.ownerKey,chatKey:selection.scope.chatKey}))fail('请先打开此版本的准确原聊天');
    journal=await own(createJournal());pending=await journal.loadHistoricalChatMutation(selection.scope.namespace,{isCurrent:live});await check();
    if(pending){pending=await inspectHistoricalChatMutation(pending);if(pending.proposal.kind!=='gallery-paged'||!same(pending.proposal.target,current.target))fail('已有另一项恢复待核对，请先处理原记录');preparation=pending.proposal.preparation;lastWrite=pending.proposal.write;}
    if(!preparation)fail('请先准备此版本的恢复资料；没有待核对记录');
    const plans=await own(createGalleryRestorePlanStorage({scope:selection.scope,guard:check,createStorage}));
    source=await own(openPreparedGallerySource({reference:preparation,planStorage:plans,archive,guard:check,signal}));
    if(!same(source.metadata.plan.source,selection))fail('准备方案或待核对记录属于另一图库版本');
    writeStorage=await own(createGalleryWritePlanStorage({scope:selection.scope,guard:check,createStorage}));
    const before=await source.baselineMetadata();baseline={gallery:summary(source.metadata.plan.baseline.sourceReceipt),saved:before.supplement.saved};
    if(!pending){messages=projectStoryboardChatMessages(getContext().chat);const evidence=await scanGalleryEvidenceSource(messages,current.target.chatId,{guard:live});await check();
      if(evidence.digest!==source.metadata.plan.evidenceDigest)fail('正文版本已变化，请重新核对原件');await verifyCurrent();
      assets=await own(createPreparedGalleryAssets({source,account,headers,guard:check,verifyCurrent,fetchImpl,signal,onProgress}));}
    return Object.freeze({
      preview(){return operation(async()=>{preview=null;let view;
        if(pending){const result=await readonlyPending(pending.proposal.write);
          if(result.status==='saved')view={mode:'recovery',status:'saved',ready:false,result};
          else{const resolved=await readResolvedGalleryWrite({reference:pending.proposal.write,source,writeStorage,guard:check,signal});
            await verifyPreparedGalleryFiles({source,resolutions:resolved.resolutions,headers,guard:check,fetchImpl,signal,onProgress});
            view={mode:'recovery',status:result.status,reason:result.reason,ready:pending.phase!=='verified'&&['confirmation_required','readback_mismatch'].includes(result.reason)};}
          // Reopening may mark a formerly submitted record verified. Bind the
          // actual new revision into the next confirmation instead of stale row.
          pending=await journal.loadHistoricalChatMutation(selection.scope.namespace,{isCurrent:live});await check();
          view.journal={revision:pending.revision,proposalDigest:pending.proposalDigest,phase:pending.phase};
        }else{const value=await assets.preview();view={mode:'fresh',status:'prepared',ready:value.ready,assets:value};}
        const plan=source.metadata.plan;view={...view,preparation:source.metadata.reference,added:plan.added,kept:plan.kept,total:plan.gallery.count,canPrune:false};
        view.digest=await vibeDigest(JSON.stringify(view));await check();preview=structuredClone(view);return structuredClone(view);
      });},
      execute({confirmed=false,expectedDigest}={}){
        if(confirmed!==true||!preview?.ready||expectedDigest!==preview.digest)return Promise.reject(Error('请先核对并明确确认本次原聊天恢复'));const confirmedView=preview;preview=null;
        return operation(async()=>{
          if(!locks?.request)fail('浏览器不支持恢复互斥保护，未写入');
          const lock=(name,run)=>locks.request(name,{mode:'exclusive',ifAvailable:true},async handle=>{if(!handle)fail('另一页面正在导入或恢复，请稍后核对');await check();return run();});
          return lock(`qianmu:package-import:${selection.scope.namespace}`,()=>lock(`qianmu:character-restore:${selection.scope.namespace}`,async()=>{
            const active=await journal.loadHistoricalChatMutation(selection.scope.namespace,{isCurrent:live});await check();let reference;
            if(pending){if(!same(active,pending)||!same(confirmedView.journal,{revision:pending.revision,proposalDigest:pending.proposalDigest,phase:pending.phase}))fail('待核对记录已变化，请重新打开核对');reference=pending.proposal.write;}
            else{if(active)fail('已有其他恢复待核对，未补回原件');
              const resolved=await resolvePreparedGalleryWrite({source,assets,writeStorage,preview:confirmedView.assets,confirmed:true,guard:check,verifyCurrent,signal,onProgress});await check();reference=resolved.reference;}
            lastWrite=reference;const session=await writer(reference);try{
              let result;if(pending){result=await session.recover();if(result.status!=='saved')result=await session.retry({confirmed:true});}
              else result=await session.save({confirmed:true,scope:'paged-gallery-current-chat'});
              await check();if(!['saved','unchanged'].includes(result.status))return result;
              return {...result,status:'restored',canPrune:false};
            }finally{session.close();owned.delete(session);}
          }));
        });
      },
      finish({confirmed=false}={}){if(confirmed!==true)return Promise.reject(Error('请确认结束已完成的恢复核对'));return operation(async()=>{
        const active=await journal.loadHistoricalChatMutation(selection.scope.namespace,{isCurrent:live});await check();if(!active)return {status:'finished'};
        if(active.proposal.kind!=='gallery-paged'||!same(active.proposal.preparation,source.metadata.reference)||!same(active.proposal.write,lastWrite))fail('不是本次恢复记录，未结束');
        const result=await readonlyPending(active.proposal.write);if(result.status!=='saved')fail('恢复尚未完整核实，未结束记录');
        const latest=await journal.loadHistoricalChatMutation(selection.scope.namespace,{isCurrent:live});await check();
        if(latest?.phase!=='verified'||!same(latest.proposal,active.proposal))fail('恢复记录已变化');
        await journal.dismissHistoricalChatMutation(latest,{confirmed:true,isCurrent:live});await check();return {status:'finished'};
      });},close,
    });
  }catch(error){close();throw error;}
}
