import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharacterRestoreSession } from '../qianmu-character-backup-restore.js';
import { newCharacterArchive, normalizeCharacterArchive } from '../qianmu-character-archive.js';
import { CHARACTER_LIBRARY_BACKUP_SCHEMA, characterLibraryBackupDigest as digest, planCharacterLibraryRestore } from '../qianmu-character-library-backup.js';
import { CHARACTER_BACKUP_FILE_SCHEMA } from '../qianmu-character-backup-file.js';
import { COMFY_LIBRARY_BACKUP_SCHEMA, planComfyLibraryRestore } from '../qianmu-comfy-library-backup.js';
import { normalizeComfyLibraryDocument, inspectComfyLibraryDocument } from '../qianmu-comfy-library.js';
import { comfyWorkflowReferenceHash } from '../qianmu-comfy-references.js';
import { validateResourceRestoreCheckpoint } from '../qianmu-storyboard-package-journal.js';
import { vibeDigest } from '../qianmu-vibe-file.js';
import { renderCharacterArchive } from '../qianmu-character-archive-view.js';

const namespace = 'st-user:alice', data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKuoAAAAASUVORK5CYII=';
const bytes = Buffer.from(data, 'base64'), sha256 = await vibeDigest(bytes), clone = structuredClone;
const image = { url: '/user/images/Qianmu-References/original.png', name: 'original', sha256, bytes: bytes.length, mime: 'image/png' };
function archive(id = 'alice', version = 1, overrides = {}) {
  const document = normalizeCharacterArchive({ ...newCharacterArchive('char'), name: id, imagegen: { appearance: 'dark hair', negative: '', sensitiveAppearance: '', reference: image,
    preview: { ...image, url: '/user/images/Qianmu-References/preview.png', sourceSha256: sha256 } }, ...overrides });
  return { document, head: { id, revision: `${id}-r${version}`, version, category: document.category, name: document.name, aliases: document.aliases, cover: document.imagegen.preview?.url || '',
    bytes: new TextEncoder().encode(JSON.stringify(document)).byteLength, createdAt: 1, updatedAt: version } };
}
const binding = () => ({ category: 'char', subjectKey: 'char:alice.png', scope: 'chat', chatKey: 'chat-one', archiveId: 'alice', revision: 'binding1', updatedAt: 1 });
const library = (archives = [archive()], bindings = [binding()]) => ({ schema: CHARACTER_LIBRARY_BACKUP_SCHEMA, namespace, credentialsIncluded: false, archives, bindings,
  usage: { count: archives.length, bindings: bindings.length, bytes: archives.reduce((sum, row) => sum + row.head.bytes, 0) } });
