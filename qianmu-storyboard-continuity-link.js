import {replayStoryboardContinuityAt,replayStoryboardContinuityEnd} from './qianmu-storyboard-continuity-events.js';

const fail=message=>{throw Object.assign(Error(message),{code:'storyboard_continuity_link'});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const slot=fact=>JSON.stringify([fact.category,fact.subject,fact.key.toLowerCase()]);
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};

// Pure bridge: the host must verify BOTH live sources, exact account/chat owner
// and reference-floor selection. Matching labels are never continuity evidence.
// It does not read history, invoke models, change request text or persist facts.
export function linkStoryboardContinuity({previous,current,target,link}={}){
  const now=replayStoryboardContinuityAt(current?.events,current?.options,target);
  const currentFacts=now.activeFacts.map(fact=>({fact,source:{messageRef:now.messageRef,branchId:now.branchId,kind:'current'}}));
  if(link===null||link===undefined)return freeze({current:now,carriedFacts:[],effectiveFacts:currentFacts});
  if(!exact(link,['relation','fromRevisionId','toRevisionId','fromBranchId','toBranchId','evidence','facts'])||link.relation!=='continuous'
    ||link.toRevisionId!==now.messageRef.revisionId||link.toBranchId!==now.branchId||!exact(link.evidence,['paragraphId','quote'])||!Array.isArray(link.facts)||link.facts.length>80)fail('跨层承接缺少明确版本、分支或连续性依据');
  const before=replayStoryboardContinuityEnd(previous?.events,previous?.options,link.fromBranchId);
  if(before.messageRef.revisionId!==link.fromRevisionId||before.messageRef.chatKey!==now.messageRef.chatKey||before.messageRef.lastKnownFloor>=now.messageRef.lastKnownFloor
    ||before.narrativeLayer!==now.narrativeLayer)fail('跨层承接来源不属于同一有序叙事分支');
  const evidence=replayStoryboardContinuityAt([],current.options,{branchId:now.branchId,paragraphId:link.evidence.paragraphId,evidence:link.evidence.quote});
  if(evidence.point.index>now.point.index||evidence.point.index===now.point.index&&evidence.point.offset>now.point.offset)fail('承接依据晚于本镜时点');
  const available=new Map(before.activeFacts.map(fact=>[fact.id,fact])),selected=new Set(),slots=new Set(),carriedFacts=[];
  // Even an expired current assignment prevents an older value from resurfacing.
  const overridden=new Set(now.facts.map(slot));
  for(const row of link.facts){
    if(!exact(row,['eventId','subjectId'])||selected.has(row.eventId)||!current.options.subjectIds.includes(row.subjectId))fail('承接人物映射或状态编号无效');
    const original=available.get(row.eventId);if(!original||original.persistence!=='persistent')fail('只可承接来源末尾仍有效的持续状态');
    selected.add(row.eventId);
    const fact={...original,subject:row.subjectId},key=slot(fact);if(slots.has(key))fail('多条旧状态映射到同一人物状态槽');slots.add(key);
    if(!overridden.has(key))carriedFacts.push({fact,source:{messageRef:before.messageRef,branchId:before.branchId,kind:'inherited',subjectId:original.subject}});
  }
  return freeze({current:now,carriedFacts,effectiveFacts:[...carriedFacts,...currentFacts]});
}
