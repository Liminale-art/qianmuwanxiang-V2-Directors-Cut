import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createYimuStore, chatStorageName} from '../yimu/server-store.mjs';
import {fingerprintMessages, stageDependenciesValid, applyOperation, validateDocument, SCHEMA} from '../yimu/contract.mjs';
import {buildPlan} from '../yimu/core.mjs';
import {sceneDependenciesValid} from '../yimu/scene-contract.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
const binding = {avatar: 'Story.png', file: 'Original', integrity: 'original_identity'};
const clone = value => structuredClone(value);
async function fixture(t, {io = null} = {}) {
    const base = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(base, 'yimu-story-test-'));
    const account = path.join(root, 'account'), chats = path.join(account, 'chats'), folder = path.join(chats, 'Story');
    await fs.mkdir(folder, {recursive: true});
    const request = {user: {profile: {handle: 'fixture'}, directories: {root: account, chats}}};
    const messages = Array.from({length: 12}, (_, i) => ({name: i % 2 ? 'User' : 'Character', is_user: Boolean(i % 2), is_system: false,
        mes: `第 ${i + 1} 层故事。${i === 8 ? '第九层未来秘密' : ''}`, send_date: `2026-10-25T10:${String(i).padStart(2, '0')}:00Z`,
        extra: {private_plugin_future_summary: 'must-not-copy'}, swipes: ['future-other-swipe']}));
    const chatFile = path.join(folder, binding.file + '.jsonl');
    const writeChat = (items = messages) => fs.writeFile(chatFile, [{chat_metadata: {integrity: binding.integrity, foreign_future: 'must-not-copy'}}, ...items].map(JSON.stringify).join('\n') + '\n');
    await writeChat();
    const store = createYimuStore({hostCwd: root, ...(io ? {io} : {})});
    let sequence = 0;
    const change = (operation, target = binding) => store.change(request, target, {id: `op_${++sequence}`, ...operation});
    await change({type: 'enable', expectedRevision: 0, enabled: true, range: {start: 1, end: messages.length, total: messages.length}});
    const hashes = await fingerprintMessages(messages);
    const source = (start, end) => ({start, end, hashes: hashes.slice(start - 1, end)});
    const append = (id, start, end, text = `摘要 ${start}—${end}`) => change({type: 'append', expectedEpoch: 1, entry: {id, kind: 'summary', text, source: source(start, end)}});
    await append('early', 1, 3); await append('middle', 4, 6); await append('cross', 7, 9, '不能提前带入第九层未来秘密');
    const plan = (query = {mode: 'branch', cutoff: 8}, target = binding) => store.planStory(request, target, query);
    const operation = (p, id = 'story_one') => ({id, planId: p.planId, mode: p.mode, cutoff: p.cutoff, manualChoices: [],
        boundarySummaries: p.boundaries.map(item => ({id: item.id, entries: [{text: '仅截止前的边界摘要', source: item.source}]}))});
    t.after(async () => {const real = await fs.realpath(root); assert.equal(path.dirname(real), base); assert.match(path.basename(real), /^yimu-story-test-/); await fs.rm(real, {recursive: true, force: true});});
    return {root, account, chats, folder, request, messages, hashes, source, store, change, append, plan, operation, chatFile, writeChat};
}

test('plan exposes only safe boundary originals and excludes unlocated legacy notes at an earlier cutoff', async t => {
    const f = await fixture(t), filename=path.join(f.account,'.yimu',chatStorageName(binding));
    const envelope=JSON.parse(await fs.readFile(filename,'utf8'));
    envelope.value.entries.push({id:'manual',kind:'manual',text:'无来源手动背景',revision:1,status:'active',edited:true,source:null,placement:null,history:[],conflicts:[],candidate:null});
    envelope.value.entryOrder.push('manual');envelope.checksum=hash(JSON.stringify(envelope.value));await fs.writeFile(filename,JSON.stringify(envelope));
    const p = await f.plan();
    assert.equal(p.sourceFingerprint, hash(JSON.stringify(f.hashes)));
    assert.equal(p.offset, 3); assert.equal(p.bridgeCount, 5); assert.equal(p.inheritedCount, 2);
    assert.deepEqual(p.boundaries[0].messages.map(m => m.floor), [7, 8]);
    assert.ok(!JSON.stringify(p).includes('第九层未来秘密'));
    assert.deepEqual(p.manualChoices, []);assert.equal(p.skippedManualCount,1);
    assert.ok(!JSON.stringify(p).includes('无来源手动背景'));
    const end=await f.plan({cutoff:12});assert.equal(end.inheritedCount,4);
    assert.equal(await fs.readFile(f.chatFile, 'utf8').then(text => text.includes('future-other-swipe')), true);
});

