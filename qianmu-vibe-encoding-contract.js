import {VIBE_ENCODING_MODELS,retainVibeAssetRef} from './qianmu-vibe-asset-ref.js';
import {novelVibeEncodeEndpoint} from './qianmu-vibe-encoding.js';
import {validateVibeEncodingDelivery,checkReviewSource,checkReviewHistory,validateVibeReviewArchive,createVibeReviewSegment,resolveVibeReviewHistory,checkCombinedVibeReviews,VIBE_REVIEW_SEGMENT_LIMIT} from './qianmu-vibe-history.js';
export {validateVibeEncodingDelivery} from './qianmu-vibe-history.js';

const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const attempt=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,160}$/.test(value);
const fail=(code,message)=>Object.assign(new Error(message),{code:`vibe_encoding_cache_${code}`,submissionState:'not_submitted'});
const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
const key=(namespace,cacheKey)=>{if(!account(namespace)||!hash(cacheKey))throw fail('identity','编码缓存账户或编号无效');return JSON.stringify([namespace,cacheKey]);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const equalReceipt=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const VIBE_ENCODING_RECEIPT_LIMIT=2048;
export const VIBE_ENCODING_ARCHIVE_LIMIT=16384;
const ARCHIVE_BYTES=64*1024*1024;
const receiptBytes=row=>new TextEncoder().encode(JSON.stringify(row)).byteLength;
export function validateVibeServiceDelivery(value){
  if(!object(value)||value.version!==1||!hash(value.channelKey)||!attempt(value.clientAttemptId)
    ||Object.keys(value).some(key=>!['version','channelKey','clientAttemptId'].includes(key)))throw fail('identity','服务编码原提交凭据无效');
  return {version:1,channelKey:value.channelKey,clientAttemptId:value.clientAttemptId};
}
export function matchesVibeServiceDelivery(row,serviceAttemptId,serviceDelivery){
  if(serviceDelivery!==undefined)validateVibeServiceDelivery(serviceDelivery);
  return row?.delivery?.transport==='service'&&row.delivery.serviceAttemptId===serviceAttemptId
    &&row.delivery.channelKey===serviceDelivery?.channelKey&&row.attemptId===serviceDelivery?.clientAttemptId;
}

export async function validateVibeEncodingIdentity(identity,cacheKey){
  if(!object(identity)||Object.keys(identity).some(k=>!['version','endpoint','remoteModelId','capabilityModelId','encodingModel','sourceId','parameters'].includes(k))
    ||identity.version!==1||!hash(identity.sourceId)||typeof identity.remoteModelId!=='string'||!identity.remoteModelId||identity.remoteModelId.trim()!==identity.remoteModelId||identity.remoteModelId.length>240||/[\u0000-\u001f\u007f]/.test(identity.remoteModelId)
    ||!VIBE_ENCODING_MODELS[identity.capabilityModelId]||VIBE_ENCODING_MODELS[identity.capabilityModelId]!==identity.encodingModel
    ||!object(identity.parameters)||Object.keys(identity.parameters).length!==1||typeof identity.parameters.information_extracted!=='number'||!Number.isFinite(identity.parameters.information_extracted)
    ||identity.parameters.information_extracted<0||identity.parameters.information_extracted>1||novelVibeEncodeEndpoint(identity.endpoint)!==identity.endpoint)throw fail('identity','编码缓存参数无效');
  // Canonical field order, no credentials or source bytes. This matches prepareNovelVibeEncoding.
  const value={version:1,endpoint:identity.endpoint,remoteModelId:identity.remoteModelId,capabilityModelId:identity.capabilityModelId,encodingModel:identity.encodingModel,
    sourceId:identity.sourceId,parameters:{information_extracted:identity.parameters.information_extracted}};
  if(!hash(cacheKey)||await digest(JSON.stringify(value))!==cacheKey)throw fail('identity','编码缓存指纹不匹配');return value;
}

function normalizeVibeEncodingReceipt(row,namespace,cacheKey){
  if(!row)return null;
  if(Object.keys(row).some(name=>!['key','namespace','cacheKey','identity','attemptId','status','revision','createdAt','updatedAt','assetRef','sourceAssetRef','delivery','feeReview','pastReviews','reviewArchive'].includes(name))
    ||row.key!==key(namespace,cacheKey)||row.namespace!==namespace||row.cacheKey!==cacheKey||!attempt(row.attemptId)
    ||!['reserved','submitting','ready','rejected','unknown','reviewed'].includes(row.status)||!Number.isSafeInteger(row.revision)||row.revision<1
    ||![row.createdAt,row.updatedAt].every(value=>Number.isFinite(value)&&value>=0)||row.updatedAt<row.createdAt||!object(row.identity))throw fail('corrupt','编码记录不完整，请先保全数据');
  if(row.status==='ready'&&(retainVibeAssetRef(row.assetRef).invalid||row.assetRef.namespace!==namespace))throw fail('corrupt','编码原资产引用失效');
  if(row.status!=='ready'&&row.assetRef)throw fail('corrupt','未完成编码含错误资产引用');
  if(row.sourceAssetRef&&(retainVibeAssetRef(row.sourceAssetRef).invalid||row.sourceAssetRef.namespace!==namespace))throw fail('corrupt','原图资产归属不符');
  if(row.delivery!==undefined)validateVibeEncodingDelivery(row.delivery);
  if(row.status==='reviewed')checkReviewSource(row);else if(row.feeReview!==undefined)throw fail('corrupt','费用核查状态不符');
  if(row.pastReviews!==undefined)checkReviewHistory(row.pastReviews);if(row.reviewArchive!==undefined)validateVibeReviewArchive(row.reviewArchive);return row;
}
// Shared by durable reads and audit files. Validation never restores or authorizes a request.
export async function validateVibeEncodingReceipt(row,namespace,cacheKey){
  if(!object(row))throw fail('corrupt','编码记录不完整，请先保全数据');
  normalizeVibeEncodingReceipt(row,namespace,cacheKey);await validateVibeEncodingIdentity(row.identity,cacheKey);return row;
}

export {hash,account,attempt,fail,digest,key,object,equalReceipt,ARCHIVE_BYTES,receiptBytes,normalizeVibeEncodingReceipt};
