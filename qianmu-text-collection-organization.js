// Classification is part of the collection document, not a second index or
// account identity. Character views are derived from saved display names.
const empty = () => ({folders: [], entries: []});
const key = value => value.trim().toLocaleLowerCase();
const fields = (value, names) => value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const failure = () => Object.assign(new Error('收藏分类无法读取，请刷新重试'), {code: 'text_collection_document'});

export function validateTextCollectionOrganization(value, itemIds) {
    if (!fields(value, ['folders', 'entries']) || !Array.isArray(value.folders) || !Array.isArray(value.entries)) throw failure();
    const folders = new Set(), names = new Set(), entries = new Set();
    for (const folder of value.folders) {
        if (!fields(folder, ['id', 'name']) || !nonempty(folder.id) || !nonempty(folder.name)
            || folders.has(folder.id) || names.has(key(folder.name))) throw failure();
        folders.add(folder.id); names.add(key(folder.name));
    }
    for (const entry of value.entries) {
        if (!fields(entry, ['itemId', 'folderId', 'tags']) || !itemIds.has(entry.itemId) || entries.has(entry.itemId)
            || entry.folderId !== null && !folders.has(entry.folderId) || !Array.isArray(entry.tags)) throw failure();
        const tags = new Set();
        for (const tag of entry.tags) {
            if (!nonempty(tag) || tags.has(key(tag))) throw failure();
            tags.add(key(tag));
        }
        entries.add(entry.itemId);
    }
    return value;
}

export function textCollectionItemOrganization(state, id) {
    return structuredClone(state.organization?.entries.find(entry => entry.itemId === id)
        || {itemId: id, folderId: null, tags: []});
}

export function textCollectionOrganizationViews(state) {
    const organization = state.organization || empty(), entries = new Map(organization.entries.map(entry => [entry.itemId, entry]));
    const folders = organization.folders.map(folder => ({...folder, count: 0}));
    const byId = new Map(folders.map(folder => [folder.id, folder])), characters = new Map(), tags = new Map();
    for (const item of state.items || []) {
        const entry = entries.get(item.id);
        if (entry?.folderId) byId.get(entry.folderId).count++;
        else if (item.charName.trim()) characters.set(item.charName, (characters.get(item.charName) || 0) + 1);
        for (const tag of entry?.tags || []) {
            const normalized = key(tag), found = tags.get(normalized);
            if (found) found.count++; else tags.set(normalized, {name: tag, count: 1});
        }
    }
    return {folders, characters: [...characters].map(([name, count]) => ({name, count})), tags: [...tags.values()]};
}

export function filterTextCollectionItems(state, {query = '', folderId = null, charName = null, tag = null} = {}) {
    const organization = state.organization || empty(), entries = new Map(organization.entries.map(entry => [entry.itemId, entry]));
    const folders = new Map(organization.folders.map(folder => [folder.id, folder.name])), needle = key(query);
    return (state.items || []).filter(item => {
        const entry = entries.get(item.id);
        if (folderId !== null && entry?.folderId !== folderId) return false;
        if (charName !== null && (entry?.folderId || item.charName !== charName)) return false;
        if (tag !== null && !(entry?.tags || []).some(value => key(value) === key(tag))) return false;
        return !needle || [item.text, item.charName, item.userName, folders.get(entry?.folderId) || '', ...(entry?.tags || [])]
            .some(value => value.toLocaleLowerCase().includes(needle));
    });
}
