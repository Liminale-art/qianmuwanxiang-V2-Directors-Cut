import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createDefaults, applyOperation, canUndoText, validateDocument, fingerprintMessages, DEFAULTS } from '../yimu/contract.mjs';
import { memoryTitle, validateMemoryTitle, MEMORY_TITLE_LIMIT } from '../yimu/timeline.mjs';
import { summaryPrompt, parseSummary, nextBatch, buildPlan, summaryCoverage, planManualRange } from '../yimu/core.mjs';
import { stagePrompt, parseStage, planStageRange, nextStage } from '../yimu/layers.mjs';
import { stageSourceFromParents, stageDependenciesValid } from '../yimu/stage-contract.mjs';
import { portableDocument, restoreBackupDocument, collectBackupSources } from '../yimu/backup-contract.mjs';
import { mergeBackupDocument } from '../yimu/backup-merge.mjs';

const binding = { avatar: 'Retention.png', file: 'Synthetic', integrity: 'retention-fixture' };
const messages = Array.from({ length: 20 }, (_, i) => ({ name: '合成人物', mes: `第${i + 1}层，桥边等信的故事。`, send_date: `${i}` }));
const change = (doc, op) => applyOperation(doc, op).document;
const get = (doc, id) => doc.entries.find(entry => entry.id === id);
async function fixture(count = 13) {
    const hashes = await fingerprintMessages(messages);
    let doc = change(createDocument(binding), { id: 'enable', type: 'enable', enabled: true, expectedRevision: 0, range: { start: 1, end: count, total: messages.length } });
    doc = change(doc, { id: 'auto', type: 'autoSummary', value: true, expectedRevision: doc.configRevision });
    for (let i = 1; i <= count; i++) doc = change(doc, { id: `append_${i}`, type: 'append', expectedEpoch: doc.epoch,
        entry: { id: `fine_${i}`, kind: 'summary', title: `桥边来信${i}`, text: `第${i}份原有正文`, source: { start: i, end: i, hashes: [hashes[i - 1]] } } });
    return { doc, hashes };
}
const addCustom = (doc, hashes, id = 'custom', floor = 1, afterId = 'fine_1') => change(doc, { id: `append_${id}`, type: 'append', afterId,
    entry: { id, kind: 'manual', title: '独处的约定', text: '她不知道信中的秘密。', source: null, placement: { binding, fromFloor: floor, hash: hashes[floor - 1] } } });
const refs = (doc, ids) => ids.map(id => ({ id, revision: get(doc, id).revision }));
async function discardedRangeFixture() {
    const hashes = await fingerprintMessages(messages);
    let doc = change(createDocument(binding), { id: 'range_enable', type: 'enable', enabled: true, expectedRevision: 0, range: { start: 1, end: 3, total: messages.length } });
    doc = change(doc, { id: 'range_auto', type: 'autoSummary', value: true, expectedRevision: doc.configRevision });
    doc = change(doc, { id: 'range_seed', type: 'append', expectedEpoch: doc.epoch,
        entry: { id: 'range_old', kind: 'summary', text: '旧稿不可恢复', source: { start: 1, end: 3, hashes: hashes.slice(0, 3) } } });
    const oldBackup = structuredClone(doc);
    doc = change(doc, { id: 'range_delete', type: 'entry', action: 'delete', entryId: 'range_old', expectedRevision: 1 });
    for (let i = 1; i <= 10; i++) {
        doc = addCustom(doc, hashes, `later_deleted_${i}`, 3, null);
        doc = change(doc, { id: `later_delete_${i}`, type: 'entry', action: 'delete', entryId: `later_deleted_${i}`, expectedRevision: 1 });
    }
    return { doc, hashes, oldBackup };
}

