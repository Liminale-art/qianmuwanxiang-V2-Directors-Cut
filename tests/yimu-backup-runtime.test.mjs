import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackupActions } from '../yimu/backup-runtime.mjs';
import { createController } from '../yimu/runtime.mjs';
import { createDocument, createDefaults, VERSION, SCHEMA } from '../yimu/contract.mjs';

const clone = value => structuredClone(value);
const deferred = () => { let resolve; return { promise: new Promise(yes => { resolve = yes; }), resolve: value => resolve(value) }; };
function fixture({ homepage = false } = {}) {
    const binding = { avatar: 'same-1.png', file: 'Original', integrity: 'original' };
    const snapshot = { binding, name: 'Same', messages: [{ mes: 'one' }] };
    const state = { snapshot: homepage ? null : clone(snapshot), document: homepage ? null : { enabled: false }, service: { status: 'ok' } };
    const life = { disposed: false, generation: 0, generating: false }, calls = [];
    const archive = { id: 'a', title: 'Archive', entriesCount: 1, primarySourceId: 'source_0', sources: [
        { id: 'source_0', label: 'Primary', binding, included: false }, { id: 'source_1', label: 'Ancestor', binding: { ...binding, file: 'Earlier' }, included: true }] };
    const document = { entries: [{ id: 'one', kind: 'manual', source: null, text: 'Preserved', history: [], conflicts: [] }] };
    const result = { status: 'complete', archiveId: 'a', binding: { ...binding, file: 'Copy', integrity: 'copy' },
        document: { enabled: false }, receipt: { status: 'complete', id: 'restore', target: { ...binding, file: 'Copy', integrity: 'copy' }, hashes: ['a'.repeat(64)] } };
    const host = { characters: () => [{ name: 'Same', avatar: 'same-1.png' }, { name: 'Same', avatar: 'same-2.png' }],
        snapshot: async () => { if (!state.snapshot) throw new Error('No chat'); return clone(state.snapshot); },
        openBackup: async (r, options) => { calls.push(['open', r, options]); return { opened: true }; } };
    const api = { backupPlan: async b => ({ planId: 'plan', title: 'Export', primarySourceId: 'source_0', sources: [{ id: 'source_0', available: true }, { id: 'source_1', available: false }] }),
        backupExport: async (b, query) => { calls.push(['export', clone(b), query]); return { blob: new Blob(['gzip-fixture']), filename: 'backup.yimu.gz' }; },
        backupUpload: async (file, id) => { calls.push(['upload', file, id]); return { archive: clone(archive) }; },
        backupUploadResult: async id => ({ status: 'complete', archive: clone(archive) }),
        backupList: async () => { calls.push(['list']); return { archives: [clone(archive)] }; },
        backupRead: async id => ({ archive: clone(archive), document: clone(document) }),
        backupRestore: async (id, request) => { calls.push(['restore', id, clone(request)]); return clone(result); },
        backupResult: async () => ({ status: 'missing' }) };
    let n = 0;
    const actions = createBackupActions({ state, host, api, id: () => `op-${++n}`, lifecycle: () => life,
        emit: () => {}, refresh: async () => calls.push(['refresh']), download: async result => calls.push(['download', result]) });
    const file = new Blob(['synthetic gzip']); Object.defineProperty(file, 'name', { value: 'backup.yimu.gz' });
    return { state, binding, snapshot, life, archive, document, result, host, api, calls, actions, file };
}

test('homepage import is explicit, keeps an independent read-only archive and never creates or opens a chat', async () => {
    const f = fixture({ homepage: true }); assert.deepEqual(f.calls, []);
    await f.actions.action('backupImport', { file: f.file });
    assert.equal(f.calls.filter(c => c[0] === 'upload').length, 1);
    assert.equal(f.calls.some(c => c[0] === 'restore' || c[0] === 'open'), false);
    assert.equal(f.state.snapshot, null); assert.equal(f.state.document, null);
    assert.deepEqual(f.state.backup.document, f.document);
    assert.equal(f.state.backup.archives.length, 1);
    await f.actions.action('backupImport', { file: f.file });
    assert.equal(f.state.backup.archives.length, 1, 'same archive is not duplicated');
});

