import test from 'node:test';
import assert from 'node:assert/strict';
import { readGagaMemoryContext, GAGA_MEMORY_KEY } from '../qianmu-memory-context.js';

const chat = Array.from({ length: 8 }, (_, index) => ({ name: index % 2 ? '林队' : '读者', mes: `正文${index}：桥边档案。`, send_date: `d${index}`, is_user: index % 2 === 0 }));
function hash(value) {
    let result = 2166136261;
    for (const character of value.split('')) { result ^= character.charCodeAt(0); result = Math.imul(result, 16777619); }
    return (result >>> 0).toString(16).padStart(8, '0');
}
const source = (start, end, messages = chat) => ({ start, end, refs: messages.slice(start, end + 1).map((message, offset) => ({
    index: start + offset, name: message.name, key: `${message.send_date}|${message.name}|${hash(message.mes)}|${start + offset}`,
    hash: hash(`${message.name}\n${message.mes}`), fullHash: hash(`${message.name}\n${message.mes}`),
})) });
const clone = value => structuredClone(value);
function fixture({ memoryMode = 'manual', summaryMode = 'mixed' } = {}) {
    const range = source(0, 1);
    const state = { schemaVersion: 6, enabled: true, memoryMode, summaryMode, lastProcessedIndex: 1,
        summaryArtifacts: { novel: '警员完成了桥边的调查。', structured: '桥边调查已完成。', mixed: '桥边调查结束，档案暂存。' },
        recap: '不能重复拼接的 recap',
        facts: [{ id: 'fact', text: '桥上发现的钥匙已封存。', truthStatus: 'fact', sourceRefs: range.refs }],
        state: { key: { key: '钥匙保管', value: '物证室', sourceRefs: range.refs } },
        threads: [{ id: 'thread', text: '失踪者仍未找到。', status: 'open', sourceRefs: range.refs }],
        timeline: [{ id: 'time', time: '周一', text: '林队返回警局。', sourceRefs: range.refs }],
        npcs: [{ id: 'npc', name: '小陈', identity: '警员', firstAppearance: '在桥边出现', lastStatus: '休假',
            openThreads: ['等待归档'], sourceRefs: range.refs }],
        sceneCards: [{ id: 'scene', title: '桥边调查', text: '林队拾起了物证。', participants: ['林队'], keywords: ['桥边'], sourceRange: range }],
        roundCapsules: [], memoryArchives: [], pending: null,
    };
    const baseline = clone(state);
    state.checkpoints = [{ id: 'cp1', status: 'committed', range, memorySnapshot: baseline }];
    return { chatMetadata: { [GAGA_MEMORY_KEY]: state }, chat: clone(chat), settings: { workshopEnabled: true, memoryMode }, chatKey: 'a/chat', query: '林队在桥边继续调查' };
}
const stateOf = input => input.chatMetadata[GAGA_MEMORY_KEY];
function capsule(start, end) { return { id: `capsule-${start}`, title: '值班', text: `新的剧情${start}`, storyTime: '周二', participants: ['小陈'],
    npcs: [{ name: '小陈', lastStatus: '正在值班', openThreads: ['等待来电'] }], sourceRange: source(start, end), revision: 1, updatedAt: 10 }; }