test('creation copies only recent selected originals, independent memory and precise parent links without touching source bytes', async t => {
    const f = await fixture(t);
    await f.change({type: 'append', expectedEpoch: 1, expectedDefaultsRevision: 0, entry: {id: 'stage', kind: 'stage', text: '前六层阶段', source: {parents: [{id: 'early', revision: 1}, {id: 'middle', revision: 1}]}}});
    const sourceBytes = await fs.readFile(f.chatFile), sourceMemory = await fs.readFile(path.join(f.account, '.yimu', chatStorageName(binding)));
    const p = await f.plan(), op = f.operation(p), result = await f.store.createStory(f.request, binding, op);
    const {document} = result;
    assert.equal(document.enabled, true); assert.equal(document.lineage.offset, 3); assert.deepEqual(document.lineage.bridgeHashes, f.hashes.slice(3, 8));
    assert.equal(document.entries.length, 4); assert.equal(document.companion, undefined);
    for (const entry of document.entries) {assert.deepEqual(entry.origin.binding, binding); assert.equal(entry.origin.offset, 0); assert.deepEqual(entry.history, []); assert.deepEqual(entry.conflicts, []);}
    assert.equal(stageDependenciesValid(document.entries.find(e => e.kind === 'stage'), document), true);
    const text = await fs.readFile(path.join(f.folder, result.binding.file + '.jsonl'), 'utf8');
    const rows = text.trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 6); assert.equal(rows[0].chat_metadata.integrity, result.binding.integrity);
    assert.deepEqual(rows.slice(1).map(m => m.mes), f.messages.slice(3, 8).map(m => m.mes));
    assert.ok(!text.includes('future-other-swipe')); assert.ok(!text.includes('must-not-copy'));
    assert.deepEqual(await fs.readFile(f.chatFile), sourceBytes);
    assert.deepEqual(await fs.readFile(path.join(f.account, '.yimu', chatStorageName(binding))), sourceMemory);
    assert.equal(result.receipt.status, 'complete'); assert.equal(result.receipt.bridge.sourceStart, 4);
});

test('same operation resumes confirmed creation and never creates duplicates or overwrites collisions', async t => {
    const f = await fixture(t), p = await f.plan(), op = f.operation(p);
    const first = await f.store.createStory(f.request, binding, op);
    const again = await f.store.createStory(f.request, binding, op);
    assert.deepEqual(again, first);
    assert.equal((await f.store.storyResult(f.request, binding, {id: op.id})).status, 'complete');
    assert.equal((await f.store.storyResult(f.request, binding, {id: 'unused'})).status, 'missing');
    await assert.rejects(f.store.createStory(f.request, binding, {...op, cutoff: 7}), {code: 'yimu_story_collision'});
    assert.equal((await fs.readdir(f.folder)).filter(name => name.endsWith('.jsonl')).length, 2);
});

