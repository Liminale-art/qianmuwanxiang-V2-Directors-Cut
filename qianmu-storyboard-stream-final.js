import {hasStoryboardStreamReference,normalizeStoryboardStreamFinalCapture,storyboardStreamGeneration,storyboardStreamBudgetReference,verifyStoryboardStreamReference} from './qianmu-storyboard-stream-reference.js?v=1.59.280';
import {resolveStoryboardMessageReference} from './qianmu-storyboard.js?v=1.59.280';
import {readStoryboardContinuationLinks} from './qianmu-storyboard-continuation-proof.js?v=1.59.280';
import {createStoryboardStreamLineage} from './qianmu-storyboard-stream-lineage.js?v=1.59.280';
import {verifyStoryboardOrdinaryContinuation} from './qianmu-storyboard-ordinary-continuation.js?v=1.59.280';
import {verifyStoryboardStreamAttemptPrefix} from './qianmu-storyboard-stream-attempt.js?v=1.59.280';
import {createStoryboardStreamCheckpointStorage} from './qianmu-storyboard-stream-checkpoint-storage.js?v=1.59.280';
import {createStoryboardStreamFinalStorage} from './qianmu-storyboard-stream-final-storage.js?v=1.59.280';
import {probeStoryboardStreamRecovery} from './qianmu-storyboard-stream-recovery.js?v=1.59.280';

