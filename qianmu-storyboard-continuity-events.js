import {STORYBOARD_NARRATIVE_LAYERS,STORYBOARD_CONTINUITY_FACT_CATEGORIES,STORYBOARD_CONTINUITY_FACT_PERSISTENCE,normalizeStoryboardContinuityFact,normalizeStoryboardMessageReference} from './qianmu-storyboard.js';

export const STORYBOARD_CONTINUITY_EVENTS_SCHEMA='qianmu.storyboard.continuity-events.v1';
export const STORYBOARD_CONTINUITY_EVENT_LIMITS=Object.freeze({events:80,paragraphs:1000,characters:200000,branches:40,subjects:80});
const fail=(code,message)=>{throw Object.assign(Error(message),{code:'storyboard_continuity_'+code});};
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
function text(v,max){
  if(typeof v!=='string'||!v.trim()||v.length>max||v.includes('\0'))return false;
  for(const char of v)if(char.length===1&&char.charCodeAt(0)>=0xd800&&char.charCodeAt(0)<=0xdfff)return false;return true;
}
const id=v=>text(v,160)&&v===v.trim()&&!/[\u0000-\u001f\u007f]/.test(v);
function unique(values,limit,key){
  if(!Array.isArray(values)||values.length>limit)fail('scope','变化输入超出范围，未截断');
  const map=new Map();for(const value of values){const name=key(value);if(!id(name)||map.has(name))fail('scope','变化来源编号缺失或重复');map.set(name,value);}return map;
}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
const comparePoints=(a,b)=>a.index-b.index||a.offset-b.offset;
// Unlike the legacy human-name ledger, subject IDs are exact roster keys.
const factSlot=fact=>JSON.stringify([fact.category,fact.subject,fact.key.toLowerCase()]);
function locate(paragraph,evidence){
  const start=paragraph.indexOf(evidence);
  if(start<0||paragraph.indexOf(evidence,start+1)!==-1)fail('grounding','变化证据未唯一匹配正文，请提供可定位的原句');
  return start+evidence.length;
}

// The host supplies the verified message revision, paragraph order and local
// branch/subject rosters. They are not model fields or an ownership grant.
// An exact unique quote locates the event; the model need not count UTF-16 offsets.
export function bindStoryboardContinuityEvents(events,{messageRef,chatKey,paragraphs,branches,subjectIds}={}){
  const ref=normalizeStoryboardMessageReference(messageRef);
  if(!exact(messageRef,Object.keys(ref))||Object.keys(ref).some(k=>messageRef[k]!==ref[k])||!ref.chatKey||ref.chatKey!==chatKey||!ref.messageKey||!ref.revisionId||!ref.revisionHash
    ||ref.role==='system'||!Number.isSafeInteger(ref.lastKnownFloor)||ref.lastKnownFloor<0)fail('source','变化来源版本未明确，请重新提取');
  let characters=0;
  const sources=unique(paragraphs,STORYBOARD_CONTINUITY_EVENT_LIMITS.paragraphs,p=>{
    if(!exact(p,['id','text'])||!text(p.text,STORYBOARD_CONTINUITY_EVENT_LIMITS.characters))fail('source','变化正文段落无效');characters+=p.text.length;return p.id;
  });
  if(!sources.size||characters>STORYBOARD_CONTINUITY_EVENT_LIMITS.characters)fail('scope','变化正文超出单次范围，未截断');
  const positions=new Map([...sources.keys()].map((key,index)=>[key,index]));
  const branchMap=unique(branches,STORYBOARD_CONTINUITY_EVENT_LIMITS.branches,b=>{
    if(!exact(b,['id','layer'])||!STORYBOARD_NARRATIVE_LAYERS.includes(b.layer))fail('branch','变化叙事分支无效');return b.id;
  });
  const subjects=unique(subjectIds,STORYBOARD_CONTINUITY_EVENT_LIMITS.subjects,value=>value);
  const eventMap=unique(events,STORYBOARD_CONTINUITY_EVENT_LIMITS.events,event=>{
    if(!exact(event,['id','branchId','paragraphId','subjectId','category','key','value','persistence','evidence'])||!branchMap.has(event.branchId)||!sources.has(event.paragraphId)||!subjects.has(event.subjectId)
      ||!STORYBOARD_CONTINUITY_FACT_CATEGORIES.includes(event.category)||!STORYBOARD_CONTINUITY_FACT_PERSISTENCE.includes(event.persistence)||!text(event.key,120)||event.key!==event.key.trim()
      ||!text(event.value,1000)||event.value!==event.value.trim()||!text(event.evidence,1000)||event.evidence!==event.evidence.trim())fail('event','变化字段或来源引用无效');return event.id;
  });
  const bound=[...eventMap.values()].map(event=>{
    return {id:event.id,branchId:event.branchId,narrativeLayer:branchMap.get(event.branchId).layer,
      point:{paragraphId:event.paragraphId,index:positions.get(event.paragraphId),offset:locate(sources.get(event.paragraphId).text,event.evidence)},
      fact:normalizeStoryboardContinuityFact({id:event.id,subject:event.subjectId,category:event.category,key:event.key,value:event.value,persistence:event.persistence,evidence:event.evidence,
        sourceParagraphIds:[event.paragraphId],sourceFloor:ref.lastKnownFloor,status:'active'})};
  }).sort((a,b)=>comparePoints(a.point,b.point));
  const slots=new Set();bound.forEach((event,index)=>{
    // Two contrary assignments at the same textual instant must be repaired,
    // not arbitrarily resolved by JSON array order or object sorting.
    const slot=JSON.stringify([event.branchId,event.point.index,event.point.offset,factSlot(event.fact)]);
    if(slots.has(slot))fail('conflict','同一时点的状态槽重复，请重新核对变化');slots.add(slot);event.fact.order=index;
  });
  return freeze({schema:STORYBOARD_CONTINUITY_EVENTS_SCHEMA,messageRef:ref,branches:[...branchMap.values()].map(b=>({...b})),events:bound});
}