test('boundary coverage, old plan and changed source/settings are rejected before creating any chat', async t => {
    const f = await fixture(t), p = await f.plan();
    await assert.rejects(f.store.createStory(f.request, binding, {...f.operation(p), boundarySummaries: []}), {code: 'yimu_story_boundary'});
    const incomplete = f.operation(p); incomplete.boundarySummaries[0].entries[0].source = f.source(7, 7);
    await assert.rejects(f.store.createStory(f.request, binding, incomplete), {code: 'yimu_story_boundary'});
    const changed = clone(f.messages); changed[0].mes += '变更'; await f.writeChat(changed);
    await assert.rejects(f.store.createStory(f.request, binding, f.operation(p)), {code: 'yimu_story_changed'});
    assert.deepEqual((await fs.readdir(f.folder)).filter(name => name.endsWith('.jsonl')), ['Original.jsonl']);
});

test('crossing human stages never leak old future text or bypass manual authority using fine children', async t => {
    const f = await fixture(t);
    await f.change({type: 'append', expectedEpoch: 1, expectedDefaultsRevision: 0, entry: {id: 'stage', kind: 'stage', text: '跨边界阶段', source: {parents: [{id: 'early', revision: 1}, {id: 'middle', revision: 1}]}}});
    await f.change({type: 'edit', entryId: 'stage', expectedRevision: 1, text: '人工第六层秘密不可提前带入'});
    const p = await f.plan({mode: 'branch', cutoff: 4});
    assert.equal(p.inheritedCount, 0); assert.equal(p.boundaries.length, 0);
    assert.deepEqual(p.manualChoices,[]);assert.equal(p.skippedManualCount,1);
    assert.ok(!JSON.stringify(p).includes('第六层秘密'));
    const op=f.operation(p),result=await f.store.createStory(f.request,binding,op);
    assert.equal(result.document.entries.length,0);
});

test('manual applicability follows its verified floor, not draggable order, and inherited anchors retain their real source', async t => {
    const f=await fixture(t);
    for(const [id,floor,text]of[['early-note',3,'截止前自定义背景'],['late-note',10,'未来人工秘密']])await f.change({type:'append',entry:{id,kind:'manual',text,placement:{binding,fromFloor:floor,hash:f.hashes[floor-1]}}});
    let doc=(await f.store.read(f.request,binding)).document;
    await f.change({type:'reorder',expectedRevision:doc.revision,entryOrder:[...doc.entryOrder].reverse()});
    const p=await f.plan({cutoff:8});assert.equal(p.skippedManualCount,1);
    const created=await f.store.createStory(f.request,binding,f.operation(p));
    const early=created.document.entries.find(entry=>entry.text==='截止前自定义背景');assert.ok(early);assert.equal(early.source,null);
    assert.deepEqual(early.placement,{binding,fromFloor:3,hash:f.hashes[2]});assert.deepEqual(early.origin.binding,binding);
    assert.equal(created.document.entries.some(entry=>entry.text==='未来人工秘密'),false);
    doc=(await f.store.read(f.request,binding)).document;
    await f.change({type:'reorder',expectedRevision:doc.revision,entryOrder:doc.entryOrder,placements:{'late-note':{binding,fromFloor:2,hash:f.hashes[1]}}});
    const moved=await f.plan({cutoff:8});assert.equal(moved.skippedManualCount,0);assert.equal(moved.inheritedCount,p.inheritedCount+1);
    await f.writeChat(f.messages.map((message,index)=>index===1?{...message,mes:'锚点原文已变化'}:message));
    const changed=await f.plan({cutoff:8});assert.ok(changed.skippedManualCount>=1);
});

