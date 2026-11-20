// 心迹页的后端：数据规则、日记整理的请求与解析、心迹的摘取，以及从总结到页面数据的整条链。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createYimuStore} from '../yimu/server-store.mjs';
import {registerYimuRoutes} from '../yimu/server-plugin.mjs';
import {createApi} from '../yimu/client.mjs';
import {createController} from '../yimu/runtime.mjs';
import {createHost, HEART_PROMPT_KEY} from '../yimu/host.mjs';
import {createDocument, applyOperation, validateDocument, DEFAULTS, validateSettings} from '../yimu/contract.mjs';
import {buildPlan} from '../yimu/core.mjs';
import {sureOf, mergeHeart, carryHeart, validateHeart} from '../yimu/heart-contract.mjs';
import {diaryWork, diaryPrompt, parseDiary, thoughtDue, thoughtRequest, takeThought, heartInjection, HEART_TAG} from '../yimu/heart-core.mjs';
import {DEFAULT_PROMPTS, composePrompt, heartNotePrompt, validatePromptConfig} from '../yimu/prompt-settings.mjs';
import {heartData} from '../yimu/heart-view.mjs';

const clone = value => structuredClone(value);
const binding = {avatar: 'Heart.png', file: 'Heart-chat', integrity: 'heart_identity'};
const DAY = 86400000, T0 = new Date(2026, 10, 1, 9).getTime();
const withTraces = days => {
    let doc = {...createDocument(binding), enabled: true};
    days.forEach((day, index) => {
        doc = applyOperation(doc, {id: `obs_${index}`, type: 'observe', range: {start: index + 1, end: index + 1}, at: T0 + day * DAY,
            items: [{about: '小满', text: `第 ${index + 1} 次看见她点了辣的。`, floor: index + 1}]}).document;
    });
    return doc;
};
const refs = doc => doc.observations.filter(item => !item.used).map(item => ({id: item.id, day: `d${Math.round((item.at - T0) / DAY)}`}));

test('an impression only firms up across different days: 3 days to begin, 6 to be sure; same-day sightings count once', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map(sureOf), [0, 0, 0, 1, 2, 2, 3, 3]);
    let doc = withTraces([0, 0, 1]);
    doc = applyOperation(doc, {id: 'diary_1', type: 'heartDiary', at: T0 + 2 * DAY, impressions: [{about: '小满', text: '她好像离不开辣。', traces: refs(doc)}], events: [], used: doc.observations.map(item => item.id)}).document;
    const first = doc.heart.impressions[0];
    assert.equal(first.days.length, 2, '同一天看见两次只算一个日子');
    assert.ok(doc.observations.every(item => item.used === true), '看过的痕迹不会再整理一遍');
    // 往后几个日子里又看见：沿用同一条印象，日子累加；改口时留下原先的说法。
    for (const [index, day] of [2, 3, 4, 5].entries()) {
        doc = applyOperation(doc, {id: `obs_more_${index}`, type: 'observe', range: {start: 10 + index, end: 10 + index}, at: T0 + day * DAY, items: [{about: '小满', text: `又一次，第 ${day} 天。`, floor: 10 + index}]}).document;
    }
    doc = applyOperation(doc, {id: 'diary_2', type: 'heartDiary', at: T0 + 6 * DAY, events: [],
        impressions: [{id: first.id, about: '小满', text: '她离不开辣，但只在心情好的时候。', was: '她好像离不开辣。', traces: refs(doc)}]}).document;
    const grown = doc.heart.impressions[0];
    assert.equal(doc.heart.impressions.length, 1); assert.equal(grown.days.length, 6); assert.equal(sureOf(grown.days.length), 3);
    assert.equal(grown.was, '她好像离不开辣。'); assert.equal(grown.updatedAt, T0 + 6 * DAY);
    validateDocument(doc);
});

