// Read-only, bounded projection of an already verified selection. Never use a
// log stage to reconstruct a route or authorize submission. Store the displayed
// name now so viewing old logs does not read a renamed/deleted style library.
export function ensembleSelectionStages(receipt,catalogue,shotIds){
  const now=Date.now();
  return Object.freeze(shotIds.map(shotId=>{
    const choice=receipt.assignments.find(row=>row.shotId===shotId);
    const name=catalogue?.find(row=>row.id===choice.schemeId)?.name|| (choice.schemeId==='current'?'当前方案':choice.schemeId);
    const reason=choice.reason||(choice.schemeId==='current'?'沿用当前方案':'');
    return Object.freeze({id:`ensemble-style-${shotId}`,type:'ensemble_style',status:'success',startedAt:now,finishedAt:now,
      input:Object.freeze({shot:shotId}),output:Object.freeze({schemeId:choice.schemeId,name,reason}),
      decisions:Object.freeze([`风格：${name}`,...(reason?[`选择理由：${reason}`]:[])]),error:''});
  }));
}
