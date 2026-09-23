import {resolveVibeReviewHistory} from './qianmu-vibe-history.js';
import {vibeReceiptEvidenceText} from './qianmu-vibe-receipt-original.js';

const immutable=row=>({key:row.key,namespace:row.namespace,cacheKey:row.cacheKey,identity:row.identity,attemptId:row.attemptId,
  revision:row.revision,createdAt:row.createdAt,sourceAssetRef:row.sourceAssetRef,delivery:row.delivery});
async function history(value){const row=value.receipt;return [...await resolveVibeReviewHistory(value.namespace,row.cacheKey,row.reviewArchive,value.segments),...(row.pastReviews||[])];}
const reviewed=row=>({attemptId:row.attemptId,delivery:row.delivery,feeReview:row.feeReview});
const reachable={reserved:['submitting','unknown','rejected','reviewed','ready'],submitting:['unknown','rejected','reviewed','ready'],unknown:['reviewed','ready'],reviewed:['ready'],rejected:[],ready:[]};

// Only compare validated complete originals. Time alone and cache-key equality
// are never enough. Different attempts require an explicit predecessor commit.
async function comparison(value){const row=value.receipt,h=await history(value),omit=Object.fromEntries(Object.entries(row).filter(([key])=>!['updatedAt','pastReviews','reviewArchive'].includes(key)));
  return {value,whole:vibeReceiptEvidenceText(value),identity:vibeReceiptEvidenceText(row.identity),immutable:vibeReceiptEvidenceText(immutable(row)),
    history:vibeReceiptEvidenceText(h),reviewedHistory:vibeReceiptEvidenceText([...h,...(row.feeReview?[reviewed(row)]:[])]),semantic:vibeReceiptEvidenceText(omit),attempts:new Set(h.map(item=>item.attemptId))};}
function follows(left,right,explicit){
  const before=left.value,after=right.value;
  const a=before.receipt,b=after.receipt;
  if(before.namespace!==after.namespace||a.cacheKey!==b.cacheKey||left.identity!==right.identity||!Object.is(b.createdAt,a.createdAt)||b.updatedAt<a.updatedAt)return false;
  if(before.section==='archived')return left.whole===right.whole;
  if(after.section==='archived'&&b.status!=='ready')return false;
  if(a.attemptId!==b.attemptId){
    return explicit&&after.section==='current'&&['rejected','reviewed'].includes(a.status)&&b.status==='reserved'&&b.revision===a.revision+1
      &&right.history===left.reviewedHistory&&!right.attempts.has(b.attemptId);
  }
  if(left.immutable!==right.immutable)return false;
  if(a.status===b.status){
    // Exact semantic equivalence also permits explicit review-chain compaction.
    return left.semantic===right.semantic&&left.history===right.history;
  }
  if(!reachable[a.status]?.includes(b.status))return false;
  if(a.feeReview)return b.status==='ready'&&right.history===left.reviewedHistory&&b.feeReview===undefined;
  if(left.history!==right.history)return false;
  if(b.status==='reviewed'){
    const previous=b.feeReview?.previousStatus;
    if(b.feeReview.at<a.updatedAt||b.feeReview.at>b.updatedAt)return false;
    return previous===a.status||reachable[a.status]?.includes(previous)===true;
  }
  return true;
}
export async function vibeReceiptFollows(before,after,{explicit=false}={}){return follows(await comparison(before),await comparison(after),explicit);}

// Preserve all branches when no single justified successor covers them. Unrelated attempts stay conflicts even
// if one is newer or already ready. No automatic review/retry is performed.
export async function resolveVibeReceiptHeads(heads,{predecessors=new Map()}={}){
  if(!Array.isArray(heads)||!heads.length)return {kind:'empty',selected:null,conflicts:[]};
  const prepared=[],past=[],cache=new Map();
  const prepare=async item=>{if(!cache.has(item.digest))cache.set(item.digest,await comparison(item.snapshot));return cache.get(item.digest);};
  for(const head of heads){prepared.push(await prepare(head));const prior=[];for(const item of predecessors.get(head.digest)||[])prior.push(await prepare(item));past.push(prior);}
  // The catalogue validates every explicit predecessor edge before supplying
  // this map. A stale source can be covered by an earlier reviewed attempt on
  // the selected branch without confusing it with an unrelated fresh attempt.
  const coveredBy=(i,j)=>follows(prepared[i],prepared[j],false)||past[j].some(value=>follows(prepared[i],value,false));
  // Linear candidate election plus a complete coverage check. Do not run the
  // full review-chain validator quadratically across source branches.
  let candidate=0;for(let i=1;i<heads.length;i++)if(coveredBy(candidate,i)&&(!coveredBy(i,candidate)||heads[i].digest<heads[candidate].digest))candidate=i;
  const covered=prepared.every((_,i)=>coveredBy(i,candidate));
  return covered?{kind:'resolved',selected:heads[candidate],conflicts:[]}:{kind:'conflict',selected:null,conflicts:heads};
}
