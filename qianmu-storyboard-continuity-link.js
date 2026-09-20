import {replayStoryboardContinuityAt,replayStoryboardContinuityEnd} from './qianmu-storyboard-continuity-events.js';

const fail=message=>{throw Object.assign(Error(message),{code:'storyboard_continuity_link'});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const slot=fact=>JSON.stringify([fact.category,fact.subject,fact.key.toLowerCase()]);
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export const STORYBOARD_CONTINUITY_CHAIN_LIMIT=21;
const referenceKey=(floor,revisionId,eventId)=>JSON.stringify([floor,revisionId,eventId]);
const localFacts=now=>now.activeFacts.map(fact=>({fact,source:{messageRef:now.messageRef,branchId:now.branchId,kind:'current',subjectId:fact.subject,via:[]}}));

// Pure bridge: the host must verify BOTH live sources, exact account/chat owner
// and reference-floor selection. Matching labels are never continuity evidence.
// It does not read history, invoke models, change request text or persist facts.
export function linkStoryboardContinuity({previous,current,target,link}={}){
  const now=replayStoryboardContinuityAt(current?.events,current?.options,target);
  const before=link==null?null:replayStoryboardContinuityEnd(previous?.events,previous?.options,link.fromBranchId);
  return applyLink(before?{current:before,effectiveFacts:localFacts(before)}:null,now,current.options,link,false);
}

function applyLink(prior,now,options,link,qualified){
  const currentFacts=localFacts(now);
  if(link===null||link===undefined)return freeze({current:now,carriedFacts:[],effectiveFacts:currentFacts});
  if(!exact(link,['relation','fromRevisionId','toRevisionId','fromBranchId','toBranchId','evidence','facts'])||link.relation!=='continuous'
    ||link.toRevisionId!==now.messageRef.revisionId||link.toBranchId!==now.branchId||!exact(link.evidence,['paragraphId','quote'])||!Array.isArray(link.facts)||link.facts.length>80)fail('跨层承接缺少明确版本、分支或连续性依据');
  const before=prior?.current;
  if(!before||before.branchId!==link.fromBranchId)fail('承接分支未对应前一层快照');
  if(before.messageRef.revisionId!==link.fromRevisionId||before.messageRef.chatKey!==now.messageRef.chatKey||before.messageRef.lastKnownFloor>=now.messageRef.lastKnownFloor
    ||before.narrativeLayer!==now.narrativeLayer)fail('跨层承接来源不属于同一有序叙事分支');
  const evidence=replayStoryboardContinuityAt([],options,{branchId:now.branchId,paragraphId:link.evidence.paragraphId,evidence:link.evidence.quote});
  if(evidence.point.index>now.point.index||evidence.point.index===now.point.index&&evidence.point.offset>now.point.offset)fail('承接依据晚于本镜时点');
  const available=new Map(prior.effectiveFacts.map(row=>[qualified?referenceKey(row.source.messageRef.lastKnownFloor,row.source.messageRef.revisionId,row.fact.id):row.fact.id,row])),selected=new Set(),slots=new Set(),carriedFacts=[];
  // Even an expired current assignment prevents an older value from resurfacing.
  const overridden=new Set(now.facts.map(slot));
  for(const row of link.facts){
    const keyId=qualified?referenceKey(row?.sourceFloor,row?.sourceRevisionId,row?.eventId):row?.eventId;
    if(!exact(row,qualified?['sourceFloor','sourceRevisionId','eventId','subjectId']:['eventId','subjectId'])||selected.has(keyId)||!options.subjectIds.includes(row.subjectId))fail('承接人物映射或状态编号无效');
    const original=available.get(keyId);if(!original||original.fact.persistence!=='persistent')fail('只可承接来源末尾仍有效的持续状态');
    selected.add(keyId);
    const fact={...original.fact,subject:row.subjectId},key=slot(fact);if(slots.has(key))fail('多条旧状态映射到同一人物状态槽');slots.add(key);
    if(!overridden.has(key))carriedFacts.push({fact,source:{...original.source,kind:'inherited',via:[...original.source.via,{messageRef:now.messageRef,branchId:now.branchId,subjectId:row.subjectId,evidence:{...link.evidence}}]}});
  }
  return freeze({current:now,carriedFacts,effectiveFacts:[...carriedFacts,...currentFacts]});
}

// Recompute a bounded chain from validated raw sources, never trust a saved
// effective-fact array. Every hop names the immediate previous revision, while
// selected facts name original floor + revision so reused local IDs cannot clash.
export function replayStoryboardContinuityChain(steps,target){return replayChain(steps,target,false);}
export function replayStoryboardContinuityChainEnd(steps){return replayChain(steps,null,true);}
function replayChain(steps,target,end){
  if(!Array.isArray(steps)||!steps.length||steps.length>STORYBOARD_CONTINUITY_CHAIN_LIMIT)fail('连续来源链超出参考范围，未截断');
  let result=null,lastRef=null;
  for(let index=0;index<steps.length;index++){
    const step=steps[index];if(!exact(step,['source','branchId','link'])||index===0&&step.link!=null)fail('连续来源链首项或字段无效');
    const now=index===steps.length-1&&!end?replayStoryboardContinuityAt(step.source?.events,step.source?.options,target):replayStoryboardContinuityEnd(step.source?.events,step.source?.options,step.branchId);
    if(now.branchId!==step.branchId||lastRef&&(now.messageRef.chatKey!==lastRef.chatKey||now.messageRef.lastKnownFloor<=lastRef.lastKnownFloor))fail('连续来源链乱序或分支不符');
    result=applyLink(result,now,step.source.options,step.link,true);lastRef=now.messageRef;
  }
  return result;
}
