import {normalizeNovelServiceChannel} from './qianmu-novel-service-channel-state.js';
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fail=()=>Object.assign(new Error('原生请求核查凭据不完整，请保留原记录'),{code:'image_service_review_state',status:409,submissionState:'not_submitted'});
export function normalizeNativeReceipt(value){
  if(!object(value)||value.version!==1||!['image','vibe'].includes(value.kind)||!hash(value.channelKey)
    ||Object.keys(value).some(key=>!['version','kind','channelKey','clientAttemptId'].includes(key))
    ||value.clientAttemptId!==undefined&&(typeof value.clientAttemptId!=='string'||!/^[A-Za-z0-9_-]{8,160}$/.test(value.clientAttemptId)))throw fail();
  return {...value};
}
export function normalizeNativeReview(value){
  if(!object(value)||value.version!==1||!hash(value.confirmation)||value.previousStatus!=='uncertain'
    ||!Number.isSafeInteger(value.at)||value.at<0||Object.keys(value).some(key=>!['version','confirmation','previousStatus','at','occupancy','completedAt'].includes(key))
    ||value.completedAt!==undefined&&(!Number.isSafeInteger(value.completedAt)||value.completedAt<value.at))throw fail();
  let occupancy=null;
  if(value.occupancy!==null){
    if(!object(value.occupancy)||!hash(value.occupancy.channelKey))throw fail();
    const {channelKey,...row}=value.occupancy;
    const [checked]=normalizeNovelServiceChannel({schema:'qianmu.novel-occupancy.v1',channelKey,entries:[row]},channelKey).entries;
    if(!['uncertain','released'].includes(checked.status))throw fail();occupancy={channelKey,...checked};
  }
  return {...value,occupancy};
}
export function normalizeNativeReviewView(value,kind){
  if(!object(value)||value.version!==1||value.kind!==kind||typeof value.attemptId!=='string'||!value.attemptId||value.attemptId.length>240
    ||!hash(value.requestDigest)||!['reserved','submitting','uncertain','acknowledged','succeeded','failed','rejected','released'].includes(value.status)
    ||!Number.isSafeInteger(value.updatedAt)||value.updatedAt<0||!['resultAvailable','canReview','reviewed'].every(key=>typeof value[key]==='boolean')
    ||typeof value.message!=='string'||value.message.length>240||value.confirmation!==''&&!hash(value.confirmation)
    ||value.canReview&&(value.resultAvailable||value.reviewed)||value.reviewed&&value.canReview)throw fail();
  const fields=['version','kind','attemptId','requestDigest','status','updatedAt','resultAvailable','canReview','reviewed','confirmation','message'];
  return Object.fromEntries(fields.map(key=>[key,value[key]]));
}