function source(l = library(), workflows = null) { return { schema: CHARACTER_BACKUP_FILE_SCHEMA, namespace, credentialsIncluded: false, originalsIncluded: true, library: l, workflows,
  images: l.archives.some(row => row.document.imagegen.reference) ? [{ sha256, mime: image.mime, bytes: image.bytes, data }] : [] }; }
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function fixture(packet = source()) {
  const e = { local: library([], []), workflows: { schema: COMFY_LIBRARY_BACKUP_SCHEMA, namespace, credentialsIncluded: false, workflows: [] }, files: new Map(), record: null, events: [], active: true };
  const store = { backup: async () => clone(e.local), restoreBackup: async (ns, input, options) => {
    assert.equal(ns, namespace); assert.equal(options.confirmed, true); assert.equal(await digest(e.local), options.expectedDigest);
    if (e.failMetadata) throw Error('synthetic quota');
    const plan = planCharacterLibraryRestore(e.local, input, options); assert.ok(plan.ready); e.local = clone(plan.value); e.events.push('metadata'); if (e.afterMetadata) await e.afterMetadata(); return plan.summary;
  } };
  const workflowStore = { backup: async () => clone(e.workflows), usage: async () => ({ limit: 64 * 1024 * 1024 }), restoreBackup: async (ns, input, options) => {
    assert.equal(await digest(e.workflows), options.expectedDigest); assert.equal(options.confirmed, true);
    const plan = planComfyLibraryRestore(e.workflows, input), rows = new Map(e.workflows.workflows.map(row => [row.head.id, row]));
    for (const row of plan.writes) rows.set(row.head.id, { head: row.head, versions: [...(rows.get(row.head.id)?.versions || []), ...row.versions] });
    e.workflows.workflows = [...rows.values()]; e.events.push('workflows'); if (e.afterWorkflows) await e.afterWorkflows(); return plan.summary;
  } };
  const images = { inspect: async receipt => {
    if (e.inspect) await e.inspect(receipt);
    return { receipt: clone(receipt), state: e.conflict === receipt.url ? 'conflict' : e.files.has(receipt.url) ? 'present' : 'missing' };
  }, restore: async (receipt, encoded, options) => {
    assert.equal(options.confirmed, true); assert.equal(encoded, data); assert.ok(e.record); assert.equal(e.record.phase, 'originals');
    assert.equal(e.files.has(receipt.url), false); e.files.set(receipt.url, encoded); e.events.push(`image:${receipt.url}`); if (e.afterImage) await e.afterImage(receipt); return { state: 'created', receipt: clone(receipt) };
  } };
  const journal = { loadResource: async () => clone(e.record), prepareResource: async (descriptor, options) => {
    assert.equal(options.confirmed, true); assert.deepEqual(options.previous, e.record); if (e.failJournal) throw Error('journal quota');
    e.record = validateResourceRestoreCheckpoint({ ...clone(descriptor), key: JSON.stringify([namespace, 'characters']), version: 1, phase: 'prepared', revision: (e.record?.revision || 0) + 1, createdAt: 1, updatedAt: 1 });
    e.events.push('journal:prepared'); return clone(e.record);
  }, updateResource: async (previous, phase) => {
    assert.deepEqual(previous, e.record); e.record = validateResourceRestoreCheckpoint({ ...previous, phase, revision: previous.revision + 1 }); e.events.push(`journal:${phase}`); return clone(e.record);
  } };
  let held = false;
  const locks = { request: async (name, options, run) => {
    assert.equal(name, `qianmu:character-restore:${namespace}`); assert.equal(options.ifAvailable, true);
    if (held || e.locked) return run(null); held = true; try { return await run({ name }); } finally { held = false; }
  } };
  const options = { store, workflowStore, images, journal, locks, guard: async () => { if (!e.active) throw Error('changed'); }, isCurrent: () => e.active };
  return { e, packet, options, session: await createCharacterRestoreSession(namespace, packet, options), reopen: () => createCharacterRestoreSession(namespace, packet, options) };
}

test('whole restore previews without writes, retains every URL use, and requires explicit binding review', async () => {
  const { e, session } = await fixture(), plan = await session.preview();
  assert.equal(plan.images.length, 2); assert.equal(plan.bindingReview.length, 1); assert.deepEqual(e.events, []);
  await assert.rejects(session.restore(plan), /确认/); await assert.rejects(session.restore(plan, { confirmed: true }), /原角色身份/); assert.deepEqual(e.events, []);
  const result = await session.restore(plan, { confirmed: true, bindingsReviewed: true });
  assert.equal(result.checkpoint.phase, 'verified'); assert.equal(result.images, 2); assert.deepEqual(e.local, library());
  assert.deepEqual(e.events, ['journal:prepared', 'journal:originals', `image:${image.url}`, 'image:/user/images/Qianmu-References/preview.png', 'journal:workflows', 'journal:metadata', 'metadata', 'journal:verified']);
  assert.doesNotMatch(JSON.stringify(e.record), /dark hair|data:|char:alice|apiKey|iVBOR/);
});

test('a lost image write response preserves original and journal; new session rechecks and writes only missing uses', async () => {
  const { e, session, reopen } = await fixture(); let once = true;
  e.afterImage = () => { if (once) { once = false; throw Error('lost response after image publication'); } };
  await assert.rejects(session.restore(await session.preview(), { confirmed: true, bindingsReviewed: true }), { code: 'character_restore_partial' });
  assert.equal(e.local.usage.count, 0); assert.equal(e.record.phase, 'originals'); assert.equal(e.files.size, 1); session.close();
  const next = await reopen(), preview = await next.preview(); assert.equal(preview.images.filter(row => row.state === 'present').length, 1);
  await next.restore(preview, { confirmed: true, bindingsReviewed: true });
  assert.equal(e.events.filter(event => event === `image:${image.url}`).length, 1); assert.equal(e.files.size, 2); assert.equal(e.record.phase, 'verified');
});

