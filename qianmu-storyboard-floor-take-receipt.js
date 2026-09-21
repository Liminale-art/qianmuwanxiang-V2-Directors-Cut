// Compact chat metadata, independent of deletable gallery images. These receipts
// retire only already-known work; they never authorize or modify a generation.
import {storyboardFloorTakeMessageKeys} from './qianmu-storyboard-floor-take-scope.js?v=1.59.240';
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const fail=()=>{throw new Error('楼层换版记录无法核对或已达容量，请保留记录并反馈；未确认正文换版，原图保留');};
const scope=value=>JSON.stringify([value.chatKey,value.messageKey,value.swipeId]);
const order=(a,b)=>a.startedAt-b.startedAt||a.id.localeCompare(b.id);
function receipt(value) {
  if(!object(value)||value.version!==1||Object.hasOwn(value,'messageKeys')||!text(value.id,160)||!text(value.chatKey,512)||!text(value.messageKey,160)
    ||!integer(value.swipeId)||!integer(value.startedAt)||value.startedAt<1
    ||!Array.isArray(value.baselineTaskIds)||value.baselineTaskIds.length>400
    ||value.baselineTaskIds.some(id=>!text(id,160))||new Set(value.baselineTaskIds).size!==value.baselineTaskIds.length)fail();
  return {version:1,id:value.id,chatKey:value.chatKey,messageKey:value.messageKey,swipeId:value.swipeId,
    startedAt:value.startedAt,baselineTaskIds:[...value.baselineTaskIds]};
}
export function normalizeStoryboardFloorTakeReceipts(value) {
  if(!Array.isArray(value)||value.length>400)fail();
  const result=value.map(receipt),seen=new Set();
  for(const row of result){const key=scope(row);if(seen.has(key))fail();seen.add(key);}
  if(new TextEncoder().encode(JSON.stringify(result)).length>262144)fail();
  return result;
}
export function mergeStoryboardFloorTakeReceipts(history,takes=[]) {
  const rows=normalizeStoryboardFloorTakeReceipts(history),byScope=new Map(rows.map(row=>[scope(row),row]));
  for(const take of takes){
    const keys=storyboardFloorTakeMessageKeys(take);if(!keys)fail();
    // Project a verified multi-key take to ordinary per-key receipts. Old chat
    // readers keep understanding retired task ids; no old generation is rewritten.
    for(const messageKey of keys){
      const next=receipt({version:1,id:take.id,chatKey:take.chatKey,messageKey,swipeId:take.swipeId,startedAt:take.startedAt,baselineTaskIds:take.baselineTaskIds||[]});
      const key=scope(next),previous=byScope.get(key);
      if(!previous){byScope.set(key,next);continue;}
      const latest=order(previous,next)>0?previous:next;
      byScope.set(key,{...latest,baselineTaskIds:[...new Set([...previous.baselineTaskIds,...next.baselineTaskIds])]});
    }
  }
  return normalizeStoryboardFloorTakeReceipts([...byScope.values()]);
}
export function storyboardFloorTakeReceiptSupersedes(record,receipts) {
  const ref=record?.messageRef;if(!ref?.messageKey)return false;
  return receipts.some(take=>{
    if(scope(take)!==scope(ref)||record.planId===take.id)return false;
    if(take.baselineTaskIds.includes(record.taskId||record.id))return true;
    const own=record.floorTake;
    return Boolean(storyboardFloorTakeMessageKeys(own)&&scope(own)===scope(take)&&integer(own.startedAt)&&text(own.id,160)&&order(own,take)<0);
  });
}
