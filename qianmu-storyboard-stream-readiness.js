// A readiness proof narrows an already captured source. It never discovers new
// context, changes the shot budget, or authorizes an image request on its own.
const object=properties=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const id=()=>({type:'string',minLength:1,maxLength:160});
const anchor=()=>object({floor:{type:'integer',minimum:0},branch_id:id(),paragraph_id:id(),quote:{type:'string',minLength:1,maxLength:1000}});
const fail=()=>{throw Object.assign(Error('流式画面尚缺完整且可定位的来源依据'),{code:'storyboard_stream_readiness'});};

export function configureStoryboardStreamReadiness(window,schema,payload,config){
  if(!window.stream)return false;
  const stable=window.stream.stableParagraphIds;
  if(config.manualSupplement||!Array.isArray(stable)||!stable.length||stable.some((id,index)=>id!==window.current.paragraphs[index]?.id))fail();
  const shot=schema.properties.shots.items;
  shot.properties.stream_support=object({scene:anchor(),content:anchor(),presence:{type:'array',maxItems:12,
    items:object({character_id:id(),source:anchor()})}});
  shot.required.push('stream_support');
  payload.constraints.min_shots_target=0;
  payload.constraints.streaming={closed_target_paragraph_ids:[...stable],
    incomplete_tail:'context_only_not_shot_or_presence_evidence',uncertain:'wait_with_no_shots',
    inherited_presence:'explicit_verified_same_scene_chain_only',count:'part_of_one_floor_budget_not_a_new_budget'};
  return true;
}

export const STORYBOARD_STREAM_READINESS_INSTRUCTION='流式提前取景：完整输入包含未完尾段，但只允许在constraints.streaming.closed_target_paragraph_ids中选镜头和落点。闭合段落不代表已可生成：人物在场/身份、场景、画面主体和关键动作互动必须足够明确，不能借未完尾段猜测。每镜stream_support给出scene、当前content和逐个可见人物presence的唯一原文短句（来源floor/branch_id/paragraph_id/quote）；scene和presence只可来自当前镜头时点之前的已闭合段落，或经continuity_links明确连续且属于同一分支的所选前文，旧名单/档案并非在场证明。content必须来自当前闭合正文。语义仍不确定则should_generate=false、shots=[]及简短等待原因，不是报错、不硬凑最少张数；独立明确的空镜/静物可无人物，但不能为了绕开歧义擅改叙事。不预测后文，不生成待用户确认的候选图，不要求终稿自动付费重画。';

export function assertStoryboardStreamReadiness({shot,window,steps,state}){
  if(!window.stream)return;
  const support=shot.stream_support,stable=new Set(window.stream.stableParagraphIds),floor=window.floor;
  if(!support||!shot.source_paragraph_ids.every(id=>stable.has(id))||!stable.has(shot.insert_after)||!stable.has(shot.state_point.paragraphId))fail();
  const check=ref=>{
    const step=steps.find(row=>row.source.options.messageRef.lastKnownFloor===ref.floor&&row.branchId===ref.branch_id);
    if(!step||typeof ref.quote!=='string'||!ref.quote.trim()||ref.quote!==ref.quote.trim())fail();
    const paragraphs=step.source.options.paragraphs,index=paragraphs.findIndex(row=>row.id===ref.paragraph_id),paragraph=paragraphs[index];
    if(!paragraph)fail();const start=paragraph.text.indexOf(ref.quote);
    if(start<0||paragraph.text.indexOf(ref.quote,start+1)>=0)fail();
    if(ref.floor===floor&&(!stable.has(ref.paragraph_id)||index>state.current.point.index
      ||index===state.current.point.index&&start+ref.quote.length>state.current.point.offset))fail();
    return step;
  };
  check(support.scene);check(support.content);
  if(support.content.floor!==floor||!shot.source_paragraph_ids.includes(support.content.paragraph_id))fail();
  const ids=new Set(shot.characters.map(row=>row.character_id)),seen=new Set();
  if(support.presence.length!==ids.size)fail();
  for(const row of support.presence){
    if(!ids.has(row.character_id)||seen.has(row.character_id))fail();seen.add(row.character_id);
    // Matching an identifier is not enough: check() also demands a validated
    // narrative chain and a unique in-scope quote. Semantic presence remains the
    // director's responsibility, not a claimed confidence score from the model.
    if(!check(row.source).source.options.subjectIds.includes(row.character_id))fail();
  }
}