test('metadata transaction failure keeps restored originals, then explicit retry succeeds without duplicate image uploads', async () => {
  const { e, session, reopen } = await fixture(); e.failMetadata = true;
  await assert.rejects(session.restore(await session.preview(), { confirmed: true, bindingsReviewed: true }), { code: 'character_restore_partial' });
  assert.equal(e.local.usage.count, 0); assert.equal(e.record.phase, 'metadata'); assert.equal(e.files.size, 2);
  e.failMetadata = false; const next = await reopen(); await next.restore(await next.preview(), { confirmed: true, bindingsReviewed: true });
  assert.equal(e.events.filter(row => row.startsWith('image:')).length, 2); assert.equal(e.local.usage.count, 1);
});

test('another page changing the role library during image staging is preserved, and fresh confirmation merges without losing it', async () => {
  const { e, session, reopen } = await fixture(); let once = true;
  e.afterImage = () => { if (once) { once = false; e.local = library([archive('unrelated', 1, { imagegen: {} })], []); } };
  await assert.rejects(session.restore(await session.preview(), { confirmed: true, bindingsReviewed: true }), { code: 'character_restore_partial' });
  assert.equal(e.local.usage.count, 1); assert.equal(e.local.archives[0].head.id, 'unrelated'); assert.equal(e.record.phase, 'metadata');
  const next = await reopen(); await next.restore(await next.preview(), { confirmed: true, bindingsReviewed: true });
  assert.deepEqual(e.local.archives.map(row => row.head.id), ['alice', 'unrelated']); assert.equal(e.files.size, 2);
});

test('lost metadata acknowledgement can be freshly verified with no invented revisions or stale conflict decisions', async () => {
  const { e, session, reopen } = await fixture(); e.afterMetadata = () => { throw Error('lost transaction acknowledgement'); };
  await assert.rejects(session.restore(await session.preview(), { confirmed: true, bindingsReviewed: true })); assert.deepEqual(e.local, library()); assert.equal(e.record.phase, 'metadata');
  e.afterMetadata = null; const next = await reopen(), preview = await next.preview(); assert.equal(preview.bindingReview.length, 0);
  await next.restore(preview, { confirmed: true }); assert.equal(e.local.archives[0].head.revision, 'alice-r1'); assert.equal(e.record.phase, 'verified');
});

test('whole import chooses each character conflict without replacing unrelated local characters or unused image files', async () => {
  const { e, session } = await fixture(); e.local = library([archive('z-local', 1, { imagegen: {} }), archive('alice', 3, { imagegen: {} })], []);
  const pending = await session.preview(); assert.equal(pending.ready, false); assert.equal(pending.conflicts.length, 1); assert.equal(pending.images.length, 0);
  const kept = await session.preview({ 'archive:alice': 'local' }); assert.equal(kept.images.length, 0);
  await session.restore(kept, { confirmed: true, bindingsReviewed: true }); assert.equal(e.files.size, 0); assert.equal(e.local.archives[0].head.version, 3); assert.equal(e.local.archives[1].head.id, 'z-local');
  const incoming = await session.preview({ 'archive:alice': 'incoming' }); await session.restore(incoming, { confirmed: true });
  assert.equal(e.local.archives[0].head.version, 1); assert.equal(e.local.archives[1].head.id, 'z-local'); assert.equal(e.files.size, 2);
});

test('existing different image data stops before any journal or metadata mutation', async () => {
  const { e, session } = await fixture(); e.conflict = image.url;
  const plan = await session.preview(); assert.equal(plan.ready, false);
  await assert.rejects(session.restore(plan, { confirmed: true, bindingsReviewed: true }), /原图冲突/); assert.deepEqual(e.events, []);
});

test('changed source, account, local revision or pending journal prevents starting a stale approved import', async () => {
  const { e, packet, session, options } = await fixture(), plan = await session.preview();
  await assert.rejects(createCharacterRestoreSession('st-user:other', packet, options), /另一 ST 账户/);
  e.local = library([archive('unrelated', 1, { imagegen: {} })], []);
  await assert.rejects(session.restore(plan, { confirmed: true, bindingsReviewed: true }), /确认后/); assert.deepEqual(e.events, []);
  e.local = library([], []); e.record = validateResourceRestoreCheckpoint({ key: JSON.stringify([namespace, 'characters']), version: 1, kind: 'characters', namespace, sourceDigest: 'f'.repeat(64), planDigest: 'e'.repeat(64), phase: 'originals', revision: 1, createdAt: 1, updatedAt: 1 });
  await assert.rejects(session.preview(), /另一份/); assert.deepEqual(e.events, []);
});