for (const memoryMode of ['manual', 'layered']) for (const summaryMode of ['novel', 'structured', 'mixed']) {
    test(`${memoryMode}/${summaryMode} reads selected full artifact and all distinct valid memory types`, () => {
        const input = fixture({ memoryMode, summaryMode }), output = readGagaMemoryContext(input);
        assert.equal(output.status, 'ready');
        assert.equal(output.blocks.find(block => block.kind === 'summary').text, stateOf(input).summaryArtifacts[summaryMode]);
        for (const kind of ['facts', 'state', 'threads', 'timeline', 'npcs', 'sceneCards']) assert.ok(output.blocks.some(block => block.kind === kind), kind);
        assert.doesNotMatch(output.text, /不能重复拼接的 recap/);
        for (const other of ['novel', 'structured', 'mixed'].filter(mode => mode !== summaryMode)) assert.ok(!output.text.includes(stateOf(input).summaryArtifacts[other]));
    });
}
test('disabled, absent, unsupported and source-less imported memory never masquerade as ready', () => {
    assert.equal(readGagaMemoryContext({}).status, 'unavailable');
    for (const path of ['host', 'chat', 'plugin']) {
        const input = fixture();
        if (path === 'host') input.settings.workshopEnabled = false;
        if (path === 'chat') stateOf(input).enabled = false;
        if (path === 'plugin') input.pluginAvailable = false;
        assert.equal(readGagaMemoryContext(input).blocks.length, 0);
    }
    const imported = fixture(); stateOf(imported).checkpoints = [];
    assert.equal(readGagaMemoryContext(imported).status, 'unverified');
    assert.equal(readGagaMemoryContext(imported).text, '');
    for (const version of [undefined, 5, 8, '6']) {
        const input = fixture(); stateOf(input).schemaVersion = version;
        assert.equal(readGagaMemoryContext(input).status, 'unsupported');
    }
    const upgraded = fixture(); stateOf(upgraded).schemaVersion = 7;
    assert.equal(readGagaMemoryContext(upgraded).status, 'ready');
    const missingChat = fixture(); delete missingChat.chat;
    assert.equal(readGagaMemoryContext(missingChat).status, 'unverified');
});
test('schema 7 message ids survive chat reindexing while preserving full source hashes', () => {
    const input = fixture();
    stateOf(input).schemaVersion = 7;
    input.chat.forEach((message, index) => { message.extra = { gagaDogMessageId: `stable-${index}` }; });
    stateOf(input).checkpoints[0].range.refs.forEach((ref, index) => { ref.messageId = `stable-${index}`; });
    input.chat.unshift({ name: '旁白', mes: '前置楼层', send_date: 'before', is_user: false });
    assert.equal(readGagaMemoryContext(input).status, 'ready');
    input.chat[1].mes += '被编辑';
    assert.equal(readGagaMemoryContext(input).blocks.length, 0);
});
test('auto recording off and pending drafts do not erase already committed memory', () => {
    const input = fixture({ memoryMode: 'layered' });
    input.settings.layeredAutoEnabled = false;
    stateOf(input).pending = { partialText: '不要注入的半成品', packet: { recap: '还未提交' } };
    const output = readGagaMemoryContext(input);
    assert.equal(output.status, 'ready'); assert.equal(output.snapshot.pending, true);
    assert.doesNotMatch(output.text, /半成品|还未提交/);
});
test('read is pure and explicit allowlist excludes director, DIY, API, cached injection, archives and revisions', () => {
    const input = fixture({ memoryMode: 'layered' });
    Object.assign(stateOf(input), { director: { plan: 'secret-plan' }, reply: 'secret-reply', lastInjection: 'secret-injection', apiKey: 'secret-key',
        memoryArchives: [{ text: 'secret-archive' }], checkpoints: stateOf(input).checkpoints,
        arbitrary: { instruction: 'secret-instruction' } });
    Object.assign(input.settings, { topDiyText: 'secret-diy', apiProfiles: [{ apiKey: 'secret-profile' }] });
    stateOf(input).facts[0].unexpectedApiKey = 'secret-field';
    stateOf(input).roundCapsules.push({ ...capsule(2, 3), revisionHistory: [{ text: 'secret-old-capsule' }] });
    const before = clone(input), output = readGagaMemoryContext(input);
    assert.deepEqual(input, before);
    assert.doesNotMatch(JSON.stringify(output), /secret-/);
});
test('whole-artifact edit wins over old records; no speculative semantic merge', () => {
    const input = fixture();
    stateOf(input).summaryArtifacts.mixed = '用户修订：桥边调查尚未结束。';
    const output = readGagaMemoryContext(input);
    assert.equal(output.status, 'partial');
    assert.equal(output.blocks.length, 1); assert.equal(output.snapshot.revisionState, 'artifact_edited');
    assert.match(output.text, /尚未结束/); assert.doesNotMatch(output.text, /休假|物证室/);
});
test('independent record edits have explicit precedence when selected prose is unchanged', () => {
    const input = fixture({ summaryMode: 'novel' });
    stateOf(input).npcs[0].lastStatus = '刚刚归队';
    const output = readGagaMemoryContext(input);
    assert.equal(output.status, 'ready'); assert.equal(output.snapshot.revisionState, 'records_edited');
    assert.match(output.text, /当前结构记录是更新后的依据/); assert.match(output.text, /刚刚归队/);
});
test('both artifact and records revised without revision clock remain explicitly unresolved', () => {
    const input = fixture();
    stateOf(input).summaryArtifacts.mixed = '人工修订的完整前情'; stateOf(input).npcs[0].lastStatus = '再次改变';
    const output = readGagaMemoryContext(input);
    assert.equal(output.snapshot.revisionState, 'unresolved'); assert.equal(output.status, 'partial');
    assert.ok(output.diagnostics.some(item => item.code === 'artifact_record_order_unknown'));
    assert.doesNotMatch(output.text, /再次改变/);
});
test('missing snapshot preserves only proven selected artifact and reports missing revision basis', () => {
    const input = fixture(); delete stateOf(input).checkpoints[0].memorySnapshot;
    const output = readGagaMemoryContext(input);
    assert.equal(output.status, 'partial'); assert.equal(output.blocks.length, 1);
    assert.ok(output.diagnostics.some(item => item.code === 'record_revision_baseline_missing'));
});
test('clear or empty selected artifact never falls back to another format or stale recap', () => {
    const input = fixture(); stateOf(input).summaryArtifacts.mixed = '';
    assert.equal(readGagaMemoryContext(input).text, '');
    input.chatMetadata = {}; assert.equal(readGagaMemoryContext(input).status, 'unavailable');
});
test('edit, swipe, delete and source movement invalidate aggregate before upstream handler runs', () => {
    for (const [label, change] of [
        ['edit', input => { input.chat[0].mes += '更改'; }],
        ['swipe', input => { input.chat[1].mes = '另一 Swipe'; }],
        ['delete', input => { input.chat.splice(0, 1); }],
        ['source-date', input => { input.chat[0].send_date = '新来源'; }],
    ]) {
        const input = fixture({ memoryMode: 'layered' }); stateOf(input).roundCapsules.push(capsule(2, 3)); change(input);
        const output = readGagaMemoryContext(input);
        assert.equal(output.status, 'unverified', label); assert.equal(output.blocks.length, 0, label);
        assert.ok(output.diagnostics.some(item => item.code === 'memory_source_changed'), label);
    }
});
test('appended recent body is not confused with invalidation; changing chat identity changes fingerprint', () => {
    const input = fixture(), before = readGagaMemoryContext(input);
    input.chat.push({ name: '林队', mes: '继续', send_date: 'd9' });
    const after = readGagaMemoryContext(input);
    assert.equal(after.status, 'ready'); assert.notEqual(after.snapshot.fingerprint, before.snapshot.fingerprint);
    input.chatKey = 'another/chat'; assert.notEqual(readGagaMemoryContext(input).snapshot.fingerprint, after.snapshot.fingerprint);
});
test('fullHash validates edits after 6000 characters; legacy partial hash cannot prove long sources', () => {
    const input = fixture(); input.chat[0].mes = '甲'.repeat(6000) + '尾部';
    const ref = stateOf(input).checkpoints[0].range.refs[0];
    ref.hash = hash(`${input.chat[0].name}\n${'甲'.repeat(6000)}`);
    ref.key = `${input.chat[0].send_date}|${input.chat[0].name}|${hash('甲'.repeat(6000))}|0`;
    ref.fullHash = hash(`${input.chat[0].name}\n${input.chat[0].mes}`);
    assert.ok(readGagaMemoryContext(input).blocks.some(block => block.kind === 'summary'));
    input.chat[0].mes += '变'; assert.equal(readGagaMemoryContext(input).blocks.length, 0);
    delete ref.fullHash; assert.equal(readGagaMemoryContext(input).blocks.length, 0);
});
test('layered capsule selection respects committed coverage, original text overlap and current revisions', () => {
    const input = fixture({ memoryMode: 'layered' });
    stateOf(input).roundCapsules = [capsule(0, 1), capsule(2, 3), capsule(4, 5), capsule(6, 7)];
    input.recentStartIndex = 5;
    const output = readGagaMemoryContext(input), capsules = output.blocks.filter(block => block.kind === 'capsule');
    assert.equal(capsules.length, 2); assert.deepEqual(capsules.map(item => item.source.range), [{ start: 2, end: 3 }, { start: 4, end: 5 }]);
    assert.match(capsules[1].text, /新的剧情4/);
    stateOf(input).roundCapsules[1].text = '手工修订胶囊'; stateOf(input).roundCapsules[1].revision++;
    assert.match(readGagaMemoryContext(input).text, /手工修订胶囊/);
    assert.notEqual(readGagaMemoryContext(input).snapshot.fingerprint, output.snapshot.fingerprint);
});
test('invalid active capsule and its later chain are excluded, stable aggregate remains', () => {
    const input = fixture({ memoryMode: 'layered' }); stateOf(input).roundCapsules = [capsule(2, 3), capsule(4, 5)];
    input.chat[3].mes = '改变';
    const output = readGagaMemoryContext(input);
    assert.equal(output.status, 'partial'); assert.ok(output.blocks.some(block => block.kind === 'summary'));
    assert.equal(output.blocks.filter(block => block.kind === 'capsule').length, 0);
});
test('capsule-only layered startup works, manual mode does not accidentally consume dormant capsules', () => {
    const input = fixture({ memoryMode: 'layered' });
    Object.assign(stateOf(input), { checkpoints: [], facts: [], state: {}, threads: [], timeline: [], npcs: [], sceneCards: [],
        summaryArtifacts: { novel: '', structured: '', mixed: '' }, recap: '', lastProcessedIndex: -1, roundCapsules: [capsule(0, 1)] });
    const output = readGagaMemoryContext(input);
    assert.equal(output.status, 'ready'); assert.equal(output.blocks.length, 1);
    input.settings.memoryMode = 'manual'; assert.equal(readGagaMemoryContext(input).blocks.length, 0);
});
test('exact represented facts are not blindly duplicated, while omitted NPC fields are retained', () => {
    const input = fixture({ summaryMode: 'structured' }), state = stateOf(input);
    state.summaryArtifacts.structured = '桥上发现的钥匙已封存。小陈，警员，休假，等待归档。';
    state.checkpoints[0].memorySnapshot.summaryArtifacts.structured = state.summaryArtifacts.structured;
    const output = readGagaMemoryContext(input);
    assert.ok(!output.blocks.some(block => block.kind === 'facts'));
    const npcs = JSON.parse(output.blocks.find(block => block.kind === 'npcs').text);
    assert.equal(npcs[0].firstAppearance, '在桥边出现'); assert.equal(npcs[0].identity, undefined);
});
test('closed threads and resolved state are not reopened except explicitly locked records retain actual status', () => {
    const input = fixture(), state = stateOf(input);
    state.threads[0].status = 'resolved'; state.state.key.status = 'resolved';
    let output = readGagaMemoryContext(input);
    assert.ok(!output.blocks.some(block => block.kind === 'threads' || block.kind === 'state'));
    state.threads[0].userLocked = true; output = readGagaMemoryContext(input);
    assert.match(output.blocks.find(block => block.kind === 'threads').text, /resolved/);
});
test('large selected artifact is passed in full, not silently clipped or summarized', () => {
    const input = fixture(), state = stateOf(input); state.summaryArtifacts.mixed = '完整记忆'.repeat(30000);
    const output = readGagaMemoryContext(input);
    assert.equal(output.blocks[0].text.length, 120000);
    assert.equal(output.blocks[0].text, state.summaryArtifacts.mixed);
});
test('changed status is carried even when the record text was already present in the unchanged artifact', () => {
    const input = fixture(), state = stateOf(input);
    state.summaryArtifacts.mixed = '失踪者仍未找到。';
    state.checkpoints[0].memorySnapshot.summaryArtifacts.mixed = state.summaryArtifacts.mixed;
    state.threads[0].status = 'resolved'; state.threads[0].userLocked = true;
    const output = readGagaMemoryContext(input), item = JSON.parse(output.blocks.find(block => block.kind === 'threads').text)[0];
    assert.equal(item.status, 'resolved'); assert.equal(item.text, '失踪者仍未找到。');
});
test('deleting a record does not silently reintroduce it from an unchanged aggregate', () => {
    const input = fixture(), state = stateOf(input);
    state.summaryArtifacts.mixed = '已经删除的旧记忆';
    state.checkpoints[0].memorySnapshot.summaryArtifacts.mixed = state.summaryArtifacts.mixed;
    state.facts = [];
    const output = readGagaMemoryContext(input);
    assert.equal(output.status, 'partial'); assert.doesNotMatch(output.text, /已经删除的旧记忆|桥上发现的钥匙已封存/);
    assert.ok(output.diagnostics.some(item => item.code === 'artifact_withheld_after_record_removal'));
});
test('missing or modified record refs are isolated rather than borrowing an unrelated checkpoint proof', () => {
    const input = fixture(), state = stateOf(input);
    delete state.npcs[0].sourceRefs; state.facts[0].sourceRefs = source(6, 7).refs; input.chat[7].mes = '已改变';
    const output = readGagaMemoryContext(input);
    assert.equal(output.status, 'partial'); assert.ok(output.blocks.some(block => block.kind === 'summary'));
    assert.ok(!output.blocks.some(block => block.kind === 'npcs' || block.kind === 'facts'));
});
