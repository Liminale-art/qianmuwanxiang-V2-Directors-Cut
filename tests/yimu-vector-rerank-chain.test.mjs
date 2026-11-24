// 向量与重排的整链回归：真实的本机存储、路由、客户端、运行层与宿主适配；只有模型与向量／重排接口是合成的。
// 不发任何真实网络请求：宿主的 fetcher 只认合成向量接口与合成重排接口，其余地址一律报错。
// 这里证明的是「链路接通、失败退回、不留错误状态」，不证明真实服务的可用性、排序质量或费用。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createYimuStore} from '../yimu/server-store.mjs';
import {registerYimuRoutes} from '../yimu/server-plugin.mjs';
import {createApi} from '../yimu/client.mjs';
import {createController} from '../yimu/runtime.mjs';
import {createHost} from '../yimu/host.mjs';
import {createApiSettings} from '../yimu/api-settings.mjs';
import {createJournal} from '../yimu/journal.mjs';
import {mountRetrievalView} from '../yimu/retrieval-view.mjs';
import {seedLegacyDefaults} from './helpers/yimu-legacy-defaults.mjs';

const clone = value => structuredClone(value);
const binding = {avatar: 'Chain.png', file: 'Synthetic-chain', integrity: 'chain_identity'};
const VECTOR_URL = 'https://synthetic-vector.example/v1', RERANK_URL = 'https://synthetic-rerank.example/v1';
// 九条旧切片各有一个互不相同的专名；近期原文与新一批原文都不含这些词，关键词因此分不出先后。
const TOPICS = ['灯塔', '码头', '雪山', '集市', '书库', '渡船', '钟楼', '果园', '矿井'];
const SUMMARIZED = TOPICS.length, RECENT = 5;
// 聊天多出四层（共 18 层）后强制整理一批：总结到「总层数 − 3」为止，即第 10–15 层，六层各成一条。
const BATCH = 6;
const floorText = floor => floor <= SUMMARIZED ? `${TOPICS[floor - 1]}那天的对话与经过。` : '两人并肩慢慢走着，谁也没有先开口。';
const baseMessages = () => Array.from({length: SUMMARIZED + RECENT}, (_, index) => ({name: index % 2 ? '角色' : '用户', is_user: !(index % 2),
    mes: floorText(index + 1), send_date: `2026-10-25T10:${String(index).padStart(2, '0')}:00.000Z`}));
const moreMessages = count => Array.from({length: count}, (_, index) => ({name: index % 2 ? '用户' : '角色', is_user: Boolean(index % 2),
    mes: `后来又过了一阵，仍旧只是寻常日子（${index + 1}）。`, send_date: `2026-10-25T11:${String(index).padStart(2, '0')}:00.000Z`}));
const deferredValue = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const topicOf = value => TOPICS.find(topic => String(value).includes(topic)) || '';
const topicsOf = list => list.map(item => topicOf(item.title || item.text));
// 余弦相似度恰为 score 的二维向量（查询固定为 [1, 0]）。
const unit = score => [score, Math.sqrt(1 - score * score)];
const until = async (check, label) => {
    for (let round = 0; round < 400; round++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.fail(`等待超时：${label}`);
};
// 合成接口挂起，直到请求方取消（与浏览器 fetch 的取消行为一致）。
const hang = signal => new Promise((_, reject) => {
    const stop = () => reject(Object.assign(new Error('The operation was aborted.'), {name: 'AbortError'}));
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, {once: true});
});