test('the source is captured once and not mutated by callers while asynchronous validation runs', async () => {
  const { e, session, packet } = await fixture(); packet.library.archives[0].document.name = 'changed outside'; packet.images[0].data = 'bad';
  await session.restore(await session.preview(), { confirmed: true, bindingsReviewed: true }); assert.equal(e.local.archives[0].document.name, 'alice'); assert.equal(e.files.get(image.url), data);
});

test('journal failure, unavailable locks and a competing live page stop before any originals are uploaded', async () => {
  const { e, session, packet, options } = await fixture(); const plan = await session.preview(); e.failJournal = true;
  await assert.rejects(session.restore(plan, { confirmed: true, bindingsReviewed: true }), /journal quota/); assert.equal(e.files.size, 0);
  e.failJournal = false; e.locked = true; await assert.rejects(session.restore(plan, { confirmed: true, bindingsReviewed: true }), /另一页面/); assert.equal(e.files.size, 0);
  const noLock = await createCharacterRestoreSession(namespace, packet, { ...options, locks: null }); await assert.rejects(noLock.restore(await noLock.preview(), { confirmed: true }), /不支持/);
});

test('concurrent restores share an account lock and a page change after one image prevents later effects', async () => {
  const { e, session, reopen } = await fixture(), started = gate(), release = gate();
  e.afterImage = async () => { started.release(); await release.promise; e.active = false; };
  const second = await reopen(), plan = await session.preview(), secondPlan = await second.preview();
  const first = session.restore(plan, { confirmed: true, bindingsReviewed: true }); await started.promise;
  await assert.rejects(second.restore(secondPlan, { confirmed: true, bindingsReviewed: true }), /另一页面/); release.release(); await assert.rejects(first, { code: 'character_restore_partial' });
  assert.equal(e.files.size, 1); assert.equal(e.local.usage.count, 0); assert.equal(e.record.phase, 'originals');
});

test('fixed Comfy originals restore before character metadata; wrong graph version cannot be substituted by name', async () => {
  const graph = { load: { class_type: 'LoadImage', inputs: { image: '%qianmu_reference_1%' } } };
  const document = normalizeComfyLibraryDocument({ workflow: graph, parameters: { seed: 0 } }), inspected = inspectComfyLibraryDocument(document);
  const head = { id: 'wf', name: 'Fixed workflow', revision: 'wf-r1', version: 1, createdAt: 1, updatedAt: 1, archived: false, bytes: inspected.bytes, totalBytes: inspected.bytes, nodes: inspected.nodes, slots: inspected.slots, issue: inspected.issue };
  const workflows = { schema: COMFY_LIBRARY_BACKUP_SCHEMA, namespace, credentialsIncluded: false, workflows: [{ head, versions: [{ meta: { ...head, parentRevision: '' }, document }] }] };
  const role = archive('alice', 1, { comfy: { version: 1, implementations: [{ version: 1, name: 'Reference', workflow: { id: head.id, revision: head.revision, version: 1, hash: await comfyWorkflowReferenceHash(graph) }, referenceSlot: 1, loras: [], conditioning: [] }] } });
  const { e, session, reopen } = await fixture(source(library([role]), workflows)); e.failMetadata = true;
  await assert.rejects(session.restore(await session.preview(), { confirmed: true, bindingsReviewed: true })); assert.equal(e.workflows.workflows.length, 1); assert.equal(e.local.usage.count, 0);
  e.failMetadata = false; const next = await reopen(); await next.restore(await next.preview(), { confirmed: true, bindingsReviewed: true });
  assert.equal(e.workflows.workflows[0].versions.length, 1); assert.deepEqual(e.local.archives[0].document.comfy, role.document.comfy);
  const bad = source(library([clone(role)]), clone(workflows)); bad.library.archives[0].document.comfy.implementations[0].workflow.hash = 'f'.repeat(64);
  await assert.rejects(fixture(bad), /固定工作流原文不符/);
});

