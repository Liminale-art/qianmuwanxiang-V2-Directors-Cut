import {hasStoryboardStreamReference,normalizeStoryboardStreamReference,normalizeStoryboardStreamFinalCapture,storyboardStreamGeneration} from './qianmu-storyboard-stream-reference.js?v=1.59.231';

// Finished host notifications share the existing automatic-capture queue. A
// persisted final-pass marker prevents repeated notifications/reloads from
// rerunning the LLM after success, failure or an interrupted paid batch.
export async function finishStoryboardStreamCapture(ticket,d){
  const floor=d.storyboardAutomaticTicketFloor(ticket);
  if(floor<0)return false;
  const {state,message,messageRef}=ticket,generation=JSON.stringify(storyboardStreamGeneration(message));
  const valid=()=>d.storyboardAutomaticTicketFloor(ticket)===floor&&JSON.stringify(storyboardStreamGeneration(message))===generation;
  let outcome=null,attemptError=null,attempted=false,marker,plan,namespace;
  try{
    const refs=[...state.shotPlans.map(row=>row.messageRef),...state.logs.map(row=>row.snapshot?.messageRef),...d.storyboardGalleryRecords().map(row=>row.messageRef)];
    const families=new Set();
    for(const ref of refs){
      if(!hasStoryboardStreamReference(ref)||ref.chatKey!==ticket.chatKey||ref.messageKey!==messageRef.messageKey)continue;
      const proof=normalizeStoryboardStreamReference(ref);
      if(proof.invalid)throw Error('本层流式来源记录不完整，未重新自动生成');
      if(JSON.stringify(proof.generation)===generation)families.add(ref.revisionId);
    }
    if(!families.size)return null; // Ordinary finished-floor behavior remains unchanged.
    if(!ticket.autoGenerate||!state.automation.autoGenerate)return false;
    if(families.size!==1)throw Error('本层流式任务归属不唯一，未重新自动生成');
    const matches=state.shotPlans.filter(row=>families.has(row.revisionId)&&row.chatKey===ticket.chatKey&&row.origin==='automatic');
    if(matches.length!==1)throw Error('本层原流式计划缺失或重复，请手动核对，未重复提交');
    [plan]=matches;
    if(Object.hasOwn(plan,'streamFinalCapture')){
      const old=normalizeStoryboardStreamFinalCapture(plan.streamFinalCapture);
      if(old.invalid)throw Error('终稿取景记录不完整，未重新自动生成');
      if(old.sourceRevisionId===messageRef.revisionId)return false;
    }
    namespace=await d.resolveNamespace();
    if(typeof namespace!=='string'||!namespace.startsWith('st-user:'))throw Error('无法确认终稿所属账户，未自动补图');
    if(!valid())return false;
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
