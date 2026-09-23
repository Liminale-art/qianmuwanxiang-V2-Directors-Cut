import {uniqueClean} from './qianmu-storyboard-utils.js';

export const GALLERY_MEMBERSHIP_LIMIT=30;
export function galleryMembershipIds(record){
  return uniqueClean([...(Array.isArray(record?.collectionIds)?record.collectionIds:[]),record?.collectionId]).map(id=>String(id||'').trim()).filter(Boolean);
}
// Inheritance is not a new user selection. Keep complete historical membership,
// including the legacy primary ID, without lifting the 30-item add guard.
export function galleryMembershipSnapshot(record){
  const collectionIds=galleryMembershipIds(record),primary=String(record?.collectionId||'').trim();
  if(collectionIds.length>10000||collectionIds.some(id=>id.length>240||/[\u0000-\u001f\u007f]/.test(id)))throw Error('图片合集归属超过完整保留范围，未截断或继续生成');
  return {collectionIds,collectionId:primary||collectionIds[0]||''};
}
export function galleryMembershipChange(record,id,checked){
  const before=galleryMembershipIds(record),after=checked?uniqueClean([...before,id]):before.filter(value=>value!==id);
  assertGalleryMembershipChange(record,after);return after;
}
export function assertGalleryMembershipChange(record,ids){
  const previous=new Set(galleryMembershipIds(record));
  if(ids.length>GALLERY_MEMBERSHIP_LIMIT&&ids.some(id=>!previous.has(id)))throw Error(`每张图片最多归入 ${GALLERY_MEMBERSHIP_LIMIT} 个合集，请先取消部分归属；本次未修改`);
}
export function assignGalleryMemberships(record,ids){
  const values=uniqueClean(ids).map(id=>String(id||'').trim()).filter(Boolean);assertGalleryMembershipChange(record,values);
  record.collectionIds=values;record.collectionId=values[0]||'';return values;
}
// Validate the whole batch before touching any record. Old over-limit membership
// is retained on no-op/removal; it is never truncated to the displayed controls.
export function applyGalleryCollectionTarget(records,selected,target){
  const changes=records.filter(record=>selected.has(record.id)).map(record=>({record,ids:target?galleryMembershipChange(record,target,true):[]}));
  for(const {record,ids} of changes)assignGalleryMemberships(record,ids);
  return changes.length;
}
export function galleryCollectionChoices(collections,selected=[]){
  const items=collections.map(item=>({id:item.id,label:item.name})),known=new Set(items.map(item=>item.id));
  for(const id of selected)if(!known.has(id)){known.add(id);items.push({id,label:`未在当前列表中 · ${id}`});}
  return items;
}
