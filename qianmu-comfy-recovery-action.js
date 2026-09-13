// Manual receipt of an existing image. Never submit a new generation request.
import { bindComfyCloudProtocol, resolveStoryboardComfyCloud } from './qianmu-comfy-cloud-protocol.js';

export async function resolveComfyCloudRecoveryKey(item, { connections, resolve, guard = () => {} }) {
  const row = item?.cloudRecord || item, task = row?.cloudTask, channelKey = row?.taskLocator?.channelKey;
  if (row?.version !== 3 || !task || !/^[a-f0-9]{64}$/.test(channelKey || '') || ['archived','confirmed'].includes(row.status)) return '';
  const connection = bindComfyCloudProtocol(task.origin, task.protocol);
  const entries = () => { const group = connections(); return [group?.draft,group?.active,...(group?.presets || [])].filter(Boolean); };
  const sameOrigin = entry => { try { return bindComfyCloudProtocol(entry.baseUrl, connection.protocol).origin === connection.origin; } catch (_) { return false; } };
  const ids = [...new Set(entries().filter(sameOrigin).map(entry => entry.credentialId).filter(Boolean))];
  if (ids.length > 64) return '';
  for (const id of ids) {
    const matches = () => { const owned = entries().filter(entry => entry.credentialId === id); return owned.length && owned.every(sameOrigin); };
    await guard(); if (!matches()) continue;
    const apiKey = await resolve(id); await guard();
    if (!matches() || typeof apiKey !== 'string' || !/^[\x21-\x7e]{1,2048}$/.test(apiKey)) continue;
    // Match the server's exact original resource fingerprint, not a same-host
    // guess. Keys never leave memory or go to a mismatching historical account.
    const bytes = new TextEncoder().encode(JSON.stringify(['qianmu.cloud-resource.v1',connection.provider,connection.origin,apiKey]));
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value => value.toString(16).padStart(2,'0')).join('');
    await guard(); if (matches() && digest === channelKey) return apiKey;
  }
  return '';
}

export async function resolveComfyRecoveryKey(connection, {connections,resolve}) {
  if (!connection?.credentialId) return '';
  const root = value => { try { const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash ? url.href.replace(/\/+$/, '') : ''; } catch (_) { return ''; } };
  const expected = root(connection.baseUrl), credentialId = connection.credentialId;
  // Reused credential ids must not send today's Key to an unrelated old host.
  const matches = () => {
    const group = connections();
    const rows = [group?.draft, group?.active, ...(group?.presets || [])].filter(item => item?.credentialId === credentialId);
    return expected && rows.length && rows.every(item => root(item.baseUrl) === expected);
  };
  if (!matches()) return '';
  const apiKey = await resolve(credentialId);
  return matches() ? apiKey : '';
}

export async function receiveComfyImage(log, { refresh = true, taskLocator, cloudRecord } = {}, deps) {
  const initial = deps.scope();
  const current = () => {
    const next = deps.scope();
    if (next.chat !== initial.chat) throw new Error('聊天已切换，请回原聊天继续领取');
    if (next.owner !== initial.owner || next.epoch !== initial.epoch) throw new Error('分镜配置已变化，请从当前页面重新领取原图');
  };
  try {
    if (!deps.canReceive(log)) throw new Error('请使用原 Comfy 服务日志领取');
    const snapshot = deps.sanitize(log.snapshot, { source: 'comfy' });
    const job = { ...snapshot, id: snapshot.imageAdmission.attemptId, logId: log.id, recoveringOriginal: true,
      ...(taskLocator ? { comfyTaskLocator: taskLocator } : {}) };
    if (job.chatKey && job.chatKey !== initial.chat) throw new Error('请返回原聊天后领取 Comfy 原图');
    const service = await deps.recovery(); current();
    const deliver = (original,data,archiveFiles,checkpoint,guard) => {
      current();return deps.deliver(original,log,data,{service:true,archiveFiles, checkpoint,guard:async()=>{await guard();current();}});
    };
    let result;
    if(resolveStoryboardComfyCloud(job.connection)) {
      const selected=await service.cloudRecordFor(job);current();
      if(selected?.version!==3||!selected.cloudTask)throw new Error('原云任务受理尚未确认，请从收片管理核查原任务，勿重新生成');
      if(selected.attemptId!==job.id||selected.namespace!==job.imageAdmission.namespace)throw new Error('原日志与云任务不匹配');
      const supplied=cloudRecord?.cloudRecord||cloudRecord;
      if(supplied&&(supplied.attemptId!==selected.attemptId||supplied.namespace!==selected.namespace
        ||JSON.stringify(supplied.taskLocator)!==JSON.stringify(selected.taskLocator)||JSON.stringify(supplied.cloudTask)!==JSON.stringify(selected.cloudTask)))throw new Error('所选云任务与原日志不匹配');
      const apiKey=await deps.resolveCloudKey(selected,current);current();
      result=await service.retrieveCloudJob(job,selected,{apiKey,deliver});
    }else{
      const apiKey = await deps.resolveKey(job.connection); current();
      result = await service.retrieve(job,{apiKey,deliver:(...args)=>deliver(job,...args)});
    }
    current();
    if (result.status==='failed' && result.cloudUsage) deps.finish(log,'failed',{
      error:result.warning,submissionState:'accepted',cloudUsage:result.cloudUsage,durationMs:Number(log.durationMs)||0,
    });
    if (result.archived) {
      log.error = ''; log.submissionState = 'accepted';
      deps.finish(log, 'success', { durationMs: Number(log.durationMs) || 0 });
      try { const admission = await deps.admission(); current(); await admission.confirmResult(job.imageAdmission); }
      catch (_) { result.warning ||= '原图已归档；本地任务状态尚待核查'; }
    }
    current();
    deps.notify(result.warning || '原图已领取并归档', result.warning ? 'warning' : 'success');
    if (refresh) deps.render();
    return result;
  } catch (error) { deps.notify(error.message || 'Comfy 原图暂不可领取，未重新生成', 'warning'); }
}