test('only own package extension is accepted before upload and archives load solely on explicit request', async () => {
    const f = fixture({ homepage: true }), wrong = new Blob(['{}']); Object.defineProperty(wrong, 'name', { value: 'other.json' });
    await assert.rejects(f.actions.action('backupImport', { file: wrong }), /\.yimu\.gz/);
    assert.deepEqual(f.calls, []);
    await f.actions.action('backupList'); assert.deepEqual(f.calls, [['list']]);
    assert.deepEqual(f.state.backup.roles.map(role => role.avatar), ['same-1.png', 'same-2.png']);
});

test('export defaults to no raw source and stale chat plans never export a different chat', async () => {
    const f = fixture(); await f.actions.action('backupPlan');
    await f.actions.action('backupExport', { includeOriginals: false, sourceIds: ['source_0'] });
    assert.deepEqual(f.calls.find(c => c[0] === 'export')[2].sourceIds, []);
    await assert.rejects(f.actions.action('backupExport', { includeOriginals: true, sourceIds: ['source_1'] }), /不可用/);
    f.state.snapshot.binding.file = 'Elsewhere';
    await assert.rejects(f.actions.action('backupExport', {}), /当前聊天已变化/);
    assert.equal(f.calls.filter(c => c[0] === 'export').length, 1);
});

test('upload lost acknowledgement queries the fixed operation and unknown retry cannot replace the selected file', async () => {
    const f = fixture({ homepage: true });
    f.api.backupUpload = async (file, id) => { f.calls.push(['upload', file, id]); throw new Error('offline'); };
    f.api.backupUploadResult = async id => { f.calls.push(['upload-result', id]); throw new Error('offline'); };
    await assert.rejects(f.actions.action('backupImport', { file: f.file }), /offline/);
    assert.equal(f.state.backup.uploadPending, true);
    await assert.rejects(f.actions.action('backupImport', { file: f.file }), /先核对/);
    f.api.backupUploadResult = async id => { f.calls.push(['upload-result', id]); return { status: 'complete', archive: clone(f.archive) }; };
    await f.actions.action('backupImport', { retry: true });
    const uploads = f.calls.filter(c => c[0] === 'upload'); assert.equal(uploads[0][2], uploads[1][2]);
    assert.equal(uploads[0][1], uploads[1][1]); assert.equal(f.state.backup.uploadPending, false);
});

test('confirmed invalid upload clears pending, while unknown absence keeps the same operation', async () => {
    for (const status of [400, 503]) {
        const f = fixture(); f.api.backupUpload = async () => { throw Object.assign(new Error('reject'), { status }); };
        f.api.backupUploadResult = async () => ({ status: 'missing' });
        await assert.rejects(f.actions.action('backupImport', { file: f.file }), /reject/);
        assert.equal(f.state.backup.uploadPending, status === 503);
    }
});

test('server-declared failed upload releases the file and permits selecting a different package', async () => {
    const f = fixture(); f.api.backupUpload = async () => { throw new Error('disconnected'); };
    f.api.backupUploadResult = async () => ({ status: 'failed', message: '包格式不正确' });
    await assert.rejects(f.actions.action('backupImport', { file: f.file }), /包格式不正确/);
    assert.equal(f.state.backup.uploadPending, false); assert.equal(f.state.backup.uploadReset, 1);
    f.api.backupUpload = async () => ({ archive: clone(f.archive) });
    await f.actions.action('backupImport', { file: f.file }); assert.equal(f.state.backup.selected.id, 'a');
});

