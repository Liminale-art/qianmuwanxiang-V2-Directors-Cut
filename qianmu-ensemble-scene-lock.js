// Request-local continuity constraints for the expression stage. The caller
// supplies the already verified narrative, never raw/unselected chat history.
// This owns no model, storage, route, image-count or generation permission.
const fail=()=>{throw Object.assign(Error('连续场景风格核对失败'),{code:'ensemble_scene_lock',submissionState:'not_submitted'});};
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const text=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const signal=value=>value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu,' ');
function sceneRows(narrative){
  if(!Array.isArray(narrative?.shots)||narrative.shots.length>20)fail();
  return narrative.shots.map((shot,index)=>{
    const branch=shot?.state_point?.branchId,layer=shot?.narrative_layer,key=shot?.composition?.continuity_key;
    const location=shot?.scene?.location,time=shot?.scene?.time;
    if(!text(branch,160)||!text(layer,80)||!text(key,240)||!text(location,1000)||!text(time,240))fail();
    // A reused scene label cannot join distinct branches, explicit time jumps
    // or places. Framing, cast, subject, light and aspect ratio are not locks.
    return {shotId:`S${index+1}`,identity:JSON.stringify([branch,layer,signal(key),signal(location),signal(time)])};
  });
}

export function createEnsembleSceneLock(narrative,{enabled=false,assertCurrent,inherited=[]}={}){
  if(enabled!==true)return null;
  if(typeof assertCurrent!=='function')fail();
  const check=()=>{const value=assertCurrent();if(value&&typeof value.then==='function'){void Promise.resolve(value).catch(()=>{});fail();}if(value===false)fail();};
  check();const rows=sceneRows(narrative),snapshot=JSON.stringify(rows),byScene=new Map();
  for(const row of rows){let group=byScene.get(row.identity);if(!group){group={id:`scene-${byScene.size+1}`,leader_shot_id:row.shotId,shot_ids:[]};byScene.set(row.identity,group);}group.shot_ids.push(row.shotId);}
  if(!Array.isArray(inherited)||inherited.length>rows.length)fail();const seen=new Set();
  for(const item of inherited){const row=rows.find(row=>row.shotId===item?.shotId);if(!row||seen.has(row.shotId)||!text(item.schemeId,160))fail();seen.add(row.shotId);
    const group=byScene.get(row.identity);if(group.scheme_id&&group.scheme_id!==item.schemeId)fail();group.scheme_id=item.schemeId;}
  const constraints=freeze({mode:'continuous_scene',groups:[...byScene.values()]});
  const current=()=>{check();if(JSON.stringify(sceneRows(narrative))!==snapshot)fail();};
  return Object.freeze({constraints,assertCurrent:current,validate(assignments){
    current();
    if(!Array.isArray(assignments)||assignments.length!==rows.length)fail();
    const chosen=new Map();
    for(const row of assignments){if(!rows.some(shot=>shot.shotId===row?.shot_id)||chosen.has(row.shot_id)||!text(row.scheme_id,160))fail();chosen.set(row.shot_id,row.scheme_id);}
    for(const group of constraints.groups){const scheme=group.scheme_id||chosen.get(group.leader_shot_id);if(group.shot_ids.some(id=>chosen.get(id)!==scheme))fail();}
    current();return true;
  }});
}
