import {hasStoryboardStreamReference,normalizeStoryboardStreamFinalCapture,storyboardStreamGeneration,storyboardStreamBudgetReference,verifyStoryboardStreamReference} from './qianmu-storyboard-stream-reference.js?v=1.59.240';
import {resolveStoryboardMessageReference} from './qianmu-storyboard.js?v=1.59.240';
import {readStoryboardContinuationLinks} from './qianmu-storyboard-continuation-proof.js?v=1.59.240';
import {createStoryboardStreamLineage} from './qianmu-storyboard-stream-lineage.js?v=1.59.240';
import {verifyStoryboardOrdinaryContinuation} from './qianmu-storyboard-ordinary-continuation.js?v=1.59.240';
import {verifyStoryboardStreamAttemptPrefix} from './qianmu-storyboard-stream-attempt.js?v=1.59.240';

// Finished host notifications share the existing automatic-capture queue. A
// persisted final-pass marker prevents repeated notifications/reloads from
// rerunning the LLM after success, failure or an interrupted paid batch.
export async function finishStoryboardStreamCapture(ticket,d){
  const floor=d.storyboardAutomaticTicketFloor(ticket);
  if(floor<0)return false;
  const {state,message,messageRef}=ticket,generation=JSON.stringify(storyboardStreamGeneration(message));
  const valid=()=>d.storyboardAutomaticTicketFloor(ticket)===floor&&JSON.stringify(storyboardStreamGeneration(message))===generation
    &&(!plan||state.shotPlans.includes(plan)&&plan.status!=='cancelled'&&!plan.promptLocked&&!plan.manualReviewRequired);
  let outcome=null,attemptError=null,attempted=false,marker,plan,namespace;
  try{
    const refs=[...state.shotPlans.map(row=>row.messageRef),...state.logs.map(row=>row.snapshot?.messageRef),...d.storyboardGalleryRecords().map(row=>row.messageRef)];
    if(refs.length>2000||state.shotPlans.length>300)throw Error('流式任务记录超过核对范围，未新增自动生成');
    const links=()=>readStoryboardContinuationLinks(d.getContext().chatMetadata?.story_director_liminale);
    const currentLineage=createStoryboardStreamLineage(messageRef,message,links());
    const matchesSource=(lineage,ref)=>hasStoryboardStreamReference(ref)?lineage.matches(ref):lineage.matchesOrdinary(ref);
    const candidates=refs.filter(ref=>matchesSource(currentLineage,ref));
    if(!candidates.length){
      if(currentLineage.links.length)throw Error('本次续写未找到可核对的原自动计划，请手动重新提取；未另开额度');
      return null; // An ordinary NEW floor keeps its existing automatic path.
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
    plan.streamFinalCapture=marker;d.saveSettings();
    await d.storyboardCompilePrompt(null,{quiet:true,automatic:true,stream:{floor,complete:true,namespace},onPrepared:async prepared=>{
      if(!valid())throw Object.assign(Error('终稿来源已变化，未继续补图'),{code:'storyboard_input_changed'});
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
    if(marker&&valid()&&namespace===await d.resolveNamespace().catch(()=>null)&&valid()){
      const current=state.shotPlans.find(row=>row.id===plan.id);
      if(current?.streamFinalCapture?.requestId===marker.requestId){
        current.streamFinalCapture={...marker,status:attemptError||!attempted||outcome?.failed?'failed':'complete',updatedAt:Date.now()};
        d.saveSettings();
      }
      if(outcome?.queued&&(attemptError||outcome.failed))d.toast(`终稿已入队 ${outcome.queued} 镜；其余未提交镜头请单独核对，勿整批重复生成`,'warning');
    }
  }
}
