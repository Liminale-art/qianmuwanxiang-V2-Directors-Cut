import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { projectCreativeContinuity } from '../qianmu-creative-contract.js';
import { selectCreativeOptions } from '../qianmu-creative-runtime.js';
import { hashText } from '../qianmu-storyboard-utils.js';

const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const between = (start, end) => {
    const begin = entry.indexOf(start), finish = entry.indexOf(end, begin + start.length);
    assert.ok(begin >= 0 && finish > begin, `source boundaries: ${start}`);
    return entry.slice(begin, finish);
};
const fingerprintSource = between('function directorSourceFingerprint()', 'async function buildPrompt(');
const promptSource = between('async function buildPrompt(', 'function buildGeopoliticsArchiveSegment(');

function fixture() {
    const store = { blueprint: '审定剧本', plan: { story_status: { title: '当前主线' }, quests: [{ title: '际遇', description: '访客带来旧日来信。' }],
        parallel_scene: { title: '平行世界', content: 'SECRET_PARALLEL' }, interlude: { type: 'theater', title: '趣味', content: 'SECRET_INTERLUDE' },
        director_comment: ['SECRET_VOICES'] }, factions: [{ id: 'f1', name: '警局' }], factionRelations: [], worldEvents: [] };
    const context = { chat: [{ name: '林队', mes: '今天仍在查案', is_user: false }], name1: '读者', mainApi: 'openai',
        chatCompletionSettings: { model: 'host-a', chat_completion_source: 'custom' }, getChatCompletionModel: () => context.chatCompletionSettings.model };
    const settings = { blueprint: '审定剧本', systemPrompt: '当前身份', outputSchemaText: 'default schema', contextBudget: 0,
        selectedPresetItems: { writing: { p1: true } }, selectedWorldBookItemsByChat: { chat: { world: { w1: true } } },
        contextOptions: { includeChatHistory: true, contextDepth: 5 }, geopoliticsEnabled: true, worldChatterEnabled: false,
        parallelSceneEnabled: true, interludeEnabled: true, newcomerMode: false, providerMode: 'external' };
    const scan = { presetScannedAt: 'today', worldScannedAt: 'today', presets: { writing: [{ id: 'p1', content: '写作来源' }] },
        worldBooks: { world: [{ id: 'w1', content: '城市世界' }] } };
    const state = { memoryFingerprint: 'memory-a', memoryStatus: 'ready', presetNames: ['writing'], bookNames: ['world'],
        char: '林队', persona: '读者', charDescription: '刑警', personaDescription: '记者', onWorld: null, onPreset: null };
    const c = { settings, contextScanCache: scan, hashText, projectCreativeContinuity, selectCreativeOptions,
        ctx: () => context, getChatStore: () => store, getChatKey: () => 'chat',
        getCharacterName: () => state.char, getPersonaName: () => state.persona,
        getCharacterDescription: () => state.charDescription, getPersonaDescription: () => state.personaDescription,
        getSelectedPresetNames: () => state.presetNames, getSelectedWorldBookNames: () => state.bookNames,
        directorMemorySnapshot: () => ({ snapshot: { fingerprint: state.memoryFingerprint }, text: '完整的有效记忆', status: state.memoryStatus, diagnostics: [] }),
        directorHistorySelection: () => ({ text: context.chat.map(item => item.mes).join('\n'), recentStartIndex: 0 }),
        refreshPresets: async () => {}, refreshWorldBooks: async () => {}, prepareDirectorMemoryHost: async () => {}, resolveMacro: async value => value,
        buildWorldContextText: async () => { await state.onWorld?.(); return '世界资料'; },
        buildPresetContextText: async () => { await state.onPreset?.(); return '预设资料'; },
        buildGeopoliticsArchiveSegment: () => '有效组织延续资料', estimateTokens: value => value.length,
        creativeSectionGuidance: () => '栏目引导', createCreativeSchema: () => '当前输出协议',
        DEFAULT_BLUEPRINT: '默认剧本', JSON_SCHEMA_TEXT: 'default schema', console,
    };
    vm.createContext(c); vm.runInContext(fingerprintSource + '\n' + promptSource, c);
    return { c, context, store, settings, scan, state };
}