test('a note from the same floor replaces the earlier one; an unwritten round still moves the mark; clearing memory clears the page', () => {
    let doc = {...createDocument(binding), enabled: true};
    doc = applyOperation(doc, {id: 't1', type: 'heartThought', floor: 40, at: T0, item: {group: 'you', about: '小满', text: '她比看上去更怕冷场。'}}).document;
    doc = applyOperation(doc, {id: 't2', type: 'heartThought', floor: 40, at: T0 + 1, item: {group: 'self', about: '自己', text: '我好像开始等她的消息了。'}}).document;
    assert.deepEqual(doc.heart.thoughts.map(item => [item.floor, item.group, item.text]), [[40, 'self', '我好像开始等她的消息了。']]);
    doc = applyOperation(doc, {id: 't3', type: 'heartThought', floor: 75, at: T0 + 2}).document;
    assert.equal(doc.heart.thoughts.length, 1); assert.equal(doc.heart.thoughtFloor, 75, '这次没写也记下问过');
    doc = applyOperation(doc, {id: 'e1', type: 'heartDiary', at: T0 + 3, impressions: [], eventFloor: 30,
        events: [{title: '第一次同桌', text: '两人第一次一起吃饭。', floor: 3, date: '三月初四'}, {title: '第一次同桌', text: '重复的不再写。', floor: 3}]}).document;
    assert.deepEqual(doc.heart.events.map(item => [item.title, item.floor, item.date]), [['第一次同桌', 3, '三月初四']]);
    assert.equal(doc.heart.eventFloor, 30);
    const removed = applyOperation(doc, {id: 'r1', type: 'heartRemove', kind: 'event', itemId: doc.heart.events[0].id, at: T0 + 4}).document;
    assert.equal(removed.heart.events.length, 0);
    assert.throws(() => applyOperation(doc, {id: 'r2', type: 'heartRemove', kind: 'event', itemId: 'nope', at: T0}), /不在了/);
    const purged = applyOperation(doc, {id: 'p1', type: 'purge', scope: 'all', expectedRevision: doc.revision}).document;
    assert.equal(purged.heart, undefined); assert.equal(purged.observations, undefined);
});

test('backup merge keeps what is already there; a continued story carries impressions whole and only earlier notes and events', () => {
    const base = validateHeart({impressions: [], thoughts: [{id: 'a', group: 'you', about: '小满', text: '甲', floor: 5, at: 1}], events: [{id: 'e', title: '相遇', text: '乙', floor: 2, at: 1}], eventFloor: 20, thoughtFloor: 5});
    const extra = {impressions: [{id: 'i', about: '小满', text: '丙', days: [{day: 'd1', text: '丁', at: 1}], at: 1, updatedAt: 1}],
        thoughts: [{id: 'a', group: 'self', about: '自己', text: '不该覆盖', floor: 5, at: 9}, {id: 'b', group: 'self', about: '自己', text: '戊', floor: 60, at: 2}], events: [], eventFloor: 80, thoughtFloor: 60};
    const merged = mergeHeart(base, extra);
    assert.deepEqual(merged.thoughts.map(item => [item.id, item.text]), [['a', '甲'], ['b', '戊']]);
    assert.equal(merged.impressions.length, 1); assert.equal(merged.eventFloor, 80);
    const carried = carryHeart(merged, 10);
    assert.deepEqual([carried.impressions.length, carried.thoughts.map(item => item.id), carried.events.length, carried.eventFloor, carried.thoughtFloor], [1, ['a'], 1, 10, 10]);
    assert.equal(carryHeart(undefined, 10), undefined);
});

test('the page settings: diary and chronicle on, heart notes and both injections off; numbers are bounded', () => {
    assert.deepEqual([DEFAULTS.diary, DEFAULTS.chronicle, DEFAULTS.diaryInject, DEFAULTS.thoughts, DEFAULTS.thoughtInject, DEFAULTS.diaryChars, DEFAULTS.thoughtChars, DEFAULTS.thoughtCooldown], [true, true, false, false, false, 60, 200, 30]);
    assert.deepEqual(validateSettings({thoughts: true, thoughtCooldown: 12, diaryChars: 80}), {thoughts: true, thoughtCooldown: 12, diaryChars: 80});
    assert.throws(() => validateSettings({thoughtCooldown: 0}), /超出范围/);
    assert.throws(() => validateSettings({diary: 'yes'}), /开关/);
});

