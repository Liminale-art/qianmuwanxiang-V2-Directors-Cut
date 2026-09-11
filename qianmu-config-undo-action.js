import {configRestoreGate} from './qianmu-config-connections.js';
import {finishConfigRestore} from './qianmu-config-apply.js';

// The captured record has identity, not just equal content. A newer import must
// survive an older confirmation or an older operation's asynchronous UI work.
export function createConfigUndoAction({undo, current, activity, confirm, notify, applyOptions}) {
  let busy = false;
  return async function undoRestore() {
    if (busy) return {status:'busy'};
    busy = true;
    try {
      const owner = current(), held = undo.capture(owner);
      const reject = () => { notify('配置或排版状态已变化，无法撤回本次恢复。', 'warning'); return {status:'stale'}; };
      if (!held) return reject();
      const allowed = configRestoreGate(owner, activity, notify), options = applyOptions();
      const unchanged = () => {
        if (!held.valid(current())) return false;
        try {
          const expected = held.snapshot.layoutAfter, storage = options.layoutStorage();
          return expected?.available === !!storage && (!storage || storage.getItem(options.layoutKey) === expected.raw);
        } catch (_) { return false; }
      };
      if (!unchanged()) return reject();
      if (!allowed(current())) return {status:'blocked'};
      if (!await confirm('撤回本次恢复', '将恢复本次导入前的配置及排版。书籍、图片、录音等独立原件不会改动。确认撤回？')) return {status:'cancelled'};
      if (!unchanged()) return reject();
      if (!allowed(current())) return {status:'blocked'};
      const result = await finishConfigRestore({...options, prepared:held.snapshot.settings, owner,
        current, notify, undo:undefined, layoutSnapshot:held.snapshot.layout, action:'undo'});
      if (result.status === 'applied') held.release();
      return result;
    } catch (_) {
      notify('撤回未能完成，请检查当前配置并保留备份后重试。', 'error');
      return {status:'error'};
    } finally { busy = false; }
  };
}