// Rebind raw events rather than accepting arbitrary pre-bound offsets. This
// computes state after the quoted instant, independent of shot selection or
// image completion. Cross-floor inheritance requires a separate verified link.
export function replayStoryboardContinuityAt(events,options,target){
  const bound=bindStoryboardContinuityEvents(events,options);
  if(!exact(target,['branchId','paragraphId','evidence'])||!text(target.evidence,1000)||target.evidence!==target.evidence.trim())fail('target','镜头状态时点无效');
  const branch=bound.branches.find(value=>value.id===target.branchId),index=options.paragraphs.findIndex(value=>value.id===target.paragraphId);
  if(!branch||index<0)fail('target','镜头状态时点未属于当前叙事来源');
  const point={paragraphId:target.paragraphId,index,offset:locate(options.paragraphs[index].text,target.evidence)};
  return replayBound(bound,branch,point);
}

// A previous floor must contribute its end state, not a selected earlier shot.
export function replayStoryboardContinuityEnd(events,options,branchId){
  const bound=bindStoryboardContinuityEvents(events,options),branch=bound.branches.find(value=>value.id===branchId);
  if(!branch)fail('target','变化分支未属于当前叙事来源');
  const index=options.paragraphs.length-1,paragraph=options.paragraphs[index];
  return replayBound(bound,branch,{paragraphId:paragraph.id,index,offset:paragraph.text.length});
}

function replayBound(bound,branch,point){
  const facts=[],appliedEventIds=[],slots=new Map(),moments=[];
  const expire=at=>{for(const item of moments)if(item.fact.status==='active'&&comparePoints(item.point,at)<0)item.fact.status='expired';};
  for(const event of bound.events){
    if(event.branchId!==branch.id||comparePoints(event.point,point)>0)continue;
    expire(event.point);
    const fact={...event.fact,sourceParagraphIds:[...event.fact.sourceParagraphIds],supersedes:[]},slot=factSlot(fact),previous=slots.get(slot);
    if(previous?.status==='active'){previous.status='superseded';previous.replacedBy=fact.id;fact.supersedes.push(previous.id);}
    facts.push(fact);slots.set(slot,fact);appliedEventIds.push(event.id);
    if(fact.persistence==='momentary')moments.push({point:event.point,fact});
  }
  expire(point);
  return freeze({messageRef:bound.messageRef,branchId:branch.id,narrativeLayer:branch.layer,point,appliedEventIds,facts,activeFacts:facts.filter(fact=>fact.status==='active')});
}