test('the heart prompt group is editable like the others; the note for the main model never goes into the diary request', () => {
    const settings = {prompts: clone(DEFAULT_PROMPTS)};
    assert.deepEqual(DEFAULT_PROMPTS.groups.heart.map(item => item.name), ['观察日记', '关系年表', '心迹']);
    const diary = composePrompt(settings, 'heart', {protocol: 'P', data: 'D'});
    assert.ok(diary.includes('将零散的观察细节归拢为针对人物的私人印象') && diary.includes('锚定关系发展中的标志性时间节点'));
    assert.ok(!diary.includes('仅写给自己的私密心绪记录'));
    assert.ok(heartNotePrompt(settings).startsWith('正文撰写完毕后另起段落'));
    const off = clone(DEFAULT_PROMPTS); off.groups.heart.find(item => item.id === 'heart-note').enabled = false;
    assert.equal(heartNotePrompt({prompts: off}), '');
    // 早先存下的配置没有这一组：读到时补上默认的。
    const {heart, ...older} = clone(DEFAULT_PROMPTS.groups);
    assert.equal(validatePromptConfig({groups: older, presets: [], selectedPreset: ''}).groups.heart.length, 3);
});

test('a diary request offers unseen traces and unread slices; the reply is read item by item', () => {
    let doc = withTraces([0, 1]);
    doc.entries.push({id: 's1', kind: 'summary', status: 'active', text: '两人第一次一起吃饭。', source: {start: 1, end: 2, hashes: []}, scenes: [{date: '三月初四'}]},
        {id: 's2', kind: 'summary', status: 'deleted', text: '已删除。', source: {start: 3, end: 3, hashes: []}});
    const settings = {...DEFAULTS, prompts: clone(DEFAULT_PROMPTS)}, names = {char: '阿澈', user: '小满'};
    const work = diaryWork(doc, settings);
    assert.deepEqual([work.traces.length, work.slices.map(entry => entry.id)], [2, ['s1']]);
    const prompt = diaryPrompt(settings, names, work);
    assert.ok(prompt.includes('以阿澈第一人称视角') && !prompt.includes('{{char}}'), '名字在发送前换成实际的');
    assert.ok(prompt.includes('"n":1') && prompt.includes('三月初四') && prompt.includes('不超过60字'));
    const parsed = parseDiary(JSON.stringify({impressions: [{about: '小满', text: '她好像离不开辣。', traces: [1, 2, 2, 9]}, {about: '', text: '没有对象的丢掉', traces: [1]}, {id: 'ghost', about: '小满', text: '编号是编的、又没有新痕迹', traces: []}],
        events: [{title: '第一次同桌', text: '两人第一次一起吃饭。', floor: 2}, {title: '越界的', text: '楼层不在所给记忆里', floor: 30}]}), work);
    assert.deepEqual(parsed.impressions, [{about: '小满', text: '她好像离不开辣。', traces: work.traces.map(item => ({id: item.id, day: `2026-11-0${new Date(item.at).getDate()}`}))}]);
    assert.deepEqual(parsed.events, [{title: '第一次同桌', text: '两人第一次一起吃饭。', floor: 2, date: '三月初四'}]);
    assert.throws(() => parseDiary('不是 JSON', work), /未采用/);
    // 两项都关掉就没有可做的。
    assert.equal(diaryWork(doc, {...settings, diary: false, chronicle: false}), null);
    assert.deepEqual(diaryWork(doc, {...settings, chronicle: false}).slices, []);
});