test('resource checkpoint rejects bodies, foreign keys, invalid phases and revision overflow', () => {
  const good = { key: JSON.stringify([namespace, 'characters']), version: 1, kind: 'characters', namespace, sourceDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64), phase: 'originals', revision: 1, createdAt: 1, updatedAt: 1 };
  assert.deepEqual(validateResourceRestoreCheckpoint(good), good);
  for (const extra of [{ apiKey: 'private' }, { data }, { key: 'another user' }, { namespace: 'st-user:other' }, { phase: 'done' }, { revision: Number.MAX_SAFE_INTEGER + 1 }]) assert.throws(() => validateResourceRestoreCheckpoint({ ...good, ...extra }));
});

test('restore view escapes conflict names and identity keys, requires explicit binding review and limits initial rendering', () => {
  const row = { key: 'archive:alice', kind: 'archive', localName: '<img src=x onerror=alert(1)>', incomingName: 'Backup', localVersion: 1, incomingVersion: 2, choice: '' };
  const view = { busy: false, error: '', restoring: { shown: 24, preview: { conflicts: Array.from({ length: 40 }, () => row), bindingReview: [binding()], ready: true, images: [], summary: { added: 1, replaced: 0, kept: 0 } }, bindingsReviewed: false } };
  const html = renderCharacterArchive(view); assert.doesNotMatch(html, /<img src=x/); assert.match(html, /&lt;img/);
  assert.equal((html.match(/data-archive-restore-decision=/g) || []).length, 24); assert.match(html, /data-archive-action="restore-commit" disabled/); assert.match(html, /下一页/);
  view.restoring.page = 1; const next = renderCharacterArchive(view); assert.equal((next.match(/data-archive-restore-decision=/g) || []).length, 16); assert.match(next, /data-archive-restore-decision="24"/);
  view.restoring.bindingsReviewed = true; assert.doesNotMatch(renderCharacterArchive(view), /data-archive-action="restore-commit" disabled/);
});

test('conflict choices use a compact snapshot without reading either library, journal or any image again', async () => {
  const { e, options, session, packet } = await fixture();
  e.local = library([archive('alice', 3, { imagegen: { appearance: 'a much longer local appearance' } }), archive('unrelated', 1, { imagegen: {} })], [{ ...binding(), archiveId: '', revision: 'local-unbind' }]);
  const initial = await session.preview(), bindKey = initial.conflicts.find(row => row.kind === 'binding').key;
  const expected = [ {}, { 'archive:alice': 'local' }, { 'archive:alice': 'incoming', [bindKey]: 'local' }, { 'archive:alice': 'local', [bindKey]: 'incoming' } ].map(decisions => ({ decisions, plan: planCharacterLibraryRestore(e.local, packet.library, { decisions }) }));
  for (const object of [options.store, options.workflowStore, options.images, options.journal]) for (const method of Object.keys(object)) object[method] = () => assert.fail(`choice must not call ${method}`);
  for (const { decisions, plan } of expected) {
    const draft = await session.choose(decisions);
    assert.deepEqual(draft.conflicts, plan.conflicts); assert.deepEqual(draft.summary, plan.summary); assert.deepEqual(draft.bindingReview, plan.bindingWrites);
    assert.equal(draft.choicesReady, plan.ready); assert.equal(draft.ready, false); assert.equal(draft.needsRecheck, true);
    assert.equal(draft.planDigest, ''); assert.deepEqual(draft.images, []); assert.equal(draft.workflowDigest, null); assert.equal(draft.workflowSummary, null);
    assert.doesNotMatch(JSON.stringify(draft), /dark hair|longer local appearance|iVBOR|"document"|"imagegen"/);
    await assert.rejects(session.restore(draft, { confirmed: true, bindingsReviewed: true }), /核对并确认/);
    draft.summary.kept = 9000; draft.conflicts[0].key = 'tampered';
    assert.deepEqual((await session.choose(decisions)).summary, plan.summary);
  }
  assert.deepEqual(e.events, []);
});