test('generated summaries request source-faithful short names and validate Unicode length without a model fallback request', async () => {
    const { hashes } = await fixture(2), batch = { start: 1, end: 2 };
    assert.equal(MEMORY_TITLE_LIMIT, 8);
    assert.match(summaryPrompt(messages, batch, DEFAULTS), /"title"/);
    assert.match(summaryPrompt(messages, batch, DEFAULTS), /不超过8/);
    const response = title => JSON.stringify({ slices: [{ start: 1, end: 2, title, text: '桥边一起等信。' }] });
    assert.equal(parseSummary(response('桥边等信'), batch, hashes)[0].title, '桥边等信');
    assert.equal(validateMemoryTitle('𠮷'.repeat(8)), '𠮷'.repeat(8));
    assert.throws(() => parseSummary(response('𠮷'.repeat(9)), batch, hashes), /最多 8 字/);
    assert.throws(() => validateMemoryTitle('两行\n标题'), /最多 8 字/);
    const legacy = { kind: 'summary', text: '桥边重逢。后续情节', history: [] }, before = structuredClone(legacy);
    assert.equal(memoryTitle(legacy), '桥边重逢'); assert.deepEqual(legacy, before);
    assert.equal(memoryTitle({ kind: 'manual', text: '私有正文不会变成默认标题' }), '自定义切片');
    assert.equal(parseSummary(response(undefined), batch, hashes)[0].title, '桥边一起等信');
});

test('custom renaming participates in conflict preservation and text undo while shield and placement stay intact', async () => {
    const f = await fixture(2); let doc = addCustom(f.doc, f.hashes);
    doc = change(doc, { id: 'rename', type: 'edit', entryId: 'custom', expectedRevision: 1, title: '桥边约定', text: get(doc, 'custom').text });
    assert.equal(get(doc, 'custom').title, '桥边约定'); assert.equal(canUndoText(get(doc, 'custom')), true);
    doc = change(doc, { id: 'shield', type: 'entry', action: 'exclude', entryId: 'custom', expectedRevision: 2 });
    doc = change(doc, { id: 'undo_rename', type: 'entry', action: 'undoText', entryId: 'custom', expectedRevision: 3 });
    assert.equal(get(doc, 'custom').title, '独处的约定'); assert.equal(get(doc, 'custom').status, 'excluded');
    assert.deepEqual(get(doc, 'custom').placement, { binding, fromFloor: 1, hash: f.hashes[0] });
    assert.equal(canUndoText(get(doc, 'custom')), false);
    const conflict = applyOperation(doc, { id: 'late_name', type: 'edit', entryId: 'custom', expectedRevision: 1, title: '另一端标题', text: '另一端正文' });
    assert.equal(conflict.outcome, 'conflict'); assert.equal(get(conflict.document, 'custom').conflicts[0].title, '另一端标题');
    assert.equal(get(conflict.document, 'custom').title, '独处的约定');
    assert.throws(() => change(doc, { id: 'long', type: 'edit', entryId: 'custom', expectedRevision: 4, title: '很'.repeat(9), text: '原文' }), /最多 8/);
});

test('manual stages exclude custom by default, include only in-range custom when selected, and persist their exact policy', async () => {
    const f = await fixture(4); let doc = addCustom(f.doc, f.hashes);
    doc = addCustom(doc, f.hashes, 'later', 4, 'fine_4');
    const off = planStageRange(doc, DEFAULTS, { start: 1, end: 2 });
    assert.deepEqual(off.parents.map(entry => entry.id), ['fine_1', 'fine_2']); assert.equal(off.includeCustom, false);
    const source = stageSourceFromParents(doc, refs(doc, ['fine_1', 'fine_2']), { includeCustom: false });
    assert.equal(source.includeCustom, false);
    const stage = parseStage('{"title":"桥边记事","text":"相遇与约定"}', off.parents, DEFAULTS, { includeCustom: false });
    doc = change(doc, { id: 'save_stage', type: 'append', expectedEpoch: doc.epoch, entry: { ...stage, id: 'stage' } });
    assert.equal(stageDependenciesValid(get(doc, 'stage'), doc), true);
    assert.equal(get(portableDocument(doc), 'stage').source.includeCustom, false);
    assert.equal(get(doc, 'custom').text, '她不知道信中的秘密。');
    const included = planStageRange(addCustom(f.doc, f.hashes), DEFAULTS, { start: 1, end: 2, includeCustom: true });
    assert.deepEqual(included.parents.map(entry => entry.id), ['fine_1', 'custom', 'fine_2']);
    assert.throws(() => stageSourceFromParents(doc, refs(doc, ['fine_1', 'custom', 'fine_2']), { includeCustom: false }), /未选择包含/);
    assert.throws(() => change(f.doc, { id: 'bad_stage_flag', type: 'append', expectedEpoch: f.doc.epoch,
        entry: { id: 'bad', kind: 'stage', text: '不能伪造选项', source: { parents: refs(f.doc, ['fine_1', 'fine_2']), includeCustom: 'false' } } }), /选项无效/);
    assert.match(stagePrompt(included.parents, DEFAULTS), /"title"/);
    assert.match(stagePrompt(included.parents, DEFAULTS), /不超过8/);
    assert.throws(() => parseStage(JSON.stringify({title:'𠮷'.repeat(9),text:'相遇与约定'}), included.parents, DEFAULTS), /最多 8 字/);
    const automatic = nextStage(addCustom(f.doc, f.hashes), { ...DEFAULTS, stageAuto: true, stageRecent: 0, stageThreshold: 1 });
    assert.ok(automatic.parents.some(entry => entry.id === 'custom'), 'automatic custom preservation stays unchanged');
});