test('a heart note is asked for only when it is due, and is lifted out of the reply', () => {
    const settings = {...DEFAULTS, thoughts: true, prompts: clone(DEFAULT_PROMPTS)}, names = {char: '阿澈', user: '小满'};
    const snapshot = floors => ({mainApi: 'openai', name: '阿澈', userName: '小满', messages: Array.from({length: floors}, () => ({mes: '……'}))});
    const stage = end => ({id: `st${end}`, kind: 'stage', status: 'active', text: '阶段', source: {ranges: [{start: 1, end}], parents: []}});
    const doc = {entries: [stage(20)]};
    assert.equal(thoughtDue(doc, settings, snapshot(20), 'normal'), null, '离上一则不够远');
    assert.deepEqual(thoughtDue(doc, settings, snapshot(29), 'normal'), {floor: 30});
    assert.equal(thoughtDue({entries: []}, settings, snapshot(60), 'normal'), null, '其间没有完成过阶段总结');
    assert.equal(thoughtDue(doc, {...settings, thoughts: false}, snapshot(60)), null);
    assert.equal(thoughtDue(doc, settings, {...snapshot(60), mainApi: 'textgenerationwebui'}), null, '只支持聊天补全');
    const written = {entries: [stage(20)], heart: {impressions: [], thoughts: [], events: [], eventFloor: 0, thoughtFloor: 30}};
    assert.equal(thoughtDue(written, settings, snapshot(45), 'normal'), null);
    assert.deepEqual(thoughtDue(written, settings, snapshot(30), 'swipe'), {floor: 30}, '同一层重新生成时照旧再要一次');
    assert.equal(thoughtDue({...written, entries: [stage(20)]}, settings, snapshot(70), 'normal'), null, '上一则之后没有新的阶段总结');
    assert.deepEqual(thoughtDue({...written, entries: [stage(20), stage(55)]}, settings, snapshot(70), 'normal'), {floor: 71});
    const ask = thoughtRequest(settings, names);
    assert.ok(ask.includes(`<${HEART_TAG} 对象=`) && ask.includes('不超过 200 字') && ask.includes('可围绕小满') && !ask.includes('{{'));
    const reply = `正文一段。\n\n<${HEART_TAG} 对象="小满">她比看上去更怕冷场。</${HEART_TAG}>`;
    assert.deepEqual(takeThought(reply, names), {item: {group: 'you', about: '小满', text: '她比看上去更怕冷场。'}, cleaned: '正文一段。'});
    assert.deepEqual(takeThought(`甲<${HEART_TAG} 对象="自己">我在等。</${HEART_TAG}>`, names).item, {group: 'self', about: '自己', text: '我在等。'});
    assert.deepEqual(takeThought(`甲<${HEART_TAG} 对象="《雪国》">读到这里我想起了她。</${HEART_TAG}>`, names).item.group, 'books');
    assert.deepEqual(takeThought(`甲<${HEART_TAG} 对象="店主">他记得她的口味。`, names), {item: {group: 'others', about: '店主', text: '他记得她的口味。'}, cleaned: '甲'}, '被截断、没有收尾标签也摘得走');
    assert.deepEqual(takeThought('没有这一段。', names), {item: null, cleaned: '没有这一段。'});
    assert.deepEqual(takeThought(`甲<${HEART_TAG}></${HEART_TAG}>`, names), {item: null, cleaned: '甲'}, '空的一段从正文里去掉，但不记');
});