test('mixed and manual-only stages survive continuation with remapped parent identities', async t => {
    for(const manualOnly of [false,true]){
        const f=await fixture(t);
        for(const [id,floor]of[['note-a',2],['note-b',3]])await f.change({type:'append',entry:{id,kind:'manual',text:`自定义内容 ${id}`,placement:{binding,fromFloor:floor,hash:f.hashes[floor-1]}}});
        const parents=(manualOnly?['note-a','note-b']:['early','note-a','note-b','middle']).map(id=>({id,revision:1}));
        await f.change({type:'append',expectedEpoch:1,expectedDefaultsRevision:0,entry:{id:'mixed-stage',kind:'stage',text:'保留人工含义的阶段',source:{parents}}});
        const p=await f.plan({cutoff:8}),created=await f.store.createStory(f.request,binding,f.operation(p));
        const stage=created.document.entries.find(entry=>entry.kind==='stage');assert.ok(stage);assert.equal(stage.source.parents.length,parents.length);
        assert.equal(stageDependenciesValid(stage,created.document),true);if(manualOnly)assert.deepEqual(stage.source.ranges,[]);
        for(const ref of stage.source.parents){assert.ok(created.document.entries.some(entry=>entry.id===ref.id));assert.equal(ref.revision,1);}
        if(manualOnly){
            await f.writeChat(f.messages.map((message,index)=>index===1?{...message,mes:'人工锚点原文已改'}:message));
            const changed=await f.store.read(f.request,created.binding);
            assert.ok(changed.invalidSourceIds.includes(stage.id));assert.equal(changed.document.entries.find(entry=>entry.id===stage.id).originVerified,false);
        }
    }
});

test('scene inheritance references follow copied IDs and absent anchors become unknown rather than broken proof', async t => {
    const f=await fixture(t),file=path.join(f.account,'.yimu',chatStorageName(binding));
    const envelope=JSON.parse(await fs.readFile(file,'utf8'));
    envelope.value.entries[1].scenes=[{world:'世界A',date:'次日',period:'夜',place:'河边',characters:['甲'],nature:'present',evidence:{floors:[],inheritedFrom:{id:'early',revision:1}}}];
    envelope.checksum=hash(JSON.stringify(envelope.value));await fs.writeFile(file,JSON.stringify(envelope));
    const p=await f.plan({cutoff:8}),created=await f.store.createStory(f.request,binding,f.operation(p));
    const early=created.document.entries.find(entry=>entry.text==='摘要 1—3'),middle=created.document.entries.find(entry=>entry.text==='摘要 4—6');
    assert.deepEqual(middle.scenes[0].evidence.inheritedFrom,{id:early.id,revision:1});assert.equal(sceneDependenciesValid(middle,created.document),true);
    await f.change({type:'entry',entryId:'early',action:'exclude',expectedRevision:1});
    const without=await f.plan({cutoff:8}),separate=await f.store.createStory(f.request,binding,f.operation(without,'without-anchor'));
    const unknown=separate.document.entries.find(entry=>entry.text==='摘要 4—6');assert.equal(unknown.scenes[0].nature,'unknown');assert.equal(unknown.scenes[0].evidence.inheritedFrom,undefined);
});

test('real inherited manual proof permits budget selection and bridge edits remove its eligibility', async t => {
    const f=await fixture(t);
    await f.change({type:'append',entry:{id:'in-bridge',kind:'manual',text:'桥接内已确认的人工背景',placement:{binding,fromFloor:5,hash:f.hashes[4]}}});
    const p=await f.plan({cutoff:8}),created=await f.store.createStory(f.request,binding,f.operation(p));
    const read=await f.store.read(f.request,created.binding),manual=read.document.entries.find(entry=>entry.kind==='manual');
    assert.equal(manual.originVerified,true);assert.equal(manual.placementVerified,true);
    const target=path.join(f.folder,created.binding.file+'.jsonl'),rows=(await fs.readFile(target,'utf8')).trim().split('\n').map(JSON.parse),snapshot={binding:created.binding,messages:rows.slice(1),maxContext:32000,maxResponse:1000};
    const chosen=await buildPlan(read.document,read.defaults,snapshot);assert.ok(chosen.entries.some(entry=>entry.id===manual.id));
    rows[2].mes='分支桥接层已被修改';await fs.writeFile(target,rows.map(JSON.stringify).join('\n')+'\n');
    const changed=await f.store.read(f.request,created.binding),changedManual=changed.document.entries.find(entry=>entry.id===manual.id);
    assert.equal(changedManual.originVerified,false);assert.ok(changed.invalidSourceIds.includes(manual.id));
});

