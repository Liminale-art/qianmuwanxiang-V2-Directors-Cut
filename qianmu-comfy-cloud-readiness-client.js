// Reuse the existing account-bound cloud request path, without journal writes
// or downloading the full platform catalog into the browser.
import { createComfyRecoveryClient } from './qianmu-comfy-recovery-client.js';
export async function checkCloudComfyReadiness(request,{headers,fetchImpl=globalThis.fetch,guard=async()=>{},signal,createClient=createComfyRecoveryClient}={}) {
  const before=JSON.stringify(request);
  const current=async()=>{signal?.throwIfAborted();await guard();signal?.throwIfAborted();if(before!==JSON.stringify(request))throw Error('节点检查配置已变化');};
  const client=createClient({headers:()=>headers||{},timeoutMs:30000,fetchImpl:async(...args)=>{await current();return fetchImpl(...args);}});
  const abort=()=>client.close();signal?.addEventListener('abort',abort,{once:true});
  try {await current();const result=await client.inspectCloudWorkflow(request);await current();return result;}
  finally {signal?.removeEventListener('abort',abort);client.close();}
}
