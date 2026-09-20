// Compact representation, not summarization: every character of each selected
// source stays present. Paragraph labels do not require another copy of prose.
export function storyboardFocusedCatalogue(window,floors=null){
  const wanted=floors?new Set(floors):null,messages=new Map(window.messages.map(row=>[row.floor,row]));
  return window.sources.filter(source=>!wanted||wanted.has(source.messageRef.lastKnownFloor)).map(source=>{
    const floor=source.messageRef.lastKnownFloor,message=messages.get(floor);
    if(!message||typeof message.text!=='string')throw Object.assign(Error('完整正文来源缺失，未发送不完整上下文'),{code:'storyboard_context_unavailable'});
    const passages=[];let cursor=0;
    for(const paragraph of source.paragraphs){
      const start=message.text.indexOf(paragraph.text,cursor);
      // HTML/entity preprocessing can intentionally yield a different paragraph
      // string. Preserve both representations then; never pretend they matched.
      if(start<0)return {floor,role:message.role,full_text:message.text,paragraphs:source.paragraphs};
      if(start>cursor)passages.push({text:message.text.slice(cursor,start)});
      passages.push({paragraph_id:paragraph.id,text:paragraph.text});cursor=start+paragraph.text.length;
    }
    if(cursor<message.text.length)passages.push({text:message.text.slice(cursor)});
    return {floor,role:message.role,passages};
  });
}

export function projectStoryboardFocusedInput(payload,window){
  payload.target_paragraph_ids=payload.target_paragraphs.map(row=>row.id);delete payload.target_paragraphs;
  payload.recent_messages=window.messages.map(({floor,role})=>({floor,role}));
  payload.source_catalogue=storyboardFocusedCatalogue(window);
  return payload;
}

// The evidence scope is chosen by validators, not arbitrary model-authored
// fields. Invalid floor IDs never authorize reading outside the borrowed window.
export function storyboardFocusedRepairContext({name,result,data,context,request,definition}){
  if(name==='expression')return {verified_handoff:JSON.parse(definition.messages[1].content)};
  const payload=JSON.parse(request.messages[1].content),floors=new Set(result.repairFloors||[]);
  for(const error of result.errors||[]){
    const path=error.path||'';
    const record=/^\$\.source_states\[(\d+)\]/.exec(path),link=/^\$\.continuity_links\[(\d+)\]/.exec(path);
    if(record){const floor=data?.source_states?.[Number(record[1])]?.floor;if(Number.isSafeInteger(floor))floors.add(floor);}
    else if(link){const row=data?.continuity_links?.[Number(link[1])];for(const floor of [row?.from_floor,row?.to_floor,...(Array.isArray(row?.facts)?row.facts.map(item=>item?.source_floor):[])])if(Number.isSafeInteger(floor))floors.add(floor);}
    else if(path==='$.source_states')request.requiredFloors.forEach(floor=>floors.add(floor));
    else if(path.startsWith('$.shots'))floors.add(context.floor);
  }
  const available=new Set(context.compilerSources.sources.map(source=>source.messageRef.lastKnownFloor));
  const selected=[...floors].filter(floor=>available.has(floor));
  return {target_floor:context.floor,constraints:payload.constraints,required_state_floors:request.requiredFloors,
    ...(payload.committed_images?{committed_images:payload.committed_images}:{}),
    paragraph_catalogue:context.compilerSources.sources.map(source=>({floor:source.messageRef.lastKnownFloor,paragraph_ids:source.paragraphs.map(row=>row.id)})),
    evidence_sources:storyboardFocusedCatalogue(context.compilerSources,selected),
    cached_source_states:payload.cached_source_states.filter(row=>selected.includes(row.floor))};
}