test('only ten recent deleted bodies survive; guards preserve excluded floors without injecting content or restoring', async () => {
    const f = await fixture(); let doc = f.doc;
    for (let i = 1; i <= 12; i++) doc = change(doc, { id: `delete_${i}`, type: 'entry', action: 'delete', entryId: `fine_${i}`, expectedRevision: 1 });
    const visible = doc.entries.filter(entry => entry.status === 'deleted' && !entry.discarded);
    assert.deepEqual(visible.map(entry => entry.id), Array.from({ length: 10 }, (_, i) => `fine_${i + 3}`));
    for (const id of ['fine_1', 'fine_2']) {
        const entry = get(doc, id);
        assert.equal(entry.discarded, true); assert.equal(entry.text, '已删除'); assert.equal(entry.title, undefined);
        assert.deepEqual(entry.history, []); assert.deepEqual(entry.conflicts, []); assert.equal(entry.candidate, null);
        assert.equal(canUndoText(entry), false);
        assert.throws(() => change(doc, { id: `undo_${id}`, type: 'entry', action: 'undo', entryId: id, expectedRevision: entry.revision }), /超出保留/);
        assert.throws(() => change(doc, { id: `edit_${id}`, type: 'edit', entryId: id, expectedRevision: entry.revision, text: '不能重新填入' }), /超出保留/);
    }
    assert.equal(nextBatch(doc, messages, DEFAULTS), null, 'deleted source guards do not become automatic gaps');
    const plan = await buildPlan(doc, createDefaults(), { messages });
    assert.deepEqual(plan.memoryIds, ['fine_13']);
    const coverage = summaryCoverage(doc, messages, DEFAULTS);
    assert.equal(coverage.organizedFloors, 1); assert.equal(coverage.sliceCount, 1); assert.equal(coverage.pendingFloors, 0);
    const latest = get(doc, 'fine_12');
    doc = change(doc, { id: 'undo_latest', type: 'entry', action: 'undo', entryId: latest.id, expectedRevision: latest.revision });
    assert.equal(get(doc, 'fine_12').status, 'active'); assert.equal(get(doc, 'fine_12').text, '第12份原有正文');
});