test('central controller exposes homepage archive actions and retains archives across chat switches without automatic library scans', async () => {
    const f = fixture({ homepage: true });
    f.api.health = async () => ({ version: VERSION, schema: SCHEMA });
    f.api.read = async binding => ({ document: createDocument(binding), defaults: createDefaults(), sourceAvailable: true, invalidSourceIds: [] });
    f.host.clear = () => {}; f.host.profiles = () => [];
    const controller = createController({ host: f.host, api: f.api, defer: () => {} });
    try {
        await controller.refresh(); assert.equal(controller.state.snapshot, null);
        await controller.action('backupList'); await controller.action('backupRead', { archiveId: 'a' });
        assert.equal(controller.state.backup.selected.id, 'a'); assert.equal(controller.state.document, null);
        f.state.snapshot = clone(f.snapshot); await controller.refresh();
        assert.equal(controller.state.backup.selected.id, 'a');
        f.state.snapshot.binding.file = 'Other'; await controller.refresh();
        assert.equal(controller.state.backup.selected.id, 'a');
        assert.equal(f.calls.filter(c => c[0] === 'list').length, 1);
    } finally { controller.destroy(); }
});

test('restoring needs an exact avatar and explicit matching current source, never enables or overwrites the current chat', async () => {
    const f = fixture(); await f.actions.action('backupRead', { archiveId: 'a' });
    await assert.rejects(f.actions.action('backupRestore', { targetAvatar: 'Same', sourceIds: [] }), /明确选择/);
    await assert.rejects(f.actions.action('backupRestore', { targetAvatar: 'same-2.png', sourceIds: [] }), /主聊天原件/);
    await assert.rejects(f.actions.action('backupRestore', { targetAvatar: 'same-2.png', useCurrent: true, currentBinding: { ...f.binding, file: 'wrong' } }), /当前聊天已变化/);
    const before = clone(f.state.document);
    await f.actions.action('backupRestore', { targetAvatar: 'same-2.png', sourceIds: ['source_1'], useCurrent: true, currentBinding: f.binding });
    const request = f.calls.find(c => c[0] === 'restore')[2];
    assert.equal(request.targetAvatar, 'same-2.png'); assert.deepEqual(request.useCurrentBinding, f.binding);
    assert.deepEqual(f.state.document, before); assert.equal(f.calls.some(c => c[0] === 'open'), false);
});

test('restoration unknown acknowledgement resumes its persisted request after reload; failed receipt permits a new operation', async () => {
    const f = fixture(); const request = { id: 'from-earlier-page', targetAvatar: 'same-2.png', sourceIds: ['source_0'] };
    f.api.backupResult = async () => ({ status: 'pending', request: clone(request), receipt: { id: request.id, status: 'pending' } });
    await f.actions.action('backupRead', { archiveId: 'a' }); assert.equal(f.state.backup.restorePending, true);
    f.api.backupRestore = async (id, op) => { f.calls.push(['restore', id, clone(op)]); return { status: 'failed', message: '已确认来源变化' }; };
    await assert.rejects(f.actions.action('backupRestore', { retry: true }), /已确认来源变化/);
    assert.deepEqual(f.calls[0][2], request); assert.equal(f.state.backup.restorePending, false);
    f.api.backupRestore = async (id, op) => { f.calls.push(['restore', id, clone(op)]); return clone(f.result); };
    await f.actions.action('backupRestore', { targetAvatar: 'same-1.png', useCurrent: true, currentBinding: f.binding });
    assert.notEqual(f.calls[1][2].id, request.id);
});

test('late restore never steals navigation and completed archives do not create a second copy', async () => {
    const f = fixture(); await f.actions.action('backupRead', { archiveId: 'a' }); const wait = deferred(), began = deferred();
    f.api.backupRestore = async (id, request) => { f.calls.push(['restore', id, clone(request)]); began.resolve(); return wait.promise; };
    const pending = f.actions.action('backupRestore', { targetAvatar: f.binding.avatar, useCurrent: true, currentBinding: f.binding });
    await began.promise; f.state.snapshot = null; f.life.generation++; wait.resolve(clone(f.result)); await pending;
    assert.equal(f.calls.some(c => c[0] === 'open'), false);
    await f.actions.action('backupRestore', {}); assert.equal(f.calls.filter(c => c[0] === 'restore').length, 1);
    await f.actions.action('backupOpen'); assert.equal(f.calls.some(c => c[0] === 'open'), false);
    f.state.snapshot = clone(f.snapshot); await f.actions.action('backupOpen'); assert.equal(f.calls.filter(c => c[0] === 'open').length, 1);
});
