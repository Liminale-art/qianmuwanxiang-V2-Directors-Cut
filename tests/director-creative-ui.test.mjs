import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { QIANMU_HIVE_COMMANDS } from '../qianmu-hive-commands.js';
import { directorPreviewPlan, directorSectionEnabled, directorSectionStatus, directorQualitySummary, renderDirectorLive } from '../qianmu-director-live.js';
import { renderCreativeSocialCard } from '../qianmu-creative-social.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const skinStyles = await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function section(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, name);
  const tail = source.slice(match.index), next = tail.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
function fixture(plan, settings = {}) {
  const links = [];
  const c = vm.createContext({
    settings, directorLiveLog: null, directorPreviewPlan, directorSectionEnabled, directorSectionStatus, directorQualitySummary, renderDirectorLive, renderCreativeSocialCard, currentPlan: () => plan, htmlEscape: escape, snip: value => String(value), chatterExpanded: true,
    getContextItemId: item => item.title || item.name || 'one', injectSelection: new Map(),
    renderHistorySection: () => '<div>history</div>', renderHeroActions: () => '', renderGenerateRow: () => '',
    renderDirectorWorldEntryLink: (field, index) => { links.push({ field, index }); return '<span class="sd-world-media-entry"></span>'; },
    renderInjectPreview: () => '', renderBackstageBlueprintCard: () => '', DEFAULT_SYSTEM_PROMPT: '', JSON_SCHEMA_TEXT: '',
  });
  vm.runInContext(['directorDisplayPlan', 'renderDirectorSectionNotice', 'renderDashboardTab', 'renderDirectorExtraCard', 'renderChainReactionsCard', 'renderTasksNodesTab',
    'renderCastWorldFront', 'renderWorldChatterCard', 'renderRelationUndercurrentsCard', 'renderPlanSectionFold', 'renderNoPlan', 'renderItemList', 'directorItemParagraphs', 'directorSelectionOrder', 'renderDirectorParagraph', 'renderItemCard', 'renderItemChips', 'collectDirectorSelectedText',
    'renderInjectSections', 'renderDirectorSettingsTab'].map(section).join('\n'), c);
  return { c, links };
}

test('live generation does not render a stale saved plan before the first closed card', () => {
  const previous = { story_status: { title: '旧方向' }, quests: [{ title: '旧卡' }] };
  const { c } = fixture(previous);
  c.directorLiveLog = { status: 'loading', response: '{"quests":[' };
  assert.equal(c.directorDisplayPlan(), null);
  c.directorLiveLog = { status: 'loading', response: '{"quests":[{"title":"新卡"}]}' };
  assert.equal(c.directorDisplayPlan().quests[0].title, '新卡');
});

test('review shows separate read-only extras, escapes their content and respects both switches without mutating history', () => {
  const plan = { story_status: { title: '现场' }, director_comment: ['retired commentary'],
    parallel_scene: { title: '<另一幕>', content: '第一段\n第二段<script>' },
    interlude: { type: 'phone', owner: '<同事>', title: '未读消息', content: '发来一句问候。' } };
  const before = JSON.stringify(plan), { c } = fixture(plan);
  const html = c.renderDashboardTab();
  assert.match(html, /未映之幕/); assert.match(html, /幕间拾趣/); assert.doesNotMatch(html, /平行番外/);
  assert.doesNotMatch(html, /<同事>/); assert.match(html, /<p>第一段<br>第二段&lt;script&gt;<\/p>/);
  assert.doesNotMatch(html, /&lt;另一幕&gt;|data-director-memory-review|临时查阅/);
  assert.match(html, /<h4>未读消息<\/h4>/, 'only parallel story subtitles are removed');
  assert.doesNotMatch(html, /众声|retired commentary|<script>|sd-inject|sd-world-media-entry/);
  c.settings.interludeEnabled = false;
  assert.doesNotMatch(c.renderDashboardTab(), /幕间拾趣|发来一句问候/);
  c.settings.parallelSceneEnabled = false;
  assert.doesNotMatch(c.renderDashboardTab(), /未映之幕|第一段/);
  assert.equal(JSON.stringify(plan), before);
  assert.doesNotMatch(c.renderDirectorExtraCard({ type: 'wrong', content: 'invalid' }, 'interlude'), /invalid/);
});

