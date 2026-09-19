// Pure text originals, independent of chat lifetime. No DOM, storage or API access.
// Text/range limits use UTF-16 code units, as do textarea selection offsets.
export const TEXT_COLLECTION_LIMITS = Object.freeze({ text: 200000, name: 256, identity: 512, preview: 500 });
const sourceKeys = ['account', 'chatId', 'messageId', 'replyId', 'charName', 'userName'];
const recordKeys = ['schemaVersion', 'id', 'source', 'mode', 'range', 'text', 'createdAt', 'updatedAt', 'revision'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, fields) => object(value) && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key));
const fail = (code, message) => { throw Object.assign(new Error(message), { code: `text_collection_${code}` }); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
function validText(value, limit) {
    if (typeof value !== 'string' || value.length > limit || value.includes('\0')) return false;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
}
function identifier(value) {
    return validText(value, TEXT_COLLECTION_LIMITS.identity) && value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function metadata(value) {
    if (!object(value) || typeof value.account !== 'string' || !/^st-user:[a-f0-9]{64}$/.test(value.account)
        || !identifier(value.chatId) || !(identifier(value.messageId) || integer(value.messageId)) || !identifier(value.replyId)
        || !validText(value.charName, TEXT_COLLECTION_LIMITS.name) || !value.charName.trim()
        || !validText(value.userName, TEXT_COLLECTION_LIMITS.name) || !value.userName.trim()) fail('source', '收藏来源身份或名称无效');
    return Object.fromEntries(sourceKeys.map(key => [key, value[key]]));
}
function body(value) {
    if (!validText(value, TEXT_COLLECTION_LIMITS.text) || !value.trim()) fail('text', '收藏文字为空、过长或编码无效；未截断原文');
    return value;
}
function timestamp(value) {
    // Epoch milliseconds, supported local calendar display years 1970..9999.
    if (!integer(value) || value > 253402214400000) fail('time', '收藏时间无效');
    return value;
}
function offsets(start, end, length) {
    if (!integer(start) || !integer(end) || start >= end || end > length) fail('range', '收藏选段范围无效；请重新选择');
    return Object.freeze({ start, end });
}
function splitSurrogate(text, offset) {
    const left = text.charCodeAt(offset - 1), right = text.charCodeAt(offset);
    return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}

// Only an ephemeral source snapshot contains the full layer. Never persist this value.
export function captureTextCollectionSource(input) {
    const source = metadata(input);
    return Object.freeze({ ...source, text: body(input.text) });
}

export function createTextCollection({ id, source, mode, start, end, createdAt } = {}) {
    if (!identifier(id)) fail('id', '收藏编号无效');
    const captured = captureTextCollectionSource(source);
    if (mode !== 'full' && mode !== 'selection') fail('mode', '请选择选段或全文');
    if (mode === 'full' && (start !== undefined || end !== undefined)) fail('range', '全文收藏不能覆盖选段范围');
    const range = mode === 'full' ? offsets(0, captured.text.length, captured.text.length) : offsets(start, end, captured.text.length);
    if (splitSurrogate(captured.text, range.start) || splitSurrogate(captured.text, range.end)) fail('range', '收藏选段不能截断完整字符');
    const text = body(captured.text.slice(range.start, range.end)), time = timestamp(createdAt);
    // Deliberately omit source.text: a selection must not retain unselected prose.
    const origin = Object.freeze({ ...metadata(captured), textLength: captured.text.length });
    return Object.freeze({ schemaVersion: 1, id, source: origin, mode, range, text, createdAt: time, updatedAt: time, revision: 1 });
}

// Validates serialized records without reloading the original chat or trusting extra fields.
export function textCollectionRecord(value) {
    if (!keys(value, recordKeys) || value.schemaVersion !== 1 || !identifier(value.id)
        || !keys(value.source, [...sourceKeys, 'textLength']) || !integer(value.source.textLength)
        || value.source.textLength < 1 || value.source.textLength > TEXT_COLLECTION_LIMITS.text
        || !keys(value.range, ['start', 'end']) || !['full', 'selection'].includes(value.mode)
        || !integer(value.revision) || value.revision < 1) fail('record', '收藏记录格式无效');
    const source = Object.freeze({ ...metadata(value.source), textLength: value.source.textLength });
    const range = offsets(value.range.start, value.range.end, source.textLength), text = body(value.text);
    const createdAt = timestamp(value.createdAt), updatedAt = timestamp(value.updatedAt);
    if (updatedAt < createdAt || value.mode === 'full' && (range.start !== 0 || range.end !== source.textLength)
        || value.revision === 1 && text.length !== range.end - range.start) fail('record', '收藏来源范围或版本时间不一致');
    return Object.freeze({ schemaVersion: 1, id: value.id, source, mode: value.mode, range, text, createdAt, updatedAt, revision: value.revision });
}

export function updateTextCollection(record, changes, expectedRevision, updatedAt) {
    const current = textCollectionRecord(record);
    if (!integer(expectedRevision) || expectedRevision !== current.revision) fail('conflict', '收藏已被更新，请重新载入后编辑');
    if (!keys(changes, ['text'])) fail('edit', '收藏编辑只能修改文字');
    const text = body(changes.text), time = timestamp(updatedAt);
    if (time < current.updatedAt || current.revision === Number.MAX_SAFE_INTEGER) fail('revision', '收藏版本或更新时间无效');
    return Object.freeze({ ...current, text, updatedAt: time, revision: current.revision + 1 });
}

export function textCollectionListLabel(record) {
    const current = textCollectionRecord(record), date = new Date(current.createdAt);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return `${current.source.charName} & ${current.source.userName} · ${day}`;
}

export function textCollectionPreview(record, maxLength = 100) {
    if (!integer(maxLength) || maxLength < 1 || maxLength > TEXT_COLLECTION_LIMITS.preview) fail('preview', '收藏预览长度无效');
    const text = textCollectionRecord(record).text.replace(/\s+/g, ' ').trim();
    const points = Array.from(text);
    return points.length > maxLength ? `${points.slice(0, maxLength).join('')}…` : text;
}
