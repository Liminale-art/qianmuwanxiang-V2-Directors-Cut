// One local cleanup at a time. Invalidating a session stops future work, not
// transactions which have already committed; callers must keep partial results honest.
export function createStorageCleanupSession({owner, scope, epoch, activity = () => ({}), notify = () => {}}) {
  let active = null;
  const hasActivity = () => Object.values(activity()).some(Boolean);
  return {
    get busy() { return active !== null; },
    begin(root) {
      if (active) { notify('已有清理正在处理。', 'info'); return null; }
      try { if (hasActivity()) { notify('请先结束正在运行的任务或备份/恢复，再清理。', 'warning'); return null; } }
      catch (_) { notify('暂时无法确认任务状态，未开始清理。', 'warning'); return null; }
      const captured = [owner(), scope(), epoch()];
      let invalid = false;
      const token = {
        current(view = true) {
          if (invalid) return false;
          try {
            invalid = !(active === token && (!view || root?.isConnected === true)
              && owner() === captured[0] && scope() === captured[1] && epoch() === captured[2] && !hasActivity());
          } catch (_) { invalid = true; }
          return !invalid;
        },
        check() {
          if (!token.current()) throw Object.assign(new Error('清理页面、配置或任务状态已变化，后续操作已停止；已完成的清理不会撤回，请重新盘点。'), {code:'qianmu_cleanup_stale'});
        },
        release() { if (active === token) active = null; },
      };
      active = token;
      return token;
    },
  };
}
