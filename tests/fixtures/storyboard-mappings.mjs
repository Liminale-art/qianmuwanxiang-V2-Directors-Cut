import {createStoryboardEnvironmentReview} from '../../qianmu-storyboard-environment-map.js';
import {createStoryboardSubjectMapReview,inspectStoryboardSubjectMapReview} from '../../qianmu-storyboard-subject-map.js';
import {captureStoryboardSubjectEvidence} from '../../qianmu-storyboard-subject-evidence.js';
import {comfyLibraryBackupDigest as digest} from '../../qianmu-comfy-library-backup.js';
import {vibeDigest} from '../../qianmu-vibe-file.js';
export const namespace='st-user:mapping-registry';
export async function mappingFixture({bindings=25,namespace:targetNamespace=namespace}={}){
  const namespace=targetNamespace;
  const chatHash='b'.repeat(64),sourceDigest='a'.repeat(64);
  const source={ok:true,version:1,expectedAccount:'st-user:'+await vibeDigest(namespace.slice(8)),state:'ready',instanceId:'11111111-1111-4111-8111-111111111111',accountId:'22222222-2222-4222-8222-222222222222',proof:'installation-labels',automaticRebinding:false};
  const environment=await createStoryboardEnvironmentReview({namespace,chatHash,sourceDigest,source,target:{...source,instanceId:'33333333-3333-4333-8333-333333333333'}});
  const mappings=[{category:'char',sourceKey:'char:alice.png',targetKey:'char:renamed.png'}];
  const sourceEvidence=await captureStoryboardSubjectEvidence([{category:'char',subjectKey:mappings[0].sourceKey,state:'present',profile:{name:'Alice',description:'Private narrative not in receipts'}}]);
  const targetEvidence=await captureStoryboardSubjectEvidence([{category:'char',subjectKey:mappings[0].targetKey,state:'present',profile:{name:'Alice',description:'Changed narrative not in receipts'}}]);
  const lineage=[];
  for(let i=0;i<bindings;i++){
    const source={category:'char',subjectKey:mappings[0].sourceKey,scope:i?'chat':'default',chatKey:i?`<chat>-${i}-${'x'.repeat(200)}`:'',archiveId:i===1?'':'alice',revision:`source-${i}`,updatedAt:1};
    const targetKey=mappings[0].targetKey;lineage.push({source,target:{...source,subjectKey:targetKey,revision:'mapped-'+await digest({sourceDigest,source,targetKey})}});
  }
  const review=await inspectStoryboardSubjectMapReview(await createStoryboardSubjectMapReview({namespace,chatHash,sourceDigest,environmentDigest:environment.digest,sourceEvidence,targetEvidence,lineage,mappings}));
  const bytes=new TextEncoder().encode(JSON.stringify(review)).length;
  return {environment:{key:environment.digest,namespace,review:environment,createdAt:1},subjects:{key:JSON.stringify([namespace,review.digest,bytes]),namespace,review,bytes,createdAt:2}};
}
