const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const attempt=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,160}$/.test(value);
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fail=(message,code='history')=>Object.assign(new Error(message),{code:`vibe_encoding_cache_${code}`,submissionState:'not_submitted'});
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])):value;
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(value))))),b=>b.toString(16).padStart(2,'0')).join('');
export const VIBE_REVIEW_HISTORY_LIMIT=2048;
export const VIBE_REVIEW_SEGMENT_LIMIT=128;
export function validateVibeEncodingDelivery(value){
  if(!object(value)||value.version!==1||!['direct','service'].includes(value.transport)||!hash(value.channelKey)
    ||Object.keys(value).some(key=>!['version','transport','channelKey','serviceAttemptId'].includes(key))
    ||(value.transport==='service'?!hash(value.serviceAttemptId):value.serviceAttemptId!==undefined))throw fail('编码发送来源无效','identity');
  return {version:1,transport:value.transport,channelKey:value.channelKey,...(value.transport==='service'?{serviceAttemptId:value.serviceAttemptId}:{})};
}
export function checkReviewSource(row){
  const value=row.feeReview;
  if(!object(value)||value.version!==1||!hash(value.confirmation)||!['reserved','submitting','unknown'].includes(value.previousStatus)
    ||!Number.isSafeInteger(value.at)||value.at<0||(value.method!==undefined&&value.method!=='local-user')
    ||Object.keys(value).some(key=>!['version','confirmation','previousStatus','at','method'].includes(key)))throw fail('原费用核查记录不完整','corrupt');
  if(row.delivery!==undefined)validateVibeEncodingDelivery(row.delivery);
  if(value.method==='local-user'?row.delivery?.transport==='service':row.delivery?.transport!=='service')throw fail('原费用核查方式与提交来源不符','corrupt');
}
export function checkReviewHistory(rows){
  if(!Array.isArray(rows)||rows.length>32)throw Object.assign(fail('原编码核查历史过多，请先整理明细'),{code:'vibe_encoding_cache_capacity'});
  const seen=new Set();for(const row of rows){
    if(!object(row)||!attempt(row.attemptId)||seen.has(row.attemptId)||Object.keys(row).some(key=>!['attemptId','delivery','feeReview'].includes(key)))throw fail('原费用核查历史不完整','corrupt');
    checkReviewSource(row);seen.add(row.attemptId);
  }return rows;
}
export function validateVibeReviewArchive(value){
  if(!object(value)||value.version!==1||!hash(value.id)||!Number.isSafeInteger(value.count)||value.count<1||value.count>VIBE_REVIEW_HISTORY_LIMIT
    ||Object.keys(value).some(key=>!['version','id','count'].includes(key)))throw fail('核查明细索引不完整，未授权新请求');return value;
}
export async function createVibeReviewSegment(namespace,cacheKey,previous,reviews){
  if(!account(namespace)||!hash(cacheKey))throw fail('核查明细归属无效');
  if(previous!==null)validateVibeReviewArchive(previous);checkReviewHistory(reviews);
  const count=(previous?.count||0)+reviews.length;if(!reviews.length||count>VIBE_REVIEW_HISTORY_LIMIT)throw fail('核查明细档案已满，原记录保留');
  const body=structuredClone({version:1,namespace,cacheKey,previous,reviews,count}),id=await digest(body);
  return {...body,id,key:JSON.stringify([namespace,cacheKey,id])};
}
export async function validateVibeReviewSegment(segment,namespace,cacheKey,ref){
  validateVibeReviewArchive(ref);
  if(!object(segment)||Object.keys(segment).some(key=>!['version','namespace','cacheKey','previous','reviews','count','id','key'].includes(key))
    ||segment.version!==1||segment.namespace!==namespace||segment.cacheKey!==cacheKey||segment.id!==ref.id||segment.count!==ref.count
    ||segment.key!==JSON.stringify([namespace,cacheKey,ref.id]))throw fail('核查明细缺失或归属不符，原费用状态保留');
  const expected=await createVibeReviewSegment(namespace,cacheKey,segment.previous,segment.reviews);
  if(expected.id!==segment.id||expected.count!==segment.count)throw fail('核查明细摘要不符，未授权新请求');return segment;
}
// Resolve a bounded immutable chain; missing, extra, altered or duplicate evidence is never silently dropped.
export async function resolveVibeReviewHistory(namespace,cacheKey,reference,segments){
  if(!Array.isArray(segments)||segments.length>VIBE_REVIEW_SEGMENT_LIMIT)throw fail('核查明细段数无效，请先保全数据');
  if(!reference){if(segments.length)throw fail('核查明细已失去原索引，未授权新请求');return [];}
  validateVibeReviewArchive(reference);const remaining=new Map();
  for(const item of segments){if(!object(item)||!hash(item.id)||remaining.has(item.id))throw fail('核查明细重复或无效');remaining.set(item.id,item);}
  const batches=[];let ref=reference;
  while(ref){const segment=remaining.get(ref.id);await validateVibeReviewSegment(segment,namespace,cacheKey,ref);remaining.delete(ref.id);batches.unshift(segment.reviews);ref=segment.previous;}
  if(remaining.size)throw fail('存在未关联核查明细，未授权新请求');
  const reviews=batches.flat();if(reviews.length!==reference.count||new Set(reviews.map(row=>row.attemptId)).size!==reviews.length)throw fail('核查明细数量或尝试编号重复');return reviews;
}
export function checkCombinedVibeReviews(receipt,archived){
  const seen=new Set(archived.map(row=>row.attemptId));
  for(const row of receipt?.pastReviews||[]){if(seen.has(row.attemptId))throw fail('当前与历史核查明细重复');seen.add(row.attemptId);}
  if(receipt?.feeReview&&seen.has(receipt.attemptId))throw fail('本次核查与历史尝试重复');
}