test('injection is off unless switched on; it brings at most three impressions of people present and one note, respecting the callback cooldown', () => {
    const day = n => ({day: `d${n}`, text: '依据', at: n});
    const heart = {eventFloor: 0, thoughtFloor: 40, events: [],
        impressions: [{id: 'i1', about: '小满', text: '她离不开辣。', days: [1, 2, 3, 4, 5, 6].map(day), at: 1, updatedAt: 9},
            {id: 'i2', about: '小满', text: '还只看见两次的不带。', days: [1, 2].map(day), at: 1, updatedAt: 9},
            {id: 'i3', about: '店主', text: '他记得熟客的口味。', days: [1, 2, 3].map(day), at: 1, updatedAt: 9}],
        thoughts: [{id: 't1', group: 'others', about: '店主', text: '他大概也在留意她。', floor: 20, at: 1}, {id: 't2', group: 'you', about: '小满', text: '她比看上去更怕冷场。', floor: 40, at: 2}]};
    const snapshot = {name: '阿澈', userName: '小满', messages: [{mes: '很早以前提过店主。'}, {mes: '今天只有我们两个。'}, {mes: '嗯。'}, {mes: '走吧。'}]};
    assert.deepEqual(heartInjection({heart}, DEFAULTS, snapshot), {text: '', ids: []});
    const on = {...DEFAULTS, diaryInject: true, thoughtInject: true};
    const carried = heartInjection({heart}, on, snapshot);
    assert.ok(carried.text.startsWith('<yimu_heart>') && carried.text.includes('她离不开辣。') && carried.text.includes('"sure":"笃定"'));
    assert.ok(!carried.text.includes('还只看见两次') && !carried.text.includes('熟客'), '不成印象的、没出场的人不带');
    assert.ok(carried.text.includes('她比看上去更怕冷场。')); assert.deepEqual(carried.ids, ['heart:t2']);
    // 刚带过的那一则在冷却里：这一轮不带；也没有别的合适的，就只剩印象。
    const cooled = heartInjection({heart}, on, snapshot, {recalledAt: new Map([['heart:t2', 2]])});
    assert.ok(!cooled.text.includes('怕冷场') && cooled.text.includes('离不开辣')); assert.deepEqual(cooled.ids, []);
});

test('buildPlan hands the per-memory recall floors to selection (callback cooldown and warm-up run in the real chain)', async () => {
    const asked = [];
    const recalledAt = {get: id => { asked.push(id); return undefined; }};
    const snapshot = {binding, messages: Array.from({length: 12}, (_, i) => ({name: i % 2 ? '角色' : '用户', is_user: !(i % 2), mes: `第 ${i + 1} 层，说到了灯塔。`}))};
    const hashes = await (await import('../yimu/contract.mjs')).fingerprintMessages(snapshot.messages);
    const doc = {...createDocument(binding), enabled: true, entries: [{id: 'm1', kind: 'summary', status: 'active', revision: 1, text: '他们在灯塔下约好再见。', history: [], conflicts: [],
        source: {start: 1, end: 2, hashes: hashes.slice(0, 2)}, scenes: []}], entryOrder: ['m1']};
    const plan = await buildPlan(doc, {values: {...DEFAULTS}}, snapshot, {type: 'normal', recalledAt});
    assert.deepEqual(plan.memoryIds, ['m1']);
    assert.ok(asked.includes('m1'), '选记忆时查过这条记忆上次被带入的楼层');
});

