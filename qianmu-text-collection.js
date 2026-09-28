// Collection operations share the supplied page/account document session.
// This module owns neither persistence nor the lifetime of that session.
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
function validate(value) {
    if (!fields(value, ['version', 'items']) || value.version !== 1 || !Array.isArray(value.items)) {
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
    return value;
}

export function createTextCollection({session, now = () => new Date().toISOString(), createId = () => crypto.randomUUID()} = {}) {
    if (!session || !['open', 'refresh', 'save', 'state', 'subscribe'].every(key => typeof session[key] === 'function')
        || typeof now !== 'function' || typeof createId !== 'function') {
        throw new TypeError('Text collection requires a document session, clock and ID source');
    }
    function view(raw) {
        const result = {
            phase: raw.phase, loaded: false, items: [], fingerprint: null,
            needsRefresh: raw.needsRefresh, error: raw.error ? {...raw.error} : null,
        };
        if (!raw.document) return result;
        try {
            const document = raw.document.exists ? validate(raw.document.value) : {version: 1, items: []};
            return {...result, loaded: true, items: structuredClone(document.items), fingerprint: raw.document.fingerprint};
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
            const next = validate({version: 1, items: transform(current.items)});
            // save marks the session busy synchronously, before a second click
            // can create another entry. No queue or implicit retry is added.
            return session.save(next, {expectedFingerprint: current.fingerprint}).then(state);
        } catch (error) { return Promise.reject(error); }
    }
    return Object.freeze({
        open: () => load('open'), refresh: () => load('refresh'), state,
        subscribe(listener) {
            if (typeof listener !== 'function') throw new TypeError('Listener must be a function');
            return session.subscribe(raw => listener(view(raw)));
        },
        add(input, options) {
            return mutate(options, items => {
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
            });
        },
        edit(id, text, options) {
            return mutate(options, items => {
                if (!nonempty(id) || !nonempty(text)) throw failure('input', '请填写要保存的正文');
                const item = items.find(item => item.id === id);
                if (!item) throw failure('missing', '这条收藏已不存在');
                if (item.text === text) return items;
                const updatedAt = now();
                if (!timestamp(updatedAt)) throw failure('input', '未能保存收藏，请重试');
                return items.map(item => item.id === id ? {...item, text, updatedAt} : item);
            });
        },
        remove(ids, options) {
            return mutate(options, items => {
                if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => !nonempty(id))) throw failure('input', '请先选择收藏');
                const selected = new Set(ids);
                if ([...selected].some(id => !items.some(item => item.id === id))) throw failure('missing', '所选收藏已变化，请重新选择');
                return items.filter(item => !selected.has(item.id));
            });
        },
    });
}