for (const range of [{ start: 1, end: 3 }, { start: 2, end: 2 }]) test(`explicit manual regeneration of discarded floors ${range.start}-${range.end} creates fresh memory without recovering old text`, async () => {
    const f = await discardedRangeFixture(), guard = structuredClone(get(f.doc, 'range_old'));
    const plan = planManualRange(f.doc, messages, DEFAULTS, range);
    assert.deepEqual(plan.range, range); assert.equal(plan.expanded, false); assert.equal(plan.batches.length, 1);
    assert.equal(plan.batches[0].redo, undefined);
    assert.deepEqual(plan.batches[0].discardedSources, [{ id: guard.id, revision: guard.revision, source: guard.source }]);
    const operation = { id: 'explicit_regenerate', type: 'append', expectedEpoch: f.doc.epoch,
        entry: { id: 'fresh_summary', kind: 'summary', text: '依据当前正文重新整理的新稿', source: { ...range, hashes: f.hashes.slice(range.start - 1, range.end) } } };
    assert.throws(() => change(f.doc, operation), /此来源已有记忆/);
    const renewed = change(f.doc, { ...operation, discardedSources: plan.batches[0].discardedSources });
    assert.deepEqual(get(renewed, 'range_old'), guard);
    assert.equal(get(renewed, 'fresh_summary').status, 'active'); assert.equal(get(renewed, 'fresh_summary').history.length, 0);
    assert.equal(nextBatch(renewed, messages, DEFAULTS, { force: true }), null, 'unselected deleted floors must not be automatically recreated');
    const coverage = summaryCoverage(renewed, messages, DEFAULTS);
    assert.equal(coverage.organizedFloors, range.end - range.start + 1); assert.equal(coverage.pendingFloors, 0);
    const replan = planManualRange(renewed, messages, DEFAULTS, range);
    assert.equal(replan.batches[0].redo.id, 'fresh_summary', 'a retained guard does not prevent later deliberate edits to its new summary');
    const imported = mergeBackupDocument(renewed, f.oldBackup, { operationId: 'stale_after_regenerate', packageId: 'stale_old' });
    assert.equal(imported.outcome, 'duplicate'); assert.deepEqual(get(imported.document, 'range_old'), guard);
    assert.equal(get(imported.document, 'fresh_summary').text, '依据当前正文重新整理的新稿');
    const changedGuard = structuredClone(f.doc); get(changedGuard, guard.id).revision++;
    assert.throws(() => change(changedGuard, { ...operation, discardedSources: plan.batches[0].discardedSources }), /已清除来源已变化/);
    const changedSource = structuredClone(plan.batches[0].discardedSources); changedSource[0].source.hashes[0] = 'b'.repeat(64);
    assert.throws(() => change(f.doc, { ...operation, discardedSources: changedSource }), /已清除来源已变化/);
});

test('manual discarded-source authorization cannot bypass a retained deletion, injection shield or manual revision', async () => {
    const f = await fixture(2);
    for (const action of ['delete', 'exclude']) {
        const doc = change(f.doc, { id: `protected_${action}`, type: 'entry', action, entryId: 'fine_1', expectedRevision: 1 });
        assert.throws(() => planManualRange(doc, messages, DEFAULTS, { start: 1, end: 1 }), /已删除或暂不使用/);
        assert.throws(() => change(doc, { id: 'fabricated_permission', type: 'append', expectedEpoch: doc.epoch,
            discardedSources: [{ ...refs(doc, ['fine_1'])[0], source: get(doc, 'fine_1').source }], entry: { id: 'overlap', kind: 'summary', text: '不应保存', source: get(doc, 'fine_1').source } }), /已清除来源已变化/);
    }
    const edited = change(f.doc, { id: 'human_revision', type: 'edit', entryId: 'fine_1', expectedRevision: 1, text: '人工修订不应被覆盖' });
    const plan = planManualRange(edited, messages, DEFAULTS, { start: 1, end: 1 });
    assert.equal(plan.batches[0].redo.edited, true); assert.equal(plan.batches[0].discardedSources, undefined);
    const next = change(edited, { id: 'review_new_summary', type: 'redo', entryId: 'fine_1', expectedRevision: 2, expectedEpoch: edited.epoch,
        entry: { id: 'fine_1', kind: 'summary', text: '仅作为新候选', source: get(edited, 'fine_1').source } });
    assert.equal(get(next, 'fine_1').text, '人工修订不应被覆盖'); assert.equal(get(next, 'fine_1').candidate.text, '仅作为新候选');
});