test('branch of a branch truncates inherited original coordinates rather than inheriting the first branch future', async t => {
    const f = await fixture(t), p = await f.plan({mode: 'branch', cutoff: 9});
    const first = await f.store.createStory(f.request, binding, f.operation(p));
    assert.equal(first.document.lineage.offset, 4);
    const secondPlan = await f.plan({mode: 'branch', cutoff: 2}, first.binding);
    assert.equal(secondPlan.offset, 4); assert.equal(secondPlan.inheritedCount, 2); assert.equal(secondPlan.boundaries.length, 0);
    const second = await f.store.createStory(f.request, first.binding, f.operation(secondPlan, 'branch_two'));
    assert.ok(second.document.entries.every(entry => entry.origin.offset + entry.source.end <= 6));
    assert.ok(!JSON.stringify(second.document).includes('第九层未来秘密'));
});

test('foreign source changes and modified bridge invalidate only affected inherited entries in this branch', async t => {
    const f = await fixture(t), p = await f.plan(), result = await f.store.createStory(f.request, binding, f.operation(p));
    const initial = await f.store.read(f.request, result.binding);
    assert.ok(initial.document.entries.every(entry => entry.originVerified));
    const targetFile = path.join(f.folder, result.binding.file + '.jsonl'), rows = (await fs.readFile(targetFile, 'utf8')).trim().split('\n').map(JSON.parse);
    rows[1].mes += '分支自己的改写'; await fs.writeFile(targetFile, rows.map(JSON.stringify).join('\n') + '\n');
    const branchChanged = await f.store.read(f.request, result.binding);
    const middle = branchChanged.document.entries.find(entry => entry.text === '摘要 4—6');
    assert.ok(branchChanged.invalidSourceIds.includes(middle.id));
    assert.equal(branchChanged.document.entries.find(entry => entry.text === '摘要 1—3').originVerified, true);
    const originalChanged = clone(f.messages); originalChanged[0].mes += '源变化'; await f.writeChat(originalChanged);
    const changed = await f.store.read(f.request, result.binding);
    assert.ok(changed.invalidSourceIds.includes(changed.document.entries.find(entry => entry.text === '摘要 1—3').id));
    assert.equal(changed.sourceAvailable, true);
});

test('new local summaries may reuse inherited floor numbers, but foreign redo and forged origins remain blocked', async t => {
    const f = await fixture(t), p = await f.plan(), result = await f.store.createStory(f.request, binding, f.operation(p));
    const entry = result.document.entries[0];
    assert.throws(() => applyOperation(result.document, {id: 'redo', type: 'redo', entryId: entry.id, expectedRevision: 1, expectedEpoch: 1, entry}), /继承摘要/);
    assert.throws(() => applyOperation(result.document, {id: 'fake', type: 'append', expectedEpoch: 1, entry: {...entry, id: 'fake'}}), /继承来源/);
    const local = applyOperation(result.document, {id: 'local', type: 'append', expectedEpoch: 1, entry: {id: 'local', kind: 'summary', text: '新的第六层', source: f.source(6, 6)}});
    assert.equal(local.document.entries.at(-1).id, 'local');
    assert.throws(() => applyOperation(result.document, {id: 'bridge', type: 'append', expectedEpoch: 1, entry: {id: 'bridge', kind: 'summary', text: '错误重整衔接', source: f.source(1, 1)}}), /衔接原文/);
    const transient = clone(result.document); transient.entries[0].originVerified = true;
    assert.equal(validateDocument(transient).entries[0].originVerified, undefined);
    assert.equal(result.document.schema, SCHEMA);
});

test('excluded, deleted and invalid manually edited stages do not revive their children in a new branch', async t => {
    for (const action of ['exclude', 'delete', 'invalid']) {
        const f = await fixture(t);
        await f.change({type: 'append', expectedEpoch: 1, expectedDefaultsRevision: 0, entry: {id: 'stage', kind: 'stage', text: '保护的阶段', source: {parents: [{id: 'early', revision: 1}, {id: 'middle', revision: 1}]}}});
        if (action === 'invalid') {
            await f.change({type: 'edit', entryId: 'stage', expectedRevision: 1, text: '人工修订的阶段'});
            await f.change({type: 'invalidate', entries: [{id: 'stage', revision: 2}]});
        } else await f.change({type: 'entry', entryId: 'stage', expectedRevision: 1, action});
        const p = await f.plan(); assert.equal(p.inheritedCount, 0); assert.equal(p.boundaries.length, 1);
    }
});