const changes = {
    '正文原句': e => { e.context.chat[0].mes += '改写'; },
    '当前剧本': e => { e.store.blueprint += '改写'; },
    '千幕身份': e => { e.settings.systemPrompt += '改写'; },
    '当前成品记忆': e => { e.state.memoryFingerprint = 'memory-b'; },
    '已选预设名': e => { e.state.presetNames = []; },
    '预设勾选': e => { e.settings.selectedPresetItems.writing.p1 = false; },
    '预设原文': e => { e.scan.presets.writing[0].content += '改写'; },
    '已选世界书名': e => { e.state.bookNames = []; },
    '世界书勾选': e => { e.settings.selectedWorldBookItemsByChat.chat.world.w1 = false; },
    '世界书原文': e => { e.scan.worldBooks.world[0].content += '改写'; },
    '角色设定': e => { e.state.charDescription += '改写'; },
    '用户设定': e => { e.state.personaDescription += '改写'; },
    '正文取材范围': e => { e.settings.contextOptions.contextDepth = 2; },
    '栏目开关': e => { e.settings.interludeEnabled = false; },
    '载入主线历史': e => { e.store.plan.story_status.title = '用户重新选择的历史'; },
    '清空当前推演': e => { e.store.plan = null; },
    '世界格局修订': e => { e.store.factions[0].name = '更新后的组织'; },
    '预算调整': e => { e.settings.contextBudget = 1; },
};
for (const [name, change] of Object.entries(changes)) {
    test(`actual input fingerprint changes on ${name}`, () => {
        const e = fixture(), before = e.c.directorSourceFingerprint(); change(e);
        assert.notEqual(e.c.directorSourceFingerprint(), before);
    });
}
for (const name of ['正文原句', '当前成品记忆', '预设勾选', '预设原文', '载入主线历史', '世界格局修订']) {
    test(`actual async preparation rejects ${name} changes rather than mixing two snapshots`, async () => {
        const e = fixture(); e.state.onPreset = () => changes[name](e);
        await assert.rejects(e.c.buildPrompt({}), /准备期间已变化/);
    });
}
test('actual prompt keeps mainline continuity but never forwards parallel, fun or legacy voices', async () => {
    const e = fixture(), run = {}, prompt = await e.c.buildPrompt(run);
    assert.match(prompt, /当前主线|访客带来旧日来信/);
    assert.doesNotMatch(prompt, /SECRET_PARALLEL|SECRET_INTERLUDE|SECRET_VOICES/);
    assert.equal(run.sourceFingerprint, e.c.directorSourceFingerprint());
    assert.equal(run.memoryStatus.status, 'ready');
    assert.ok(Object.isFrozen(run.creativeOptions));
});
test('editing a read-only side story does not dirty the mainline input snapshot', () => {
    const e = fixture(), before = e.c.directorSourceFingerprint();
    e.store.plan.parallel_scene.content += '修改'; e.store.plan.interlude.content += '修改';
    assert.equal(e.c.directorSourceFingerprint(), before);
});
test('over-budget reference input fails intact before model submission instead of cutting memory', async () => {
    const e = fixture(); e.settings.contextBudget = 1;
    await assert.rejects(e.c.buildPrompt({}), /未裁切、未提交/);
});
for (const field of ['model', 'chat_completion_source']) test(`actual host-model ${field} changes are part of request fingerprint`, () => {
    const e = fixture(); e.settings.providerMode = 'sillytavern';
    const before = e.c.directorSourceFingerprint();
    e.context.chatCompletionSettings[field] += '-changed';
    assert.notEqual(e.c.directorSourceFingerprint(), before);
});
test('host APIs and extension disable flags are read live, not inferred from residual settings', () => {
    const source = between('function directorMemoryPluginAvailable()', 'function directorSourceFingerprint()');
    const context = { extensionSettings: { gagaDogSummary: { workshopEnabled: true }, disabledExtensions: [] }, chatMetadata: {}, chat: [] };
    const c = { directorMemoryHostModule: null, ctx: () => context, getChatKey: () => 'chat',
        directorHistorySelection: () => ({ text: '当前正文', recentStartIndex: 2 }), readGagaMemoryContext: options => options };
    vm.createContext(c); vm.runInContext(source, c);
    assert.equal(c.directorMemorySnapshot().pluginAvailable, false);
    c.directorMemoryHostModule = { extensionNames: ['third-party/gaga-dog-summary'] };
    assert.equal(c.directorMemorySnapshot().pluginAvailable, true);
    context.extensionSettings.disabledExtensions.push('third-party/gaga-dog-summary');
    assert.equal(c.directorMemorySnapshot().pluginAvailable, false);
    context.extensionSettings.disabledExtensions = [];
    c.directorMemoryHostModule.extensionNames = [];
    assert.equal(c.directorMemorySnapshot().pluginAvailable, false);
    let installed = { name: 'third-party/gaga-dog-summary', enabled: true };
    c.directorMemoryHostModule = { findExtension: () => installed };
    assert.equal(c.directorMemorySnapshot().pluginAvailable, true);
    installed.enabled = false; assert.equal(c.directorMemorySnapshot().pluginAvailable, false);
    installed = null; assert.equal(c.directorMemorySnapshot().pluginAvailable, false);
});
test('actual body injection includes CHAR continuity and never emits read-only extras', () => {
    const source = between('function buildPlanDigest(', 'function currentDirectorInjectionText(');
    const c = { settings: { injectSections: {}, geopoliticsEnabled: false },
        INJ_LEN: { label: 60, line: 150, parties: 100, chain: 240, arc: 120 },
        snip: (value, length) => String(value || '').slice(0, length), buildGeopoliticsDigest: () => '' };
    vm.createContext(c); vm.runInContext(source, c);
    const plan = { character_dynamics: [{ title: '独立生活', content: 'CHAR 正在和同事复核一份证词。' }],
        npc_updates: [{ name: '小陈', next_action: '接到自己的家人来电' }],
        parallel_scene: { content: 'SECRET_PARALLEL' }, interlude: { content: 'SECRET_INTERLUDE' }, world_chatter: [{ text: 'SECRET_CHATTER' }] };
    const result = c.buildPlanDigest(plan);
    assert.match(result, /此间一人|CHAR 正在和同事复核一份证词/);
    assert.match(result, /小陈|家人来电/);
    assert.doesNotMatch(result, /SECRET_/);
    c.settings.injectSections.npc = false;
    assert.doesNotMatch(c.buildPlanDigest(plan), /CHAR 正在和同事复核一份证词|家人来电/);
});