test('fresh summaries over discarded guards survive export, mapped restore, merge, stage and injection without reviving an old backup', async () => {
    const f = await fixture(); let doc = f.doc;
    for (let i = 1; i <= 12; i++) doc = change(doc, { id: `purge_${i}`, type: 'entry', action: 'delete', entryId: `fine_${i}`, expectedRevision: 1 });
    for (let i = 1; i <= 2; i++) {
        const batch = planManualRange(doc, messages, DEFAULTS, { start: i, end: i }).batches[0];
        doc = change(doc, { id: `fresh_${i}`, type: 'append', expectedEpoch: doc.epoch, discardedSources: batch.discardedSources,
            entry: { id: `renewed_${i}`, kind: 'summary', title: `重读来信${i}`, text: `新整理的第${i}层经历`, source: { start: i, end: i, hashes: [f.hashes[i - 1]] } } });
    }
    const guard = structuredClone(get(doc, 'fine_1'));
    const portable = portableDocument(doc), target = { ...binding, file: 'Mapped-restore' };
    const incoming = restoreBackupDocument(portable, { binding: target, mappings: { source_0: target } }).document;
    // Restore preserves entry identities; both guard and provenance remain linked
    // while the enclosing ST chat binding is mapped to the verified target.
    assert.deepEqual(get(incoming, 'renewed_1').discardedSources, get(doc, 'renewed_1').discardedSources);
    let merged = mergeBackupDocument(createDocument(target), incoming, { operationId: 'fresh_import', packageId: 'fresh_package' }).document;
    assert.deepEqual(merged.entries.filter(entry => entry.kind === 'summary' && entry.status === 'active').map(entry => entry.id), ['fine_13', 'renewed_1', 'renewed_2']);
    assert.deepEqual(get(merged, 'fine_1'), guard);
    const existing = structuredClone(incoming);
    existing.entries = existing.entries.filter(entry => !entry.id.startsWith('renewed_'));
    existing.entryOrder = existing.entryOrder.filter(id => !id.startsWith('renewed_'));
    const mergedExisting = mergeBackupDocument(existing, incoming, { operationId: 'existing_import', packageId: 'fresh_existing' }).document;
    assert.deepEqual(mergedExisting.entries.filter(entry => entry.kind === 'summary' && entry.status === 'active').map(entry => entry.id), ['fine_13', 'renewed_1', 'renewed_2']);
    assert.deepEqual(get(mergedExisting, 'fine_1'), guard);
    merged = change(merged, { id: 'enable_restored', type: 'enable', enabled: true, expectedRevision: merged.configRevision,
        range: { start: 1, end: 13, total: messages.length } });
    const manualStage = planStageRange(merged, DEFAULTS, { start: 1, end: 2, includeCustom: false });
    assert.deepEqual(manualStage.parents.map(entry => entry.id), ['renewed_1', 'renewed_2']);
    const autoStage = nextStage(merged, { ...DEFAULTS, stageAuto: true, stageRecent: 0, stageThreshold: 1 });
    assert.deepEqual(autoStage.parents.map(entry => entry.id), ['renewed_1', 'renewed_2']);
    const stage = parseStage('{"title":"再读桥边","text":"重新整理后形成的阶段"}', manualStage.parents, DEFAULTS, { includeCustom: false });
    merged = change(merged, { id: 'create_restored_stage', type: 'append', expectedEpoch: merged.epoch, entry: { ...stage, id: 'renewed_stage' } });
    assert.equal(stageDependenciesValid(get(merged, 'renewed_stage'), merged), true);
    const injection = await buildPlan(merged, createDefaults(), { messages });
    assert.ok(injection.memoryIds.includes('renewed_stage'));
    assert.ok(!injection.memoryIds.some(id => ['fine_1', 'fine_2', 'renewed_1', 'renewed_2'].includes(id)), 'the stage replaces its new parents without injecting guards or duplicate summaries');
    assert.equal(nextBatch(merged, messages, DEFAULTS, { force: true }), null);
    const oldIncoming = restoreBackupDocument(portableDocument(f.doc), { binding: target, mappings: { source_0: target } }).document;
    const oldOnly = { ...oldIncoming, entries: oldIncoming.entries.filter(entry => ['fine_1', 'fine_2'].includes(entry.id)), entryOrder: ['fine_1', 'fine_2'] };
    const staleMerge = mergeBackupDocument(merged, oldOnly, { operationId: 'stale_import', packageId: 'old_package' });
    assert.equal(staleMerge.outcome, 'duplicate'); assert.deepEqual(get(staleMerge.document, 'fine_1'), guard);
    const disconnected = structuredClone(merged); get(disconnected, 'renewed_2').source = { start: 3, end: 3, hashes: [f.hashes[2]] };
    assert.throws(() => stageSourceFromParents(disconnected, refs(disconnected, ['renewed_1', 'renewed_2']), { includeCustom: false }), /连续/);
    for (const broken of ['missing', 'revision', 'hash', 'range']) {
        const draft = structuredClone(incoming), slice = get(draft, 'renewed_1');
        draft.entries = [slice]; draft.entryOrder = [slice.id];
        if (broken === 'missing') delete slice.discardedSources;
        else if (broken === 'revision') slice.discardedSources[0].revision++;
        else if (broken === 'hash') slice.discardedSources[0].source.hashes[0] = 'b'.repeat(64);
        else { slice.discardedSources[0].source.start = 2; slice.discardedSources[0].source.end = 2; }
        const receiver = createDocument(target); receiver.entries = [structuredClone(guard)]; receiver.entryOrder = [guard.id];
        const result = mergeBackupDocument(receiver, draft, { operationId: `broken_${broken}`, packageId: `broken_${broken}` });
        assert.equal(result.document.entries.length, 1, `${broken} provenance must not bypass the guard`);
    }
});

