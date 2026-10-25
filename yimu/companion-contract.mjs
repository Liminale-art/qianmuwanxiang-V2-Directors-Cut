// User-confirmed, bounded reading summaries. This is not a second book store
// and does not claim that old browser archives have verified original sources.
const fail = message => { throw Object.assign(new Error(message), { status: 400, statusCode: 400 }); };
const text = (value, max = 300, allowEmpty = false) => {
    if (typeof value !== 'string' || value.length > max || !allowEmpty && !value.trim()) fail('伴读关联资料不完整或过长');
    return value;
};
const hash = value => { if (!/^[a-f0-9]{64}$/.test(value)) fail('伴读快照指纹无效'); return value; };
const integer = value => { if (!Number.isSafeInteger(value) || value < 0) fail('请明确确认共同已读范围'); return value; };

export function validateCompanion(value) {
    if (!value || value.version !== 1 || value.confirmed !== true || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > 200) fail('没有可关联的已确认伴读摘要，请调整已读范围或先在伴读中整理记忆');
    const result = { version: 1, confirmed: true, account: text(value.account), key: text(value.key, 1500),
        bookId: text(value.bookId), scope: text(value.scope, 1000), persona: text(value.persona, 300, true), avatar: text(value.avatar),
        title: text(value.title), charName: text(value.charName, 300, true), userName: text(value.userName, 300, true),
        confirmedReadTo: integer(value.confirmedReadTo), hash: hash(value.hash) };
    if (!/^st-user:[^\u0000-\u001f]+$/.test(result.account) || result.key !== `${result.scope}::${result.bookId}`) fail('伴读账户或记录归属不一致');
    const ids = new Set(); let size = 0;
    result.entries = value.entries.map(item => {
        const id = text(item?.id, 300);
        if (ids.has(id) || !['book', 'dialog'].includes(item.kind)) fail('伴读来源重复或无法区分背景与交流');
        ids.add(id);
        const readTo = integer(item.readTo);
        if (readTo > result.confirmedReadTo) fail('伴读摘要超过共同已读截止');
        const body = text(item.text, 100000); size += body.length;
        if (size > 500000) fail('本次关联摘要过多，请缩小共同已读范围');
        return { id, kind: item.kind, text: body, readTo, hash: hash(item.hash), sourceLabel: item.kind === 'book' ? '书中情节（阅读背景）' : '伴读交流（共同经历）' };
    });
    return result;
}

export function applyCompanionOperation(document, operation) {
    if (operation.expectedRevision !== document.revision) throw Object.assign(new Error('此聊天记忆已变化，请重新预览后确认关联'), {status: 409});
    if (operation.action === 'clear') document.companion = null;
    else if (operation.action === 'set') document.companion = validateCompanion(operation.snapshot);
    else fail('未知的伴读关联操作');
    document.epoch++;
    return document;
}

export function companionEntries(snapshot) {
    if (!snapshot) return [];
    let valid;
    try { valid = validateCompanion(snapshot); } catch { return []; }
    return valid.entries.map((item, index) => ({ id: `companion_${valid.hash.slice(0, 16)}_${index}`, kind: 'manual',
        text: item.text, source: null, status: 'active', edited: true, revision: 1,
        companion: { kind: item.kind, title: valid.title, readTo: item.readTo, sourceId: item.id } }));
}

export function sameCompanionContext(snapshot, context, binding) {
    return !!snapshot && !!context && ['account', 'key', 'bookId', 'scope', 'persona', 'avatar'].every(key => snapshot[key] === context[key])
        && !!context.story && ['avatar', 'file', 'integrity'].every(key => typeof binding?.[key] === 'string' && binding[key].trim() && context.story[key] === binding[key]);
}