// Finished host notifications share the existing automatic-capture queue. A
// persisted final-pass marker prevents repeated notifications/reloads from
// rerunning the LLM after success, failure or an interrupted paid batch.
export async function finishStoryboardStreamCapture(ticket,d){
  const floor=d.storyboardAutomaticTicketFloor(ticket);
  if(floor<0)return false;
  const {state,message,messageRef}=ticket,generation=JSON.stringify(storyboardStreamGeneration(message));
  const valid=()=>d.storyboardAutomaticTicketFloor(ticket)===floor&&JSON.stringify(storyboardStreamGeneration(message))===generation
    &&(!plan||state.shotPlans.includes(plan)&&plan.status!=='cancelled'&&!plan.promptLocked&&!plan.manualReviewRequired);
  let outcome=null,attemptError=null,attempted=false,marker,plan,namespace,checkpoint,prepared=false,owned;
  try{
    const references=()=>{
      const rows=[...state.shotPlans.map(row=>row.messageRef),...state.logs.map(row=>row.snapshot?.messageRef),...d.storyboardGalleryRecords().map(row=>row.messageRef)];
      if(rows.length>2000||state.shotPlans.length>300)throw Error('流式任务记录超过核对范围，未新增自动生成');return rows;
    };
    const refs=references();
    const links=()=>readStoryboardContinuationLinks(d.getContext().chatMetadata?.story_director_liminale);
    const currentLineage=createStoryboardStreamLineage(messageRef,message,links());
    const matchesSource=(lineage,ref)=>hasStoryboardStreamReference(ref)?lineage.matches(ref):lineage.matchesOrdinary(ref);
    const candidates=refs.filter(ref=>matchesSource(currentLineage,ref));
    if(!candidates.length){
      if(currentLineage.links.length)throw Error('本次续写未找到可核对的原自动计划，请手动重新提取；未另开额度');
      const previous=await probeStoryboardStreamRecovery({reference:messageRef,message,resolveNamespace:d.resolveNamespace,guard:valid});
      if(previous)throw Error('本层存在已保存的取景记录，但本地计划缺失；请手动核对，未重复生成');
      if(!valid())return false;
      const latest=createStoryboardStreamLineage(messageRef,message,links());
      if(latest.links.length||references().some(ref=>matchesSource(latest,ref)))return false;
      return null; // Confirmed absent, or an ordinary legacy source without a stream identity.
    }
    if(!ticket.autoGenerate||!state.automation.autoGenerate)return false;
    namespace=await d.resolveNamespace();
    if(typeof namespace!=='string'||!namespace.startsWith('st-user:')||!namespace.slice(8).trim())throw Error('无法确认终稿所属账户，未自动补图');
    if(!valid())return false;
    const lineage=createStoryboardStreamLineage(messageRef,message,links(),namespace),families=new Map(),verified=new Set();
    for(const ref of candidates){
      if(!matchesSource(lineage,ref))throw Error('续写记录账户不一致，未新增自动生成');
      const key=JSON.stringify(ref);
      if(!verified.has(key)){
        const resolve=()=>resolveStoryboardMessageReference(ref,d.getContext().chat,{chatKey:ticket.chatKey,namespace,metadata:d.getContext().chatMetadata});
        if(hasStoryboardStreamReference(ref))await verifyStoryboardStreamReference(ref,resolve);
        else await verifyStoryboardOrdinaryContinuation(ref,resolve,{namespace,required:true});
        if(!valid())return false;verified.add(key);
      }
      const root=hasStoryboardStreamReference(ref)?storyboardStreamBudgetReference(ref,namespace):ref;families.set(JSON.stringify([root.messageKey,root.revisionId]),root);
    }
    if(families.size!==1)throw Error('本层流式任务归属不唯一，未重新自动生成');
    const [root]=families.values();
    const matches=state.shotPlans.filter(row=>row.revisionId===root.revisionId&&row.messageRef?.messageKey===root.messageKey&&row.chatKey===ticket.chatKey&&row.origin==='automatic');
    if(matches.length!==1)throw Error('本层原流式计划缺失或重复，请手动核对，未重复提交');
    [plan]=matches;
    await verifyStoryboardStreamAttemptPrefix(plan,{message:()=>message,guard:()=>{if(!valid())throw Error('终稿来源已变化，未继续补图');}});
    if(!plan.id||root.stream&&plan.id!==`stream-${root.stream.generationKey}`)throw Error('本层原流式计划编号不一致，未重复提交');
    if(!valid())return false;
    if(Object.hasOwn(plan,'streamFinalCapture')){
      const old=normalizeStoryboardStreamFinalCapture(plan.streamFinalCapture);
      if(old.invalid)throw Error('终稿取景记录不完整，未重新自动生成');
      if(old.sourceRevisionId===messageRef.revisionId)return false;
    }
    marker={version:1,sourceRevisionId:messageRef.revisionId,requestId:d.uid('stream-final'),status:'preparing',updatedAt:Date.now()};
    const signature=JSON.stringify(marker),planId=plan.id,partial=plan.streamAttempt,partialSignature=JSON.stringify(partial);
    plan.streamFinalCapture=marker;
    owned=()=>{
      if(!valid()||plan.streamFinalCapture!==marker||JSON.stringify(marker)!==signature||plan.streamAttempt!==partial||JSON.stringify(partial)!==partialSignature
        ||plan.id!==planId||plan.origin!=='automatic'||plan.chatKey!==root.chatKey||plan.revisionId!==root.revisionId||plan.messageRef?.messageKey!==root.messageKey)
        throw Object.assign(Error('终稿计划或检查点已变化，未继续补图'),{code:'storyboard_input_changed'});
      return true;
    };
    owned();d.saveSettings();owned();
    const scope={namespace,chatKey:root.chatKey,messageKey:root.messageKey,revisionId:root.revisionId,planId:plan.id};
    if(partial){
      const previous=await createStoryboardStreamCheckpointStorage({scope,guard:owned});
      try{await previous.verify(partial);owned();}finally{previous.close();}
    }
    checkpoint=await createStoryboardStreamFinalStorage({scope:{...scope,sourceRevisionId:messageRef.revisionId},guard:owned});
    await checkpoint.prepare(marker);owned();prepared=true;
    await d.storyboardCompilePrompt(null,{quiet:true,automatic:true,stream:{floor,complete:true,namespace},onPrepared:async prepared=>{
      owned();
      attempted=true;
      try{outcome=await d.storyboardSubmitStreamPrepared(prepared);await prepared.context.compilerSources.guard();prepared.inputGuard.assertCurrent();}
      catch(error){attemptError=error;outcome=error.streamOutcome||outcome;throw error;}
    }});
    return Boolean(outcome?.queued);
  }catch(error){
    attemptError=error;
    if(valid())d.toast(String(d.sanitizeStoryboardDiagnosticData(error?.message||'终稿补图准备失败')).slice(0,160),'warning');
    return Boolean(outcome?.queued);
  }finally{
    try{
      if(marker&&valid()&&namespace===await d.resolveNamespace().catch(()=>null)&&valid()){
        owned();
        const status=attemptError||!attempted||outcome?.failed?'failed':'complete';
        if(prepared){const receipt=await checkpoint.settle(marker,status);owned();Object.assign(marker,receipt.record);}
        else Object.assign(marker,{status:'failed',updatedAt:Date.now()});
        d.saveSettings();
        if(outcome?.queued&&(attemptError||outcome.failed))d.toast(`终稿已入队 ${outcome.queued} 镜；其余未提交镜头请单独核对，勿整批重复生成`,'warning');
      }
    }catch(_){
      if(valid()&&plan.streamFinalCapture===marker){marker.status='failed';d.toast('终稿检查点保存未确认，已保留入队画面；请勿整批重复生成','warning');}
    }finally{try{checkpoint?.close();}catch(_){}}
  }
}