async function fixture(t, {sliceFiller = 0, semanticWaitMs = 1200, retrievalTimeoutMs = null} = {}) {
    const parent = await fs.realpath(os.tmpdir());
    const root = await fs.mkdtemp(path.join(parent, 'yimu-vector-chain-test-'));
    const account = path.join(root, 'account'), chats = path.join(account, 'chats');
    await fs.mkdir(path.join(chats, 'Chain'), {recursive: true});
    const request = {user: {profile: {handle: 'fixture'}, directories: {root: account, chats}}};
    const writeChat = async items => fs.writeFile(path.join(chats, 'Chain', `${binding.file}.jsonl`),
        [{chat_metadata: {integrity: binding.integrity}}, ...items].map(JSON.stringify).join('\n'), 'utf8');
    await writeChat(baseMessages());
    // 「原文回查」已去掉（2026-11-24）：总结前照常发现候选并显示在检索页，但不再作为目录发给整理模型。
    await seedLegacyDefaults(account);
    const store = createYimuStore({hostCwd: root});
    const routes = new Map();
    registerYimuRoutes({get(route, fn) { routes.set(`GET ${route}`, fn); }, post(route, fn) { routes.set(`POST ${route}`, fn); }}, {store});
    const storeFetch = async (url, options) => {
        const route = url.slice(url.indexOf('/yimu/') + 5);
        let status = 200, body;
        const response = {status(value) { status = value; return this; }, json(value) { body = clone(value); return this; }};
        await routes.get(`${options.method} ${route}`)({...request, body: options.body ? JSON.parse(options.body) : undefined}, response);
        return {ok: status >= 200 && status < 300, status, json: async () => clone(body)};
    };
    const api = createApi({fetcher: storeFetch, headers: () => ({'X-CSRF-Token': 'synthetic-only'})});

    // 合成向量／重排接口。默认答复是「正常情况」：每条输入都有向量，重排按给定分数排好。
    // 相似度：点名的专名用给定值，其余旧切片 0.1，新整理出的「寻常日子」切片 0.05，查询本身为 1。
    const net = {calls: [], similarity: {}, relevance: {}, embeddings: null, rerank: null,
        score: value => net.similarity[topicOf(value)] ?? (topicOf(value) ? 0.1 : String(value).includes('寻常日子的记录') ? 0.05 : 1),
        defaultEmbeddings: call => Response.json({data: call.body.input.map((value, index) => ({index, embedding: unit(net.score(value))}))}),
        defaultRerank: call => Response.json({results: call.body.documents.map((value, index) => ({index, relevance_score: net.relevance[topicOf(value)] ?? 0}))
            .sort((left, right) => right.relevance_score - left.relevance_score).slice(0, call.body.top_n)})};
    const provider = async (url, options = {}) => {
        const call = {url, body: options.body ? JSON.parse(options.body) : null, authorization: options.headers?.Authorization || '', signal: options.signal};
        net.calls.push(call);
        if (url === `${VECTOR_URL}/embeddings`) return (net.embeddings || net.defaultEmbeddings)(call);
        if (url === `${RERANK_URL}/rerank`) return (net.rerank || net.defaultRerank)(call);
        throw new Error(`夹具不允许访问此地址：${url}`);
    };
    const sent = kind => net.calls.filter(call => call.url.endsWith(kind));

    const prompts = [], slot = [];
    let model = async prompt => {
        const match = prompt.match(/完整覆盖第(\d+)至(\d+)层/);
        assert.ok(match, '合成模型只接受有明确楼层范围的切片总结');
        const start = Number(match[1]), end = Number(match[2]);
        return JSON.stringify({slices: Array.from({length: end - start + 1}, (_, index) => {
            const floor = start + index;
            // 每条切片各有自己的地点：不同场景的相邻切片不会被并成一条。
            return {start: floor, end: floor, scenes: [{place: floor <= SUMMARIZED ? TOPICS[floor - 1] : `路上${floor}`, evidence: {floors: [floor]}}],
                text: (floor <= SUMMARIZED ? `${TOPICS[floor - 1]}往事。` : `寻常日子的记录（${floor}）。`) + '旧事细节留存备查。'.repeat(sliceFiller)};
        })});
    };
    const context = {
        groupId: null, characterId: 0, characters: [{name: 'Chain', avatar: binding.avatar}],
        chatId: binding.file, chatMetadata: {integrity: binding.integrity}, chat: baseMessages(), maxContext: 65536,
        mainApi: 'openai', name1: '用户',
        chatCompletionSettings: {chat_completion_source: 'custom', openai_max_context: 65536, openai_max_tokens: 1024, names_behavior: 0},
        getChatCompletionModel: () => 'fixture-model', getTokenCountAsync: async text => Math.ceil(text.length / 3),
        setExtensionPrompt(key, prompt) { slot.push(prompt); },
        extensionSettings: {}, saveSettingsDebounced: async () => {},
        async generateRaw({prompt}) { prompts.push(prompt); return model(prompt); },
    };
    let host = createHost({getContext: () => context, fetcher: provider});
    if (retrievalTimeoutMs) {
        // 候选请求超时的账户设置最短 5 秒；为了在测试里等得起，这里用同一份设置、同一个合成接口另建一个限时极短的连接层，
        // 并照 host.mjs 末尾的三行转发接到宿主上。其余用例一律走宿主自带的连接层。
        const quick = createApiSettings({getContext: () => context, fetchImpl: provider, retrievalTimeoutMs});
        host = {...host, connectionApi: quick, vectorCandidates: input => quick.vectorCandidates(input),
            vectorScores: input => quick.vectorScores(input), rerankCandidates: input => quick.rerankCandidates(input)};
    }
    const tasks = [], notices = [];
    let nextId = 0;
    const controller = createController({host, api, defer: fn => tasks.push(fn), id: () => `chain_${++nextId}`, journal: createJournal({storage: null}),
        semanticWaitMs, onNotice: (message, tone) => notices.push({message, tone})});
    t.after(async () => {
        controller.destroy();
        const real = await fs.realpath(root);
        assert.equal(path.dirname(real), parent);
        assert.match(path.basename(real), /^yimu-vector-chain-test-/);
        await fs.rm(real, {recursive: true});
    });
    const flush = async () => { while (tasks.length) await tasks.shift()(); };
    // 与界面开关走同一个动作（yimu/view.mjs 里 onToggleVector／onToggleRerank 发出的就是这一条）。
    const chatSettings = values => controller.action('settings', {global: false, values, expectedRevision: controller.state.document.configRevision});
    const entries = async () => (await api.read(binding)).document.entries;
    // 正常情况的起点：九层旧原文各整理成一条切片，最近五层保留为原文。
    const prepare = async () => {
        await controller.refresh();
        await chatSettings({summarySlices: 0, stageAuto: false});
        await controller.action('enable', {enabled: true, range: {start: 1, end: context.chat.length, total: context.chat.length}});
        await controller.action('autoSummary', {value: true});
        await flush();
        // 自动总结现在一律要先够触发条件，且一次总结到「总层数 − 3」；夹具要的是「恰好前九层成片、最近五层是原文」，
        // 所以用手动范围总结把第 1–9 层整理出来（走同一条总结链路）。
        await controller.action('summarizeRange', {range: {start: 1, end: SUMMARIZED}, expectedRange: {start: 1, end: SUMMARIZED}, batchFloors: 20});
        await flush();
        const saved = await entries();
        assert.deepEqual(saved.map(entry => [entry.source.start, entry.source.end]), TOPICS.map((_, index) => [index + 1, index + 1]), '夹具有九条各占一层的切片');
        return saved;
    };
    // 设置页里填好接口（账户级），再在当前聊天打开开关。
    const useVector = async () => {
        await host.connectionApi.updateVector({apiUrl: VECTOR_URL, apiKey: 'vector-fixture-key', model: 'synthetic-embedding'});
        assert.equal(await chatSettings({vectorEnabled: true}), true); await flush();
    };
    const useRerank = async (topN = 6) => {
        await host.connectionApi.updateRerank({apiUrl: RERANK_URL, apiKey: 'rerank-fixture-key', model: 'synthetic-reranker', topN});
        assert.equal(await chatSettings({rerankEnabled: true}), true); await flush();
    };
    // 聊天又往前走了几层：ST 里的聊天与服务端保存的聊天文件一起更新。
    const extend = async (count = 4) => { context.chat.push(...moreMessages(count)); await writeChat(context.chat); await controller.refresh(); await flush(); };
    // 生成前半段：到拦截器（选记忆）为止。intercepting 是还在进行中的那一步，可以在它等向量时插入别的事。
    const begin = async () => {
        await controller.event('GENERATION_STARTED', ['normal', {}, false]);
        const coreChat = clone(context.chat).filter(message => !message.is_system).map((message, index) => ({...message, index}));
        return {coreChat, intercepting: controller.intercept(coreChat, 65536, () => {}, 'normal')};
    };
    // 生成后半段：最终请求边界。返回这一轮真正写进请求的记忆。
    const finish = async coreChat => {
        const payload = {type: 'normal', model: 'fixture-model', chat_completion_source: 'custom', max_tokens: 1024,
            messages: [{role: 'system', content: '合成角色设定'}, ...coreChat.map(message => ({role: message.is_user ? 'user' : 'assistant', content: message.mes}))]};
        await controller.event('GENERATE_AFTER_DATA', [{prompt: payload.messages}, false]);
        await controller.event('CHAT_COMPLETION_SETTINGS_READY', [payload]);
        const prompt = payload.messages.find(message => message.content.includes('<yimu_memory>'))?.content || '';
        const used = controller.state.lastUsed, skip = controller.state.lastSkip;
        await controller.event('GENERATION_ENDED', []); await flush();
        return {prompt, used, skip, topics: TOPICS.filter(topic => prompt.includes(`${topic}往事`))};
    };
    const inject = async () => { const {coreChat, intercepting} = await begin(); await intercepting; return finish(coreChat); };
    // 切片总结前的候选发现：聊天多出四层后手动整理一批，返回这一批的候选顺序（检索页显示的界面状态）。
    // 原文回查已去掉（2026-11-24）：发给整理模型的总结请求里不再有候选目录，也不再请它提回查请求。
    const summarize = async () => {
        const before = prompts.length;
        await controller.start({force: true}); await flush();
        for (const prompt of prompts.slice(before)) {
            assert.ok(!prompt.includes('可回查的旧细摘要目录') && !prompt.includes('recallRequests'), '总结请求不带候选目录');
        }
        return {retrieval: controller.state.retrieval, shown: topicsOf(controller.state.retrieval.candidates)};
    };
    return {api, context, host, controller, net, sent, prompts, slot, notices, flush, entries, prepare, useVector, useRerank, extend, begin, finish, inject, summarize,
        chatSettings, writeChat, model: value => { model = value; }};
}

