const fail=()=>{throw Object.assign(new Error('已提交镜头的叙事落点无法核对，未继续自动补图'),{code:'storyboard_stream_coverage'});};
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max)=>typeof v==='string'&&v.trim()&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const content=(v,max)=>typeof v==='string'&&v.trim()&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
export function normalizeStoryboardStreamMoment(value){
  if(!plain(value)||value.version!==1||!text(value.paragraphId,160)||!text(value.branchId,160)||!text(value.layer,80)
    ||!content(value.quote,1000)||!content(value.subject,1000)||!Number.isSafeInteger(value.start)||value.start<0
    ||!Number.isSafeInteger(value.end)||value.end!==value.start+value.quote.length||value.end>200000
    ||!text(value.insertAfter,160)||!Array.isArray(value.sourceIds)||!value.sourceIds.length||value.sourceIds.length>80
    ||value.sourceIds.some(id=>!text(id,160))||new Set(value.sourceIds).size!==value.sourceIds.length||!value.sourceIds.includes(value.paragraphId))return null;
  return {version:1,paragraphId:value.paragraphId,branchId:value.branchId,layer:value.layer,quote:value.quote,
    start:value.start,end:value.end,subject:value.subject,insertAfter:value.insertAfter,sourceIds:[...value.sourceIds]};
}
export function assertStoryboardStreamMoment(value,window){
  const moment=normalizeStoryboardStreamMoment(value);if(!moment)fail();
  const rows=window.current.paragraphs,row=rows.find(row=>row.id===moment.paragraphId);
  if(!row||row.text.indexOf(moment.quote)!==moment.start||row.text.indexOf(moment.quote,moment.start+1)>=0
    ||!moment.sourceIds.every(id=>rows.some(row=>row.id===id))||!rows.some(row=>row.id===moment.insertAfter))fail();
  return moment;
}
export function createStoryboardStreamMoment(shot,window){
  const point=shot.state_point,row=window.current.paragraphs.find(row=>row.id===point?.paragraphId);
  if(!row||typeof point.evidence!=='string')fail();const start=row.text.indexOf(point.evidence);
  return assertStoryboardStreamMoment({version:1,paragraphId:point.paragraphId,branchId:point.branchId,layer:shot.narrative_layer,
    quote:point.evidence,start,end:start+point.evidence.length,subject:shot.subject,insertAfter:shot.insert_after,sourceIds:shot.source_paragraph_ids},window);
}
const subjectKey=value=>value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu,'');
// Sharing a sentence does not mean sharing its visual subject: a reaction and
// a significant object can both be useful. Only deterministic same-picture
// matches are removed here; semantic paraphrases remain the director's duty.
export const storyboardStreamMomentsOverlap=(a,b)=>a.paragraphId===b.paragraphId&&a.start<b.end&&b.start<a.end&&subjectKey(a.subject)===subjectKey(b.subject);