test('a chosen full preview can be edited back and forth with accurate counts and expired resource approvals', async () => {
  const { e, session, packet } = await fixture(); e.local = library([archive('alice', 8, { imagegen: {} })], []);
  const full = await session.preview({ 'archive:alice': 'incoming' }); assert.equal(full.ready, true); assert.equal(full.images.length, 2);
  for (const decisions of [{ 'archive:alice': 'local' }, {}, { 'archive:alice': 'incoming' }]) {
    const draft = await session.choose(decisions), exact = planCharacterLibraryRestore(e.local, packet.library, { decisions });
    assert.deepEqual(draft.summary, exact.summary); assert.deepEqual(draft.bindingReview, exact.bindingWrites); assert.equal(draft.planDigest, '');
  }
  const selected = await session.choose({ 'archive:alice': 'incoming' });
  e.conflict = image.url;
  const rechecked = await session.preview(selected.decisions); assert.equal(rechecked.ready, false); assert.equal(rechecked.images[0].state, 'conflict');
  await assert.rejects(session.restore(full, { confirmed: true, bindingsReviewed: true }), /原图冲突/); assert.deepEqual(e.events, []);
});

test('choice snapshots cannot hide changes made by another page, stale keys or a closed account scope', async () => {
  const { e, session } = await fixture(); e.local = library([archive('alice', 2, { imagegen: {} })], []);
  await session.preview(); const choice = await session.choose({ 'archive:alice': 'incoming' });
  e.local = library();
  await assert.rejects(session.preview(choice.decisions), /过期/);
  await assert.rejects(session.choose({}), /快照已失效/);
  const fresh = await session.preview(); assert.equal(fresh.conflicts.length, 0);
  await assert.rejects(session.choose({ 'archive:alice': 'incoming' }), /过期/);
  e.active = false; await assert.rejects(session.choose({}), /changed/); e.active = true;
  session.close(); await assert.rejects(session.choose({}), /会话已结束/); assert.deepEqual(e.events, []);
});

test('choices reject malformed values, capture input before awaiting guards and ignore inherited selections', async () => {
  const { e, session, options, packet } = await fixture(); e.local = library([archive('alice', 2, { imagegen: {} })], []); await session.preview();
  for (const input of [null, [], 1, { 'archive:alice': 'skip' }, { 'archive:missing': 'incoming' }]) await assert.rejects(session.choose(input));
  assert.equal((await session.choose(Object.create({ 'archive:alice': 'incoming' }))).choicesReady, false);
  const delayed = gate(); let pause = false;
  const next = await createCharacterRestoreSession(namespace, packet, { ...options, guard: async () => { if (pause) await delayed.promise; } });
  await next.preview(); pause = true;
  const input = { 'archive:alice': 'local' }, promise = next.choose(input); input['archive:alice'] = 'incoming'; delayed.release();
  assert.equal((await promise).decisions['archive:alice'], 'local');
});

test('maximum-size role conflict lists stay lightweight when changing many choices', async () => {
  const incoming = library(Array.from({ length: 512 }, (_, index) => archive(`id-${index}`, 1, { imagegen: { appearance: 'original-body-'.repeat(800) } })), []);
  const { e, session, options } = await fixture(source(incoming));
  e.local = library(Array.from({ length: 512 }, (_, index) => archive(`id-${index}`, 2, { imagegen: { appearance: 'local-body-'.repeat(700) } })), []);
  const initial = await session.preview(); assert.equal(initial.conflicts.length, 512);
  options.store.backup = () => assert.fail('draft changes must not read 512 full documents again');
  const choices = {}; let result;
  for (let index = 0; index < 512; index++) { choices[`archive:id-${index}`] = index % 2 ? 'local' : 'incoming'; result = await session.choose(choices); }
  const exact = planCharacterLibraryRestore(e.local, incoming, { decisions: choices });
  assert.deepEqual(result.summary, exact.summary); assert.equal(result.choicesReady, true); assert.ok(JSON.stringify(result).length < 150000);
  assert.doesNotMatch(JSON.stringify(result), /original-body|local-body/); assert.deepEqual(e.events, []);
});

test('a closed or replaced choice snapshot cannot return late while its account guard is pending', async () => {
  const { e, packet, options } = await fixture(); e.local = library([archive('alice', 2, { imagegen: {} })], []);
  let pending = null;
  const session = await createCharacterRestoreSession(namespace, packet, { ...options, guard: async () => { if (pending) await pending.promise; } });
  await session.preview(); pending = gate();
  const choosing = session.choose({ 'archive:alice': 'local' }), refreshing = session.preview();
  pending.release(); pending = null;
  await assert.rejects(choosing, /快照已失效/); await refreshing;
  pending = gate(); const closing = session.preview(); session.close(); pending.release();
  await assert.rejects(closing, /会话已结束/); assert.deepEqual(e.events, []);
});
