// C-23：正则开关绑定聊天——预设正则的绑定键错位（写 `preset:<id>`，读 `preset:<预设名>:<id>`）导致从未生效；
// 未绑定聊天沿用上一个聊天的开关（泄漏）。
import test from 'node:test';
import assert from 'node:assert/strict';

const { createChatRegex } = await import('../features/chat/qianmu-chat-regex.js');

function world() {
  let chatId = 'A';
  let presetList = [{ id: 'p1', scriptName: '预设甲' }, { id: 'p2', scriptName: '预设乙' }];
  const manager = { apiId: 'openai', getSelectedPresetName: () => '写作预设',
    readPresetExtensionField: ({ path }) => (path === 'regex_scripts' ? presetList : null),
    writePresetExtensionField: async ({ value }) => { presetList = value; } };
  const ctx = { extensionSettings: { regex: [{ id: 'g1', scriptName: '全局甲' }] }, getPresetManager: () => manager,
    getCurrentChatId: () => chatId, reloadCurrentChat: async () => {}, saveSettingsDebounced() {} };
  const bindings = {};   // 每个聊天自己的 chat_metadata
  let defaults = {};
  const ctrl = createChatRegex({ getContext: () => ctx, timers: { set: () => 1, clear() {} },
    readBinding: () => bindings[chatId] || { enabled: false, overrides: {} },
    writeBinding: value => { bindings[chatId] = JSON.parse(JSON.stringify(value)); },
    readDefaults: () => defaults, writeDefaults: value => { defaults = JSON.parse(JSON.stringify(value)); } });
  const live = () => ({
    p1: presetList.find(s => s.id === 'p1').disabled !== true,
    g1: ctx.extensionSettings.regex.find(s => s.id === 'g1').disabled !== true });
  const enter = async id => { chatId = id; await ctrl.applyBinding(); };
  return { ctrl, live, enter, bindings, get defaults() { return defaults; }, setBindings: (id, value) => { bindings[id] = value; } };
}

test('two bound chats keep their own preset-regex and global-regex switches', async () => {
  const w = world();
  await w.enter('A');
  await w.ctrl.actions.setBindingEnabled(true);
  await w.ctrl.actions.toggle({ source: 'preset', id: 'p1', name: '预设甲', enabled: false });
  // C-27：开绑定即记下此刻全部开关；预设正则的绑定键带预设名，拨动后静默覆盖该条
  assert.deepEqual(Object.keys(w.bindings.A.overrides).sort(), ['global:g1', 'preset:写作预设:p1', 'preset:写作预设:p2']);
  assert.deepEqual(w.bindings.A.overrides['preset:写作预设:p1'], { enabled: false }, '拨动覆盖记录');
  await w.enter('B');
  await w.ctrl.actions.setBindingEnabled(true);
  assert.deepEqual(w.live(), { p1: true, g1: true }, '进 B：没覆盖的条目复位到基线');
  await w.ctrl.actions.toggle({ source: 'global', id: 'g1', name: '全局甲', enabled: false });
  await w.enter('A');
  assert.deepEqual(w.live(), { p1: false, g1: true }, '回 A：预设正则关、全局正则复位');
  await w.enter('B');
  assert.deepEqual(w.live(), { p1: true, g1: false }, '回 B：各自保持');
});

test('an unbound chat returns to the global baseline instead of inheriting the last bound chat', async () => {
  const w = world();
  await w.enter('A');
  await w.ctrl.actions.setBindingEnabled(true);
  await w.ctrl.actions.toggle({ source: 'preset', id: 'p1', name: '预设甲', enabled: false });
  await w.enter('C');
  assert.deepEqual(w.live(), { p1: true, g1: true }, '未绑定聊天复位到基线');
  // 在未绑定聊天里拨开关 = 更新全局基线，A 不受影响
  await w.ctrl.actions.toggle({ source: 'global', id: 'g1', name: '全局甲', enabled: false });
  assert.deepEqual(w.defaults['global:g1'], { enabled: false }, '开绑定时已为全部条目建基线，未绑定聊天里拨动即更新基线');
  await w.ctrl.actions.toggle({ source: 'preset', id: 'p1', name: '预设甲', enabled: false });
  assert.deepEqual(w.defaults['preset:写作预设:p1'], { enabled: false }, '已有基线的条目同步更新');
  await w.enter('A');
  assert.equal(w.live().p1, false);
});

test('legacy overrides written with the old key (preset:<id>) still apply', async () => {
  const w = world();
  w.setBindings('A', { enabled: true, overrides: { 'preset:p2': { enabled: false } } });
  await w.enter('A');
  const p2 = w.ctrl.state().sources.preset.items.find(item => item.id === 'p2');
  assert.equal(p2.enabled, false, '旧键按当前预设兼容读取');
});
