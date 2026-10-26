import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoryActions, storyFingerprint } from '../yimu/story-runtime.mjs';
import { createDocument, createDefaults, fingerprintMessages } from '../yimu/contract.mjs';

const clone = value => structuredClone(value);
function deferred() { let resolve; return { promise: new Promise(yes => { resolve = yes; }), resolve: value => resolve(value) }; }
async function fixture() {
    const binding = { avatar: 'Actor.png', file: 'Original', integrity: 'source-identity' };
    const snapshot = { binding, messages: Array.from({ length: 8 }, (_, i) => ({ name: i % 2 ? 'Actor' : 'User', is_user: !(i % 2), mes: `Floor ${i + 1}`, send_date: `date-${i}` })), maxContext: 32768, maxResponse: 1024 };
    const state = { snapshot: clone(snapshot), document: createDocument(binding), defaults: createDefaults(), story: {} };
    state.document.enabled = true; const life = { disposed: false, generation: 0, generating: false };
    const calls = { plan: [], create: [], result: [], generate: [], open: [], refresh: [], confirm: [] }, events = [];
    let current = clone(snapshot), nextId = 0;
    const plan = { planId: 'plan-one', sourceBinding: binding, sourceRevision: state.document.revision, defaultsRevision: state.defaults.revision,
        sourceFingerprint: await storyFingerprint(snapshot.messages), mode: 'continue', cutoff: 8, total: 8, recent: 5, bridgeCount: 5,
        manualChoices: [], boundaries: [] };
    const target = { ...binding, file: 'New story', integrity: 'new-integrity' };
    const complete = { status: 'complete', binding: target, document: createDocument(target), receipt: { id: 'create-1', status: 'complete', target } };
    const host = { snapshot: async () => clone(current), openStory: async (result, options) => { calls.open.push({ result: clone(result), options }); return { opened: false, message: '保留新聊天，未切换' }; },
        confirmStoryBoundary: async scope => { calls.confirm.push(clone(scope)); return true; },
        generate: async (prompt, options) => { calls.generate.push({ prompt, options }); return JSON.stringify({ slices: [{ start: 2, end: 4, text: '截止前的事实' }] }); } };
    const api = { planStory: async (b, payload) => { calls.plan.push({ binding: clone(b), payload }); return clone(plan); },
        createStory: async (b, operation) => { calls.create.push({ binding: clone(b), operation: clone(operation) }); return clone(complete); },
        storyResult: async (b, query) => { calls.result.push({ binding: clone(b), query }); return clone(complete); } };
    const action = createStoryActions({ state, host, api, emit: () => events.push(clone(state.story)), id: () => `create-${++nextId}`,
        lifecycle: () => life, refresh: async options => calls.refresh.push(options) });
    state.story = action.forBinding(binding);
    return { binding, snapshot, state, life, plan, target, complete, host, api, calls, action, events,
        current(value) { current = clone(value); state.snapshot = clone(value); state.story = action.forBinding(value.binding); } };
}

test('story planning rejects a disk fingerprint mismatch and a late source mutation before any generation or creation', async () => {
    const f = await fixture(); f.plan.sourceFingerprint = 'wrong';
    await assert.rejects(f.action('storyPlan', { mode: 'continue' }), /尚未完整保存/);
    assert.equal(f.calls.generate.length + f.calls.create.length, 0); assert.equal(f.state.story.plan, null);
    f.api.planStory = async () => { f.current({ ...f.snapshot, messages: [...f.snapshot.messages, { mes: 'new' }] }); return f.plan; };
    await assert.rejects(f.action('storyPlan', { mode: 'continue' }), /原文已变化/);
    assert.equal(f.calls.create.length, 0);
});

test('single story action plans internally before creating with no manual-choice UI payload', async () => {
    const f=await fixture();await f.action('storyContinue',{cutoff:8});
    assert.equal(f.calls.create.length,1);assert.deepEqual(f.calls.create[0].operation.manualChoices,[]);
    assert.equal(f.state.story.receipt.status,'complete');
    assert.equal(f.calls.confirm.length,0,'no model work means no confirmation');
});