// 「没有出错」的统一口径：记忆照常带进请求、没有回退记录、界面没有错误文字。
const assertQuiet = (f, round, label) => {
    assert.ok(round.prompt.includes('<yimu_memory>'), `${label}：记忆仍随请求送达`);
    assert.equal(round.skip, null, `${label}：没有回退记录`);
    assert.equal(f.controller.state.error, '', `${label}：没有错误文字`);
};

// 检索页用的最小文档：只够挂载与读取文字，不证明排版。
function pageDocument() {
    const document = {activeElement: null};
    class Node {
        constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.dataset = {}; this.events = new Map(); this.className = ''; this._text = ''; }
        set textContent(value) { this._text = String(value); this.children = []; }
        get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
        set innerHTML(value) { this._markup = value; }
        append(...nodes) { for (const node of nodes) { node.remove(); this.children.push(node); node.parentNode = this; } }
        replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); }
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
        setAttribute(name, value) { this.attrs[name] = String(value); }
        removeAttribute(name) { delete this.attrs[name]; }
        getAttribute(name) { return this.attrs[name] ?? null; }
        addEventListener(name, handler) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push(handler); }
        async emit(name) { for (const handler of this.events.get(name) || []) await handler({type: name, target: this}); }
        focus() { document.activeElement = this; }
    }
    document.createElement = tag => new Node(tag);
    const all = node => node.children.flatMap(child => [child, ...all(child)]);
    return {document, all};
}
function retrievalPage(f) {
    const page = pageDocument();
    const view = mountRetrievalView({document: page.document, vectorApi: f.host.connectionApi,
        onToggleVector: enabled => f.chatSettings({vectorEnabled: enabled}), onToggleRerank: enabled => f.chatSettings({rerankEnabled: enabled})});
    const nodes = () => page.all(view.element);
    const row = title => {
        const name = nodes().find(node => node.className === 'ym-retrieval-status-name' && node.textContent === title), [, badge, detail] = name.parentNode.children;
        return {badge: badge.textContent, detail: detail.textContent, hover: detail.title || ''};
    };
    const toggle = label => nodes().find(node => node.attrs['aria-label'] === label);
    return {render: () => view.render(f.controller.state), row, toggle,
        candidates: () => nodes().filter(node => node.className === 'ym-retrieval-candidate').map(node => topicOf(node.textContent))};
}

// ———————————————————————— 一、生成前选记忆（向量相似度参与排序） ————————————————————————

