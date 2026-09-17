// Executed inside an isolated browser page. Only view-facing services are mocked;
// real restore/storage protocols have their own contract and persistence tests.
export async function installRestoreReviewFixture() {
    Object.assign(window, await import('/qianmu-storyboard-bundle-view.js'), await import('/qianmu-storyboard-restore-storage-view.js'),
        await import('/qianmu-appearance-session.js'), await import('/qianmu-appearance-settings.js'));
    window.setup = async ({ rich = false, aliases = false, environment = false, family = 'classic', mode = 'light', kind = 'bundle', hold = '', fail = '' } = {}) => {
        window.owner?.close(); window.appearance?.reset();
        document.body.innerHTML = '<div id="story-director-modal" class="open sd-theme-light"><button id="opener">打开</button></div>';
        const root = document.getElementById('story-director-modal'), settings = { theme: 'light' };
        if (family !== 'classic') settings.appearance = updateAppearancePreferences(settings, { family, mode });
        window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
        appearance.mount(root); await appearance.sync();
        const f = window.fixture = { calls: [], closeCount: 0, hold, fail, stale: '', revision: 0, choices: {}, mappings: [], aliases: {}, consent: null, signals: [], paints: 0 };
        f.setAppearance = async patch => { settings.appearance = updateAppearancePreferences(settings, patch); await appearance.sync(); };
        const clone = value => structuredClone(value);
        const gate = async (action, input, result) => {
            f.calls.push({ action, input: clone(input) });
            if (f.hold === action) await new Promise(resolve => { f.release = resolve; });
            if (f.fail === action) throw Error(`隔离失败 ${action}`);
            return result();
        };
        const subjects = rich ? Array.from({ length: 26 }, (_, i) => ({ category: i === 0 ? 'char' : i === 1 ? 'user' : 'other', subjectKey: `source-${i}.png`, state: 'matched', required: i < 2 })) : [];
        const preview = (recheck = true) => ({
            ready: (!rich || !!f.choices['archive-0']) && (!aliases || !!f.aliases.g0), needsRecheck: !recheck, planDigest: recheck ? 'plan-' + f.revision : '',
            images: [], sourceLabelsMatched: true,
            ...(environment ? { environmentReview: { state: 'mapping-required', source: { instanceId: 'source', accountId: 'source-account' }, target: { instanceId: 'target', accountId: 'target-account' }, sourceDigest: 'source-digest', digest: 'mapping-digest' } } : {}),
            summary: { images: 0, vibeFiles: 0, workflows: { count: 0, versions: 0 }, pools: { count: 0 }, characters: { count: subjects.length },
                ...(rich ? { resourceOrigins: { total: 26, recorded: true, digest: `resources-${f.revision}`, included: 24, external: 2, dynamic: 0, unresolved: 0, review: 0 },
                    mappingReceipts: { count: 26, digest: `receipts-${f.revision}`, environment: 13, subjects: 13 } } : {}) },
            characterSummary: { added: 0, kept: 1, replaced: 0 }, configuration: { connections: rich ? [{ name: '连接占位', providerId: 'fixture', differences: [], credential: 'retained', state: 'same' }] : [] },
            conflicts: rich ? Array.from({ length: 26 }, (_, i) => ({ key: `archive-${i}`, kind: 'archive', localName: `本机 ${i}`, incomingName: `备份 ${i}`, localVersion: 1, incomingVersion: 2, choice: f.choices[`archive-${i}`] || (i ? 'local' : '') })) : [],
            bindingReview: rich ? [{ category: 'char', subjectKey: 'source-0.png', scope: 'default', archiveId: 'archive' }] : [],
            subjectReview: subjects.map(row => ({ ...row, targetKey: f.mappings.find(item => item.sourceKey === row.subjectKey)?.targetKey })), subjectMappings: clone(f.mappings),
            ...(rich ? { mappingRestore: { added: 26, existing: 0 }, carrierRestore: { count: 26, added: 26, existing: 0, originalCount: 26, addedOriginals: 26, totalBytes: 2048, descriptorDigest: `carriers-${f.revision}` } } : {}),
            ...(aliases ? { sourceAliases: { changed: true, total: 26, groups: 1, unresolved: f.aliases.g0 ? 0 : 1, ready: !!f.aliases.g0, targetsReady: true, evidenceChanges: 1, digest: `aliases-${f.revision}` }, sourceAliasChoices: clone(f.aliases) } : {}),
        });
        const page = (input, rows, extra) => ({ ...input, ...extra, total: rows.length, rows: rows.slice(input.offset || 0, (input.offset || 0) + 24) });
        const mismatch = (action, expected) => f.stale === action ? 'mismatched-digest' : expected;
        f.session = {
            preview: (choices = {}, mappings = f.mappings, sourceChoices = f.aliases) => gate('preview', { choices, mappings, sourceChoices }, () => {
                f.choices = clone(choices); f.mappings = clone(mappings); f.aliases = clone(sourceChoices); return preview();
            }),
            choose: choices => gate('choose', choices, () => { f.choices = clone(choices); return preview(false); }),
            targets: input => gate('targets', input, () => page(input, Array.from({ length: 26 }, (_, i) => ({ name: `${input.query || '目标'} ${i} <b>`, subjectKey: `${input.category}:target-${i}.png` })), {})),
            resources: input => gate('resources', input, () => page(input, Array.from({ length: input.filter === 'external' ? 2 : 26 }, (_, i) => ({ label: `用途 ${i} <img src=x>`, state: input.filter === 'external' ? 'external' : 'included', target: `file-${i}`, at: `/fixture/${i}` })), { digest: mismatch('resources', `resources-${f.revision}`) })),
            receipts: input => gate('receipts', input, () => page(input, Array.from({ length: 26 }, (_, i) => ({ kind: i % 2 ? 'subjects' : 'environment', createdAt: 1700000000000, bindings: 1, bytes: 20, sourceDigest: 'original', digest: `receipt-${i}` })), { indexDigest: mismatch('receipts', `receipts-${f.revision}`) })),
            carriers: input => gate('carriers', input, () => page(input, Array.from({ length: 26 }, (_, i) => ({ current: !i, createdAt: 1700000000000, indexState: 'empty', receiptCount: 0, bytes: 20, carrierDigest: `carrier-${i}` })), { descriptorDigest: mismatch('carriers', `carriers-${f.revision}`) })),
            aliases: input => gate('aliases', input, () => page(input, Array.from({ length: 26 }, (_, i) => ({ groupId: i < 2 ? 'g0' : `g${i}`, candidateId: `c${i}`, archiveName: `人设 ${i}`, sourceKey: `avatars/user-${i}.png`, targetKey: `user-${i}.png`, scope: 'default', selected: f.aliases.g0 === `c${i}`, conflict: i < 2 })), { digest: mismatch('aliases', `aliases-${f.revision}`) })),
            restore: (prepared, consent) => gate('restore', { prepared, consent }, () => { f.consent = clone(consent); return { resourcesVerified: true, settingsVerified: false }; }),
            close: () => { f.closeCount++; },
        };
        let removed = false;
        f.storageRun = async (action, options) => {
            f.signals.push(options.signal);
            const { signal, ...input } = options;
            return gate(action, input, () => {
                if (action === 'clear') { removed = true; return { removed: [input.selected[0]], complete: !f.partial, error: f.partial ? '另一记录已变化' : '' }; }
                if (removed && f.failAfterClear) throw Error('盘点暂时失败');
                return { count: removed ? 0 : 2, bytes: 100, items: removed ? [] : [0, 1].map(i => ({ kind: i ? 'bundle' : 'configuration', key: `record-${i}`, fingerprint: `fingerprint-${i}`, phase: 'prepared', fileHash: 'f'.repeat(64), chatHash: 'chat', bytes: 50, updatedAt: 1700000000000 })) };
            });
        };
        document.getElementById('opener').focus();
        window.owner = kind === 'storage' ? openRestoreStorageManager({ parent: root, chatHash: 'chat', run: f.storageRun, formatBytes: value => `${value} B`, icons: () => f.paints++ })
            : openStoryboardBundleReview({ parent: root, fileName: '隔离 <b> 备份.qianmu', connect: () => gate('connect', {}, () => f.session), paintIcons: () => f.paints++ });
        window.dialog = root.querySelector('dialog');
    };
}