test('continuation results retain only nonzero transfer omissions, including a later open retry', async () => {
    for (const [skipped, missing, expected] of [[0, 0, undefined], [2, 0, '2 份人工记忆留在原聊天'],
        [0, 3, '3 层较早正文留在原聊天'], [2, 3, '2 份人工记忆、3 层较早正文留在原聊天']]) {
        const f = await fixture(); f.plan.skippedManualCount = skipped; f.plan.unrepresentedFloorCount = missing;
        const result = await f.action('storyContinue', {cutoff: 8});
        assert.equal(result.transferNote, expected); assert.equal(f.state.story.result.transferNote, expected);
        assert.equal(result.openResult.opened, false);
        f.host.openStory = async () => ({opened: true});
        const opened = await f.action('storyOpen'); assert.equal(opened.transferNote, expected);
        assert.equal(f.calls.create.length, 1, 'opening the completed file never recreates it');
        assert.equal(f.calls.generate.length, 0);
    }
});

test('boundary generation receives only cutoff-bounded raw text and manual choices pass through unchanged', async () => {
    const f = await fixture(), hashes = await fingerprintMessages(f.snapshot.messages);
    f.plan.mode = 'branch'; f.plan.cutoff = 4;
    f.plan.boundaries = [{ id: 'boundary', source: { start: 2, end: 4, hashes: hashes.slice(1, 4) },
        messages: f.snapshot.messages.slice(1, 4).map((message, index) => ({ ...message, floor: index + 2 })) }];
    f.plan.manualChoices = [{ id: 'edited', revision: 3, reason: 'crossing-edited' }];
    await f.action('storyPlan', { mode: 'branch', cutoff: 4 });
    const choices = [{ id: 'edited', revision: 3, text: '用户确认的截止前人工内容' }];
    await f.action('storyCreate', { manualChoices: choices });
    assert.deepEqual(f.calls.confirm,[{ranges:[{start:2,end:4}]}]);
    assert.equal(f.calls.generate.length, 1);
    assert.match(f.calls.generate[0].prompt, /Floor 2/); assert.match(f.calls.generate[0].prompt, /Floor 4/);
    assert.doesNotMatch(f.calls.generate[0].prompt, /Floor 1|Floor 5|Floor 8|用户确认的截止前人工内容/);
    const operation = f.calls.create[0].operation;
    assert.deepEqual(operation.manualChoices, choices);
    assert.deepEqual(operation.boundarySummaries[0].entries[0].source, f.plan.boundaries[0].source);
    assert.equal(f.state.story.receipt.status, 'complete'); assert.equal(f.calls.open.length, 1);
});

async function addBoundary(f) {
    const hashes = await fingerprintMessages(f.snapshot.messages);
    f.plan.boundaries = [{id: 'edge', source: {start: 2, end: 4, hashes: hashes.slice(1, 4)},
        messages: f.snapshot.messages.slice(1, 4).map((message, index) => ({...message, floor: index + 2}))}];
}

test('cancelled boundary confirmation performs no model or file work and a later explicit attempt asks again', async () => {
    const f = await fixture(); await addBoundary(f);
    let approved = false;
    f.host.confirmStoryBoundary = async scope => { f.calls.confirm.push(scope); return approved; };
    assert.deepEqual(await f.action('storyContinue', {cutoff: 4}), {cancelled: true});
    assert.equal(f.calls.generate.length + f.calls.create.length + f.calls.open.length, 0);
    assert.equal(f.state.story.plan, null); assert.ok(!f.state.story.pending); assert.equal(f.state.story.error, '');
    approved = true; await f.action('storyContinue', {cutoff: 4});
    assert.equal(f.calls.confirm.length, 2); assert.equal(f.calls.generate.length, 1); assert.equal(f.calls.create.length, 1);
});