test('生成前：接口填好＋当前聊天打开开关后，相似度参与排序并改变带入的记忆；切片向量只请求一次', async t => {
    const f = await fixture(t);
    await f.prepare();
    // 每轮最多带两条：名额有限时，排序决定谁进得来。
    await f.chatSettings({maxSlices: 2});
    f.net.similarity = {灯塔: 0.9, 雪山: 0.8};

    const keyword = await f.inject();
    assert.deepEqual(keyword.topics, ['果园', '矿井'], '关键词分不出先后时带的是最近两条');
    assert.equal(keyword.used.semantic, false);
    // 只填接口、不开当前聊天的开关：不请求。
    await f.host.connectionApi.updateVector({apiUrl: VECTOR_URL, apiKey: 'vector-fixture-key', model: 'synthetic-embedding'});
    assert.deepEqual((await f.inject()).topics, ['果园', '矿井']);
    assert.equal(f.sent('/embeddings').length, 0, '开关默认关闭，接口填好也不发请求');

    assert.equal(await f.chatSettings({vectorEnabled: true}), true); await f.flush();
    const ranked = await f.inject();
    assertQuiet(f, ranked, '向量成功');
    assert.deepEqual(ranked.topics, ['灯塔', '雪山'], '相似度最高的两条取代了最近两条');
    assert.equal(ranked.used.semantic, true, '这一轮的注入记录带有「向量参与排序」标记');
    const [first] = f.sent('/embeddings');
    assert.equal(first.url, `${VECTOR_URL}/embeddings`);
    assert.equal(first.authorization, 'Bearer vector-fixture-key');
    assert.equal(first.body.model, 'synthetic-embedding');
    assert.equal(first.body.input.length, 1 + SUMMARIZED, '一次请求：查询（最近几层原文）加九条切片');
    assert.ok(first.body.input[0].includes('谁也没有先开口'), '查询取自最近保留的原文');
    assert.deepEqual(first.body.input.slice(1).map(topicOf), TOPICS);

    // 第二轮：切片向量已记下，只为查询发一次请求，结果不变。
    const again = await f.inject();
    assert.deepEqual(again.topics, ['灯塔', '雪山']); assert.equal(again.used.semantic, true);
    assert.equal(f.sent('/embeddings').length, 2);
    assert.equal(f.sent('/embeddings')[1].body.input.length, 1, '已知切片不再重复发送');

    // 关掉开关即回到关键词排序，也不再请求。
    assert.equal(await f.chatSettings({vectorEnabled: false}), true); await f.flush();
    const off = await f.inject();
    assert.deepEqual(off.topics, ['果园', '矿井']); assert.equal(off.used.semantic, false);
    assert.equal(f.sent('/embeddings').length, 2);
});

test('生成前：开关已开但接口没填时不请求、不报错，按关键词排序', async t => {
    const f = await fixture(t);
    await f.prepare();
    const keyword = await f.inject();
    assert.equal(await f.chatSettings({vectorEnabled: true}), true); await f.flush();
    const round = await f.inject();
    assertQuiet(f, round, '未配置');
    assert.deepEqual(round.topics, keyword.topics); assert.equal(round.used.semantic, false);
    assert.equal(f.net.calls.length, 0);
});

const BAD_EMBEDDINGS = [
    ['无结果（data 为空数组）', () => Response.json({data: []})],
    ['没有 data 字段', () => Response.json({ok: true})],
    ['data 不是数组', () => Response.json({data: '不是数组'})],
    ['正文不是 JSON', () => new Response('<html>网关错误页</html>', {status: 200})],
    ['切片向量与查询维度不一致', call => Response.json({data: call.body.input.map((_, index) => ({index, embedding: index ? [1, 0, 0] : [1, 0]}))})],
    ['向量含非数值（NaN 经 JSON 传输后的样子）', call => Response.json({data: call.body.input.map((_, index) => ({index, embedding: [null, 'NaN']}))})],
    ['全零向量', call => Response.json({data: call.body.input.map((_, index) => ({index, embedding: [0, 0]}))})],
    ['只有查询向量无效', call => Response.json({data: call.body.input.map((_, index) => ({index, embedding: index ? [1, 0] : []}))})],
    ['接口报错（HTTP 500）', () => new Response('synthetic failure', {status: 500})],
    ['鉴权被拒（HTTP 401，两种 Key 格式都试过）', () => new Response('', {status: 401})],
    ['连接失败', () => { throw new TypeError('Failed to fetch'); }],
];
for (const [label, reply] of BAD_EMBEDDINGS) {
    test(`生成前：向量${label}时退回关键词排序，不阻塞、不留错误状态，接口恢复后下一轮即用上`, async t => {
        const f = await fixture(t);
        await f.prepare();
        f.net.similarity = {灯塔: 0.9, 雪山: 0.8};
        const keyword = await f.inject();
        await f.useVector();
        f.net.embeddings = reply;
        const failed = await f.inject();
        assert.ok(f.sent('/embeddings').length >= 1, '确实向向量接口发过请求（不是悄悄没跑）');
        assertQuiet(f, failed, label);
        assert.deepEqual(failed.topics, keyword.topics, '带入的记忆与关键词排序完全一致');
        assert.equal(failed.used.semantic, false, '注入记录不谎称向量参与了排序');
        assert.ok(!JSON.stringify(f.controller.state).includes('vector-fixture-key'), '密钥不进入界面状态');
        f.net.embeddings = null;
        const recovered = await f.inject();
        assertQuiet(f, recovered, `${label}后恢复`);
        assert.equal(recovered.used.semantic, true, '失败不留下卡住的状态或坏缓存');
        assert.ok(recovered.topics.includes('灯塔') && recovered.topics.includes('雪山'));
    });
}

test('生成前：只有部分切片拿到有效向量时，拿到的参与排序，其余按关键词；缺的下一轮只补它们', async t => {
    const f = await fixture(t);
    await f.prepare();
    await f.chatSettings({maxSlices: 2});
    await f.useVector();
    f.net.similarity = {灯塔: 0.9, 雪山: 0.8};
    // 「码头」「集市」两条的向量坏了，其余正常。
    f.net.embeddings = call => Response.json({data: call.body.input.map((value, index) => ({index,
        embedding: ['码头', '集市'].includes(topicOf(value)) ? [null, 1] : unit(f.net.score(value))}))});
    const round = await f.inject();
    assertQuiet(f, round, '部分有效');
    assert.deepEqual(round.topics, ['灯塔', '雪山']); assert.equal(round.used.semantic, true);
    await f.inject();
    assert.deepEqual(f.sent('/embeddings').at(-1).body.input.slice(1).map(topicOf), ['码头', '集市'], '只重新请求上一轮没拿到的两条');
});