test('failure after create-only raw save leaves a pending receipt and retries finish the exact same target', async t => {
    const f = await fixture(t), p = await f.plan(), op = f.operation(p);
    let targetWrites = 0;
    const faulty = createYimuStore({hostCwd: f.root, io: {...fs, async rename(from, to) {
        if (path.dirname(to) === path.join(f.account, '.yimu') && to !== path.join(f.account, '.yimu', chatStorageName(binding))) {
            targetWrites++;
            if (targetWrites === 2) throw Object.assign(new Error('synthetic receipt-save failure'), {code: 'EIO'});
        }
        return fs.rename(from, to);
    }}});
    await assert.rejects(faulty.createStory(f.request, binding, op), /synthetic/);
    const pending = await f.store.storyResult(f.request, binding, {id: op.id});
    assert.equal(pending.status, 'pending');
    assert.equal((await f.store.read(f.request, pending.binding)).sourceAvailable, false);
    const before = await fs.readFile(path.join(f.folder, pending.binding.file + '.jsonl'));
    const saved = await f.store.createStory(f.request, binding, op);
    assert.equal(saved.receipt.status, 'complete'); assert.deepEqual(saved.binding, pending.binding);
    assert.deepEqual(await fs.readFile(path.join(f.folder, pending.binding.file + '.jsonl')), before);
    assert.equal((await fs.readdir(f.folder)).filter(name => name.endsWith('.jsonl')).length, 2);
});

test('pending creation cannot be completed from a changed source, and completed replay checks its target still exists', async t => {
    const f = await fixture(t), p = await f.plan(), op = f.operation(p);
    const faulty = createYimuStore({hostCwd: f.root, io: {...fs, async open(target, flags, ...rest) {
        if (target !== f.chatFile && target.endsWith('.jsonl') && flags === 'wx') throw Object.assign(new Error('synthetic new-chat unavailable'), {code: 'EIO'});
        return fs.open(target, flags, ...rest);
    }}});
    await assert.rejects(faulty.createStory(f.request, binding, op), /synthetic/);
    assert.equal((await f.store.storyResult(f.request, binding, {id: op.id})).status, 'pending');
    const altered = clone(f.messages); altered[0].mes += '源已改变'; await f.writeChat(altered);
    await assert.rejects(f.store.createStory(f.request, binding, op), {code: 'yimu_story_changed'});
    assert.equal((await f.store.storyResult(f.request, binding, {id: op.id})).status, 'failed');
    await f.writeChat();
    await assert.rejects(f.store.createStory(f.request, binding, op), {code: 'yimu_story_failed'});
    const next = f.operation(await f.plan(), 'fresh_after_failure');
    const complete = await f.store.createStory(f.request, binding, next);
    await fs.rename(path.join(f.folder, complete.binding.file + '.jsonl'), path.join(f.root, 'preserved-created-chat.jsonl'));
    await assert.rejects(f.store.createStory(f.request, binding, next), {code: 'yimu_source_missing'});
    await assert.rejects(f.store.storyResult(f.request, binding, {id: next.id}), {code: 'yimu_source_missing'});
});

test('an unrelated existing destination without an integrity slug is never adopted or overwritten', async t => {
    const f = await fixture(t), p = await f.plan(), op = f.operation(p);
    const targetHash = hash(JSON.stringify([binding, op.id]));
    const target = path.join(f.folder, `${binding.file}-忆幕-${targetHash.slice(0, 20)}.jsonl`);
    const original = Buffer.from('{"chat_metadata":{}}\n{"mes":"keep this unrelated file"}\n'); await fs.writeFile(target, original);
    await assert.rejects(f.store.createStory(f.request, binding, op), {code: 'yimu_story_collision'});
    assert.deepEqual(await fs.readFile(target), original);
    assert.equal((await f.store.storyResult(f.request, binding, {id: op.id})).status, 'missing');
});

