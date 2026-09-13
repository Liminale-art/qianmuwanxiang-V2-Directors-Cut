// Navigation metadata only. Never an API target, authentication source or workflow import.
import {resolveStoryboardComfyCloud} from './qianmu-comfy-cloud-protocol.js';
export function normalizeRunningHubConsoleUrl(value) {
  if(typeof value!=='string')throw Error('请填写 RunningHub 工作流链接');
  const match=value.trim().match(/^https:\/\/(www\.runninghub\.(?:cn|ai))\/(?:workflow|post)\/([0-9]{1,64})(?:\?source=workspace)?$/);
  if(!match)throw Error('请填写 RunningHub 工作流链接，不包含 Key 或其他参数');
  return `https://${match[1]}/workflow/${match[2]}`;
}
export function comfyWorkbenchConsoleLink(profile,connection) {
  try {
    const binding=resolveStoryboardComfyCloud(connection);
    if(binding?.provider==='comfy-cloud'&&binding.origin==='https://cloud.comfy.org')return {url:binding.origin,label:'打开 Comfy Cloud'};
    if(binding?.provider!=='runninghub'||!profile?.comfyConsoleUrl)return null;
    const url=normalizeRunningHubConsoleUrl(profile.comfyConsoleUrl);
    // Do not silently change regional accounts or forward a connection credential.
    return new URL(url).origin===binding.origin?{url,label:'打开工作流控制台'}:null;
  } catch (_) { return null; }
}