test('生成前：向量迟迟不回时到点按关键词排序放行；请求在后台跑完，下一轮即用上', async t => {
    const f = await fixture(t, {semanticWaitMs: 40});
    await f.prepare();
    f.net.similarity = {灯塔: 0.9, 雪山: 0.8};
    const keyword = await f.inject();
    await f.useVector();
    const gate = deferredValue();
    f.net.embeddings = async call => { await gate.promise; return f.net.defaultEmbeddings(call); };
    const began = Date.now();
    const slow = await f.inject();
    assert.ok(Date.now() - began < 2000, '生成没有等到向量接口答复');
    assertQuiet(f, slow, '限时等待');
    assert.deepEqual(slow.topics, keyword.topics); assert.equal(slow.used.semantic, false);
    assert.equal(f.sent('/embeddings').length, 1);
    // 迟到的答复：不改已经发出的那一轮，只把向量记下。
    f.net.embeddings = null; gate.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    const next = await f.inject();
    assert.equal(next.used.semantic, true);
    assert.ok(next.topics.includes('灯塔') && next.topics.includes('雪山'));
    assert.equal(f.sent('/embeddings').at(-1).body.input.length, 1, '迟到的切片向量已被记下，下一轮只请求查询');
});

test('生成前：接口超过「候选请求超时」时请求被真正取消，退回关键词排序', async t => {
    const f = await fixture(t, {semanticWaitMs: 5000, retrievalTimeoutMs: 30});
    await f.prepare();
    const keyword = await f.inject();
    await f.useVector();
    f.net.embeddings = call => hang(call.signal);
    const began = Date.now();
    const round = await f.inject();
    assert.ok(Date.now() - began < 3000, '由请求自身的超时结束，不必等满生成前的限时');
    assertQuiet(f, round, '请求超时');
    assert.deepEqual(round.topics, keyword.topics); assert.equal(round.used.semantic, false);
    assert.equal(f.sent('/embeddings')[0].signal.aborted, true, '超时后请求已取消，没有悬空');
});

test('生成前：等向量期间这一轮被新的生成取代或聊天被停用，迟到的选记忆结果不会被写进请求', async t => {
    const f = await fixture(t);
    await f.prepare();
    await f.useVector();
    f.net.similarity = {灯塔: 0.9, 雪山: 0.8};
    let gate = deferredValue();
    f.net.embeddings = async call => { await gate.promise; return f.net.defaultEmbeddings(call); };

    // 被新的一轮取代。
    const stale = await f.begin();
    await until(() => f.sent('/embeddings').length === 1, '第一轮向量请求已发出');
    await f.controller.event('GENERATION_STARTED', ['regenerate', {}, false]);
    gate.resolve(); await stale.intercepting;
    const dropped = await f.finish(stale.coreChat);
    assert.equal(dropped.prompt, '', '旧一轮的选记忆结果没有写进请求');
    assert.equal(dropped.used, null); assert.equal(f.controller.state.error, '');

    // 之后正常的一轮不受影响（向量已记下）。
    f.net.embeddings = null;
    const normal = await f.inject();
    assertQuiet(f, normal, '取代之后');
    assert.equal(normal.used.semantic, true);

    // 等向量期间停用当前聊天。
    await f.host.connectionApi.updateVector({model: 'synthetic-embedding-next'});
    gate = deferredValue();
    f.net.embeddings = async call => { await gate.promise; return f.net.defaultEmbeddings(call); };
    const waiting = await f.begin(), before = f.sent('/embeddings').length;
    await until(() => f.sent('/embeddings').length === before + 1, '向量请求已发出');
    await f.controller.action('enable', {enabled: false});
    gate.resolve(); await waiting.intercepting;
    const disabled = await f.finish(waiting.coreChat);
    assert.equal(disabled.prompt, ''); assert.equal(disabled.used, null); assert.equal(f.controller.state.error, '');
});

test('生成前：等向量期间记忆被修订（来源在途中变化）时，不用旧内容改写请求，并记下原因', async t => {
    const f = await fixture(t);
    const saved = await f.prepare();
    await f.useVector();
    f.net.similarity = {灯塔: 0.9, 雪山: 0.8};
    const gate = deferredValue();
    f.net.embeddings = async call => { await gate.promise; return f.net.defaultEmbeddings(call); };
    const round = await f.begin();
    await until(() => f.sent('/embeddings').length === 1, '向量请求已发出');
    assert.equal(await f.controller.action('edit', {entryId: saved[2].id, text: '雪山往事。人工修订后的说法。'}), true);
    gate.resolve(); await round.intercepting;
    const result = await f.finish(round.coreChat);
    assert.equal(result.prompt, '', '修订前选好的记忆没有被拿去改写请求');
    assert.equal(result.used, null);
    assert.equal(result.skip?.reason, 'source-or-route-changed', '回退原因如实记下');
    assert.equal(f.controller.state.error, '');
    // 下一轮带的是修订后的内容，向量照常参与（改过的那条只需补一个向量）。
    f.net.embeddings = null;
    const next = await f.inject();
    assertQuiet(f, next, '修订之后');
    assert.equal(next.used.semantic, true);
    assert.ok(next.prompt.includes('人工修订后的说法'));
    assert.deepEqual(f.sent('/embeddings').at(-1).body.input.slice(1), ['雪山往事。人工修订后的说法。']);
});

test('生成前选记忆目前不调用重排：重排开关与接口都就绪时也不向重排接口发请求', async t => {
    // 现状记录：重排只在切片总结前的候选发现里生效。若以后主线决定生成前也用重排，这条用例要随之改写。
    const f = await fixture(t);
    await f.prepare();
    await f.useVector(); await f.useRerank();
    const round = await f.inject();
    assertQuiet(f, round, '向量与重排都开');
    assert.equal(round.used.semantic, true);
    assert.equal(f.sent('/rerank').length, 0);
});

