// Actual host entry, view, selection model, account guard and mutation contract.
// Only ST context/persistence and the journal are replaced by synthetic memory.
export async function installStoryboardLinkReviewFixture({ hostSource }) {
    const view = await import('/qianmu-storyboard-link-review-view.js');
    const model = await import('/qianmu-storyboard-link-review.js');
    const mutation = await import('/qianmu-storyboard-package-mutation.js');
    const assets = await import('/qianmu-storyboard-package-assets.js');
    const { createQianmuAppearanceSession } = await import('/qianmu-appearance-session.js');
    const { updateAppearancePreferences } = await import('/qianmu-appearance-settings.js');
    window.setup = async ({ family = 'classic', mode = 'light', empty = false } = {}) => {
        window.fixture?.releaseLock?.(); window.owner?.close(); window.fixture?.release?.();
        await window.fixture?.run; window.appearance?.reset();
        document.body.innerHTML = '<div id="story-director-modal" class="open sd-theme-light"><button id="opener">核对正文位置</button></div>';
        const root = document.getElementById('story-director-modal'), settings = { theme: 'light' };
        if (family !== 'classic') settings.appearance = updateAppearancePreferences(settings, { family, mode });
        window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
        appearance.mount(root); await appearance.sync();
        const record = { id: 'image-1', url: '/user/images/fixture.png', floor: null, inline: false, messageHash: 'old',
            recipe: { floor: 7, prompt: 'original recipe' }, snapshot: { chatKey: 'old', payload: { prompt: 'original' } },
            restoreLinkReview: { version: 1, sourceFloor: 7, sourceChatKey: 'old', sourceFingerprint: 'source-bundle', reason: 'unverified-message' } };
        const f = window.fixture = { state: { shotPlans: [] }, store: { storyboardImages: [record, { id: 'other', tags: ['keep'] }] },
            messages: [{ mes: 'USER', is_user: true }, { mes: 'SYSTEM', is_system: true }, ...Array.from({ length: 28 }, (_, i) => ({
                mes: Array.from({ length: 28 }, (_, j) => `正文 ${i + 1} · 段落 ${j + 1} <img src=x> ${'保留叙事原意。'.repeat(8)}`).join('\n'),
                name: `角色 ${i + 1} <b>`, send_date: '2026-09-17', swipe_id: 0,
            }))], chatKey: 'chat', namespace: 'st-user:test', live: true, applies: 0, writes: 0, scheduled: 0, rendered: 0, closed: 0, released: 0, events: [], notices: [] };
        if (empty) f.messages = f.messages.slice(0, 2);
        f.original = structuredClone(f.store);
        f.setAppearance = async patch => { settings.appearance = updateAppearancePreferences(settings, patch); await appearance.sync(); };
        const pause = async stage => { if (f.hold === stage) await new Promise(resolve => { f.release = () => { f.hold = ''; f.release = null; resolve(); }; }); };
        const journal = {
            hasMutation: async () => Boolean(f.pending || f.receipt),
            prepareMutation: async (row, { isCurrent }) => {
                if (!isCurrent()) throw Error('原定位记录未写入：页面已变化');
                f.receipt = structuredClone(row); f.events.push('receipt'); await pause('receipt'); return row;
            },
            updateMutation: async (_, phase, { isCurrent }) => {
                if (!isCurrent()) throw Error('回执页面已变化'); f.phase = phase; f.events.push(phase); await pause(phase);
            },
            close: () => f.closed++,
        };
        let opened; const ready = new Promise(resolve => { opened = resolve; });
        const modules = { storyboardPackageAssets: assets, imageAdmission: { resolveImageAccountNamespace: async () => f.namespace },
            storyboardPackageJournal: { createStoryboardPackageJournal: () => journal }, storyboardPackageMutation: mutation, storyboardLinkReview: model,
            storyboardLinkReviewView: { openStoryboardLinkReview(options) {
                window.owner = view.openStoryboardLinkReview({ ...options, apply: () => { f.applies++; return options.apply(); } });
                f.owner = owner; window.dialog = root.querySelector('dialog');
                void owner.finished.then(result => { f.finished = true; f.result = result; }); opened(); return owner;
            } },
        };
        f.transfer = {}; f.jobs = new Set(); f.queue = [];
        const globals = {
            storyboardImportPackage: f.transfer, storyboardExportPackage: {}, storyboardState: () => f.state, getChatStore: () => f.store,
            getChatKey: () => f.chatKey, storyboardAdmissionEpoch: 1, featureRuntime: { load: async name => modules[name] }, MODAL_ID: root.id,
            storyboardActiveJobs: f.jobs, storyboardQueue: f.queue, storyboardSafeUrl: url => url, ctx: () => ({ chat: f.messages }),
            storyboardLinkReviewParagraphs: text => text.split('\n'), applyQianmuIcons() {},
            createStorageBackupCheck: () => {
                const check = () => { if (!f.live || !root.isConnected || !root.classList.contains('open')) throw Error('数据操作页面已变化；已写入内容保留'); };
                check.release = () => f.released++; return check;
            },
            saveMetadata: async () => { f.events.push('save-start'); await pause('save'); if (f.saveFail === 'before') throw Error('隔离保存失败'); f.persisted = structuredClone(f.store); f.writes++; f.events.push('save'); if (f.saveFail === 'after') throw Error('隔离回执丢失'); },
            storyboardScheduleInlineRender: () => f.scheduled++, renderModal: () => f.rendered++, toast: message => f.notices.push(message),
        };
        const run = new Function(...Object.keys(globals), `let storyboardLinkReview = null;\n${hostSource}\nreturn storyboardReviewRecordLink;`)(...Object.values(globals));
        document.getElementById('opener').focus(); f.run = run(record);
        await Promise.race([ready, f.run]);
    };
}
