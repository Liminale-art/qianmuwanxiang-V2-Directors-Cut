// C-25：绑定套用稳定性——进已绑定聊天、预设加载中又手动换预设、宿主重载回声、套用中途换聊天等竞态。
import test from 'node:test';
import assert from 'node:assert/strict';

const { createChatRegex } = await import('../features/chat/qianmu-chat-regex.js');

// 一个「慢」的 ST：selectPreset 要等到我们手动放行才完成，用来制造套用进行中的窗口。
function slowWorld({ presets = ['甲', '乙', '丙'], selected = '甲' } = {}) {
  let current = selected, chatId = 'A';
  const presetLists = Object.fromEntries(presets.map(name => [name, [{ id: `${name}-1`, scriptName: `${name}一` }]]));
  const gates = [];
  const manager = { apiId: 'openai',
    getAllPresets: () => presets, getSelectedPresetName: () => current,
    findPreset: name => (presets.includes(name) ? name : undefined),
    selectPreset: value => new Promise(resolve => gates.push(() => { current = value; resolve(); })),
    readPresetExtensionField: ({ path }) => (path === 'regex_scripts' ? presetLists[current] : null),
    writePresetExtensionField: async ({ value }) => { writes.push({ preset: current, value }); presetLists[current] = value; } };
  const writes = [];
  const log = { reloads: 0 };
  const ctx = { extensionSettings: { regex: [{ id: 'g1', scriptName: '全局一' }] }, getPresetManager: () => manager,
    getCurrentChatId: () => chatId, reloadCurrentChat: async () => { log.reloads += 1; }, saveSettingsDebounced() {} };
  const bindings = {};
  let defaults = {};
  const notes = [];
  const ctrl = createChatRegex({ getContext: () => ctx, timers: { set: () => 1, clear() {} }, notify: (m, t) => notes.push([t, m]),
    readBinding: () => bindings[chatId] || { enabled: false, overrides: {} },
    writeBinding: value => { bindings[chatId] = JSON.parse(JSON.stringify(value)); },
    readDefaults: () => defaults, writeDefaults: value => { defaults = JSON.parse(JSON.stringify(value)); } });
  return {
    ctrl, notes, writes, log, bindings,
    get current() { return current; },
    setChat(id) { chatId = id; },
    release() { const g = gates.shift(); g?.(); return !!g; },
    releaseAll() { while (gates.length) gates.shift()(); },
    pending: () => gates.length,
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('switching preset by hand while a bound chat is still applying never snaps back to the bound preset', async () => {
  const w = slowWorld();
  w.bindings.A = { enabled: true, overrides: { 'preset:乙:乙-1': { enabled: false } }, preset: '乙' };
  w.ctrl.events.chatChanged();            // 进聊天 A：开始切到绑定预设「乙」（卡在宿主的异步切换里）
  await tick();
  assert.equal(w.pending(), 1, '绑定预设的切换正在进行');
  const manual = w.ctrl.actions.selectPreset('丙');   // 用户此时手动换到「丙」
  await tick();
  w.releaseAll(); await tick(); await tick();
  await manual; w.releaseAll(); await tick(); await tick();
  assert.equal(w.current, '丙', '最终停在用户手选的预设，不被旧一轮切回');
  assert.ok(!w.writes.some(entry => entry.preset === '丙'), '旧一轮的正则写入没有落到「丙」上');
  assert.equal(w.bindings.A.enabled, false, '手动换预设 = 本聊天绑定暂停，需用户重新开启');
});

test('leaving the chat mid-apply abandons the old round (no preset switch, no regex write for the old chat)', async () => {
  const w = slowWorld();
  w.bindings.A = { enabled: true, overrides: { 'preset:乙:乙-1': { enabled: false } }, preset: '乙' };
  w.ctrl.events.chatChanged();
  await tick();
  w.setChat('B');                          // 套用进行中换到聊天 B（未绑定）
  w.ctrl.events.chatChanged();
  w.releaseAll(); await tick(); await tick();
  assert.equal(w.writes.length, 0, '旧聊天的正则覆盖没有写进任何预设');
});

test('a host reload echo (CHAT_CHANGED for the same chat) does not switch the preset again', async () => {
  const w = slowWorld();
  w.bindings.A = { enabled: true, overrides: {}, preset: '乙' };
  w.ctrl.events.chatChanged();
  await tick(); w.releaseAll(); await tick(); await tick();
  assert.equal(w.current, '乙');
  // 用户在同一聊天里改用「丙」（走 ST 原生，不经过千幕），随后宿主重载发出同一聊天的 CHAT_CHANGED
  w.ctrl.actions.selectPreset('丙'); await tick(); w.releaseAll(); await tick(); await tick();
  w.bindings.A.enabled = true;            // 即使绑定又被打开，同一聊天的回声也不切预设
  w.ctrl.events.chatChanged();
  await tick();
  assert.equal(w.pending(), 0, '同一聊天的回声不触发预设切换');
  assert.equal(w.current, '丙');
});

test('overlapping chatChanged calls are serialized, and a runaway loop trips the breaker', async () => {
  const w = slowWorld();
  w.bindings.A = { enabled: true, overrides: {}, preset: '乙' };
  w.ctrl.events.chatChanged();
  w.ctrl.events.chatChanged();
  w.ctrl.events.chatChanged();
  await tick();
  assert.equal(w.pending(), 1, '同一时刻只有一轮在切预设');
  w.releaseAll(); await tick(); await tick(); w.releaseAll(); await tick();
});

test('a runaway apply loop on one chat trips the breaker and stops writing', async () => {
  const w = slowWorld({ selected: '乙' });
  // 每轮都有差异可写：宿主（模拟）每次都把 g1 打回开启，千幕每轮又按绑定把它关掉
  w.bindings.A = { enabled: true, overrides: { 'global:g1': { enabled: false } }, preset: '乙' };
  const g1 = () => w.ctrl.state().sources.global.items.find(item => item.id === 'g1');
  let rounds = 0;
  for (let i = 0; i < 6; i += 1) {
    await w.ctrl.actions.toggle({ source: 'global', id: 'g1', name: '全局一', enabled: true });   // 外力打开
    w.bindings.A.overrides['global:g1'] = { enabled: false };
    if (await w.ctrl.applyBinding({ entering: false })) rounds += 1;
  }
  assert.equal(rounds, 3, '同一聊天 10 秒内第 4 轮起不再写入');
  assert.ok(w.notes.some(([kind, msg]) => kind === 'warning' && msg.includes('暂停本聊天的自动套用')), '提示熔断');
  assert.equal(g1().enabled, true, '熔断后不再改动');
});

test('manual toggle during an apply round is not overwritten by the stale round', async () => {
  const w = slowWorld({ selected: '乙' });
  w.bindings.A = { enabled: true, overrides: { 'global:g1': { enabled: false } }, preset: '乙' };
  // 绑定预设已是当前预设 → 直接进入正则写入；在它写之前用户手动打开 g1
  const round = w.ctrl.applyBinding({ entering: true });
  await w.ctrl.actions.toggle({ source: 'global', id: 'g1', name: '全局一', enabled: true });
  await round;
  const g1 = w.ctrl.state().sources.global.items.find(item => item.id === 'g1');
  assert.equal(g1.enabled, true, '用户刚拨的状态保留');
});