test('rehearsals expose three independently selectable paragraphs with an explicit subject and no whole-card checkbox', () => {
  const { c } = fixture({ quests: [{ title: '门前的来客', subject: '邮差', description: '邮差带来一封无人领取的信。', trigger: '愿意停下来听他说明。',
    objective: 'old objective', reward: 'old reward', priority: 'high', type: 'main', status: 'active', deadline: '明早', inject_prompt: '门边有人询问信件的主人。' }] });
  const html = c.renderTasksNodesTab();
  assert.match(html, /预演/); assert.match(html, /邮差带来/); assert.match(html, /发生条件/);
  assert.equal((html.match(/data-director-paragraph /g) || []).length, 3);
  assert.match(html, /data-subject="邮差"/); assert.match(html, /role="button" tabindex="0" aria-pressed="false"/);
  assert.doesNotMatch(html, /写入输入框|sd-select-inject|class="sd-btn sd-inject"/);
  assert.doesNotMatch(section('bindActiveTabEvents'), /querySelectorAll\('\.sd-inject'\)/);
  assert.doesNotMatch(html, /任务|奖励|收获|优先级|期限|old objective|old reward|>main<|>active</);
  assert.match(html, /时机/);
  assert.equal(QIANMU_HIVE_COMMANDS.find(item => item.id === 'tasksnodes').label, '预演');
});

test('fate card presents near then far prose without task headings and reads old summaries without rewriting them', () => {
  const plan = { story_status: { title: '街角的分岔', summary: 'OLD_SUMMARY', current_stage: 'OLD_STAGE', mood: 'OLD_MOOD',
    cycle: '黄昏', directions: [{ horizon: 'far', title: '共同修缮', content: '几家店铺各让出一天人手，旧街开始重新接纳夜客。' }, { horizon: 'near', title: '账本换了主人', content: '学徒将旧账交还家人，积年的生意开始转向。' }] } };
  const { c } = fixture(plan), original = JSON.stringify(plan);
  const html = c.renderDashboardTab();
  assert.equal((html.match(/class="sd-director-direction"/g) || []).length, 2);
  assert.match(html, /<h3>命运之脉<\/h3>/); assert.match(html, /sd-fate-time">黄昏/);
  assert.ok(html.indexOf('学徒将旧账') < html.indexOf('几家店铺'));
  assert.doesNotMatch(html, /共同修缮|账本换了主人|OLD_SUMMARY|OLD_STAGE|OLD_MOOD|阶段：|氛围：/);
  assert.equal(JSON.stringify(plan), original);
  delete plan.story_status.directions;
  assert.match(c.renderDashboardTab(), /OLD_SUMMARY/);
  assert.equal(plan.story_status.current_stage, 'OLD_STAGE');
});

test('paragraph drafts retain original prose in display order without planning labels', () => {
  const { c } = fixture(null);
  const fields = c.directorItemParagraphs({ description: '正文已有称呼不可用来猜姓名', trigger: '完成取证后', inject_prompt: '递交报告。' }, 'quest');
  for (const order of [2, 0, 1]) c.injectSelection.set(`part-${order}`, { cardId: 'quest-one', subject: '邵宁', order, ...fields[order] });
  c.injectSelection.set('old-whole-card', '旧世界原文');
  const text = c.collectDirectorSelectedText();
  assert.deepEqual(Array.from(text), ['递交报告。', '完成取证后', '正文已有称呼不可用来猜姓名', '旧世界原文']);
  assert.doesNotMatch(text.join('\n'), /【邵宁】|情境：|发生条件：|落笔：/);
  c.injectSelection.clear();
  const cardId = 'quest-0-one';
  for (const index of [1, 2]) c.injectSelection.set(`${cardId}:paragraph:${fields[index].key}`, { cardId, subject: '邵宁', order: index, text: fields[index].text });
  const selectedHtml = c.renderItemCard({ subject: '邵宁', description: '正文已有称呼不可用来猜姓名', trigger: '完成取证后', inject_prompt: '递交报告。' }, 'quest', 0);
  assert.match(selectedHtml, /data-selection-order="1"/);
  assert.match(selectedHtml, /data-selection-order="2"/);
  assert.match(c.renderItemCard({ title: '门口的旧信', description: '甲和乙在说话。' }, 'quest', 0), /data-subject="事项：门口的旧信"/);
  const npcHtml = c.renderItemCard({ name: '邵宁', next_action: '递交报告。' }, 'npc', 0);
  assert.match(npcHtml, /data-subject="邵宁"/);
  assert.match(npcHtml, /data-text="【邵宁】递交报告。"/);
  assert.doesNotMatch(c.renderItemCard({ subject: '邵宁', description: '递交报告。' }, 'quest', 0, true), /data-director-paragraph|role="button"|tabindex|sd-select-inject/);
  const duplicate = c.directorItemParagraphs({ description: '同一段', inject_prompt: '同一段' }, 'quest');
  assert.equal(duplicate.length, 1);
});

test('character paragraph order is summarized in the card header without an inline marker', () => {
  const { c } = fixture(null);
  const item = { name: '陈晖', content: '他把两份记录放在桌上。', inject_prompt: '他在页脚写下新的日期。' };
  const cardId = 'character-0-陈晖';
  c.injectSelection.set(`${cardId}:paragraph:scene`, { cardId, text: item.content });
  c.injectSelection.set(`${cardId}:paragraph:draft`, { cardId, text: item.inject_prompt });
  const html = c.renderItemCard(item, 'character', 0);
  assert.match(html, /class="sd-selection-order-card"[^>]*data-selection-card-id="character-0-陈晖"[^>]*>1、2<\/span>/);
  assert.match(html, /class="sd-director-paragraph[^\"]*"[^>]*data-selection-order="1"/);
  assert.match(html, /class="sd-director-paragraph[^\"]*"[^>]*data-selection-order="2"/);
  assert.match(html, /sd-item-character/);
  assert.match(styles, /\.sd-item-character \.sd-director-paragraph\[data-selection-order\][^}]*display:\s*none/);
});

