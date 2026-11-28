// 书摘成图 · 本机存储：每条收藏一份成图稿、插图与背景图原图。只在这台设备的浏览器里，按 ST 账户分开。
// 「上次的设置」「方案」「自建模板」不在这里，它们随账户设置走（见 normalizeStudioSettings）。
const DB_NAME = 'qianmu-excerpt-studio', DB_VERSION = 1, DRAFTS = 'drafts', IMAGES = 'images';
export const IMAGE_EDGE_LIMIT = 2560;

function request(value) {
    return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
}

export function createExcerptStore({namespace, indexedDB = globalThis.indexedDB} = {}) {
    if (typeof namespace !== 'string' || !namespace) throw new TypeError('书摘成图需要当前账户');
    let opening = null;
    const prefix = `${namespace}::`;
    function open() {
        if (!indexedDB) return Promise.reject(new Error('此浏览器不能保存成图稿'));
        opening ??= new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS);
                if (!db.objectStoreNames.contains(IMAGES)) db.createObjectStore(IMAGES);
            };
            req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); opening = null; }; resolve(db); };
            req.onerror = () => { opening = null; reject(req.error); };
            req.onblocked = () => { opening = null; reject(new Error('成图存储被其他页面占用')); };
        });
        return opening;
    }
    async function run(storeName, mode, action) {
        const db = await open();
        const tx = db.transaction(storeName, mode), store = tx.objectStore(storeName);
        const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('写入中断')); });
        const result = await action(store);
        await done;
        return result;
    }
    return Object.freeze({
        async loadDraft(key) { return (await run(DRAFTS, 'readonly', store => request(store.get(prefix + key)))) || null; },
        async saveDraft(key, value) { await run(DRAFTS, 'readwrite', store => request(store.put({...value, savedAt: Date.now()}, prefix + key))); },
        async deleteDraft(key) { await run(DRAFTS, 'readwrite', store => request(store.delete(prefix + key))); },
        // 删笔记、删收藏、删书时一并删掉它们的稿。keys：稿的键；startsWith：按开头删（如 `reader:<书>:`）。图留给 sweepImages。
        async deleteDrafts({keys = [], startsWith = ''} = {}) {
            const exact = keys.filter(key => typeof key === 'string' && key).map(key => prefix + key);
            const range = startsWith ? IDBKeyRange.bound(prefix + startsWith, `${prefix}${startsWith}￿`) : null;
            if (!exact.length && !range) return 0;
            return run(DRAFTS, 'readwrite', async store => {
                const matched = range ? await request(store.getAllKeys(range)) : [];
                const doomed = [...new Set([...exact, ...matched])];
                await Promise.all(doomed.map(key => request(store.delete(key))));
                return doomed.length;
            });
        },
        // 备份：逐份取出，不一次读进全部。键去掉账户前缀。
        async *exportDrafts() {
            const keys = await run(DRAFTS, 'readonly', store => request(store.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`))));
            for (const key of keys) {
                const value = await run(DRAFTS, 'readonly', store => request(store.get(key)));
                if (value) yield {key: String(key).slice(prefix.length), value};
            }
        },
        async *exportImages() {
            const keys = await run(IMAGES, 'readonly', store => request(store.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`))));
            for (const key of keys) {
                const value = await run(IMAGES, 'readonly', store => request(store.get(key)));
                if (value?.blob) yield {id: String(key).slice(prefix.length), blob: value.blob, w: value.w, h: value.h};
            }
        },
        // 恢复一份稿：本机已有同键的稿时，只有备份里的更新（savedAt 更晚）才替换。保留备份里的 savedAt。
        // 返回 'added' | 'replaced' | 'kept'。
        async importDraft(key, value) {
            if (typeof key !== 'string' || !key || !value || typeof value !== 'object') throw new TypeError('成图稿格式无效');
            return run(DRAFTS, 'readwrite', async store => {
                const current = await request(store.get(prefix + key));
                if (current && !(Number(value.savedAt) > Number(current.savedAt || 0))) return 'kept';
                await request(store.put({...value, savedAt: Number(value.savedAt) || Date.now()}, prefix + key));
                return current ? 'replaced' : 'added';
            });
        },
        // 恢复一张图：图的编号不重复，本机已有同号的就不动。返回 true 表示写入了。
        async importImage(id, {blob, w, h} = {}) {
            if (typeof id !== 'string' || !id || !(blob instanceof Blob)) throw new TypeError('成图图片格式无效');
            return run(IMAGES, 'readwrite', async store => {
                if (await request(store.getKey(prefix + id)) !== undefined) return false;
                await request(store.put({blob, w: Number(w) || 0, h: Number(h) || 0}, prefix + id));
                return true;
            });
        },
        async putImage(id, blob, w, h) { await run(IMAGES, 'readwrite', store => request(store.put({blob, w, h}, prefix + id))); },
        async getImage(id) { return (await run(IMAGES, 'readonly', store => request(store.get(prefix + id)))) || null; },
        // 清掉这个账户下哪份稿、哪个方案都不再用到的图。
        async sweepImages(keep) {
            const drafts = await run(DRAFTS, 'readonly', store => request(store.getAll(IDBKeyRange.bound(prefix, `${prefix}￿`))));
            const used = new Set(keep);
            for (const draft of drafts) for (const id of imageIdsOf(draft?.doc)) used.add(id);
            const keys = await run(IMAGES, 'readonly', store => request(store.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`))));
            const stale = keys.filter(key => !used.has(String(key).slice(prefix.length)));
            if (stale.length) await run(IMAGES, 'readwrite', store => Promise.all(stale.map(key => request(store.delete(key)))));
            return stale.length;
        },
        close() { void opening?.then(db => db.close()).catch(() => {}); opening = null; },
    });
}

export function imageIdsOf(value) {
    const ids = [];
    if (!value || typeof value !== 'object') return ids;
    if (value.bg?.image) ids.push(value.bg.image);
    for (const layout of [...(value.pages || []), value.restLayout, value.first, value.rest]) {
        for (const element of layout?.elements || []) if (element?.image?.id) ids.push(element.image.id);
    }
    return ids;
}

// 选来的图：太大的按长边 2560 缩一次（导出宽 1080，留足裁切余量），其余原样存。
export async function prepareImage(file, {document = globalThis.document} = {}) {
    if (!file || !/^image\//.test(file.type || '')) throw new Error('请选择图片文件');
    if (file.size > 40 * 1024 * 1024) throw new Error('图片超过 40MB');
    const bitmap = await createImageBitmap(file);
    try {
        const {width, height} = bitmap;
        if (!width || !height) throw new Error('图片读不出尺寸');
        const edge = Math.max(width, height);
        if (edge <= IMAGE_EDGE_LIMIT && /^image\/(?:png|jpeg|webp|gif)$/.test(file.type)) return {blob: file, w: width, h: height};
        const scale = Math.min(1, IMAGE_EDGE_LIMIT / edge), w = Math.round(width * scale), h = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片处理失败')), type, 0.92));
        canvas.width = canvas.height = 0;
        return {blob, w, h};
    } finally { bitmap.close?.(); }
}
