import {omitConfigConnections,readConfigEnvelope,CONFIG_INPUT_LIMITS} from './qianmu-config-connections.js';
import {parseBoundedJson} from './qianmu-json-input.js';

// An oversized snapshot can still be preserved intact, but never advertised as
// directly restorable. The user must explicitly choose that fallback download.
export async function exportConfiguration({current,clone,confirm,normalize,isPlainObject,plans,stamp,download,notify}) {
  try {
    const owner=current(),snapshot=clone(owner);
    const includeApi=await confirm('导出配置','是否包含连接配置与密钥？包含时文件含明文密钥，请勿分享。');
    const valid=()=>{if(current()===owner)return true;notify('设置已变化，请重新导出。','warning');return false;};
    if(!valid())return {status:'stale'};
    if(isPlainObject(snapshot.imagegen)) {
      snapshot.imagegen=normalize(snapshot.imagegen);
      snapshot.imagegen.shotPlans=await plans(snapshot.imagegen.shotPlans,{strict:true});
    }
    if(!valid())return {status:'stale'};
    if(!includeApi)omitConfigConnections(snapshot);
    const payload={version:2,type:'qianmu-config',includeApi,exportedAt:new Date().toISOString(),settings:snapshot};
    const text=JSON.stringify(payload,null,2),blob=new Blob([text],{type:'application/json'});
    let preservationOnly=false;
    try { readConfigEnvelope(parseBoundedJson(text,{maxBytes:CONFIG_INPUT_LIMITS.bytes,maxDepth:CONFIG_INPUT_LIMITS.depth,maxNodes:CONFIG_INPUT_LIMITS.nodes,label:'配置'})); }
    catch (_) { preservationOnly=true; }
    if(preservationOnly) {
      if(!await confirm('仅保存保全副本','此配置超过32 MiB或未通过结构检查，当前版本不能直接恢复。可完整保存原配置供后续整理，不会裁剪资料；素材原件仍需各模块单独备份。是否下载保全副本？'))return {status:'cancelled'};
      if(!valid())return {status:'stale'};
    }
    download(blob,`qianmu-config-${preservationOnly?'preservation-':''}${stamp()}.json`);
    notify(preservationOnly?'已下载保全副本，当前版本不能直接恢复；请保留原文件。':includeApi?'配置已导出（含 API）。':'配置已导出（不含 API）。',preservationOnly?'warning':'success');
    return {status:'exported',preservationOnly};
  } catch (_) {
    notify('配置导出未确认完成，请核对下载文件并保留当前页面后重试。','error');
    return {status:'error'};
  }
}