test('missing or ambiguous confirmation never grants permission for paid boundary work', async () => {
    for (const answer of ['missing', undefined, 1, 'true']) {
        const f = await fixture(); await addBoundary(f);
        if (answer === 'missing') delete f.host.confirmStoryBoundary;
        else f.host.confirmStoryBoundary = async () => answer;
        if (answer === 'missing') await assert.rejects(f.action('storyContinue', {cutoff: 4}), /无法确认/);
        else assert.deepEqual(await f.action('storyContinue', {cutoff: 4}), {cancelled: true});
        assert.equal(f.calls.generate.length + f.calls.create.length, 0);
    }
});

test('late boundary approval cannot authorize changed chat, source, memory, settings or summary connection', async () => {
    for (const change of [f => f.current({...f.snapshot, binding: {...f.binding, file: 'Other'}}),
        f => f.current({...f.snapshot, messages: [...f.snapshot.messages, {mes: 'new'}]}),
        f => f.state.document.revision++, f => f.state.defaults.revision++, f => f.life.generating = true,
        f => f.life.disposed = true, f => f.host.summaryConnection = () => ({mode: 'st', model: 'changed'})]) {
        const f = await fixture(); await addBoundary(f);
        f.host.summaryConnection = () => ({mode: 'st', model: 'original'});
        f.host.confirmStoryBoundary = async () => { change(f); return true; };
        await assert.rejects(f.action('storyContinue', {cutoff: 4}), /已变化/);
        assert.equal(f.calls.generate.length + f.calls.create.length, 0);
    }
});

test('unknown creation retries reuse already approved boundary summaries without another confirmation or model call', async () => {
    const f = await fixture(); await addBoundary(f);
    f.api.createStory = async (binding, operation) => { f.calls.create.push({binding, operation: clone(operation)}); throw new Error('offline'); };
    f.api.storyResult = async () => null;
    await assert.rejects(f.action('storyContinue', {cutoff: 4}), /offline/);
    assert.equal(f.state.story.pending, true); assert.equal(f.calls.confirm.length, 1); assert.equal(f.calls.generate.length, 1);
    f.api.createStory = async (binding, operation) => { f.calls.create.push({binding, operation: clone(operation)}); return clone(f.complete); };
    await f.action('storyCreate', {retry: true});
    assert.deepEqual(f.calls.create[1], f.calls.create[0]);
    assert.equal(f.calls.confirm.length, 1); assert.equal(f.calls.generate.length, 1);
});

test('multiple automatic boundaries use one confirmation covering all and only the planned ranges', async () => {
    const f = await fixture(), hashes = await fingerprintMessages(f.snapshot.messages);
    f.plan.boundaries = [[1, 2], [3, 4]].map(([start, end]) => ({id: `edge_${start}`, source: {start, end, hashes: hashes.slice(start - 1, end)},
        messages: f.snapshot.messages.slice(start - 1, end).map((message, index) => ({...message, floor: start + index}))}));
    f.host.generate = async prompt => {
        assert.equal(f.calls.confirm.length, 1, 'approval precedes every model call'); f.calls.generate.push(prompt);
        const [, start, end] = prompt.match(/完整覆盖第(\d+)至(\d+)层/);
        return JSON.stringify({slices: [{start: Number(start), end: Number(end), text: '范围内的事实'}]});
    };
    await f.action('storyContinue', {cutoff: 4});
    assert.deepEqual(f.calls.confirm, [{ranges: [{start: 1, end: 2}, {start: 3, end: 4}]}]);
    assert.equal(f.calls.generate.length, 2); assert.equal(f.calls.create.length, 1);
});