test('source memory edits do not synchronize copied branch text, and source loss never erases branch data', async t => {
    const f = await fixture(t), p = await f.plan(), result = await f.store.createStory(f.request, binding, f.operation(p));
    await f.change({type: 'edit', entryId: 'early', expectedRevision: 1, text: '原分支之后自己的修订'});
    const fresh = await f.store.read(f.request, result.binding);
    assert.equal(fresh.document.entries.find(entry => entry.text === '摘要 1—3').originVerified, true);
    assert.ok(!fresh.document.entries.some(entry => entry.text === '原分支之后自己的修订'));
    await fs.rename(f.chatFile, path.join(f.root, 'preserved-source.jsonl'));
    const unavailable = await f.store.read(f.request, result.binding);
    assert.equal(unavailable.sourceAvailable, true);
    assert.equal(unavailable.invalidSourceIds.length, result.document.entries.length);
    assert.equal(unavailable.document.entries.length, result.document.entries.length);
});

test('schema 3 remains read-only until the first write preserves exact legacy bytes', async t => {
    const f = await fixture(t), filename = path.join(f.account, '.yimu', chatStorageName(binding));
    const raw = JSON.parse(await fs.readFile(filename, 'utf8')); raw.value.schema = 3; raw.checksum = hash(JSON.stringify(raw.value));
    const bytes = Buffer.from(JSON.stringify(raw, null, 2)); await fs.writeFile(filename, bytes);
    assert.equal((await f.store.read(f.request, binding)).document.schema, SCHEMA);
    assert.deepEqual(await fs.readFile(filename), bytes);
    await f.change({type: 'append', entry: {id: 'upgrade', kind: 'manual', text: '保留旧格式原件',placement:{binding,fromFloor:1,hash:f.hashes[0]}}});
    assert.deepEqual(await fs.readFile(filename + '.schema3.bak'), bytes);
    assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).value.schema, SCHEMA);
});

test('ST edits during pending-memory persistence or raw readback prevent a complete receipt', async t => {
    for (const phase of ['pending', 'raw']) {
        const f = await fixture(t), p = await f.plan(), op = f.operation(p); let changed = false;
        const alter = async () => {changed = true; const messages = clone(f.messages); messages[0].mes += 'ST并行改动'; await f.writeChat(messages);};
        const io = {...fs,
            async rename(from, to) {
                await fs.rename(from, to);
                if (phase === 'pending' && !changed && path.dirname(to) === path.join(f.account, '.yimu') && to !== path.join(f.account, '.yimu', chatStorageName(binding))) await alter();
            },
            async open(target, flags, ...args) {
                const file = await fs.open(target, flags, ...args);
                if (phase === 'raw' && !changed && target.endsWith('.jsonl') && target !== f.chatFile && typeof flags === 'number') await alter();
                return file;
            },
        };
        const racing = createYimuStore({hostCwd: f.root, io});
        await assert.rejects(racing.createStory(f.request, binding, op), {code: 'yimu_story_changed'});
        assert.equal((await f.store.storyResult(f.request, binding, {id: op.id})).status, 'failed');
        assert.equal((await f.store.storyResult(f.request, binding, {id: op.id})).status, 'failed');
        assert.equal(changed, true);
    }
});

test('temporary source permission failures keep pending status and never falsely finalize the operation', async t => {
    const f = await fixture(t), p = await f.plan(), op = f.operation(p);
    const interrupted = createYimuStore({hostCwd: f.root, io: {...fs, async open(target, flags, ...rest) {
        if (target !== f.chatFile && target.endsWith('.jsonl') && flags === 'wx') throw Object.assign(new Error('synthetic temporary outage'), {code: 'EIO'});
        return fs.open(target, flags, ...rest);
    }}});
    await assert.rejects(interrupted.createStory(f.request, binding, op));
    const inaccessible = createYimuStore({hostCwd: f.root, io: {...fs, async open(target, ...rest) {
        if (target === f.chatFile) throw Object.assign(new Error('synthetic permission denial'), {code: 'EACCES'});
        return fs.open(target, ...rest);
    }}});
    await assert.rejects(inaccessible.storyResult(f.request, binding, {id: op.id}), {code: 'yimu_source_access'});
    assert.equal((await f.store.storyResult(f.request, binding, {id: op.id})).status, 'pending');
    assert.equal((await f.store.createStory(f.request, binding, op)).receipt.status, 'complete');
});

