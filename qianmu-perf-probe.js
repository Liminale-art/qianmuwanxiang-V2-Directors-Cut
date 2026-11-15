// Opt-in timing probe for "click → shown → ready" on a few surfaces (main tabs, notes, assistant, chat toolkit).
// Off by default and free when off: start() returns a shared no-op, nothing is stored.
// Turn on from the browser console:  qianmuPerf.on()   → use the app →   qianmuPerf.report()
// It owns no feature data, adds no observers and never touches the DOM; rows live in memory only.
const KEY = 'qianmu.perf';
const NOOP = Object.freeze(Object.assign(() => {}, { frame() {} }));

export function createPerfProbe({ storage = globalThis.localStorage, now = () => globalThis.performance?.now?.() ?? Date.now(),
  raf = fn => (globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(fn) : setTimeout(fn, 16)), limit = 600 } = {}) {
  const rows = [];
  let enabled = false;
  try { enabled = storage?.getItem(KEY) === '1'; } catch { enabled = false; }
  const round = ms => Math.round(ms * 10) / 10;
  const push = (surface, phase, ms) => { rows.push({ surface: String(surface), phase: String(phase), ms: round(ms) }); if (rows.length > limit) rows.shift(); };

  // start('聊天工具包') → end('显示') records the time since start; end.frame('显示') records at the next animation
  // frame (i.e. after the browser had a chance to paint what was just rendered). One start can end several phases.
  function start(surface) {
    if (!enabled) return NOOP;
    const t0 = now();
    const end = phase => push(surface, phase, now() - t0);
    end.frame = phase => { raf(() => push(surface, phase, now() - t0)); };
    return end;
  }
  // For durations measured elsewhere (e.g. the modal already times its own render).
  function record(surface, phase, ms) { if (enabled && Number.isFinite(ms)) push(surface, phase, ms); }

  function summary() {
    const groups = new Map();
    for (const row of rows) {
      const key = `${row.surface}｜${row.phase}`;
      const g = groups.get(key) || { 位置: row.surface, 阶段: row.phase, 次数: 0, 平均ms: 0, 最大ms: 0, 最近ms: 0, total: 0 };
      g.次数 += 1; g.total += row.ms; g.最大ms = Math.max(g.最大ms, row.ms); g.最近ms = row.ms;
      groups.set(key, g);
    }
    return [...groups.values()].map(({ total, ...g }) => ({ ...g, 平均ms: round(total / g.次数) }));
  }
  const text = () => summary().map(g => `${g.位置}\t${g.阶段}\t次数 ${g.次数}\t平均 ${g.平均ms}ms\t最大 ${g.最大ms}ms\t最近 ${g.最近ms}ms`).join('\n');
  const set = on => { enabled = on === true; try { if (enabled) storage?.setItem(KEY, '1'); else storage?.removeItem(KEY); } catch { /* storage blocked: keep the in-memory switch */ } return enabled; };

  const api = Object.freeze({
    start, record, summary, text,
    get enabled() { return enabled; },
    on: () => { set(true); return '计时已开启（刷新后仍有效）。操作几次后运行 qianmuPerf.report()'; },
    off: () => { set(false); return '计时已关闭'; },
    clear: () => { rows.length = 0; return '已清空'; },
    // Prints a table and returns tab-separated text that can be pasted back.
    report: () => { const table = summary(); try { console.table(table); } catch { /* no console.table */ } return text() || '还没有记录'; },
  });
  return api;
}