test('continuation boundary generation uses the chosen character cap, never a different hidden default',async()=>{
    for(const [cap,length,accepted]of[[3,4,false],[3000,2500,true]]){
        const f=await fixture(),hashes=await fingerprintMessages(f.snapshot.messages);
        f.state.document.settings.sliceChars=cap;
        f.plan.boundaries=[{id:'edge',source:{start:2,end:4,hashes:hashes.slice(1,4)},messages:f.snapshot.messages.slice(1,4).map((m,i)=>({...m,floor:i+2}))}];
        f.host.generate=async()=>JSON.stringify({slices:[{start:2,end:4,title:'截至此处',text:'文'.repeat(length)}]});
        await f.action('storyPlan',{cutoff:4});
        if(accepted){await f.action('storyCreate');assert.equal(f.calls.create[0].operation.boundarySummaries[0].entries[0].title,'截至此处');}
        else{await assert.rejects(f.action('storyCreate'),/超过 3 字上限/);assert.equal(f.calls.create.length,0);}
    }
});

test('stale plan source, document and default revisions fail before any paid boundary request', async () => {
    for (const mutate of [f => f.current({ ...f.snapshot, messages: [...f.snapshot.messages, { mes: 'new' }] }),
        f => { f.state.document.revision++; }, f => { f.state.defaults.revision++; }]) {
        const f = await fixture(); await f.action('storyPlan', { mode: 'continue' }); mutate(f);
        await assert.rejects(f.action('storyCreate', { manualChoices: [] }), /已变化/);
        assert.equal(f.calls.generate.length + f.calls.create.length, 0);
    }
});

test('lost creation acknowledgement uses a receipt query and never submits a second operation', async () => {
    const f = await fixture(); await f.action('storyPlan', { mode: 'continue' });
    f.api.createStory = async (binding, operation) => { f.calls.create.push({ binding, operation: clone(operation) }); throw new Error('lost ack'); };
    const result = await f.action('storyCreate', { manualChoices: [] });
    assert.equal(result.receipt.status, 'complete'); assert.equal(f.calls.create.length, 1);
    assert.deepEqual(f.calls.result[0].query, { id: f.calls.create[0].operation.id });
    assert.equal(f.state.story.pending, false); assert.equal(f.calls.open.length, 1);
});

test('unknown results retain the exact operation across chats; retry does not need reconstructed manual drafts', async () => {
    const f = await fixture(); await f.action('storyPlan', { mode: 'continue' });
    const choices = [{ id: 'manual', revision: 2, text: 'User confirmed' }];
    f.api.createStory = async (binding, operation) => { f.calls.create.push({ binding: clone(binding), operation: clone(operation) }); throw new Error('unknown'); };
    f.api.storyResult = async () => { throw new Error('offline'); };
    await assert.rejects(f.action('storyCreate', { manualChoices: choices }), /unknown/);
    assert.equal(f.state.story.pending, true);
    await assert.rejects(f.action('storyPlan', { mode: 'continue' }), /上次建立结果尚未确认/);
    const other = { ...f.snapshot, binding: { ...f.binding, file: 'Other', integrity: 'other-id' } };
    f.current(other); assert.equal(f.state.story.pending, undefined, 'another chat is not locked');
    f.current(f.snapshot); assert.equal(f.state.story.pending, true);
    f.api.createStory = async (binding, operation) => { f.calls.create.push({ binding: clone(binding), operation: clone(operation) }); return clone(f.complete); };
    await f.action('storyCreate', { retry: true });
    assert.deepEqual(f.calls.create[1], f.calls.create[0]); assert.equal(f.state.story.pending, false);
});

test('only explicit 4xx rejection plus confirmed absence releases an operation for replanning', async () => {
    for (const [status, found, cleared] of [[409, { status: 'missing' }, true], [503, { status: 'missing' }, false], [409, { status: 'pending' }, false], [409, null, false]]) {
        const f = await fixture(); await f.action('storyPlan', { mode: 'continue' });
        f.api.createStory = async () => { throw Object.assign(new Error('reject'), { status }); };
        f.api.storyResult = async () => found;
        await assert.rejects(f.action('storyCreate', { manualChoices: [] }), /reject/);
        assert.equal(f.state.story.pending, !cleared); assert.equal(f.state.story.plan === null, cleared);
    }
});

