// Ephemeral authority issued only by the validated original-image archive path.
// Never serialize this proof into logs, backups or a request to the server.
import {normalizeComfySceneOrigin} from './qianmu-comfy-route-contract.js';
import {normalizeComfyDelivery} from './qianmu-comfy-delivery-store.js';
import {COMFY_SELECTION_SCHEMA} from './qianmu-comfy-selection.js';
import {resolveStoryboardComfyCloud} from './qianmu-comfy-cloud-protocol.js';
const issued=new WeakMap();
const fail=()=>{throw Object.assign(new Error('原图归档与续场来源不匹配，未修改风格保护'),{code:'comfy_scene_archive_proof'});};
const root=value=>{try{return resolveStoryboardComfyCloud({baseUrl:value})?.origin||new URL(value).href.replace(/\/+$/,'');}catch(_){return '';}};
function binding(job) {
  const source=normalizeComfySceneOrigin(job?.comfySceneOrigin),admission=job?.imageAdmission;
  if(job?.source!=='comfy'||job.originalOnly||source.mode!=='scene'||admission?.version!==1
    ||admission.namespace!==source.scope.namespace||job.chatKey!==source.scope.chatKey||job.id!==admission.attemptId
    ||typeof job.id!=='string'||!job.id||job.id.length>240||!root(job.connection?.baseUrl))fail();
  return {namespace:admission.namespace,attemptId:job.id,baseUrl:root(job.connection.baseUrl),source};
}
function archive(row,job,origin) {
  const current=normalizeComfyDelivery(row,origin),expected=binding(job);
  if(current.originalOnly||!['archived','confirmed'].includes(current.status)||current.namespace!==expected.namespace
    ||current.attemptId!==expected.attemptId||current.chatKey!==expected.source.scope.chatKey||root(current.baseUrl)!==expected.baseUrl
    ||!current.imageCount||current.files.length!==current.imageCount||!/^[a-f0-9]{64}$/.test(current.receipt)
    ||current.version===3&&(!current.cloudTask||!current.taskLocator))fail();
  return {expected,signature:JSON.stringify([current.version,current.namespace,current.attemptId,current.baseUrl,current.credentialId,
    current.chatKey,current.logId,current.automatic,current.receipt,current.imageCount,current.files,current.cloudTask,current.taskLocator])};
}
export function issueComfySceneArchiveProof(job,row,verify,{origin=globalThis.location?.origin}={}) {
  if(typeof verify!=='function')fail();
  const captured=archive(row,job,origin),proof=Object.freeze({version:1});
  issued.set(proof,{...captured,verify,origin});return proof;
}
export async function readComfySceneArchiveProof(proof,job) {
  const entry=issued.get(proof);if(!entry)fail();
  const before=JSON.stringify(binding(job));if(before!==JSON.stringify(entry.expected))fail();
  const current=archive(await entry.verify(),job,entry.origin);
  if(before!==JSON.stringify(current.expected)||current.signature!==entry.signature)fail();
  const {namespace,attemptId,source}=entry.expected;
  return {namespace,attemptId,scope:{...source.scope},lock:{schema:COMFY_SELECTION_SCHEMA,scope:{...source.scope},
    poolKey:source.poolKey,candidateId:source.candidateId,executionKey:source.executionKey}};
}

export function attachComfySceneArchiveProof(result,job,row,verify,options) {
  if(result?.archived!==true||job?.originalOnly||!job?.comfySceneOrigin||job.comfySceneOrigin.mode==='independent')return result;
  try{return Object.defineProperty({...result},'sceneArchiveProof',{value:issueComfySceneArchiveProof(job,row,verify,options)});}
  catch(_){return {...result,warning:result.warning||'原图已归档；续场来源尚待核查'};}
}
