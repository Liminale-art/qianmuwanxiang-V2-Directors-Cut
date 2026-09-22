import {galleryArchiveScope,galleryArchiveObjectReference} from './qianmu-gallery-archive-record.js';
import {chatCharacterReceiptTarget} from './qianmu-chat-character-receipt.js';
import {captureGalleryArchiveJson} from './qianmu-gallery-page-index.js';

export const GALLERY_WRITE_PROPOSAL_KIND='gallery-paged';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// A discriminator deliberately keeps this contract separate from legacy whole
// before/after proposals. Both occupy the SAME account journal, never two active
// intents. These references are not themselves readback or retry authorization.
export function inspectGalleryWriteProposal(raw){
  const value=captureGalleryArchiveJson(raw,16*1024),keys=['kind','namespace','target','scope','preparation','write','evidenceDigest','fileHash'];
  if(!value||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||value.kind!==GALLERY_WRITE_PROPOSAL_KIND
    ||!(/^[a-f0-9]{64}$/).test(value.evidenceDigest)||!(/^[a-f0-9]{64}$/).test(value.fileHash))throw Error('分页恢复写前记录不完整');
  const scope=galleryArchiveScope(value.scope),target=chatCharacterReceiptTarget(value.target);
  if(value.namespace!==scope.namespace||target.chatId!==scope.chatKey
    ||(target.kind==='character'?scope.ownerKey!=='char:'+target.avatar:!scope.ownerKey.startsWith('group:')))throw Error('分页恢复写前记录与准确聊天不符');
  const preparation=galleryArchiveObjectReference(value.preparation,128*1024),write=galleryArchiveObjectReference(value.write,128*1024);
  if(value.fileHash!==write.sha256)throw Error('分页恢复写前记录与方案摘要不符');
  return {kind:GALLERY_WRITE_PROPOSAL_KIND,namespace:scope.namespace,target,scope,preparation,write,evidenceDigest:value.evidenceDigest,fileHash:value.fileHash};
}
export function createGalleryWriteProposal({prepared,resolved}){
  if(!same(prepared.reference,resolved.plan.preparation)||!same(prepared.plan.scope,resolved.plan.scope))throw Error('分页恢复写回来源不符');
  return inspectGalleryWriteProposal({kind:GALLERY_WRITE_PROPOSAL_KIND,namespace:prepared.plan.scope.namespace,target:prepared.plan.target,
    scope:prepared.plan.scope,preparation:prepared.reference,write:resolved.reference,evidenceDigest:prepared.plan.evidenceDigest,fileHash:resolved.reference.sha256});
}
