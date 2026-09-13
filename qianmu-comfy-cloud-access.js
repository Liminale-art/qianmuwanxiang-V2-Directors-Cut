// Official cloud egress belongs to the authenticated user's explicit request,
// not the administrator's native/private-network target registry. This grant
// does not authorize a job, a CDN URL, private DNS, redirects or credentials.
import { imageServiceAccount, imageServiceAccountStillMatches } from './qianmu-image-service-access.js';
import { resolveStoryboardComfyCloud } from './qianmu-comfy-cloud-protocol.js';
import { ImageGatewayError } from './qianmu-image-gateway.js';

const fail=(code,message,status=403)=>Object.assign(new ImageGatewayError(status,`comfy_cloud_access_${code}`,message),{submissionState:'not_submitted',retryable:false});
export async function authorizeComfyCloudTarget(req,input,{policy}={}) {
  let account;try{account=imageServiceAccount(req);}catch(_){throw fail('account','请先登录 ST 账户',401);}
  let binding;
  try{if(input?.allowPrivateNetwork!==false)throw Error('private');binding=resolveStoryboardComfyCloud({baseUrl:input.baseUrl});}catch(_){throw fail('target','云连接仅支持已确认的官方 HTTPS 地址');}
  if(!binding)throw fail('target','此地址不是已支持的官方云平台，未放开自建或本地地址');
  if(policy!==undefined&&typeof policy!=='function')throw fail('policy','站点云连接策略未就绪');
  const current=()=>{if(!imageServiceAccountStillMatches(req,account))throw fail('account','ST 账户已变化，已停止后续云连接',401);};
  current();const verifyPolicy=policy?await policy(req,binding):null;current();
  if(policy&&typeof verifyPolicy!=='function')throw fail('policy','站点未允许此云连接');
  const verify=async()=>{current();if(verifyPolicy)await verifyPolicy();current();};
  await verify();return verify;
}