// ---- 整条链：用真实的服务端存储、宿主与运行时，只有模型是假的 ----
async function fixture(t) {
    const parent = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(parent, 'yimu-heart-test-'));
    const account = path.join(root, 'account'), chats = path.join(account, 'chats');
    await fs.mkdir(path.join(chats, 'Heart'), {recursive: true});
    const request = {user: {profile: {handle: 'fixture'}, directories: {root: account, chats}}};
    const messages = Array.from({length: 7}, (_, i) => ({name: i % 2 ? '阿澈' : '小满', is_user: !(i % 2),
        mes: `合成原文第 ${i + 1} 层。` + '她又点了辣的，把辣椒挑到了他的碗里。'.repeat(12), send_date: `2026-11-01T10:0${i}:00.000Z`}));
    const writeChat = async items => fs.writeFile(path.join(chats, 'Heart', `${binding.file}.jsonl`), [{chat_metadata: {integrity: binding.integrity}}, ...items].map(JSON.stringify).join('\n'), 'utf8');
    await writeChat(messages);
    const store = createYimuStore({hostCwd: root}), routes = new Map();
    registerYimuRoutes({get(route, fn) { routes.set(`GET ${route}`, fn); }, post(route, fn) { routes.set(`POST ${route}`, fn); }}, {store});
    const fetcher = async (url, options) => {
        const route = url.slice(url.indexOf('/yimu/') + 5);
        let status = 200, body;
        const response = {status(value) { status = value; return this; }, json(value) { body = clone(value); return this; }};
        await routes.get(`${options.method} ${route}`)({...request, body: options.body ? JSON.parse(options.body) : undefined}, response);
        return {ok: status >= 200 && status < 300, status, json: async () => clone(body)};
    };
    const api = createApi({fetcher, headers: () => ({})});
    const prompts = new Map(), tasks = [], sent = [];
    let model = async () => { throw new Error('这个用例没有准备模型回复'); };
    const context = {
        groupId: null, characterId: 0, characters: [{name: '阿澈', avatar: binding.avatar}], chatId: binding.file, chatMetadata: {integrity: binding.integrity},
        chat: clone(messages), maxContext: 65536, mainApi: 'openai', name1: '小满',
        chatCompletionSettings: {chat_completion_source: 'custom', openai_max_context: 65536, openai_max_tokens: 1024, names_behavior: 0},
        getChatCompletionModel: () => 'fixture-model', getTokenCountAsync: async text => Math.ceil(text.length / 3),
        setExtensionPrompt(key, prompt) { prompts.set(key, prompt); },
        async generateRaw({prompt}) { sent.push(prompt); return model(prompt); },
        async saveChat() { await writeChat(context.chat); },
    };
    const host = createHost({getContext: () => context});
    let nextId = 0;
    const controller = createController({host, api, defer: fn => tasks.push(fn), id: () => `heart_${++nextId}`, roundStore: null});
    t.after(async () => { controller.destroy(); await fs.rm(await fs.realpath(root), {recursive: true}); });
    const flush = async () => { for (let pass = 0; pass < 20; pass++) { while (tasks.length) await tasks.shift()(); await new Promise(resolve => setTimeout(resolve, 5)); if (!tasks.length) break; } };
    const round = async (type, reply) => {
        await controller.event('GENERATION_STARTED', [type, {}, false]);
        if (type === 'swipe') { /* ST 滑动时保留最后一层，重新生成它 */ } else if (type === 'regenerate') context.chat.pop();
        const coreChat = clone(context.chat).filter(message => !message.is_system).slice(0, type === 'swipe' ? -1 : undefined).map((message, index) => ({...message, index}));
        await controller.intercept(coreChat, 65536, () => {}, type);
        const asked = prompts.get(HEART_PROMPT_KEY) || '';
        if (type === 'swipe') context.chat[context.chat.length - 1] = {...context.chat.at(-1), mes: reply}; else context.chat.push({name: '阿澈', is_user: false, mes: reply});
        await controller.event('GENERATION_ENDED', []);
        // 回复落定后总会排一次刷新；有心迹要摘时，它排在摘取与保存之后。等到它出现再往下走。
        for (let waited = 0; !tasks.length && waited < 3000; waited += 5) await new Promise(resolve => setTimeout(resolve, 5));
        await flush();
        return asked;
    };
    return {api, context, controller, prompts, sent, flush, round, model: value => { model = value; }, read: async () => (await api.read(binding)).document};
}