test('a server-confirmed failed receipt releases the operation without opening partial artifacts and permits a fresh plan', async () => {
    const f = await fixture(); await f.action('storyPlan', { mode: 'continue' });
    f.api.createStory = async (binding, operation) => { f.calls.create.push({ binding, operation: clone(operation) }); throw new Error('lost ack'); };
    f.api.storyResult = async () => ({ status: 'pending' });
    await assert.rejects(f.action('storyCreate', { manualChoices: [] }), /lost ack/);
    const failed = { status: 'failed', binding: f.target, receipt: { ...f.complete.receipt, status: 'failed' }, message: '来源已变化，本次建立已停止，请重新核对范围' };
    f.api.storyResult = async () => clone(failed);
    await assert.rejects(f.action('storyCreate', { retry: true }), /本次建立已停止/);
    assert.equal(f.state.story.pending, false); assert.equal(f.state.story.plan, null);
    assert.equal(f.state.story.result, null); assert.equal(f.state.story.receipt, null);
    assert.equal(f.calls.open.length, 0, 'a failed target is never opened as a complete story');
    assert.equal(f.calls.create[0].operation.id, f.calls.create[1].operation.id);
    await f.action('storyPlan', { mode: 'continue' });
    f.api.createStory = async (binding, operation) => { f.calls.create.push({ binding, operation: clone(operation) }); return clone(f.complete); };
    await f.action('storyCreate', { manualChoices: [] });
    assert.notEqual(f.calls.create[2].operation.id, f.calls.create[0].operation.id);
    assert.equal(f.calls.open.length, 1);
});

test('a generation beginning while a local snapshot is awaited rejects the operation before any model or create call', async () => {
    const f = await fixture(); await f.action('storyPlan', { mode: 'continue' });
    const original = f.host.snapshot, waiting = deferred(), started = deferred(); let reads = 0;
    f.host.snapshot = async () => {
        const value = await original();
        if (++reads === 2) { started.resolve(); await waiting.promise; }
        return value;
    };
    const creating = f.action('storyCreate', { manualChoices: [] }); await started.promise;
    f.life.generating = true; waiting.resolve();
    await assert.rejects(creating, /生成状态已变化/);
    assert.equal(f.calls.generate.length + f.calls.create.length, 0);
});

test('late creation remains attached to its source and never opens over a different current chat', async () => {
    const f = await fixture(); await f.action('storyPlan', { mode: 'continue' }); const wait = deferred(), began = deferred();
    f.api.createStory = async () => { began.resolve(); return wait.promise; };
    const creating = f.action('storyCreate', { manualChoices: [] }); await began.promise;
    const other = { ...f.snapshot, binding: { ...f.binding, file: 'Other', integrity: 'other-id' } };
    f.current(other); f.life.generation++;
    wait.resolve(f.complete); await creating;
    assert.equal(f.calls.open.length, 0); assert.equal(f.state.story.receipt, undefined);
    f.current(f.snapshot); assert.equal(f.state.story.receipt.status, 'complete');
});

test('a generation or source edit during boundary work discards the model result without creating a chat', async () => {
    const f = await fixture(), hashes = await fingerprintMessages(f.snapshot.messages);
    f.plan.boundaries = [{ id: 'edge', source: { start: 2, end: 4, hashes: hashes.slice(1, 4) }, messages: f.snapshot.messages.slice(1, 4).map((m, i) => ({ ...m, floor: i + 2 })) }];
    await f.action('storyPlan', { mode: 'continue' });
    f.host.generate = async () => { f.life.generating = true; return JSON.stringify({ slices: [{ start: 2, end: 4, text: 'late' }] }); };
    await assert.rejects(f.action('storyCreate', { manualChoices: [] }), /生成状态已变化/);
    assert.equal(f.calls.create.length, 0); assert.equal(f.state.story.pending, undefined);
});
