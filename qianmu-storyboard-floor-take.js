// A floor retake is an immutable receipt attached to the original jobs/images.
// It neither deletes assets nor authorizes a request. Only a fully saved take
// changes inline visibility; the gallery remains the source of originals.
import {normalizeStoryboardFloorTakeReceipts,mergeStoryboardFloorTakeReceipts,storyboardFloorTakeReceiptSupersedes} from './qianmu-storyboard-floor-take-receipt.js?v=1.59.349';
import {storyboardFloorTakeMessageKeys,storyboardFloorTakeScopesOverlap} from './qianmu-storyboard-floor-take-scope.js?v=1.59.349';
const obj=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max?value:'';
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const clone=value=>structuredClone(value);
const invalid=()=>({invalid:true});
const saving=new WeakMap();
const provisionalReceipts=new WeakMap();
export const storyboardFloorTakeSavePending=receipts=>Boolean(receipts&&(saving.has(receipts)||provisionalReceipts.has(receipts)));
export async function saveStoryboardFloorTakes(records,save,eligible=()=>true,current=()=>true,receipts=undefined) {
  const key=Array.isArray(receipts)?receipts:records,previous=saving.get(key);
  const pending=(previous?previous.catch(()=>{}):Promise.resolve()).then(async()=>{
    if(!current())throw new Error('收片聊天已切换，原结果保留待恢复');
    const history=normalizeStoryboardFloorTakeReceipts(receipts===undefined?[]:receipts),update=settleStoryboardFloorTakes(records,eligible,history);
    let installed;
    try{
      const next=mergeStoryboardFloorTakeReceipts(history,update.committed);
      if(receipts){provisionalReceipts.set(receipts,history);receipts.splice(0,receipts.length,...next);installed=JSON.stringify(receipts);}
      await save();
    }catch(error){
      update.rollback();
      if(receipts&&installed===JSON.stringify(receipts))receipts.splice(0,receipts.length,...history);
      throw error;
    }finally{if(receipts)provisionalReceipts.delete(receipts);}
  });
  saving.set(key,pending);
  try{await pending;}finally{if(saving.get(key)===pending)saving.delete(key);}
}
export function createStoryboardCaptureReservation(state) {
  const controls=()=>({target:state.target,floor:state.floor,inlineByDefault:state.inlineByDefault,paragraphMode:state.paragraphMode,
    manualParagraphIndex:state.manualParagraphIndex,pendingParagraphSelection:clone(state.pendingParagraphSelection),promptMode:state.promptMode,compilerEnabled:state.promptCompiler.enabled});
  const draft=()=>JSON.stringify([state.prompt,state.negative,state.promptDraft,state.pendingCompilerStages]);
  const before=controls(),original=draft();let prepared;
  return {seal(){prepared=JSON.stringify(controls());},restore(){
    if(prepared!==JSON.stringify(controls())||original!==draft())return false;
    const {compilerEnabled,...rest}=before;Object.assign(state,rest);state.promptCompiler.enabled=compilerEnabled;return true;
  }};
}
export function normalizeStoryboardFloorTake(value) {
  if(value==null)return null;
  if(!obj(value)||!storyboardFloorTakeMessageKeys(value)||!text(value.id,160)||!text(value.chatKey,512)||!text(value.messageKey,160)||!text(value.revisionId,80)
    ||!integer(value.swipeId,0,Number.MAX_SAFE_INTEGER)||!integer(value.floor,0,Number.MAX_SAFE_INTEGER)
    ||!integer(value.startedAt,1,Number.MAX_SAFE_INTEGER)||!Array.isArray(value.baselineIds)||value.baselineIds.length>400
    ||value.baselineIds.some(id=>!text(id,160))||new Set(value.baselineIds).size!==value.baselineIds.length
    ||!Array.isArray(value.slots)||value.slots.length>40
    ||Object.hasOwn(value,'baselineTaskIds')&&(!Array.isArray(value.baselineTaskIds)||value.baselineTaskIds.length>400
      ||value.baselineTaskIds.some(id=>!text(id,160)||/[\u0000-\u001f\u007f]/.test(id))||new Set(value.baselineTaskIds).size!==value.baselineTaskIds.length))return invalid();
  const slots=[],seen=new Set();
  for(const slot of value.slots) {
    if(!obj(slot)||!text(slot.shotId,160)||!integer(slot.requestIndex,1,8)||!integer(slot.imageCount,1,8))return invalid();
    const key=JSON.stringify([slot.shotId,slot.requestIndex]);if(seen.has(key))return invalid();seen.add(key);
    slots.push({shotId:slot.shotId,requestIndex:slot.requestIndex,imageCount:slot.imageCount});
  }
  return {version:value.version,id:value.id,chatKey:value.chatKey,messageKey:value.messageKey,revisionId:value.revisionId,swipeId:value.swipeId,floor:value.floor,
    startedAt:value.startedAt,baselineIds:[...value.baselineIds],slots,
    ...(value.version===2?{messageKeys:storyboardFloorTakeMessageKeys(value)}:{}),
    ...(Object.hasOwn(value,'baselineTaskIds')?{baselineTaskIds:[...value.baselineTaskIds]}:{})};
}
const scope=take=>JSON.stringify([take.chatKey,take.messageKey,take.swipeId]);
const order=(left,right)=>left.startedAt-right.startedAt||left.id.localeCompare(right.id);
const sameTakeSource=(record,take)=>scope(record?.messageRef||{})===scope(take)&&record.messageRef.revisionId===take.revisionId;
function sameFloor(record,take) {
  const ref=record?.messageRef;
  if(ref?.messageKey)return ref.chatKey===take.chatKey&&Boolean(storyboardFloorTakeMessageKeys(take)?.includes(ref.messageKey))&&ref.swipeId===take.swipeId;
  return (!record?.chatKey||record.chatKey===take.chatKey)&&record?.floor===take.floor&&Number(record.swipeId||0)===take.swipeId;
}
export function createStoryboardFloorTake(plan,records,visible,pending=[],receipts=[],messageKeys=null) {
  const ref=plan.messageRef;
  const take={version:1,id:plan.id,chatKey:plan.chatKey,messageKey:ref?.messageKey,revisionId:ref?.revisionId,
    swipeId:ref?.swipeId,floor:plan.floor,startedAt:Date.now(),baselineIds:[],slots:[]};
  if(messageKeys!==null){
    if(!Array.isArray(messageKeys)||messageKeys[0]!==ref?.messageKey)throw new Error('原楼层关联标识无效，未开始重拍');
    if(messageKeys.length>1)Object.assign(take,{version:2,messageKeys:[...messageKeys]});
  }
  if(!storyboardFloorTakeMessageKeys(take))throw new Error('原楼层关联标识无效，未开始重拍');
  const baseline=records.filter(record=>sameFloor(record,take)&&visible(record));
  take.baselineIds=baseline.map(record=>record.id);
  if(!Array.isArray(pending)||pending.length>1000)throw new Error('在途分镜记录无法核对，未开始重拍');
  // Freeze only work already known at this explicit retake. A later user
  // supplement/redraw owns a new task id and must not be hidden by a time cutoff.
  const taskIds=new Set(baseline.map(record=>record.taskId).filter(Boolean));
  for(const task of pending){
    if(!task?.messageRef?.messageKey||!sameFloor(task,take)||task.planId===plan.id)continue;
    const inline=task.uiVisible===true&&(task.status!=='completed'||['pending_chat','volatile_pending'].includes(task.deliveryState))
      ||task.inlineByDefault===true&&task.target!=='gallery';
    if(inline&&task.id)taskIds.add(task.id);
  }
  take.baselineTaskIds=[...taskIds];
  for(const record of records){const older=normalizeStoryboardFloorTake(record.floorTake);if(older&&!older.invalid&&storyboardFloorTakeScopesOverlap(older,take))take.startedAt=Math.max(take.startedAt,older.startedAt+1);}
  for(const older of normalizeStoryboardFloorTakeReceipts(receipts))if(storyboardFloorTakeScopesOverlap(older,take))take.startedAt=Math.max(take.startedAt,older.startedAt+1);
  mergeStoryboardFloorTakeReceipts(receipts,[take]); // Capacity/shape preflight before extraction or paid generation.
  const normalized=normalizeStoryboardFloorTake(take);if(normalized?.invalid)throw new Error('原楼层画面版本无法核对，未开始重拍');return normalized;
}
export function bindStoryboardFloorTakeJobs(plan,jobs) {
  if(!plan?.floorTake)return;
  const take=normalizeStoryboardFloorTake(plan.floorTake);
  if(!take||take.invalid||take.id!==plan.id||take.revisionId!==plan.revisionId)throw new Error('整层重拍版本已失效，未提交');
  const slots=[];
  for(const shot of plan.shots||[]) {
    const requests=jobs.filter(job=>job.planShotId===shot.id);
    if(!requests.length)slots.push({shotId:shot.id,requestIndex:1,imageCount:1}); // A failed preparation is not a completed take.
    for(const job of requests)slots.push({shotId:shot.id,requestIndex:job.inlineOrder?.requestIndex,imageCount:Number(job.profile?.count||1)});
  }
  const next=normalizeStoryboardFloorTake({...take,slots});
  if(!next||next.invalid||!next.slots.length||jobs.some(job=>job.planId!==plan.id||job.chatKey!==take.chatKey||!sameTakeSource(job,take)))throw new Error('整层重拍的镜头清单不完整，未提交');
  plan.floorTake=next;
  for(const job of jobs)job.floorTake=clone(next);
}
export function applyStoryboardFloorTakeToJob(plan,job) {
  if(!plan?.floorTake)return;
  const take=normalizeStoryboardFloorTake(plan.floorTake);
  if(!take||take.invalid||take.id!==job.planId||take.chatKey!==job.chatKey||!sameTakeSource(job,take)
    ||!take.slots.some(slot=>slot.shotId===job.planShotId&&slot.requestIndex===job.inlineOrder?.requestIndex&&slot.imageCount===Number(job.profile?.count||1)))throw new Error('原整层重拍清单已变化，未重试');
  job.floorTake=clone(take);
}
function supersededBy(record,take) {
  if(!sameFloor(record,take)||record.planId===take.id)return false;
  const older=normalizeStoryboardFloorTake(record.floorTake);
  return take.baselineIds.includes(record.id)||(take.baselineTaskIds||[]).includes(record.taskId||record.id)
    ||Boolean(older&&!older.invalid&&storyboardFloorTakeScopesOverlap(older,take)&&order(older,take)<0);
}
function floorTakeGroups(records) {
  const groups=new Map();
  for(const record of records){
    const take=normalizeStoryboardFloorTake(record?.floorTake);if(!take||take.invalid||!take.slots.length)continue;
    if(record.planId!==take.id||!sameTakeSource(record,take))continue;
    const key=JSON.stringify([scope(take),take.id]),signature=JSON.stringify(take);
    if(!groups.has(key))groups.set(key,{take,signature,rows:[],invalid:false});
    const group=groups.get(key);if(group.signature!==signature)group.invalid=true;
    group.rows.push(record);
  }
  return [...groups.values()].filter(group=>!group.invalid).sort((a,b)=>order(a.take,b.take));
}
export function storyboardFloorTakeInitialInline(job,records=[],receipts=[]) {
  // Apply an already saved replacement before inserting a late result. Even
  // if this new receipt's save fails, rollback must not revive a superseded image.
  try{if(storyboardFloorTakeReceiptSupersedes(job,normalizeStoryboardFloorTakeReceipts(provisionalReceipts.get(receipts)||receipts)))return false;}catch{return false;}
  if(!provisionalReceipts.has(receipts)&&floorTakeGroups(records).some(group=>group.rows.some(row=>row.floorTakeCommittedAt>0)&&supersededBy(job,group.take)))return false;
  if(job.floorTake==null)return true;
  const take=normalizeStoryboardFloorTake(job.floorTake);
  return Boolean(take&&!take.invalid&&take.slots.length&&(job.floorTakeCommittedAt>0||!take.baselineIds.length&&!take.baselineTaskIds?.length));
}
// Compatibility export for a still-loaded older entry. Counting to 400 is not
// permission to discard history or its recipes. New delivery paths do not call
// this function. Paged metadata adoption must retain an exact readable source;
// until then keep originals and accept new results, without a generation gate.
export function pruneStoryboardRetakeGallery() { return []; }
export function settleStoryboardFloorTakes(records,eligible=()=>true,receipts=[]) {
  receipts=normalizeStoryboardFloorTakeReceipts(receipts);
  const changes=[],committed=[];
  const change=(record,key,value)=>{if(record[key]===value)return;changes.push({record,key,had:Object.hasOwn(record,key),before:record[key],value});record[key]=value;};
  for(const record of records)if(storyboardFloorTakeReceiptSupersedes(record,receipts))change(record,'inline',false);
  const ordered=floorTakeGroups(records);
  for(const group of ordered) {
    const {take,rows}=group;
    if(storyboardFloorTakeReceiptSupersedes(rows[0],receipts))continue;
    // A later completed retake wins even if an older failed request is retried late.
    if(ordered.some(other=>storyboardFloorTakeScopesOverlap(other.take,take)&&order(other.take,take)>0&&other.rows.some(row=>row.floorTakeCommittedAt>0)))continue;
    if(!rows.some(row=>row.floorTakeCommittedAt>0)&&!rows.every(eligible))continue;
    const complete=take.slots.every(slot=>{
      const images=new Set(rows.filter(row=>row.floorTakeEligible===true&&row.url&&row.planShotId===slot.shotId
        &&row.inlineOrder?.requestIndex===slot.requestIndex&&integer(row.imageIndex,0,slot.imageCount-1)).map(row=>row.imageIndex));
      return images.size===slot.imageCount;
    });
    if(!complete&&!rows.some(row=>row.floorTakeCommittedAt>0))continue;
    committed.push(take);
    const committedAt=rows.find(row=>row.floorTakeCommittedAt>0)?.floorTakeCommittedAt||Date.now();
    for(const record of records) {
      if(supersededBy(record,take))change(record,'inline',false);
    }
    for(const record of rows)if(!record.floorTakeCommittedAt&&record.floorTakeEligible===true) {
      change(record,'inline',record.requestedInline===true);change(record,'floorTakeCommittedAt',committedAt);
    }
  }
  return {changed:changes.length>0,committed,rollback(){for(const item of [...changes].reverse())if(item.record[item.key]===item.value){if(item.had)item.record[item.key]=item.before;else delete item.record[item.key];}}};
}
