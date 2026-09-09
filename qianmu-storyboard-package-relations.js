const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=field=>{throw Object.assign(new Error(`分镜关联 ${field} 无法完整保留，未重置选择或裁剪规则，请保留原资料核对`),{code:'storyboard_portable_relations',submissionState:'not_submitted'});};

export const STORYBOARD_RELATION_FIELDS=Object.freeze(['promptCompiler','parameterPresetSelection','generationPolicy','tagLibrary','vibeLibrary','selectedVibeIds','selectedArtistPresetId','selectedArtistPoolId','compositionPolicy','routing']);
export function captureStoryboardRelationData(state){
  return structuredClone(Object.fromEntries(STORYBOARD_RELATION_FIELDS.filter(key=>Object.hasOwn(state,key)).map(key=>[key,state[key]])));
}

// Compare the detached pre-normalization graph, including local selectors affected by a partial import.
// Defaults may be added. Rules are keyed by ID because routing deliberately sorts them by priority.
export function assertStoryboardRelationsRetained(before,after){
  let nodes=0;
  function retained(a,b,field,path=[]){
    if(++nodes>500000||path.length>40)fail(field);
    if(a===b)return true;
    if(Array.isArray(a)){
      if(!Array.isArray(b)||a.length!==b.length)return false;
      if(field==='routing'&&path.length===1&&path[0]==='rules'){
        const original=new Set(a.map(row=>row?.id)),rows=new Map(b.map(row=>[row?.id,row]));
        return original.size===a.length&&rows.size===b.length&&a.every(row=>object(row)&&rows.has(row.id)&&retained(row,rows.get(row.id),field,[...path,row.id]));
      }
      return a.every((row,i)=>retained(row,b[i],field,[...path,i]));
    }
    if(object(a))return object(b)&&Object.keys(a).every(key=>{
      if(field==='promptCompiler'&&path.length===0&&key==='excludedTags'&&Array.isArray(a.tagRules))return true;
      if(field==='routing'&&path.length===0&&key==='mode'&&typeof a.enabled==='boolean')return true;
      // Encoded Vibe originals, not temporary preview URLs, are authoritative for these library rows.
      if(field==='vibeLibrary'&&path.length===1&&key==='previewUrl'&&object(a.assetRef))return true;
      return Object.hasOwn(b,key)&&retained(a[key],b[key],field,[...path,key]);
    });
    return false;
  }
  for(const field of STORYBOARD_RELATION_FIELDS)if(Object.hasOwn(before,field)&&!retained(before[field],after[field],field))fail(field);
}

export function mergeStoryboardParameterSelection(local={},incoming={}){
  if(!object(local)||!object(incoming))fail('parameterPresetSelection');
  return {...structuredClone(local),...structuredClone(incoming)};
}
