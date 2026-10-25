import {constants} from 'node:fs';
import * as contract from './contract.mjs';
import {entryOrigin, selectStoryEntries, storyOffset} from './story-contract.mjs';
const clone = value => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const requestId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

export function createStoryHandlers({io, context, prepare, exclusive, documentRead, defaultsRead, read, requireSource, requireForeignSource,
    sourcePath, checkDirectory, checkRoot, writeFile, normalizeStoreBinding, chatStorageName, fail, digest}) {
    const exists = async target => {try { await io.lstat(target); return true; } catch (error) {if (error.code === 'ENOENT') return false; throw error;}};
    const targetBinding = (binding, id) => {
        if (!requestId(id)) fail('story_id', '故事创建标识无效', 400);
        const hash = digest(JSON.stringify([binding, id]));
        return {avatar: binding.avatar, file: `${Array.from(binding.file).slice(0, 60).join('')}-忆幕-${hash.slice(0, 20)}`, integrity: `yimu-${hash}`};
    };
    const receipt = document => ({id: document.creation.id, status: document.creation.status, target: clone(document.binding),
        source: {binding: clone(document.lineage.sourceBinding), cutoff: document.lineage.cutoff},
        bridge: {count: document.lineage.bridgeCount, hashes: [...document.lineage.bridgeHashes],
            sourceStart: document.lineage.cutoff - document.lineage.bridgeCount + 1, sourceEnd: document.lineage.cutoff}, documentRevision: document.revision});
    const safeMessage = message => {
        if (typeof message?.mes !== 'string' || message.tool_calls || message.tool_call_id || message.extra?.tool_invocations
            || message.extra?.file || message.extra?.files || message.extra?.media?.length || message.extra?.image || message.extra?.video || message.extra?.audio) {
            fail('story_content', '衔接范围含暂不支持安全复制的媒体或工具消息，请调整截止位置');
        }
        return {name: String(message.name || ''), is_user: Boolean(message.is_user), is_system: Boolean(message.is_system),
            mes: message.mes, send_date: String(message.send_date ?? '')};
    };

    async function plan(request, ctx, binding, query) {
        if (!['continue', 'branch'].includes(query?.mode)) fail('story_mode', '请选择续接或指定楼层分支', 400);
        if (query.cutoff !== undefined && (!Number.isSafeInteger(query.cutoff) || query.cutoff < 1)) fail('story_cutoff', '故事截止楼层无效', 400);
        const loaded = await read(request, binding), document = loaded.document;
        if (!loaded.sourceAvailable) fail('story_source', '当前聊天原件尚未通过核对，未创建故事');
        const settings = contract.effectiveSettings(document, loaded.defaults), hashes = [], bridge = [];
        const cutoffLimit = query.cutoff ?? Infinity;
        await requireSource(ctx, binding, null, [], (message, floor, hash) => {
            hashes.push(hash);
            if (floor <= cutoffLimit) {
                bridge.push(message);
                if (bridge.length > settings.recent) bridge.shift();
            }
        });
        const total = hashes.length, cutoff = query.cutoff ?? total;
        if (!total || cutoff > total) fail('story_cutoff', '故事截止楼层不存在，未创建', 400);
        const valid = new Set(document.entries.filter(entry => entry.status === 'active' && !loaded.invalidSourceIds.includes(entry.id)
            && (entry.origin ? entry.originVerified : !entry.source || contract.sourceMatches(entry.source, hashes))).map(entry => entry.id));
        const selected = selectStoryEntries(document, cutoff, valid);
        const boundaries = [];
        for (const boundary of selected.boundaries) {
            const messages = [];
            await requireForeignSource(ctx, normalizeStoreBinding(boundary.origin.binding), boundary.source, null, (message, floor) => {
                if (floor >= boundary.source.start && floor <= boundary.source.end) messages.push({floor, ...safeMessage(message)});
            });
            boundaries.push({...boundary, messages});
        }
        const bridgeCount = bridge.length, bridgeHashes = hashes.slice(cutoff - bridgeCount, cutoff);
        const offset = storyOffset(document) + cutoff - bridgeCount;
        const represented = new Set();
        for (const entry of selected.entries) if (entry.kind === 'summary') for (const range of contract.sourceRanges(entry)) {
            const start = entryOrigin(entry, document).offset + range.start - storyOffset(document);
            const end = entryOrigin(entry, document).offset + range.end - storyOffset(document);
            for (let floor = Math.max(1, start); floor <= Math.min(cutoff, end); floor++) represented.add(floor);
        }
        for (const boundary of boundaries) for (let floor = Math.max(1, boundary.origin.offset + boundary.source.start - storyOffset(document));
            floor <= Math.min(cutoff, boundary.origin.offset + boundary.source.end - storyOffset(document)); floor++) represented.add(floor);
        for (let floor = cutoff - bridgeCount + 1; floor <= cutoff; floor++) represented.add(floor);
        const publicPlan = {sourceBinding: clone(binding), sourceRevision: document.revision,
            sourceFingerprint: digest(JSON.stringify(hashes)), defaultsRevision: loaded.defaults.revision,
            mode: query.mode, cutoff, total, recent: settings.recent, offset, bridgeCount, inheritedCount: selected.entries.length,
            skippedExcerptCount: selected.skippedExcerptCount, unrepresentedFloorCount: cutoff - represented.size,
            manualChoices: selected.manualChoices, boundaries};
        const bridgeMessages = bridge.map(safeMessage);
        const planId = digest(JSON.stringify([publicPlan, selected.entries.map(entry => {
            const {history, conflicts, candidate, originVerified, ...value} = entry; return value;
        }), bridgeHashes]));
        return {publicPlan: {planId, ...publicPlan}, document, entries: selected.entries, bridge: bridgeMessages, bridgeHashes};
    }

    async function planStory(request, rawBinding, query) {
        const binding = normalizeStoreBinding(rawBinding), ctx = context(request); await prepare(ctx);
        return (await exclusive(ctx, 'defaults.json', () => exclusive(ctx, chatStorageName(binding), () => plan(request, ctx, binding, query)))).publicPlan;
    }

    function newDocument(binding, source, prepared, operation, requestHash) {
        const document = contract.createDocument(binding), ids = new Map();
        const fresh = (entry, suffix) => {
            const {history, conflicts, candidate, originVerified, ...values} = clone(entry);
            return {...values, id: `story_${digest(`${operation.id}:${suffix}`).slice(0, 36)}`, revision: 1, status: 'active', history: [], conflicts: [], candidate: null};
        };
        for (const entry of prepared.entries) ids.set(entry.id, `story_${digest(`${operation.id}:${entry.id}`).slice(0, 36)}`);
        document.entries = prepared.entries.map(entry => {
            const value = fresh(entry, entry.id); value.origin = clone(entryOrigin(entry, prepared.document));
            if (value.kind === 'stage') value.source.parents = value.source.parents.map(ref => ({id: ids.get(ref.id), revision: 1}));
            return value;
        });
        if (!Array.isArray(operation.manualChoices || []) || !Array.isArray(operation.boundarySummaries || [])) fail('story_choices', '故事继承选择无效', 400);
        const choices = new Set();
        for (const choice of operation.manualChoices || []) {
            const offered = prepared.publicPlan.manualChoices.find(item => item.id === choice?.id && item.revision === choice.revision);
            if (!offered || choices.has(choice.id) || typeof choice.text !== 'string' || !choice.text.trim() || choice.text.length > 100000) fail('story_choices', '人工继承内容不完整或已变化', 400);
            choices.add(choice.id);
            document.entries.push(fresh({kind: 'manual', text: choice.text.trim(), source: null, edited: true}, `manual:${choice.id}`));
        }
        const boundaryIds = new Set();
        for (const item of operation.boundarySummaries || []) {
            const offered = prepared.publicPlan.boundaries.find(boundary => boundary.id === item?.id);
            if (!offered || boundaryIds.has(item.id) || !Array.isArray(item.entries) || !item.entries.length) fail('story_boundary', '截止边界整理结果无效', 400);
            boundaryIds.add(item.id); let next = offered.source.start;
            for (const [index, entry] of item.entries.entries()) {
                const range = entry?.source;
                if (!range || range.start !== next || !Number.isSafeInteger(range.end) || range.end < next || range.end > offered.source.end
                    || !same(range.hashes, offered.source.hashes.slice(range.start - offered.source.start, range.end - offered.source.start + 1))
                    || typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 100000) fail('story_boundary', '截止边界未完整按原文整理，未创建');
                next = range.end + 1;
                document.entries.push(fresh({kind: 'summary', text: entry.text.trim(), source: clone(range), origin: clone(offered.origin), edited: false}, `boundary:${item.id}:${index}`));
            }
            if (next !== offered.source.end + 1) fail('story_boundary', '截止边界整理尚未完成，未创建');
        }
        if (boundaryIds.size !== prepared.publicPlan.boundaries.length) fail('story_boundary', '请先完成截止边界的原文整理');
        const value = prepared.publicPlan;
        document.settings = clone(prepared.document.settings);
        document.autoSummary = prepared.document.autoSummary;
        document.enabled = true; document.epoch = 1; document.configRevision = 1; document.revision = 1;
        document.initialRange = {start: 1, end: value.bridgeCount, total: value.bridgeCount};
        document.lineage = {sourceBinding: clone(source), cutoff: value.cutoff, offset: value.offset, bridgeCount: value.bridgeCount, bridgeHashes: [...prepared.bridgeHashes]};
        document.creation = {id: operation.id, requestHash, planId: value.planId, status: 'pending',
            sourceFingerprint: value.sourceFingerprint, sourceRevision: value.sourceRevision, defaultsRevision: value.defaultsRevision};
        return contract.validateDocument(document);
    }

    async function chatBytes(ctx, binding) {
        const {folder, target} = sourcePath(ctx, binding); await checkDirectory(ctx, folder);
        const before = await io.lstat(target, {bigint: true});
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) fail('story_target', '故事目标文件身份异常，未覆盖');
        const file = await io.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
            const opened = await file.stat({bigint: true});
            if (before.ino !== opened.ino || before.dev !== opened.dev || before.mtimeNs !== opened.mtimeNs || before.size !== opened.size) fail('story_target', '故事目标读取期间变化');
            const bytes = await file.readFile();
            const after = await io.lstat(target, {bigint: true});
            if (after.ino !== opened.ino || after.dev !== opened.dev || after.mtimeNs !== opened.mtimeNs || after.size !== opened.size || after.nlink !== 1n) fail('story_target', '故事目标读取期间变化');
            return bytes;
        } finally {await file.close();}
    }

    async function createOnlyChat(ctx, binding, bytes) {
        const {folder, target} = sourcePath(ctx, binding); await checkDirectory(ctx, folder); await checkRoot(ctx);
        if (await exists(target)) {
            if (!(await chatBytes(ctx, binding)).equals(bytes)) fail('story_collision', '目标聊天已存在且内容不同，未覆盖');
            return;
        }
        let file, identity, confirmed = false;
        try {
            file = await io.open(target, 'wx', 0o600); identity = await file.stat({bigint: true});
            await file.writeFile(bytes); await file.sync(); await file.close(); file = null;
            if (process.platform !== 'win32') {
                const directory = await io.open(folder, 'r');
                try {await directory.sync();} finally {await directory.close();}
            }
            if (!(await chatBytes(ctx, binding)).equals(bytes)) fail('story_unconfirmed', '新聊天尚未完整核实，请核对创建结果');
            confirmed = true;
        } finally {
            if (file) await file.close();
            if (identity && !confirmed) {
                const current = await io.lstat(target, {bigint: true});
                if (current.ino === identity.ino && current.dev === identity.dev && current.nlink === 1n && !current.isSymbolicLink()) {
                    // Only our incomplete, never-confirmed new file is removed; old chats are never a target.
                    await checkDirectory(ctx, folder); await io.unlink(target);
                }
            }
        }
    }

    async function createStory(request, rawBinding, operation) {
        const binding = normalizeStoreBinding(rawBinding), ctx = context(request); await prepare(ctx);
        const target = targetBinding(binding, operation?.id), requestHash = digest(JSON.stringify(operation));
        const names = [chatStorageName(binding), chatStorageName(target)].sort();
        return exclusive(ctx, 'defaults.json', () => exclusive(ctx, names[0], () => exclusive(ctx, names[1], async () => {
            const previous = await documentRead(ctx, target);
            if (previous.fingerprint && (previous.value.creation?.id !== operation.id || previous.value.creation?.requestHash !== requestHash
                || !same(previous.value.lineage?.sourceBinding, binding))) fail('story_collision', '该创建标识已有不同结果，未覆盖');
            if (previous.value.creation?.status === 'failed') fail('story_failed', '上次创建所依据的来源已变化，请重新预览并另建；原有文件已保留');
            if (previous.value.creation?.status === 'complete') {
                await requireSource(ctx, target, {start: 1, end: previous.value.lineage.bridgeCount, hashes: previous.value.lineage.bridgeHashes});
                return {binding: target, document: previous.value, receipt: receipt(previous.value)};
            }
            const prepared = await plan(request, ctx, binding, operation);
            if (prepared.publicPlan.planId !== operation.planId) fail('story_changed', '源聊天、记忆或设置已经变化，请重新预览后创建');
            const document = newDocument(target, binding, prepared, operation, requestHash);
            if (previous.fingerprint && !same(previous.value, document)) fail('story_changed', '待完成故事已被修改，未覆盖');
            const header = {user_name: 'unused', character_name: 'unused', chat_metadata: {integrity: target.integrity, yimu_story: operation.id}};
            const bytes = Buffer.from([header, ...prepared.bridge].map(JSON.stringify).join('\n') + '\n', 'utf8');
            const chatTarget = sourcePath(ctx, target).target;
            if (!previous.fingerprint && await exists(chatTarget)) fail('story_collision', '目标聊天已经存在，未覆盖');
            if (!previous.fingerprint) await writeFile(ctx, chatStorageName(target), document, null, contract.validateDocument);
            const verifyCurrentSources = async () => {
                const hashes = [];
                await requireSource(ctx, binding, null, [], (message, floor, hash) => hashes.push(hash));
                if (digest(JSON.stringify(hashes)) !== prepared.publicPlan.sourceFingerprint) fail('story_changed', '创建期间源聊天已变化，尚未确认新故事');
                const foreign = new Map();
                for (const entry of document.entries.filter(entry => entry.source && entry.origin && !same(entry.origin.binding, binding))) {
                    const key = JSON.stringify(entry.origin.binding);
                    if (!foreign.has(key)) foreign.set(key, {binding: entry.origin.binding, entries: []});
                    foreign.get(key).entries.push(entry);
                }
                for (const group of foreign.values()) {
                    const checked = await requireForeignSource(ctx, normalizeStoreBinding(group.binding), null, group.entries);
                    if (checked.invalidSourceIds.length) fail('story_changed', '创建期间继承原文已变化，尚未确认新故事');
                }
            };
            await verifyCurrentSources();
            await createOnlyChat(ctx, target, bytes);
            await verifyCurrentSources();
            const current = await documentRead(ctx, target);
            if (!same(current.value, document)) fail('story_changed', '新故事记忆已经变化，未覆盖');
            document.creation.status = 'complete'; document.revision++;
            await writeFile(ctx, chatStorageName(target), document, current.fingerprint, contract.validateDocument);
            return {binding: target, document, receipt: receipt(document)};
        })));
    }

    async function storyResult(request, rawBinding, query) {
        const binding = normalizeStoreBinding(rawBinding), ctx = context(request); await prepare(ctx);
        const target = targetBinding(binding, query?.id);
        const names = [chatStorageName(binding), chatStorageName(target)].sort();
        return exclusive(ctx, 'defaults.json', () => exclusive(ctx, names[0], () => exclusive(ctx, names[1], async () => {
            const saved = await documentRead(ctx, target);
            if (!saved.fingerprint) return {status: 'missing'};
            const document = saved.value;
            if (document.creation?.id !== query.id || !same(document.lineage?.sourceBinding, binding)) fail('story_collision', '该标识不是本次故事创建结果');
            if (document.creation.status === 'complete') {
                await requireSource(ctx, target, {start: 1, end: document.lineage.bridgeCount, hashes: document.lineage.bridgeHashes});
                return {status: 'complete', binding: target, document, receipt: receipt(document)};
            }
            if (document.creation.status === 'pending') {
                let terminal = '';
                try {
                    const source = await documentRead(ctx, binding), defaults = await defaultsRead(ctx);
                    if (source.value.revision !== document.creation.sourceRevision || defaults.value.revision !== document.creation.defaultsRevision) {
                        terminal = '创建所依据的源记忆或设置已变化；未完成文件已保留，请重新预览后另建。';
                    } else {
                        const hashes = [];
                        await requireSource(ctx, binding, null, [], (message, floor, hash) => hashes.push(hash));
                        if (digest(JSON.stringify(hashes)) !== document.creation.sourceFingerprint) terminal = '创建所依据的源聊天已变化；未完成文件已保留，请重新预览后另建。';
                        const foreign = new Map();
                        for (const entry of document.entries.filter(entry => entry.source && entry.origin && !same(entry.origin.binding, binding))) {
                            const key = JSON.stringify(entry.origin.binding);
                            if (!foreign.has(key)) foreign.set(key, {binding: entry.origin.binding, entries: []});
                            foreign.get(key).entries.push(entry);
                        }
                        for (const group of foreign.values()) if ((await requireForeignSource(ctx, normalizeStoreBinding(group.binding), null, group.entries)).invalidSourceIds.length) {
                            terminal = '创建所依据的继承原文已变化；未完成文件已保留，请重新预览后另建。';
                        }
                        if (await exists(sourcePath(ctx, target).target)) await requireSource(ctx, target, {start: 1, end: document.lineage.bridgeCount, hashes: document.lineage.bridgeHashes});
                    }
                } catch (caught) {
                    if (['yimu_source_missing', 'yimu_source_changed', 'yimu_source_identity'].includes(caught?.code)) {
                        terminal = '创建所依据的聊天原件已缺失或变化；未完成文件已保留，请重新预览后另建。';
                    } else throw caught;
                }
                if (terminal) {
                    document.creation.status = 'failed'; document.creation.message = terminal; document.enabled = false; document.epoch++; document.revision++;
                    await writeFile(ctx, chatStorageName(target), document, saved.fingerprint, contract.validateDocument);
                }
            }
            if (document.creation.status === 'failed') return {status: 'failed', binding: target, receipt: receipt(document), message: document.creation.message};
            return {status: 'pending', binding: target, receipt: receipt(document)};
        })));
    }
    return {planStory, createStory, storyResult};
}
