// Actual USER alias view/coordinator/receipt validation; all persistence is memory-only.
export async function installUserAliasFixture({ library, namespace, chatHash }) {
    const { openUserAliasReview } = await import('/qianmu-user-alias-view.js');
    const { runUserAliasOperation } = await import('/qianmu-user-alias-runtime.js');
    const { planUserAliases, inspectUserAliasReview } = await import('/qianmu-user-alias.js');
    const { inspectUserAliasTargets } = await import('/qianmu-user-identity.js');
    const { mappingBytes } = await import('/qianmu-storyboard-mapping-contract.js');
    const { createQianmuAppearanceSession } = await import('/qianmu-appearance-session.js');
    const { updateAppearancePreferences } = await import('/qianmu-appearance-settings.js');
    window.setup = async ({ family = 'classic', mode = 'light', empty = false, missing = false, fail = '', hold = '' } = {}) => {
        window.fixture?.releaseLock?.();
        window.owner?.close(); window.appearance?.reset();
        document.body.innerHTML = '<div id="story-director-modal" class="open sd-theme-light"><button id="opener">核对 USER</button></div>';
        const root = document.getElementById('story-director-modal'), settings = { theme: 'light' };
        if (family !== 'classic') settings.appearance = updateAppearancePreferences(settings, { family, mode });
        window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
        appearance.mount(root); await appearance.sync();
        const f = window.fixture = { library: structuredClone(library), maps: new Map(), writes: 0, attempts: 0, calls: [], events: [], signals: [], fail, hold, when: 'after', live: true, fits: true, missing, applied: false };
        if (empty) f.library.bindings = [];
        f.original = structuredClone(f.library);
        f.setAppearance = async patch => { settings.appearance = updateAppearancePreferences(settings, patch); await appearance.sync(); };
        const targets = async keys => inspectUserAliasTargets(keys, f.missing ? {} : { 'A B.png': '同名 USER', 'Other.png': '同名 USER' });
        const journal = {
            inspectSubjectMap: async review => ({ fits: f.fits, receipt: f.maps.get(review.digest) || null }),
            prepareSubjectMap: async (review, { confirmed, isCurrent }) => {
                if (!confirmed || !isCurrent() || f.receiptFail) throw Error('原关系凭据保存失败');
                await inspectUserAliasReview(review); const bytes = mappingBytes(review);
                f.maps.set(review.digest, { key: JSON.stringify([namespace, review.digest, bytes]), namespace, review: structuredClone(review), bytes, createdAt: 1 }); f.events.push('receipt');
            },
        };
        const store = {
            bindings: async () => structuredClone(f.library.bindings),
            list: async () => f.library.archives.map(row => structuredClone(row.head)),
            applyUserAliasReview: async (_, review, { expectedBindings, confirmed, isCurrent }) => {
                f.attempts++;
                if (!confirmed || !isCurrent() || !f.maps.has(review.digest) || JSON.stringify(expectedBindings) !== JSON.stringify(f.library.bindings)) throw Error('隔离绑定写入缺少原凭据或版本已变化');
                const choices = Object.fromEntries(review.selections.map(row => [row.groupId, row.candidateId]));
                const result = await planUserAliases({ namespace, chatHash, bindings: f.library.bindings, choices, resolveTargets: targets });
                if (f.writeFail === 'before') throw Error('隔离写入失败');
                f.library.bindings = result.after; f.writes++; f.events.push('bindings');
                if (f.writeFail === 'after') throw Error('隔离写后回执丢失');
            },
        };
        const pause = async (action, when) => { if (f.hold === action && f.when === when) await new Promise(resolve => { f.release = () => { f.hold = ''; f.release = null; resolve(); }; }); };
        const run = async (action, { input, signal }) => {
            f.calls.push({ action, input: structuredClone(input) }); f.signals.push(signal);
            await pause(action, 'before');
            if (f.fail === action || f.applied && f.failAfterApply && action === 'user-alias-preview') throw Error('隔离复查失败 ' + action);
            const current = () => f.live && !signal.aborted;
            const result = await runUserAliasOperation(action, { namespace, chatHash, input: structuredClone(input), journal, store, resolveTargets: targets, isCurrent: current,
                guard: async () => { if (!current()) throw Error('页面或账户已变化'); } });
            if (action === 'user-alias-apply') { f.applied = true; f.result = result; } else f.preview = result;
            await pause(action, 'after'); // A response can arrive despite a cancelled view.
            return result;
        };
        document.getElementById('opener').focus();
        window.owner = openUserAliasReview({ parent: root, run }); window.dialog = root.querySelector('dialog');
    };
}