// ———————————————————————— 二、向量打分缓存 ————————————————————————

test('向量缓存：按「接口地址＋模型＋正文」记在本机内存；换模型后整批重取；「清本机记录」清空并报数', async t => {
    const f = await fixture(t);
    await f.prepare();
    await f.useVector();
    await f.inject(); await f.inject();
    assert.deepEqual(f.sent('/embeddings').map(call => call.body.input.length), [1 + SUMMARIZED, 1]);
    // 换模型：旧向量不能拿来比，全部重新请求。
    await f.host.connectionApi.updateVector({model: 'synthetic-embedding-next'});
    await f.inject();
    assert.equal(f.sent('/embeddings').at(-1).body.model, 'synthetic-embedding-next');
    assert.equal(f.sent('/embeddings').at(-1).body.input.length, 1 + SUMMARIZED);
    // 换回原模型：原先记下的向量仍在。
    await f.host.connectionApi.updateVector({model: 'synthetic-embedding'});
    await f.inject();
    assert.equal(f.sent('/embeddings').at(-1).body.input.length, 1);
    // 管理页「本机记录与向量缓存」。
    assert.equal(await f.controller.action('clearLocal', {}), true);
    assert.match(f.notices.at(-1).message, /已清本机记录与 18 条向量缓存/, '两个模型各九条切片向量');
    assert.equal(f.controller.state.lastUsed, null);
    const after = await f.inject();
    assert.equal(after.used.semantic, true);
    assert.equal(f.sent('/embeddings').at(-1).body.input.length, 1 + SUMMARIZED, '清空后重新请求全部切片');
    // 缓存与密钥都不进入聊天记忆。
    const stored = JSON.stringify((await f.api.read(binding)).document);
    assert.ok(!stored.includes('vector-fixture-key') && !stored.includes(VECTOR_URL) && !stored.includes('embedding'));
});

// ———————————————————————— 三、切片总结前的候选发现（向量补候选、重排改顺序） ————————————————————————

// 切片正文约 370 字：关键词候选受 1200 token 的目录预算限制，只放得下最近两条，其余名额才轮到向量。
const LONG = {sliceFiller: 40};
const LEXICAL = ['矿井', '果园'];

test('总结前：向量补进关键词找不到的旧切片，重排改变候选顺序，检索页显示同一份候选', async t => {
    // 对照：两个开关都关。
    const off = await fixture(t, LONG);
    await off.prepare(); await off.extend(4);
    const plain = await off.summarize();
    assert.deepEqual(plain.shown, LEXICAL);
    assert.equal(plain.retrieval.vector.status, 'disabled'); assert.equal(plain.retrieval.rerank.status, 'disabled');
    assert.equal(off.net.calls.length, 0);

    // 只开向量：补进相似度最高的几条，直到六条。
    const v = await fixture(t, LONG);
    await v.prepare(); await v.useVector();
    v.net.similarity = {灯塔: 0.9, 码头: 0.8, 雪山: 0.7, 集市: 0.6};
    await v.extend(4);
    const vector = await v.summarize();
    assert.equal(vector.retrieval.vector.status, 'ready'); assert.equal(vector.retrieval.rerank.status, 'disabled');
    assert.deepEqual(vector.shown, [...LEXICAL, '灯塔', '码头', '雪山', '集市'], '关键词候选在前，向量候选按相似度补在后面');
    assert.equal(v.sent('/embeddings').length, 1); assert.equal(v.sent('/rerank').length, 0);
    const embedding = v.sent('/embeddings')[0];
    assert.equal(embedding.authorization, 'Bearer vector-fixture-key');
    assert.equal(embedding.body.model, 'synthetic-embedding');
    assert.ok(embedding.body.input[0].includes('谁也没有先开口'), '查询是本批要整理的原文');
    assert.deepEqual(embedding.body.input.slice(1).map(topicOf), TOPICS, '九条旧切片都在候选池里');
    assert.ok(vector.retrieval.candidates.slice(2).every(candidate => /向量相似候选/.test(candidate.reason)));

    // 向量与重排都开：重排只改顺序，不增不减。
    const f = await fixture(t, LONG);
    await f.prepare(); await f.useVector(); await f.useRerank();
    f.net.similarity = v.net.similarity; f.net.relevance = {雪山: 0.9, 果园: 0.5};
    await f.extend(4);
    const reranked = await f.summarize();
    assert.equal(reranked.retrieval.vector.status, 'ready'); assert.equal(reranked.retrieval.rerank.status, 'ready');
    assert.deepEqual(reranked.shown, ['雪山', '果园', '矿井', '灯塔', '码头', '集市'], '重排分数高的排到前面，其余保持原先的相对顺序');
    assert.deepEqual([...reranked.shown].sort(), [...vector.shown].sort(), '重排不新增也不丢候选');
    assert.equal(f.sent('/rerank').length, 1);
    const rerank = f.sent('/rerank')[0];
    assert.equal(rerank.url, `${RERANK_URL}/rerank`);
    assert.equal(rerank.authorization, 'Bearer rerank-fixture-key');
    assert.equal(rerank.body.model, 'synthetic-reranker'); assert.equal(rerank.body.top_n, 6);
    assert.ok(rerank.body.query.includes('谁也没有先开口'));
    assert.deepEqual(rerank.body.documents.map(topicOf), vector.shown, '送去重排的正是已过滤的候选');
    assert.equal(f.controller.state.error, '');
    assert.equal((await f.entries()).filter(entry => entry.source.start > SUMMARIZED).length, BATCH, '本批总结已保存');

    // 检索页显示同一份状态。
    const page = retrievalPage(f); page.render();
    assert.deepEqual(page.row('向量'), {badge: '可用', detail: '已接入候选发现', hover: ''});
    assert.deepEqual(page.row('重排'), {badge: '可用', detail: '已接入排序', hover: ''});
    assert.deepEqual(page.candidates(), reranked.shown);
    assert.equal(page.toggle('启用向量').checked, true); assert.equal(page.toggle('启用重排').checked, true);
});

