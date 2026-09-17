// Native view, Blob/crypto and registry/import contracts; storage is an isolated Map.
export async function installMappingRegistryFixture({ receipts, namespace }) {
    const { openMappingRegistry } = await import('/qianmu-storyboard-mapping-view.js');
    const { runMappingRegistry } = await import('/qianmu-storyboard-mapping-registry.js');
    const { runMappingImport } = await import('/qianmu-mapping-import.js');
    const { mappingHead } = await import('/qianmu-storyboard-mapping-contract.js');
    const { inspectBundleMappingReceipt } = await import('/qianmu-bundle-mappings.js');
    const { createQianmuAppearanceSession } = await import('/qianmu-appearance-session.js');
    const { updateAppearancePreferences } = await import('/qianmu-appearance-settings.js');
    const createUrl = URL.createObjectURL.bind(URL), revokeUrl = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = createUrl(blob); fixture.urls.push(url); return url; };
    URL.revokeObjectURL = url => { fixture.revoked.push(url); revokeUrl(url); };
    window.mappingReceipts = receipts;
    window.setup = async ({ empty = false, exclude = [], family = 'classic', mode = 'light', hold = '', fail = '' } = {}) => {
        window.owner?.close(); window.appearance?.reset();
        document.body.innerHTML = '<div id="story-director-modal" class="open sd-theme-light"><button id="opener">打开凭据</button></div>';
        const root = document.getElementById('story-director-modal'), settings = { theme: 'light' };
        if (family !== 'classic') settings.appearance = updateAppearancePreferences(settings, { family, mode });
        window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
        appearance.mount(root); await appearance.sync();
        const f = window.fixture = { calls: [], signals: [], urls: [], revoked: [], writes: 0, reads: 0, hold, fail, when: 'after', live: true, imported: false,
            records: new Map((empty ? [] : receipts.filter((_, index) => !exclude.includes(index))).map(row => [row.head.key, structuredClone(row)])) };
        f.setAppearance = async patch => { settings.appearance = updateAppearancePreferences(settings, patch); await appearance.sync(); };
        const journal = {
            listMappingHeads: async () => [...f.records.values()].map(row => structuredClone(row.head)),
            loadMappingReceipt: async (_, kind, digest) => {
                f.reads++; const row = [...f.records.values()].find(row => row.kind === kind && row.head.digest === digest);
                if (!row) return null;
                await inspectBundleMappingReceipt(row.receipt, row.head, namespace); return structuredClone(row.receipt);
            },
            importMappingReceipt: async (receipt, { head, confirmed, isCurrent }) => {
                if (!confirmed || !isCurrent()) throw Error('隔离写入缺少确认或页面已变化');
                await inspectBundleMappingReceipt(receipt, head, namespace);
                if (!f.records.has(head.key)) { f.records.set(head.key, { kind: head.kind, head: mappingHead(head.kind, receipt), receipt: structuredClone(receipt) }); f.writes++; }
            },
        };
        const pause = async (action, when) => { if (f.hold === action && f.when === when) await new Promise(resolve => { f.release = () => { f.hold = ''; f.release = null; resolve(); }; }); };
        const run = async (action, { input, signal }) => {
            f.calls.push({ action, input }); f.signals.push(signal);
            await pause(action, 'before');
            if (f.fail === action || f.imported && f.failAfterImport && action === 'mapping-list') throw Error('隔离读取失败 ' + action);
            const current = () => f.live && !signal.aborted;
            const guard = async () => { if (!current()) throw Error('页面或账户已变化'); };
            const options = { input, namespace, journal, guard, isCurrent: current };
            const result = await (action.startsWith('mapping-import-') ? runMappingImport(action, options) : runMappingRegistry(action, options));
            if (action === 'mapping-import-apply') f.imported = true;
            await pause(action, 'after'); // Simulate a successful response arriving after cancellation.
            return result;
        };
        document.getElementById('opener').focus();
        window.owner = openMappingRegistry({ parent: root, run, formatBytes: value => `${value} B` });
        window.dialog = root.querySelector('dialog');
    };
}
