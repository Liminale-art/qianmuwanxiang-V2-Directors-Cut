import {storyboardMessageIdentityInputs} from './qianmu-storyboard.js?v=1.59.337';

// One current-session projection, never history. Oversized/unsupported shapes
// bypass reuse; they are still passed intact to the ordinary builder.
export const GALLERY_NARRATIVE_REUSE_LIMITS = Object.freeze({messages:20000,records:50000});
const scalar = value => {
  if (value !== null && (typeof value==='object'||typeof value==='function')) throw Error('non-scalar locator');
  return value;
};
const fields = (value, names) => names.map(name=>scalar(value?.[name]));
export function captureGalleryNarrativeInputs(input) {
  try {
    const messages=input.messages===undefined?[]:input.messages,records=input.records===undefined?[]:input.records;
    if (!Array.isArray(messages)||!Array.isArray(records)||messages.length>GALLERY_NARRATIVE_REUSE_LIMITS.messages
      ||records.length>GALLERY_NARRATIVE_REUSE_LIMITS.records) return null;
    return {chatKey:scalar(input.chatKey),paragraphs:input.paragraphs,
      messages:Array.from(messages,message=>{
        if (!message||message.is_user||message.is_system||typeof message.mes!=='string'||!message.mes.trim()) return null;
        return [...Object.values(storyboardMessageIdentityInputs(message)),String(message.name??'').slice(0,120)];
      }),
      records:Array.from(records,record=>{
        if (!record?.id) return null;
        return [scalar(record.id),scalar(record.chatKey),Boolean(record.restoreLinkReview),Boolean(record.messageRef),
          ...fields(record,['messageHash','swipeId']),
          ...fields(record.messageRef,['chatKey','messageKey','revisionId','revisionHash','swipeId']),
          ...fields(record.paragraphAnchor,['chatKey','paragraphIndex','paragraphHash','paragraphText','messageHash','swipeId'])];
      })};
  } catch { return null; }
}
const sameRows = (left,right) => left.length===right.length && left.every((row,index)=>row===null
  ? right[index]===null : right[index]!==null&&row.length===right[index].length&&row.every((value,at)=>Object.is(value,right[index][at])));
export function sameGalleryNarrativeInputs(left,right) {
  return Boolean(left&&right&&Object.is(left.chatKey,right.chatKey)&&left.paragraphs===right.paragraphs
    &&sameRows(left.messages,right.messages)&&sameRows(left.records,right.records));
}
