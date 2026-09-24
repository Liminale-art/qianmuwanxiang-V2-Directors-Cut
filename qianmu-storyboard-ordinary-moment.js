import {STORYBOARD_MAX_SHOTS} from './qianmu-storyboard-limits.js';
import {assertStoryboardStreamMoment,createStoryboardStreamMoment} from './qianmu-storyboard-stream-moment.js?v=1.59.224';
const fail=()=>{throw Object.assign(new Error('旧镜头的叙事位置无法完整核对，未重复自动生成'),{code:'storyboard_stream_coverage'});};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function assertStoryboardOrdinaryMomentSpec(moment,spec){
  if(!spec||spec.subject!==moment.subject||spec.narrativeLayer!==moment.layer||spec.insertAfter!==moment.insertAfter
    ||!same(spec.sourceParagraphIds,moment.sourceIds))fail();
  return moment;
}

// Prefer the compact typed position. Older ordinary jobs may retain the original
// focused compiler result instead. Match its unique saved shot ID and fields;
// never infer a position from a prompt, title, array order or similar prose.
export function readStoryboardOrdinaryMoment(job,window,pipelineStages=[]){
  const spec=job?.shotSpec;
  if(spec&&Object.hasOwn(spec,'narrativeMoment'))return assertStoryboardOrdinaryMomentSpec(assertStoryboardStreamMoment(spec.narrativeMoment,window),spec);
  const own=job?.compilerStages||[];
  if(!Array.isArray(own)||own.length>100||!Array.isArray(pipelineStages)||pipelineStages.length>100)fail();
  const stages=[...own,...pipelineStages];
  let result=null;
  for(const stage of stages){
    if(stage?.type!=='prompt_compiler'||stage.status!=='success')continue;
    const output=stage.output,shots=output?.shots,narrative=output?.trace?.narrative?.shots;
    if(!shots||!narrative)continue;
    if(!Array.isArray(shots)||!Array.isArray(narrative)||shots.length!==narrative.length||shots.length>STORYBOARD_MAX_SHOTS)fail();
    const id=job.planShotId||spec?.id;if(!id)continue;
    const matches=shots.map((shot,index)=>({shot,index})).filter(({shot})=>shot.id===id);
    if(matches.length>1)fail();if(!matches.length)continue;
    const {shot,index}=matches[0],raw=narrative[index];
    // Old generic snapshots had a shallower depth budget than pipeline logs.
    // Missing nested fields are not evidence; a separately matched pipeline may
    // still retain them. Present but invalid evidence is never ignored.
    if(!raw||!Object.hasOwn(raw,'state_point')||!Object.hasOwn(raw,'source_paragraph_ids'))continue;
    const moment=assertStoryboardOrdinaryMomentSpec(createStoryboardStreamMoment(raw,window),spec);
    assertStoryboardOrdinaryMomentSpec(moment,shot.shotSpec);
    if(result&&!same(result,moment))fail();result=moment;
  }
  return result;
}
