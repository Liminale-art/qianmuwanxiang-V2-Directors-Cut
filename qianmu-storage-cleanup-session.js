// One local cleanup at a time. Invalidating a session stops future work, not
// transactions which have already committed; callers must keep partial results honest.
export function createStorageCleanupSession({owner, scope, epoch, notify = () => {}}) {
  let active = null;
  return {
    get busy() { return active !== null; },
    begin(root) {
      if (active) { notify('已有清理正在处理。', 'info'); return null; }
      const captured = [owner(), scope(), epoch()];
      const token = {
        current(view = true) {
          try { return active === token && (!view || root?.isConnected === true)
            && owner() === captured[0] && scope() === captured[1] && epoch() === captured[2]; }
          catch (_) { return false; }
        },
        check() {
          if (!token.current()) throw Object.assign(new Error('清理页面或配置已变化，后续操作已停止；已完成的清理不会撤回，请重新盘点。'), {code:'qianmu_cleanup_stale'});
        },
        release() { if (active === token) active = null; },
      };
      active = token;
      return token;
    },
  };
}