test('reading old data never purges it; deliberate import preserves deletion guards and new portable settings', async () => {
    const f = await fixture(); const legacy = structuredClone(f.doc);
    for (const entry of legacy.entries) entry.status = 'deleted';
    const before = JSON.stringify(legacy); assert.equal(validateDocument(legacy).entries.filter(entry => !entry.discarded).length, 13);
    assert.equal(JSON.stringify(legacy), before);
    let receiver = f.doc;
    for (let i = 1; i <= 12; i++) receiver = change(receiver, { id: `drop_${i}`, type: 'entry', action: 'delete', entryId: `fine_${i}`, expectedRevision: 1 });
    const stale = structuredClone(f.doc); stale.entries = [stale.entries[0]]; stale.entryOrder = ['fine_1'];
    const merged = mergeBackupDocument(receiver, stale, { operationId: 'import_stale', packageId: 'old_backup' });
    assert.equal(merged.outcome, 'duplicate'); assert.equal(get(merged.document, 'fine_1').text, '已删除');
    const alternate = structuredClone(stale); alternate.entries[0].id = 'alternate'; alternate.entryOrder = ['alternate'];
    assert.equal(mergeBackupDocument(receiver, alternate, { operationId: 'import_alt', packageId: 'old_other' }).outcome, 'duplicate');
    receiver.settings = { sliceChars: 2100, stageChars: 3100, stageRecent: 12 };
    const portable = portableDocument(receiver);
    assert.deepEqual(portable.settings, receiver.settings); assert.equal(get(portable, 'fine_1').discarded, true);
    assert.equal(get(portable, 'fine_13').title, '桥边来信13');
    const target = { ...binding, file: 'Restored' };
    const restored = restoreBackupDocument(portable, { binding: target, mappings: { source_0: target } }).document;
    assert.equal(get(restored, 'fine_1').discarded, true); assert.equal(get(restored, 'fine_1').text, '已删除');
    const foreign = get(receiver, 'fine_1'); foreign.origin = { binding: { ...binding, file: 'Old discarded source' }, offset: 0 };
    assert.equal(collectBackupSources(receiver).length, 1, 'a purged body does not add an unnecessary original-file attachment');
});

test('deletion rotation keeps dependent stages invalid and imported deleted bodies bounded without erasing active manual edits', async () => {
    const f = await fixture(); let doc = f.doc;
    doc = change(doc, { id: 'stage', type: 'append', expectedEpoch: doc.epoch,
        entry: { id: 'stage', kind: 'stage', text: '旧阶段正文', source: { parents: refs(doc, ['fine_1', 'fine_2']) } } });
    doc = addCustom(doc, f.hashes);
    const protectedCustom = structuredClone(get(doc, 'custom'));
    for (let i = 1; i <= 12; i++) doc = change(doc, { id: `drop_${i}`, type: 'entry', action: 'delete', entryId: `fine_${i}`, expectedRevision: 1 });
    assert.equal(get(doc, 'stage').status, 'invalid'); assert.equal(stageDependenciesValid(get(doc, 'stage'), doc), false);
    assert.deepEqual(get(doc, 'custom'), protectedCustom);
    const next = await buildPlan(doc, createDefaults(), { messages });
    assert.ok(next.memoryIds.includes('stage')); assert.ok(next.memoryIds.includes('custom'));
    const incoming = structuredClone(f.doc);
    for (const entry of incoming.entries) entry.status = 'deleted';
    const merged = mergeBackupDocument(createDocument(binding), incoming, { operationId: 'import_old_deletes', packageId: 'legacy_deletes' }).document;
    assert.equal(merged.entries.filter(entry => entry.status === 'deleted' && !entry.discarded).length, 10);
    assert.equal(merged.entries.filter(entry => entry.discarded).length, 3);
    assert.equal(merged.enabled, false);
});