test('总结前：关键词候选已占满六条时，不向向量接口发请求，检索页如实写明', async t => {
    // 切片正文很短时，目录预算放得下六条时间近邻候选；此时向量候选没有名额，请求发了也白发。
    const f = await fixture(t);
    await f.prepare(); await f.useVector();
    f.net.similarity = {灯塔: 0.9, 码头: 0.8};
    await f.extend(4);
    const result = await f.summarize();
    assert.equal(f.sent('/embeddings').length, 0, '候选已满，向量请求没有发出');
    assert.equal(result.retrieval.vector.status, 'skipped');
    assert.equal(result.retrieval.vector.reason, '关键词候选已满，本批不另取向量');
    assert.deepEqual(result.shown, ['矿井', '果园', '钟楼', '渡船', '书库', '集市']);
    assert.ok(result.retrieval.candidates.every(candidate => !/向量/.test(candidate.reason)));
    assert.equal(f.controller.state.error, '');
    const page = retrievalPage(f); page.render();
    assert.deepEqual(page.row('向量'), {badge: '可用', detail: '关键词候选已满，本批没取向量', hover: ''}, '不显示成失败');
});

test('总结前：重排只返回部分有效结果时，有效的排到前面，其余原样保留', async t => {
    const f = await fixture(t, LONG);
    await f.prepare();
    await f.useVector(); await f.useRerank();
    f.net.similarity = {灯塔: 0.9, 码头: 0.8, 雪山: 0.7, 集市: 0.6};
    // 下标 3 是「码头」；其余几行是越界、重复、非数值与缺字段。
    f.net.rerank = () => Response.json({results: [{index: 99, relevance_score: 1}, {index: 3, relevance_score: 0.9}, {index: 3, relevance_score: 0.1},
        {index: 0, relevance_score: 'NaN'}, {relevance_score: 0.8}, null]});
    await f.extend(4);
    const result = await f.summarize();
    assert.equal(result.retrieval.rerank.status, 'ready');
    assert.deepEqual(result.shown, ['码头', '矿井', '果园', '灯塔', '雪山', '集市']);
});

const BAD_RERANK = [
    ['接口报错（HTTP 500）', () => new Response('synthetic failure', {status: 500})],
    ['正文不是 JSON', () => new Response('<html>网关错误页</html>', {status: 200})],
    ['结果不是数组', () => Response.json({results: '不是数组'})],
    ['无结果（空数组）', () => Response.json({results: []})],
    ['分数全部无效', call => Response.json({results: call.body.documents.map((_, index) => ({index, relevance_score: 'NaN'}))})],
    ['下标全部越界', call => Response.json({results: call.body.documents.map((_, index) => ({index: index + 100, relevance_score: 0.5}))})],
    ['连接失败', () => { throw new TypeError('Failed to fetch'); }],
];
for (const [label, reply] of BAD_RERANK) {
    test(`总结前：重排${label}时保留原候选顺序，总结照常完成，界面只在检索页标出重排失败`, async t => {
        const f = await fixture(t, LONG);
        await f.prepare();
        await f.useVector(); await f.useRerank();
        f.net.similarity = {灯塔: 0.9, 码头: 0.8, 雪山: 0.7, 集市: 0.6};
        f.net.rerank = reply;
        await f.extend(4);
        const result = await f.summarize();
        assert.equal(f.sent('/rerank').length, 1, '确实向重排接口发过请求，且失败后不重试');
        assert.equal(result.retrieval.rerank.status, 'error');
        assert.ok(result.retrieval.rerank.reason && !result.retrieval.rerank.reason.includes('rerank-fixture-key'));
        assert.equal(result.retrieval.vector.status, 'ready');
        assert.deepEqual(result.shown, [...LEXICAL, '灯塔', '码头', '雪山', '集市'], '顺序与没有重排时完全一致');
        assert.equal(f.controller.state.error, '', '重排失败不算整理失败');
        assert.equal((await f.entries()).filter(entry => entry.source.start > SUMMARIZED).length, BATCH, '本批总结已保存');
        const page = retrievalPage(f); page.render();
        assert.equal(page.row('重排').badge, '不可用'); assert.equal(page.row('重排').detail, '重排请求失败，保留原顺序');
        assert.equal(page.row('重排').hover, result.retrieval.rerank.reason);
        // 下一批接口恢复后照常重排。
        f.net.rerank = null; f.net.relevance = {集市: 0.9};
        await f.extend(4);
        const next = await f.summarize();
        assert.equal(next.retrieval.rerank.status, 'ready'); assert.equal(next.shown[0], '集市', '恢复后重排照常把高分候选提到最前');
    });
}

const BAD_CANDIDATE_VECTORS = [
    ['无结果（data 为空数组）', () => Response.json({data: []})],
    ['data 不是数组', () => Response.json({data: '不是数组'})],
    ['切片向量与查询维度不一致', call => Response.json({data: call.body.input.map((_, index) => ({index, embedding: index ? [1, 0, 0] : [1, 0]}))})],
    ['向量含非数值', call => Response.json({data: call.body.input.map((_, index) => ({index, embedding: [null, 'NaN']}))})],
    ['接口报错（HTTP 500）', () => new Response('synthetic failure', {status: 500})],
    ['连接失败', () => { throw new TypeError('Failed to fetch'); }],
];
for (const [label, reply] of BAD_CANDIDATE_VECTORS) {
    test(`总结前：向量${label}时只用关键词候选，总结照常完成`, async t => {
        const f = await fixture(t, LONG);
        await f.prepare();
        await f.useVector();
        f.net.embeddings = reply;
        await f.extend(4);
        const result = await f.summarize();
        assert.equal(f.sent('/embeddings').length, 1, '确实向向量接口发过请求，且失败后不重试');
        assert.equal(result.retrieval.vector.status, 'error');
        assert.ok(result.retrieval.vector.reason && !result.retrieval.vector.reason.includes('vector-fixture-key'));
        assert.deepEqual(result.shown, LEXICAL);
        assert.equal(f.controller.state.error, '');
        assert.equal((await f.entries()).filter(entry => entry.source.start > SUMMARIZED).length, BATCH);
        const page = retrievalPage(f); page.render();
        assert.deepEqual(page.row('向量'), {badge: '不可用', detail: '向量请求失败，已回退关键词召回', hover: result.retrieval.vector.reason});
    });
}

