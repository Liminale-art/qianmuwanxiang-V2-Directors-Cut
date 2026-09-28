// Collection operations share the supplied page/account document session.
// This module owns neither persistence nor the lifetime of that session.
import {validateTextCollectionOrganization} from './qianmu-text-collection-organization.js';
const failure = (code, message) => Object.assign(new Error(message), {code: `text_collection_${code}`});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object'
    && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function fields(value, expected) {
    return record(value) && Object.keys(value).length === expected.length && expected.every(key => own(value, key));
}
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function timestamp(value) {
    if (typeof value !== 'string') return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function validSource(value) {
    return value === null || fields(value, ['chatId', 'messageId']) && nonempty(value.chatId) && nonempty(value.messageId);
}
export function validateTextCollectionDocument(value) {
    if (!(value?.version === 1 && fields(value, ['version', 'items'])
        || value?.version === 2 && fields(value, ['version', 'items', 'organization'])) || !Array.isArray(value.items)) {
        throw failure('document', '收藏内容无法读取，请刷新重试');
    }
    const ids = new Set();
    for (const item of value.items) {
        if (!fields(item, ['id', 'text', 'charName', 'userName', 'createdAt', 'updatedAt', 'source'])
            || !nonempty(item.id) || ids.has(item.id) || !nonempty(item.text)
            || typeof item.charName !== 'string' || typeof item.userName !== 'string'
            || !timestamp(item.createdAt) || !timestamp(item.updatedAt) || !validSource(item.source)) {
            throw failure('document', '收藏内容无法读取，请刷新重试');
        }
        ids.add(item.id);
    }
    if (value.version === 2) validateTextCollectionOrganization(value.organization, ids);
    return value;
}
const validate = validateTextCollectionDocument;
const sameItem = (left, right) => left.id === right.id && left.text === right.text
    && left.charName === right.charName && left.userName === right.userName
    && left.createdAt === right.createdAt && left.updatedAt === right.updatedAt
    && (left.source === null && right.source === null || left.source !== null && right.source !== null
        && left.source.chatId === right.source.chatId && left.source.messageId === right.source.messageId);
export {sameItem as sameTextCollectionItem};

export function documentFromTextCollectionState(state) {
    return structuredClone(validate({version: state.version ?? 1, items: state.items,
        ...(state.version === 2 ? {organization: state.organization} : {})}));
}

export function mergeTextCollectionDocuments(current, additions) {
    const result = structuredClone(validate(current)), incoming = structuredClone(validate(additions));
    const existing = new Map(result.items.map(item => [item.id, item])), newIds = new Set();
    for (const item of incoming.items) {
        const previous = existing.get(item.id);
        if (previous && !sameItem(previous, item)) throw failure('conflict', '已有同编号收藏，未覆盖当前内容');
        if (!previous) { result.items.push(item); existing.set(item.id, item); newIds.add(item.id); }
    }
    if (incoming.version === 2) {
        const organization = result.organization || {folders: [], entries: []};
        for (const folder of incoming.organization.folders) {
            const previous = organization.folders.find(value => value.id === folder.id);
            if (previous && previous.name !== folder.name) throw failure('conflict', '文件夹已有变化，未覆盖当前内容');
            if (!previous) organization.folders.push(folder);
        }
        // Existing entries, including uncategorized ones, always retain their
        // current organization. Restore only associates newly admitted items.
        organization.entries.push(...incoming.organization.entries.filter(entry => newIds.has(entry.itemId)));
        result.version = 2; result.organization = organization;
    }
    return validate(result);
}

export function createTextCollection({session, now = () => new Date().toISOString(), createId = () => crypto.randomUUID()} = {}) {
    if (!session || !['open', 'refresh', 'save', 'state', 'subscribe'].every(key => typeof session[key] === 'function')
        || typeof now !== 'function' || typeof createId !== 'function') {
        throw new TypeError('Text collection requires a document session, clock and ID source');
    }
    function view(raw) {
        const result = {
            phase: raw.phase, loaded: false, version: 1, items: [], organization: {folders: [], entries: []}, fingerprint: null,
            needsRefresh: raw.needsRefresh, error: raw.error ? {...raw.error} : null,
        };
        if (!raw.document) return result;
        try {
            const document = raw.document.exists ? validate(raw.document.value) : {version: 1, items: []};
            return {...result, loaded: true, version: document.version, items: structuredClone(document.items),
                organization: structuredClone(document.organization || result.organization), fingerprint: raw.document.fingerprint};
        } catch (error) {
            return {...result, phase: 'error', error: {code: error.code, message: error.message}};
        }
    }
    function state() { return view(session.state()); }
    function confirmed() {
        const current = state();
        if (!current.loaded) throw failure('unopened', '请先打开收藏');
        return current;
    }
    function base(options) {
        const current = confirmed();
        if (!options || !own(options, 'expectedFingerprint') || options.expectedFingerprint !== current.fingerprint) {
            throw failure('conflict', '内容已有更新，未覆盖当前收藏');
        }
        if (['loading', 'refreshing', 'saving'].includes(current.phase)) throw failure('busy', '请等待当前操作完成');
        if (current.needsRefresh) throw failure('pending', '保存尚未确认，请刷新后重试');
        return current;
    }
    async function load(method) {
        await session[method]();
        const current = state();
        if (!current.loaded) throw Object.assign(new Error(current.error?.message || '收藏内容无法读取'), {code: current.error?.code || 'text_collection_document'});
        return current;
    }
    function mutate(options, transform) {
        try {
            const current = base(options);
            const next = validate(transform(documentFromTextCollectionState(current)));
            // save marks the session busy synchronously, before a second click
            // can create another entry. No queue or implicit retry is added.
            return session.save(next, {expectedFingerprint: current.fingerprint}).then(state);
        } catch (error) { return Promise.reject(error); }
    }
    const withItems = transform => document => {
        document.items = transform(document.items);
        if (document.version === 2) {
            const remaining = new Set(document.items.map(item => item.id));
            document.organization.entries = document.organization.entries.filter(entry => remaining.has(entry.itemId));
        }
        return document;
    };
    const classification = transform => document => {
        document.version = 2; document.organization ||= {folders: [], entries: []};
        transform(document.organization, document.items); return document;
    };
    const nameKey = name => name.trim().toLocaleLowerCase();
    function folderName(name, folders, except = null) {
        if (!nonempty(name)) throw failure('input', '请填写文件夹名称');
        if (folders.some(folder => folder.id !== except && nameKey(folder.name) === nameKey(name))) throw failure('input', '已有同名文件夹');
        return name.trim();
    }
    return Object.freeze({
        open: () => load('open'), refresh: () => load('refresh'), state,
        subscribe(listener) {
            if (typeof listener !== 'function') throw new TypeError('Listener must be a function');
            return session.subscribe(raw => listener(view(raw)));
        },
        add(input, options) {
            return mutate(options, withItems(items => {
                if (!record(input) || Object.keys(input).some(key => !['id', 'text', 'charName', 'userName', 'source'].includes(key))
                    || !nonempty(input.text) || typeof input.charName !== 'string' || typeof input.userName !== 'string'
                    || own(input, 'id') && !nonempty(input.id)
                    || !validSource(input.source === undefined ? null : input.source)) {
                    throw failure('input', '请填写要收藏的正文');
                }
                const time = now(), id = own(input, 'id') ? input.id : createId();
                if (!timestamp(time) || !nonempty(id) || items.some(item => item.id === id)) throw failure('input', '未能新建收藏，请重试');
                return [...items, {
                    id, text: input.text, charName: input.charName, userName: input.userName,
                    createdAt: time, updatedAt: time, source: input.source === undefined ? null : structuredClone(input.source),
                }];
            }));
        },
        edit(id, text, options) {
            return mutate(options, withItems(items => {
                if (!nonempty(id) || !nonempty(text)) throw failure('input', '请填写要保存的正文');
                const item = items.find(item => item.id === id);
                if (!item) throw failure('missing', '这条收藏已不存在');
                if (item.text === text) return items;
                const updatedAt = now();
                if (!timestamp(updatedAt)) throw failure('input', '未能保存收藏，请重试');
                return items.map(item => item.id === id ? {...item, text, updatedAt} : item);
            }));
        },
        remove(ids, options) {
            return mutate(options, withItems(items => {
                if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => !nonempty(id))) throw failure('input', '请先选择收藏');
                const selected = new Set(ids);
                if ([...selected].some(id => !items.some(item => item.id === id))) throw failure('missing', '所选收藏已变化，请重新选择');
                return items.filter(item => !selected.has(item.id));
            }));
        },
        restore(document, options) {
            return mutate(options, current => mergeTextCollectionDocuments(current, document));
        },
        clear(options) {
            return mutate(options, current => current.version === 1 ? {version: 1, items: []}
                : {version: 2, items: [], organization: {folders: [], entries: []}});
        },
        createFolder(name, options) {
            return mutate(options, classification(organization => {
                const value = folderName(name, organization.folders), id = createId();
                if (!nonempty(id) || organization.folders.some(folder => folder.id === id)) throw failure('input', '未能新建文件夹，请重试');
                organization.folders.push({id, name: value});
            }));
        },
        renameFolder(id, name, options) {
            return mutate(options, classification(organization => {
                const folder = organization.folders.find(folder => folder.id === id);
                if (!folder) throw failure('missing', '这个文件夹已不存在');
                folder.name = folderName(name, organization.folders, id);
            }));
        },
        removeFolder(id, options) {
            return mutate(options, classification(organization => {
                if (!organization.folders.some(folder => folder.id === id)) throw failure('missing', '这个文件夹已不存在');
                organization.folders = organization.folders.filter(folder => folder.id !== id);
                organization.entries = organization.entries.map(entry => entry.folderId === id ? {...entry, folderId: null} : entry)
                    .filter(entry => entry.folderId !== null || entry.tags.length);
            }));
        },
        organize(ids, patch, options) {
            return mutate(options, classification((organization, items) => {
                if (!Array.isArray(ids) || !ids.length || ids.some(id => !nonempty(id)) || !record(patch)
                    || !Object.keys(patch).length || Object.keys(patch).some(key => !['folderId', 'tags'].includes(key))) throw failure('input', '请先选择收藏和分类');
                const chosen = new Set(ids), available = new Set(items.map(item => item.id));
                if ([...chosen].some(id => !available.has(id))) throw failure('missing', '所选收藏已变化，请重新选择');
                if (own(patch, 'folderId') && patch.folderId !== null && !organization.folders.some(folder => folder.id === patch.folderId)) throw failure('missing', '这个文件夹已不存在');
                let tags;
                if (own(patch, 'tags')) {
                    if (!Array.isArray(patch.tags) || patch.tags.some(tag => !nonempty(tag))) throw failure('input', '请填写有效标签');
                    const seen = new Set();
                    tags = patch.tags.map(tag => tag.trim()).filter(tag => { const key = nameKey(tag); if (seen.has(key)) return false; seen.add(key); return true; });
                }
                const entries = new Map(organization.entries.map(entry => [entry.itemId, entry]));
                for (const id of chosen) {
                    const entry = entries.get(id) || {itemId: id, folderId: null, tags: []};
                    if (own(patch, 'folderId')) entry.folderId = patch.folderId;
                    if (tags) entry.tags = [...tags];
                    entries.set(id, entry);
                }
                organization.entries = [...entries.values()].filter(entry => entry.folderId !== null || entry.tags.length);
            }));
        },
    });
}
