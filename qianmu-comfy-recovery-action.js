// Manual receipt of an existing image. Never submit a new generation request.
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

export async function receiveComfyImage(log, { refresh = true, taskLocator } = {}, deps) {
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
    const apiKey = await deps.resolveKey(job.connection); current();
    const result = await service.retrieve(job, { apiKey,
      deliver: (data, archiveFiles, checkpoint, guard) => {
        current();
        return deps.deliver(job, log, data, { service: true, archiveFiles, checkpoint,
          guard: async () => { await guard(); current(); },
        });
      },
    });
    current();
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
