import {mappingFixture,namespace} from './storyboard-mappings.mjs';
import {aliasFixture} from './storyboard-user-aliases.mjs';
import {planUserAliases} from '../../qianmu-user-alias.js';
import {planBundleUserAliases} from '../../qianmu-bundle-user-alias.js';
import {createBundleSubjectMapReview} from '../../qianmu-bundle-subject-map.js';
import {captureStoryboardSubjectEvidence,storyboardSubjectTargets} from '../../qianmu-storyboard-subject-evidence.js';
import {mappingHead,mappingBytes} from '../../qianmu-storyboard-mapping-contract.js';
export {namespace};
export async function mappingReceiptsFixture(){
  const base=await mappingFixture(),library={...aliasFixture(),namespace},chatHash='d'.repeat(64);
  const localInput={namespace,chatHash,bindings:library.bindings,resolveTargets:async targets=>targets.map(subjectKey=>({subjectKey,present:true}))};
  const preview=await planUserAliases(localInput),winner=preview.display.find(row=>row.conflict&&row.archiveId==='bob');
  const local=await planUserAliases({...localInput,choices:{[winner.groupId]:winner.candidateId}});
  const evidence=await captureStoryboardSubjectEvidence(storyboardSubjectTargets(library.bindings).map(row=>({...row,state:'present',profile:{name:'User',description:'same narrative'}})));
  const input={library,evidence,sourceDigest:'e'.repeat(64)},first=await planBundleUserAliases(input),choice=first.display.find(row=>row.conflict&&row.archiveId==='bob');
  const plan=await planBundleUserAliases({...input,choices:{[choice.groupId]:choice.candidateId}});
  const combined=await createBundleSubjectMapReview({namespace,chatHash,sourceDigest:input.sourceDigest,projection:plan.receipt,targetEvidence:plan.evidence,mappings:[]});
  const row=(review,createdAt)=>({key:JSON.stringify([namespace,review.digest,mappingBytes(review)]),namespace,review,bytes:mappingBytes(review),createdAt});
  return [{kind:'environment',receipt:base.environment},{kind:'subjects',receipt:base.subjects},{kind:'subjects',receipt:row(local.review,3)},{kind:'subjects',receipt:row(combined,4)}].map(row=>({...row,head:mappingHead(row.kind,row.receipt)}));
}
