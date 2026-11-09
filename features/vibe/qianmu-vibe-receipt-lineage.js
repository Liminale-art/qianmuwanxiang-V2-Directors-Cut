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
    return explicit&&after.section==='current'&&['rejected','reviewed'].includes(a.status)&&(b.status==='reserved'||a.status==='rejected'&&b.status==='ready'&&b.attemptId.startsWith('cached-'))&&b.revision===a.revision+1
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

// Prepared comparisons belong to this one resolution only. Never reuse them
// across requests, receipts, account switches or mutable source re-reads.
function preparation(){
  const cache=new Map();return async item=>{if(!cache.has(item.digest))cache.set(item.digest,await comparison(item.snapshot));return cache.get(item.digest);};
}
async function resolveHeads(heads,predecessors,prepare){
  if(!Array.isArray(heads)||!heads.length)return {kind:'empty',selected:null,conflicts:[]};
  const prepared=[],past=[];
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

// Preserve all branches when no single justified successor covers them.
// Unrelated attempts stay conflicts; no automatic review/retry is performed.
export async function resolveVibeReceiptHeads(heads,{predecessors=new Map()}={}){
  return resolveHeads(heads,predecessors,preparation());
}

// The catalogue has already read and validated every complete original and its
// digest. Check ALL explicit edges and attempt reuse before electing a head.
// Each original's history is prepared once, shared by edge and branch checks.
// Nothing in this invocation survives the return, including prepared bodies.
export async function resolveVibeReceiptLineage(versions,{guard=()=>true}={}){
  const fail=message=>{throw Object.assign(Error(message),{code:'vibe_receipt_catalogue',submissionState:'not_submitted'});};
  if(!Array.isArray(versions)||versions.length>8192||typeof guard!=='function')fail('费用前序清单无效');
  const check=async()=>{if(await guard()===false)fail('费用前序核对已取消');};await check();
  const byId=new Map(),used=new Set(),attempts=new Set(),prepare=preparation();
  for(const version of versions){
    if(!version||typeof version.digest!=='string'||!/^[a-f0-9]{64}$/.test(version.digest)||byId.has(version.digest)
      ||!Array.isArray(version.parents)||new Set(version.parents).size!==version.parents.length||version.parents.some(id=>!byId.has(id)))fail('费用原件前后依据不完整');
    const child=await prepare(version);await check();let newAttempt=false;
    for(const id of version.parents){const parent=await prepare(byId.get(id));
      if(!follows(parent,child,true))fail('费用目录前后状态衔接不符');used.add(id);
      if(parent.value.receipt.attemptId!==child.value.receipt.attemptId)newAttempt=true;
    }
    if(newAttempt&&attempts.has(child.value.receipt.attemptId))fail('新费用尝试复用了历史请求编号');
    attempts.add(child.value.receipt.attemptId);byId.set(version.digest,version);
  }
  const heads=versions.filter(version=>!used.has(version.digest)).map(({digest,snapshot})=>({digest,snapshot}));
  // A single head needs no branch-election ancestry list, but every original,
  // history, edge and prior attempt above has still been checked in full.
  if(heads.length===1)return {kind:'resolved',selected:heads[0],conflicts:[]};
  const predecessors=new Map();
  for(const head of heads){const seen=new Set(),pending=[...byId.get(head.digest).parents],prior=[];
    while(pending.length){const id=pending.pop();if(seen.has(id))continue;seen.add(id);const parent=byId.get(id);prior.push(parent);pending.push(...parent.parents);}
    predecessors.set(head.digest,prior);
  }
  const result=await resolveHeads(heads,predecessors,prepare);await check();return result;
}