test('inherited sources follow only the existing trusted rename chain, including boundary reads and manual edits', async t => {
    const f = await fixture(t), p = await f.plan({mode: 'branch', cutoff: 9});
    const branch = await f.store.createStory(f.request, binding, f.operation(p));
    const moved = {...binding, file: 'Renamed-once'}, final = {...binding, file: 'Renamed-twice'};
    await fs.rename(f.chatFile, path.join(f.folder, moved.file + '.jsonl'));
    await f.store.rename(f.request, binding, moved);
    await fs.rename(path.join(f.folder, moved.file + '.jsonl'), path.join(f.folder, final.file + '.jsonl'));
    await f.store.rename(f.request, moved, final);
    const fresh = await f.store.read(f.request, branch.binding);
    assert.deepEqual(fresh.invalidSourceIds, []);
    assert.ok(fresh.document.entries.every(entry => entry.originVerified));
    assert.equal((await f.store.read(f.request, binding)).sourceAvailable, false, 'normal current-chat reads must not follow the alias');
    const first = fresh.document.entries[0];
    const changed = await f.change({type: 'edit', entryId: first.id, expectedRevision: 1, text: '在本分支保留的人工修订'}, branch.binding);
    assert.equal(changed.document.entries.find(entry => entry.id === first.id).edited, true);
    const secondPlan = await f.plan({mode: 'branch', cutoff: 4}, branch.binding);
    assert.equal(secondPlan.boundaries.length, 1);
    assert.deepEqual(secondPlan.boundaries[0].messages.map(message => message.floor), [7, 8]);
    assert.ok(!JSON.stringify(secondPlan).includes('第九层未来秘密'));
    const second = await f.store.createStory(f.request, branch.binding, f.operation(secondPlan, 'after_source_rename'));
    assert.equal(second.receipt.status, 'complete');
    assert.ok((await f.store.read(f.request, second.binding)).document.entries.every(entry => !entry.origin || entry.originVerified));
});

test('missing sources without rename proof, wrong-identity alias records and alias cycles never authorize inherited memories', async t => {
    for (const mode of ['missing', 'identity', 'cycle']) {
        const f = await fixture(t), p = await f.plan(), branch = await f.store.createStory(f.request, binding, f.operation(p));
        const moved = {...binding, file: 'Other-location'};
        await fs.rename(f.chatFile, path.join(f.folder, moved.file + '.jsonl'));
        if (mode !== 'missing') {
            await f.store.rename(f.request, binding, moved);
            const mutate = async (name, change) => {
                const file = path.join(f.account, '.yimu', chatStorageName(name));
                const raw = JSON.parse(await fs.readFile(file, 'utf8')); change(raw.value);
                raw.checksum = hash(JSON.stringify(raw.value)); await fs.writeFile(file, JSON.stringify(raw));
            };
            if (mode === 'identity') await mutate(binding, value => {value.movedTo.integrity = 'different_identity';});
            else {
                await fs.rename(path.join(f.folder, moved.file + '.jsonl'), path.join(f.root, 'preserved-cycle-original.jsonl'));
                await mutate(moved, value => {value.movedTo = binding;});
            }
        }
        const fresh = await f.store.read(f.request, branch.binding);
        assert.equal(fresh.sourceAvailable, true);
        assert.equal(fresh.invalidSourceIds.length, branch.document.entries.length);
        assert.ok(fresh.document.entries.every(entry => entry.originVerified === false));
    }
});