test('whole chain: traces ride on a summary → the diary turns them into an impression and a chronicle entry → a heart note written by the main model is lifted out of the reply', async t => {
    const f = await fixture(t);
    f.model(async () => JSON.stringify({slices: [{start: 1, end: 1, text: '两人第一次一起吃饭。' + '甲'.repeat(1200)}, {start: 2, end: 2, text: '她把辣椒挑到了他的碗里。' + '乙'.repeat(1200)}],
        traces: [{about: '小满', text: '她又点了辣的。', floor: 1}, {about: '小满', text: '她把辣椒挑给了我。', floor: 2}]}));
    await f.controller.refresh();
    await f.controller.action('enable', {enabled: true, range: {start: 1, end: 7, total: 7}});
    await f.controller.action('autoSummary', {value: true}); await f.flush();
    await f.controller.action('summarizeRange', {range: {start: 1, end: 2}, expectedRange: {start: 1, end: 2}, batchFloors: 10}); await f.flush();
    let doc = await f.read();
    assert.equal(doc.observations.length, 2, '痕迹随切片总结记下');
    assert.equal(doc.heart, undefined, '痕迹不够多、也没有阶段总结：不自动整理日记');
    // 手动整理一次日记。
    const before = f.sent.length;
    f.model(async prompt => { assert.ok(prompt.includes('新痕迹') && prompt.includes('以阿澈第一人称视角') && prompt.includes('记忆：'));
        return JSON.stringify({impressions: [{about: '小满', text: '她好像离不开辣。', traces: [1, 2]}], events: [{title: '第一次同桌', text: '两人第一次一起吃饭。', floor: 1}]}); });
    await f.controller.action('heartDiary');
    assert.equal(f.sent.length, before + 1, '一次请求');
    doc = await f.read();
    assert.deepEqual(doc.heart.impressions.map(item => [item.about, item.text, item.days.length]), [['小满', '她好像离不开辣。', 1]]);
    assert.deepEqual(doc.heart.events.map(item => [item.title, item.floor]), [['第一次同桌', 1]]);
    assert.ok(doc.observations.every(item => item.used));
    await assert.rejects(f.controller.action('heartDiary'), /没有新留意到的事或新记忆可合订/);
    // 页面拿到的数据：只看见一个日子的还在「留意」里，不算印象；年表有一条。
    let page = heartData(f.controller.state);
    assert.deepEqual([page.impressions.length, page.loose.length, page.events.map(item => item.title)], [0, 1, ['第一次同桌']]);
    // 心迹：开关开着、其间有过阶段总结、离上一则够远 → 这一轮向主模型要一则。
    f.model(async () => JSON.stringify({text: '相遇之后，她把辣椒挑到了他的碗里。'}));
    await f.controller.action('stage', {start: 1, end: 2}); await f.flush();
    assert.equal(await f.round('normal', '不该被要求写心迹的一轮。'), '', '开关关着时不要');
    await f.controller.action('settings', {values: {thoughts: true, thoughtCooldown: 1}}); await f.flush();
    const asked = await f.round('normal', `她笑了一下。\n\n<${HEART_TAG} 对象="小满">她比看上去更怕冷场。</${HEART_TAG}>`);
    assert.ok(asked.includes(`<${HEART_TAG} 对象=`) && asked.includes('可围绕小满'));
    assert.equal(f.context.chat.at(-1).mes, '她笑了一下。', '那一段从正文里去掉了');
    doc = await f.read();
    assert.deepEqual(doc.heart.thoughts.map(item => [item.group, item.about, item.text, item.floor]), [['you', '小满', '她比看上去更怕冷场。', f.context.chat.length]]);
    assert.equal(f.prompts.get(HEART_PROMPT_KEY), '', '回复结束后注入槽清空');
    // 同一层重新生成：再要一次，新的顶掉旧的；这次模型没写，旧的那则也不留（只认最终留下的回复）。
    const again = await f.round('swipe', '她只是点了点头。');
    assert.ok(again.includes(`<${HEART_TAG} 对象=`));
    doc = await f.read();
    assert.deepEqual(doc.heart.thoughts, []); assert.equal(doc.heart.thoughtFloor, f.context.chat.length);
    // 下一轮离上一则太近、其间也没有新的阶段总结：不再要。
    f.context.chat.push({name: '小满', is_user: true, mes: '走吧。'});
    assert.equal(await f.round('normal', '好。'), '');
    page = heartData(f.controller.state);
    assert.deepEqual(page.thoughts, []);
});
