// Receipt of existing NAI service results only. No generation or task replay.
export async function receiveServiceImage(attemptId, discovered, expectedNamespace, deps) {
  const initial = deps.scope();
  const current = () => {
    const next = deps.scope();
    if (next.owner !== initial.owner || next.epoch !== initial.epoch || next.chat !== initial.chat)
      throw new Error('收片配置或聊天已变化，请从当前页面重新领取原图');
  };
  try {
    const service = await deps.service(); current();
    if (discovered) {
      const remembered = await service.rememberOriginal(discovered, { chatKey:initial.chat }); current();
      if (!remembered) return;
    }
    const result = await service.retrieve(attemptId, async (data, row, checkpoint, accountGuard) => {
      current();
      const guard = async () => { await accountGuard(); current(); };
      const job = row.originalOnly ? { id:row.attemptId, originalOnly:true, source:'novel', target:'gallery', chatKey:row.snapshot.chatKey, inlineByDefault:false,
        profile:{model:String(data.model || '')}, prompt:'', negative:'', payload:{}, automatic:false }
        : {...deps.clone(row.snapshot), id:row.attemptId, automatic:Boolean(row.snapshot.automatic), discardRequested:false};
      const log = row.originalOnly ? null : deps.state().logs.find(item => item.id === row.logId);
      const archived = await deps.deliver(job, log, data, {service:true, archiveRecords:row.archiveRecords, checkpoint, guard});
      if (archived) {
        await guard();
        try {
          const admission = await deps.admission(); await guard();
          if (job.imageAdmission) { await admission.confirmResult(job.imageAdmission); await guard(); }
          const channel = await deps.channel(); await guard();
          await channel.confirmResult({namespace:row.namespace, attemptId:row.attemptId, channelKey:row.channelKey}); await guard();
        } catch (_) { throw new Error('原图已归档；本地请求保护记录尚待核查，可稍后再领取以同步，不会重新生图'); }
      }
      return archived;
    }, {namespace:expectedNamespace});
    current();
    deps.notify(result.warning || '原图已领取并归档', result.warning ? 'warning' : 'success');
    deps.render();
    return result;
  } catch (error) { deps.notify(error.message || '原图暂不可领取，未重新生成', 'warning'); }
}
