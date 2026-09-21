import {validateDirectorDecision} from './qianmu-director-decision.js?v=1.59.256';
import {worldSourceKey} from './qianmu-world-source.js';

const fail=()=>{throw Object.assign(Error('造物之眼来源或自动授权无效，未提交生图'),{code:'image_attempt_world_identity'});};
const hash=async value=>{
  if(!globalThis.crypto?.subtle?.digest)fail();
  const bytes=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,'0')).join('');
};

// World items own a separate scope. They must never borrow a prose floor or
// become generic manual-gallery work merely because a saved reference is bad.
export async function createWorldImageIdentity(job,namespace){
  const checked=validateDirectorDecision(job.shotSpec?.directorDecision),decision=checked.decision;
  const approval=decision.approval.worldAutomation,production=job.shotSpec?.productionContext?structuredClone(job.shotSpec.productionContext):null;
  const variant=Number(job.requestIndex??1);
  if(!checked.ok||decision.status!=='approved'||decision.approval.mode!=='world_setting'||approval.namespace!==namespace
    ||decision.owner.chatKey!==job.chatKey||job.target!=='gallery'||job.floor!=null||job.messageRef!=null||job.inlineByDefault===true
    ||job.paragraphSelection!=null||job.paragraphAnchor!=null||job.floorTake!=null
    ||!Number.isSafeInteger(variant)||variant<1||variant>8||job.automatic&&variant!==1
    ||!production||production.autoInsert!==false||production.decisionStatus!=='approved'||production.truthMode!=='speculative'
    ||production.decisionId!==decision.decisionId||production.packetId!==decision.source.packetId
    ||worldSourceKey(production.worldSource)!==worldSourceKey(approval.source))fail();
  const source=approval.source;
  const scope={namespace,chatKey:job.chatKey,messageKey:`world-item:${source.field}:${source.itemId}`,revisionId:source.revisionId};
  const reference=[decision,production,job.target,job.floor??null,job.messageRef??null,job.inlineByDefault===true,
    job.paragraphSelection??null,job.paragraphAnchor??null,job.floorTake??null,variant,job.automatic===true];
  const logicalShotId=await hash([worldSourceKey(source),variant]);
  const worldReference=await hash(reference);
  Object.freeze(approval.source);Object.freeze(approval);
  return {scope,logicalShotId,operationKey:logicalShotId,worldApproval:approval,worldReference};
}