test('character life and other people are independent sections, with distinct selection ids and legacy world reading retained', () => {
  const plan = { character_dynamics: [{ name: '陈晖', title: '交接', content: '他把两份记录放在同事面前。' }],
    npc_updates: [{ title: '交接', name: '邻居', content: '她收起暂未寄出的信。' }], world_updates: [] };
  const { c, links } = fixture(plan);
  const html = c.renderCastWorldFront();
  assert.match(html, /此间一人/); assert.match(html, /其他人物动向/); assert.match(html, /他把两份记录/); assert.match(html, /暂未寄出/);
  assert.match(html, /data-id="character-0-/); assert.match(html, /data-id="npc-0-/);
  assert.match(html, /sd-character-names">陈晖/); assert.doesNotMatch(html, /\d+ 条<|sd-director-paragraph-label">动向</);
  assert.doesNotMatch(html, /世界回声/); assert.ok(links.every(item => item.field !== undefined));
  plan.world_updates = [{ title: '旧记录', content: '仍可阅读的历史世界记录' }];
  assert.match(c.renderCastWorldFront(), /仍可阅读的历史世界记录/);
  assert.equal(plan.character_dynamics.length, 1);
});

test('ripples keep full consequences and do not manufacture extra nodes by splitting natural connective words', () => {
  const chain = '邮路改道，进而让原本错开的两班车在桥头相遇。'.repeat(5), { c } = fixture(null);
  const html = c.renderChainReactionsCard({ chain_reactions: [{ spark: '一座桥暂停通行', chain }] });
  assert.match(html, /<b>涟漪<\/b>/); assert.ok(html.replace(/<[^>]+>/g, '').includes(chain));
  assert.match(html, /class="sd-chain-link-head"><span class="sd-chain-link" aria-hidden="true">→<\/span>邮路/);
  assert.match(html, /sd-chain-node sd-chain-node-spark" data-chain-depth="0"/);
  assert.match(html, /sd-chain-node" data-chain-depth="1"/);
  assert.equal((html.match(/sd-chain-node(?: |")/g) || []).length, 2);
  assert.doesNotMatch(html, /因果链|世界自行流转的连锁/);
});

test('each ripple marks node depth for per-origin emphasis and theme skins retain node gradients', () => {
  const { c } = fixture(null);
  const html = c.renderChainReactionsCard({ story_status: { cycle: '夜间', title: '三条传播' }, chain_reactions: [
    { spark: '甲条起点', chain: '甲一 → 甲二 → 甲三' },
    { spark: '乙条起点', chain: '乙一 → 乙二 → 乙三' },
    { spark: '丙条起点', chain: '丙一 → 丙二 → 丙三' },
  ] });
  assert.equal((html.match(/data-chain-tone="[012]"/g) || []).length, 3);
  assert.equal(new Set([...html.matchAll(/data-chain-tone="([012])"/g)].map(match => match[1])).size, 3,
    'three ripple rows receive distinct tone assignments');
  for (const depth of [0, 1, 2, 3]) assert.equal((html.match(new RegExp(`data-chain-depth="${depth}"`, 'g')) || []).length, 3,
    `each ripple exposes depth ${depth}`);
  assert.match(styles, /\.sd-chain-node-spark\s*\{[^}]*--sd-chain-node-fill:\s*31%/);
  assert.match(styles, /\.sd-chain-node\[data-chain-depth="2"\]\s*\{[^}]*--sd-chain-node-fill:\s*11%/);
  assert.match(styles, /\.sd-chain-node\[data-chain-depth="3"\]\s*\{[^}]*--sd-chain-node-fill:\s*7%/);
  assert.match(styles, /\.sd-chain-link\s*\{[^}]*color:\s*var\(--sd-chain-tone\)/);
  assert.match(skinStyles, /#story-director-modal\[data-qm-theme\] \.sd-chain-item\s*\{[^}]*linear-gradient/,
    'editorial and glass override the rail without removing the gradient');
  assert.doesNotMatch(skinStyles, /:is\(\.sd-item-card, \.sd-chain-item, \.sd-relus-row\)[^}]*background:[^}]*!important/,
    'theme skins must not let a generic nested-card background erase ripple gradients');
});

test('ripples put the strongest gradient on each chain origin and preserve it in editorial and glass skins', () => {
  assert.match(styles, /\.sd-chain-node-spark\s*\{[^}]*--sd-chain-node-fill:\s*31%[^}]*--sd-chain-node-tail:\s*15%/);
  assert.match(styles, /\.sd-chain-node\[data-chain-depth="2"\]\s*\{[^}]*--sd-chain-node-fill:\s*11%/);
  assert.match(styles, /\.sd-chain-link\s*\{[^}]*color:\s*var\(--sd-chain-tone\)/);
  assert.match(skinStyles, /#story-director-modal\[data-qm-theme\] \.sd-chain-item\s*\{[^}]*background:\s*linear-gradient\([^}]*var\(--sd-chain-tone\)/s);
  assert.doesNotMatch(skinStyles, /:is\(\.sd-item-card, \.sd-chain-item, \.sd-relus-row\)\s*\{[^}]*background:/s);
});

test('derivative switches are checked by default and each immediately saves only its own preference', () => {
  const { c } = fixture(null);
  const html = c.renderDirectorSettingsTab();
  assert.match(html, /class="sd-parallel-scene-enabled" checked/);
  assert.match(html, /class="sd-interlude-enabled" checked/);
  c.settings.interludeEnabled = false;
  assert.doesNotMatch(c.renderDirectorSettingsTab(), /class="sd-interlude-enabled" checked/);
  const handlers = new Map(), messages = []; let saves = 0;
  c.root = { querySelector: selector => ({ addEventListener: (type, run) => handlers.set(selector, run) }) };
  c.saveSettings = () => saves++;
  c.toast = message => messages.push(message);
  const start = source.indexOf("  root.querySelector('.sd-parallel-scene-enabled')?.addEventListener");
  const end = source.indexOf("  root.querySelector('.sd-geopolitics-enabled')?.addEventListener", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), c);
  handlers.get('.sd-parallel-scene-enabled')({ target: { checked: false } });
  assert.equal(c.settings.parallelSceneEnabled, false); assert.equal(c.settings.interludeEnabled, false);
  handlers.get('.sd-interlude-enabled')({ target: { checked: true } });
  assert.equal(c.settings.interludeEnabled, true); assert.equal(c.settings.parallelSceneEnabled, false);
  assert.equal(saves, 2); assert.deepEqual(messages, ['未映之幕已关闭。', '幕间拾趣已开启。']);
});

test('newcomer state updates every button and clearing current plan never deletes history or requests confirmation', async () => {
  const events = new Map(), attributes = new Map(), active = new Map();
  const button = { addEventListener: (type, fn) => events.set('newcomer', fn), classList: { toggle: (key, value) => active.set(key, value) }, setAttribute: (key, value) => attributes.set(key, value) };
  const history = [{ id: 'saved', plan: { title: 'still available' } }], store = { plan: { title: 'current' }, history, injectOverride: 'override' };
  let confirms = 0, saves = 0, injected = 0;
  const c = vm.createContext({ settings: { newcomerMode: false }, busy: false,
    bindCreativeSocialEvents() {}, bindDirectorSelectionEvents() {}, saveSettings() {}, toast() {},
    getChatStore: () => store, saveMetadata: async () => saves++, applyDirectorInjection: async () => injected++, renderModal() {},
    resetDirectorNarrativeBridge() {}, resetCreativeSocialState() {}, injectSelection: new Map([['old', 'selected']]),
    confirmDialog: async () => { confirms++; return false; },
  });
  vm.runInContext(section('renderGenerateRow') + section('bindDirectorReadingEvents'), c);
  const root = { querySelectorAll: selector => selector === '.sd-newcomer-toggle' ? [button, { ...button }] : [],
    querySelector: selector => selector === '.sd-clear-plan' ? { addEventListener: (type, fn) => events.set('clear', fn) } : null };
  c.bindDirectorReadingEvents(root); events.get('newcomer')();
  assert.equal(c.settings.newcomerMode, true); assert.equal(attributes.get('aria-pressed'), 'true'); assert.equal(active.get('active'), true);
  assert.match(c.renderGenerateRow(), /aria-pressed="true"/);
  await events.get('clear')();
  assert.equal(confirms, 0); assert.equal(store.plan, null); assert.equal(store.history, history); assert.equal(history.length, 1);
  assert.equal(c.directorLiveLog, null);
  assert.equal(store.injectOverride, undefined); assert.equal(c.injectSelection.size, 0); assert.equal(saves, 1); assert.equal(injected, 1);
});

test('creative card typography and overflow remain scoped to the Qianmu modal and inherit theme tokens', () => {
  assert.match(styles, /#story-director-modal \.sd-director-extra-content\s*\{[^}]*var\(--sd-text\)[^}]*overflow-wrap:\s*anywhere/);
  assert.match(styles, /#story-director-modal \.sd-director-extra-content p\s*\{[^}]*text-indent:\s*2em/);
  assert.match(styles, /#story-director-modal \.sd-director-direction p::first-letter\s*\{[^}]*color:\s*var\(--sd-accent\)/);
  assert.match(styles, /#story-director-modal \.sd-director-direction \+ \.sd-director-direction::before\s*\{[^}]*background:\s*var\(--sd-border\)/);
  assert.match(styles, /#story-director-modal \.sd-chain-node\s*\{[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/);
  assert.match(styles, /#story-director-modal \.sd-derivative-options\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /#story-director-modal \.sd-selection-order-card\s*\{[^}]*color:\s*var\(--sd-accent\)[^}]*font-size:\s*\.78em/);
  assert.match(styles, /#story-director-modal \.sd-selection-order-card:empty\s*\{[^}]*display:\s*none/);
  assert.doesNotMatch(styles, /#story-director-modal \.sd-selection-order-card\s*\{[^}]*background(?:-color)?\s*:/);
  assert.doesNotMatch(styles, /#story-director-modal \.sd-director-paragraph\[data-selection-order\][^}]*padding-right/);
});

test('failed or stopped entries without a recorded request do not obscure the saved plan', () => {
  const plan = { story_status: { title: '已保存方案' } }, { c } = fixture(plan);
  c.directorLiveLog = { status: 'loading', response: '{"story_status":{"title":"未采纳片段"}}' };
  assert.match(c.renderDashboardTab(), /未采纳片段/); assert.doesNotMatch(c.renderDashboardTab(), /已保存方案/);
  for (const status of ['error', 'cancelled']) {
    c.directorLiveLog.status = status;
    assert.match(c.renderDashboardTab(), /已保存方案/); assert.doesNotMatch(c.renderDashboardTab(), /未采纳片段/);
  }
  plan.story_status.title = '载入的历史';
  assert.match(c.renderDashboardTab(), /载入的历史/);
});

test('failed and cancelled requests keep closed cards read-only with section-local missing notices', () => {
  const response = JSON.stringify({ story_status: { directions: [{ horizon: 'near', content: '命运片段仍然可读。' }] },
    quests: [{ title: '已收到预演', subject: '邮差', description: '预演片段仍然可读。' }],
    character_dynamics: [{ name: '陈晖', title: '已收到人物', content: '人物片段仍然可读。' }] }).slice(0, -1) + ',"interlude":{"type":"phone","messages":[';
  const { c } = fixture({ story_status: { title: '旧方案不应冒充本次结果' } });
  for (const [status, completion, expected] of [['error', undefined, '本栏未生成成功'], ['error', { finishReason: 'length' }, '回复截断'], ['cancelled', undefined, '']]) {
    c.directorLiveLog = { status, request: 'isolated request', response, completion,
      creativeOptions: { parallelSceneEnabled: true, interludeEnabled: true, worldChatterEnabled: true, geopoliticsEnabled: true },
      quality: { issues: ['story_status', 'quests', 'character_dynamics', 'npc_updates', 'chain_reactions', 'relation_undercurrents',
        'parallel_scene', 'interlude', 'world_chatter', 'factions', 'world_events'].map(field => ({ field, missing: 1 })) } };
    const dashboard = c.renderDashboardTab(), tasks = c.renderTasksNodesTab(), world = c.renderCastWorldFront();
    assert.match(dashboard, /命运片段仍然可读/); assert.match(tasks, /预演片段仍然可读/); assert.match(world, /人物片段仍然可读/);
    for (const html of [dashboard, tasks, world]) {
      if (expected) assert.ok(html.includes(expected));
      else assert.doesNotMatch(html, /已停止，本栏未完整生成|本栏未生成成功|回复截断/);
      assert.doesNotMatch(html, /旧方案不应冒充本次结果|data-director-paragraph|sd-select-inject|sd-world-media-entry|正在推演|sd-director-live/);
      if (!completion) assert.doesNotMatch(html, /回复截断/);
    }
    if (status !== 'cancelled') {
      assert.match(dashboard, /data-director-section-status="story_status"/);
      assert.match(tasks, /data-director-section-status="chain_reactions"/);
      assert.match(world, /data-director-section-status="npc_updates"/);
    }
    const geo = renderDirectorLive(c.directorLiveLog, { fields: ['factions', 'faction_relations', 'world_events'] });
    if (expected) assert.ok(geo.includes(expected));
    else assert.doesNotMatch(geo, /已停止，本栏未完整生成|本栏未生成成功|回复截断/);
    assert.doesNotMatch(geo, /sd-inject|正在推演/);
  }
});

test('disabled derivative sections stay absent on failed requests even when the model returns unsolicited cards', () => {
  const { c } = fixture(null, { parallelSceneEnabled: true, interludeEnabled: true, worldChatterEnabled: true, geopoliticsEnabled: true });
  c.directorLiveLog = { status: 'error', request: 'isolated request', creativeOptions: { parallelSceneEnabled: false, interludeEnabled: false, worldChatterEnabled: false, geopoliticsEnabled: false },
    response: JSON.stringify({ parallel_scene: { content: '不得展示番外' }, interlude: { type: 'phone', content: '不得展示趣味' }, world_chatter: [{ who: '路人', text: '不得展示群声' }], factions: [{ name: '不得展示势力' }] }) };
  assert.doesNotMatch(c.renderDashboardTab(), /未映之幕|幕间拾趣|不得展示/);
  assert.doesNotMatch(c.renderCastWorldFront(), /尘寰群生|不得展示/);
  assert.equal(renderDirectorLive(c.directorLiveLog, { fields: ['factions', 'faction_relations', 'world_events'] }), '');
});

test('optional empty legacy world and faction relations do not become spurious failure notices', () => {
  const plan = { faction_relations: [], world_updates: [], quests: [], _generation: { status: 'error', quality: { issues: [] } } };
  for (const field of ['faction_relations', 'world_updates', 'quests']) assert.equal(directorSectionStatus(plan, field), '');
  delete plan._generation.quality;
  for (const field of ['faction_relations', 'world_updates']) assert.equal(directorSectionStatus(plan, field), '');
  assert.match(directorSectionStatus(plan, 'quests'), /本栏未生成成功/);
  plan._generation.quality = { issues: [{ field: 'faction_relations', reason: 'invalid relation' }] };
  assert.match(directorSectionStatus(plan, 'faction_relations'), /本栏未生成成功/);
});

test('stream refresh binds only reading actions and preserves the world shell instead of rerunning global tab teardown', () => {
  const refresh = section('refreshDirectorLiveUI'), actions = section('bindDirectorReadingEvents');
  assert.match(refresh, /bindDirectorReadingEvents\(host\)/);
  assert.doesNotMatch(refresh, /bindActiveTabEvents\(host\)|bindCoreadTabEvents|bindTheaterTabEvents/);
  assert.match(refresh, /worldBody\.innerHTML/);
  assert.doesNotMatch(actions, /unmountReaderPortal|document\.addEventListener|window\.addEventListener|bindCoreadTabEvents/);
  assert.match(section('bindActiveTabEvents'), /bindDirectorReadingEvents\(root\)/);
  assert.equal((source.match(/root\.querySelectorAll\('\.sd-generate-main'\)/g) || []).length, 1);
});
