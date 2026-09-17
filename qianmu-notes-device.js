// Device-only layout. Never store note prose, ST account settings or sync state.
// A fixed origin-local key intentionally shares layout between accounts on this
// browser, but never between devices or through the notes service.
const KEY = 'qianmu.notes.device.v1';
const MAX_GEOMETRY = 100000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const defaults = () => ({ detached: false, position: { x: null, y: null }, panelSize: { width: null, height: null } });
const failure = (message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code: 'notes_device_storage' });
const coordinate = (value, min) => value === null || typeof value === 'number' && Number.isFinite(value) && value >= min && value <= MAX_GEOMETRY;

function shape(input, strict = false) {
    const result = defaults();
    const invalid = () => { throw Object.assign(new TypeError('便笺本机布局格式无效，未保存。'), { code: 'notes_device_shape' }); };
    if (!object(input)) { if (strict) invalid(); return result; }
    if (strict && Object.keys(input).some(key => !['detached', 'position', 'panelSize'].includes(key))) invalid();
    if (typeof input.detached === 'boolean') result.detached = input.detached;
    else if (strict && input.detached !== undefined) invalid();
    for (const [group, fields, min] of [['position', ['x', 'y'], 0], ['panelSize', ['width', 'height'], 1]]) {
        const values = input[group];
        if (values === undefined) continue;
        if (!object(values)) { if (strict) invalid(); continue; }
        if (strict && Object.keys(values).some(key => !fields.includes(key))) invalid();
        for (const field of fields) {
            const value = values[field];
            if (value === undefined) continue;
            if (coordinate(value, min)) result[group][field] = value;
            else if (strict) invalid();
        }
    }
    return result;
}

function storage() {
    if (typeof window === 'undefined') return null;
    try {
        const value = window.localStorage;
        if (!value || typeof value.getItem !== 'function' || typeof value.setItem !== 'function') throw Error('Unavailable local storage');
        return value;
    } catch (cause) { throw failure('无法访问便笺本机布局储存；布局未同步至其他设备。', cause); }
}

function write(target, state) {
    try { target.setItem(KEY, JSON.stringify({ version: 1, ...state })); }
    catch (cause) { throw failure('便笺本机布局未保存，请检查此浏览器的储存空间或权限。', cause); }
    return state;
}

/** Only a missing key may inherit legacy shared geometry, and only once. A
 * malformed or future record is preserved; it must not re-import another
 * device's current ST settings each time a panel is rendered. */
export function readNotesDeviceState(fallback) {
    const target = storage();
    if (!target) return shape(fallback);
    let raw;
    try { raw = target.getItem(KEY); }
    catch (cause) { throw failure('便笺本机布局读取失败，未覆盖已保存的布局。', cause); }
    if (raw === null) return write(target, shape(fallback));
    try {
        const record = JSON.parse(raw);
        if (!object(record) || record.version !== 1 || Object.keys(record).some(key => !['version', 'detached', 'position', 'panelSize'].includes(key))) return defaults();
        return shape({ detached: record.detached, position: record.position, panelSize: record.panelSize }, true);
    } catch { return defaults(); }
}

/** Explicit geometry edits are atomic single-key writes. Storage failure is
 * visible to the UI owner, never disguised by an in-memory success fallback. */
export function saveNotesDeviceState(input) {
    const state = shape(input, true), target = storage();
    if (!target) throw failure('当前环境无法保存便笺本机布局。');
    return write(target, state);
}