test('总结前：向量与重排各自超时后退回，总结不被拖住', async t => {
    const f = await fixture(t, {...LONG, retrievalTimeoutMs: 30});
    await f.prepare();
    await f.useVector(); await f.useRerank();
    f.net.embeddings = call => hang(call.signal);
    f.net.rerank = call => hang(call.signal);
    await f.extend(4);
    const began = Date.now();
    const result = await f.summarize();
    assert.ok(Date.now() - began < 3000);
    assert.equal(result.retrieval.vector.status, 'error'); assert.match(result.retrieval.vector.reason, /超时，已回退关键词召回/);
    assert.equal(result.retrieval.rerank.status, 'error'); assert.match(result.retrieval.rerank.reason, /超时，已保留当前顺序/);
    assert.ok(f.net.calls.every(call => call.signal.aborted), '超时的请求都已取消');
    assert.deepEqual(result.shown, LEXICAL);
    assert.equal(f.controller.state.error, '');
    assert.equal((await f.entries()).filter(entry => entry.source.start > SUMMARIZED).length, BATCH);
});

for (const [label, kind] of [['向量', '/embeddings'], ['重排', '/rerank']]) {
    test(`总结前：等${label}答复时中止整理，请求随之取消；不调用整理模型，不记成${label}失败，不留错误`, async t => {
        const f = await fixture(t, LONG);
        await f.prepare();
        await f.useVector(); await f.useRerank();
        if (kind === '/embeddings') f.net.embeddings = call => hang(call.signal); else f.net.rerank = call => hang(call.signal);
        await f.extend(4);
        const models = f.prompts.length;
        const job = f.controller.start({force: true});
        await until(() => f.sent(kind).length === 1, `${label}请求已发出`);
        assert.equal(await f.controller.action('stop', {}), true);
        await job; await f.flush();
        assert.equal(f.sent(kind)[0].signal.aborted, true, '在途请求已取消');
        assert.equal(f.prompts.length, models, '没有为这一批调用整理模型');
        assert.equal(f.controller.state.error, '');
        assert.notEqual(f.controller.state.retrieval.vector.status, 'error');
        assert.notEqual(f.controller.state.retrieval.rerank.status, 'error');
        assert.equal((await f.entries()).filter(entry => entry.source.start > SUMMARIZED).length, 0);
        const page = retrievalPage(f); page.render();
        assert.notEqual(page.row(label).badge, '不可用');
        // 之后再整理一次照常完成。
        f.net.embeddings = null; f.net.rerank = null;
        const result = await f.summarize();
        assert.equal(result.retrieval.vector.status, 'ready'); assert.equal(result.retrieval.rerank.status, 'ready');
        assert.equal((await f.entries()).filter(entry => entry.source.start > SUMMARIZED).length, BATCH);
    });
}

test('总结前：等重排答复期间本批原文被改动（来源在途中变化）时，整理结果不被采用', async t => {
    const f = await fixture(t, LONG);
    await f.prepare();
    await f.useVector(); await f.useRerank();
    const gate = deferredValue();
    f.net.rerank = async call => { await gate.promise; return f.net.defaultRerank(call); };
    await f.extend(4);
    const job = f.controller.start({force: true});
    await until(() => f.sent('/rerank').length === 1, '重排请求已发出');
    f.context.chat[SUMMARIZED + 1].mes = '这一层在整理途中被用户改写了。';
    await f.writeChat(f.context.chat);
    gate.resolve(); await job; await f.flush();
    assert.match(f.controller.state.error, /原文已变化/);
    assert.equal((await f.entries()).filter(entry => entry.source.start > SUMMARIZED).length, 0, '按旧原文整理出的结果没有保存');
    assert.equal((await f.entries()).length, SUMMARIZED, '已有记忆不受影响');
});

test('检索页：界面开关经由同一个设置动作存为账户设置；中止后的状态不显示为失败', async t => {
    const f = await fixture(t, LONG);
    await f.prepare();
    await f.host.connectionApi.updateVector({apiUrl: VECTOR_URL, apiKey: 'vector-fixture-key', model: 'synthetic-embedding'});
    const page = retrievalPage(f); page.render();
    assert.equal(page.toggle('启用向量').checked, false);
    assert.deepEqual(page.row('关键词召回'), {badge: '可召回', detail: '当前默认候选路径', hover: ''});
    page.toggle('启用向量').checked = true;
    await page.toggle('启用向量').emit('change'); await f.flush();
    // 设置都是账户全局的（2026-11-24）：开关存进全局默认，不留在当前聊天里。
    assert.equal(f.controller.state.defaults.values.vectorEnabled, true);
    const saved = await f.api.read(binding);
    assert.equal(saved.defaults.values.vectorEnabled, true, '开关存为账户设置，所有聊天共用');
    assert.equal(saved.document.settings.vectorEnabled, undefined, '当前聊天里不另存一份');
    f.net.similarity = {灯塔: 0.9};
    await f.extend(4);
    await f.summarize(); page.render();
    assert.equal(page.row('向量').badge, '可用');
    assert.equal(page.row('重排').badge, '未启用');
    assert.ok(page.candidates().includes('灯塔'));
});
