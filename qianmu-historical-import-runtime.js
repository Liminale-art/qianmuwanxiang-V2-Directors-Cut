export async function importHistoricalStoryboardBundle(file, [
  baseContext, hostContext, transfer, exportTransfer, modalId, active, epoch, featureRuntime, applyIcons, scheduleInlineRender, renderModal, toast,
] = []) {
  if (!file || transfer?.busy || exportTransfer?.busy) return;
  transfer.busy = true;
  const context = () => Object.assign(hostContext(), baseContext());
  context.release = baseContext.release;
  let journal = null, review = null;
  try {
    const initial = context();
    const [assets, identityModule, journalModule, restoreModule, viewModule] = await Promise.all([
      featureRuntime.load('storyboardPackageAssets'), featureRuntime.load('imageAdmission'),
      featureRuntime.load('storyboardPackageJournal'), featureRuntime.load('historicalRestore'), featureRuntime.load('historicalRestoreView'),
    ]);
    const scope = await assets.createStoryboardPackageGuard({ initial, context, resolveNamespace: () => identityModule.resolveImageAccountNamespace() });
    const parent = document.getElementById(modalId);
    const isCurrent = () => {
      try {
        const live = context();
        return parent?.classList.contains('open') && live.state === initial.state && live.store === initial.store && live.chatKey === initial.chatKey
          && live.epoch === initial.epoch && (!review || review.isOpen);
      } catch (_) { return false; }
    };
    const guard = async () => {
      await scope.guard();
      if (!isCurrent()) throw new Error('恢复页面或聊天来源已变化，请重新选择原件');
      if (active() || initial.state.shotPlans.some(plan => ['screening', 'compiling', 'generating', 'queued'].includes(plan.status)))
        throw new Error('分镜仍在工作，请结束当前任务后核对');
    };
    await guard();
    if (!navigator.locks?.request) throw new Error('浏览器不支持跨页恢复锁，未修改聊天资料');
    journal = journalModule.createStoryboardPackageJournal();
    await journal.assertNoHistoricalChatMutation(scope.namespace, { isCurrent });
    await guard();
    review = viewModule.openHistoricalRestoreReview({ parent, fileName: file.name || '历史聊天分镜原件', paintIcons: applyIcons,
      connect: async () => {
        const coordinator = restoreModule.createHistoricalRestore({ file, namespace: scope.namespace, getContext: context,
          epoch, account: () => identityModule.resolveImageAccountNamespace(), guard, isCurrent, journal,
          headers: () => typeof hostContext().getRequestHeaders === 'function' ? hostContext().getRequestHeaders() : {} });
        return Object.freeze({
          preview: () => coordinator.preview(),
          restore: args => navigator.locks.request(`qianmu:package-import:${scope.namespace}`, { mode: 'exclusive', ifAvailable: true }, lock => {
            if (!lock) throw new Error('另一页面正在恢复，请稍后重试');
            return coordinator.restore(args);
          }),
          close: () => coordinator.close(),
        });
      } });
    const result = await review.finished;
    if (result?.status === 'restored') {
      scheduleInlineRender(30); renderModal(); toast('历史聊天分镜已恢复并完成核对；外部依赖仍需单独配置。', 'success');
    }
  } catch (error) {
    toast(`历史聊天分镜恢复未完成：${error?.message || '请核对原件与当前聊天'}`, 'error');
  } finally {
    review?.close(); journal?.close(); context?.release(); transfer.busy = false;
  }
}
