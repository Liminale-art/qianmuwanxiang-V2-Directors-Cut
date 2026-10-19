// Presentation-only catalog. A matching native filename is a search candidate,
// never proof of chat ownership or permission to recover into a character.
const encoder = new TextEncoder();
const nativeName = /^chat_(.+)_(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.jsonl$/;
const utcTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const pad = value => String(value).padStart(2, '0');
const yieldToMainThread = () => new Promise(resolve => setTimeout(resolve, 0));

// Input avatars must already be safe filenames. No path cleanup, truncation or
// Unicode normalization may turn an invalid/ambiguous avatar into a candidate.
function validAvatar(avatar) {
    return typeof avatar === 'string' && avatar.endsWith('.png') && avatar.length > 4
        && encoder.encode(avatar).length <= 255
        && !/[<>:"|?*\\/\u0000-\u001f\u007f-\u009f]/.test(avatar)
        && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(avatar)
        && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(avatar);
}

async function nativeKey(avatar, crypto) {
    if (!validAvatar(avatar)) return null;
    // ST 1.19 uses the first .png occurrence, not path.parse().name and not the
    // card's display name. The validated avatar cannot exceed the sanitizer's
    // byte cap; removing .png cannot introduce an overlong name.
    const name = avatar.replace('.png', '');
    const sanitized = name.replace(/[. ]+$/, '');
    if (!sanitized || /^\.+$/.test(sanitized) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(sanitized)) return null;
    const key = sanitized.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    if (!/[^\x20-\x7e]/.test(name)) return key;
    if (typeof crypto?.subtle?.digest !== 'function') return null;
    try {
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(name)));
        if (hash.length !== 32) return null;
        return key + '_' + [...hash.subarray(0, 4)].map(value => value.toString(16).padStart(2, '0')).join('');
    } catch { return null; }
}

function calendarValue(year, month, day, hour, minute, second, millisecond = 0) {
    if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31
        || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, millisecond);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
        ? date.getTime() : null;
}

function dateFields(parts, value, local = false) {
    if (value === null) return { backupTimeLabel: '时间未知', backupDay: '未知日期', backupSort: null };
    let [year, month, day, hour, minute, second] = parts;
    if (local) {
        const date = new Date(value);
        [year, month, day, hour, minute, second] = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
    }
    const backupDay = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
    return { backupTimeLabel: `${backupDay} ${pad(hour)}:${pad(minute)}:${pad(second)}`, backupDay, backupSort: value };
}

export async function buildNativeBackupCatalog(rows, characters, { crypto = globalThis.crypto, yieldToMain = yieldToMainThread } = {}) {
    if (typeof yieldToMain !== 'function') throw new TypeError('Catalog yield callback must be a function');
    const roles = Array.isArray(characters) ? characters : [];
    const counts = new Map();
    for (let index = 0; index < roles.length; index++) {
        const avatar = roles[index]?.avatar;
        if (typeof avatar === 'string') counts.set(avatar, (counts.get(avatar) || 0) + 1);
        if ((index + 1) % 512 === 0 && index + 1 < roles.length) await yieldToMain();
    }
    const candidates = new Map();
    const unique = [...counts];
    // Keep the complete role catalog searchable, but never dispatch thousands of
    // Web Crypto jobs together. Consume each small batch in input order so hash
    // completion order cannot reorder colliding candidates; no global sort needed.
    for (let offset = 0; offset < unique.length; offset += 64) {
        const batch = unique.slice(offset, offset + 64);
        const keys = await Promise.all(batch.map(([avatar, count]) => count === 1 ? nativeKey(avatar, crypto) : null));
        for (let index = 0; index < batch.length; index++) {
            const key = keys[index];
            if (!key) continue;
            if (!candidates.has(key)) candidates.set(key, []);
            candidates.get(key).push(batch[index][0]);
        }
        if (offset + 64 < unique.length) await yieldToMain();
    }
    const sources = Array.isArray(rows) ? rows : [], entries = [];
    for (let index = 0; index < sources.length; index++) {
        const row = sources[index];
        const parsed = typeof row?.name === 'string' ? nativeName.exec(row.name) : null;
        const parts = parsed ? parsed.slice(2).map(Number) : [];
        const stamp = parsed ? calendarValue(...parts) : null;
        const candidateAvatars = parsed ? [...(candidates.get(parsed[1]) || [])] : [];
        entries.push({ ...row, candidateAvatars, match: candidateAvatars.length > 1 ? 'ambiguous' : candidateAvatars.length ? 'candidate' : 'unmatched',
            ...dateFields(parts, stamp), timeZoneLabel: '服务器时间', backupTimeZone: 'server', source: 'native', sourceLabel: 'ST备份' });
        if ((index + 1) % 512 === 0 && index + 1 < sources.length) await yieldToMain();
    }
    return entries;
}

export function normalizeAutomaticBackupEntries(entries) {
    return (Array.isArray(entries) ? entries : []).map(row => {
        const parsed = typeof row?.createdAt === 'string' ? utcTime.exec(row.createdAt) : null;
        const parts = parsed ? parsed.slice(1, 7).map(Number) : [];
        const stamp = parsed ? calendarValue(...parts, Number((parsed[7] || '').padEnd(3, '0'))) : null;
        const candidateAvatars = validAvatar(row?.avatar) ? [row.avatar] : [];
        return { ...row, name: `qianmu:${String(row?.id || '')}`, size: Number.isSafeInteger(row?.sizeBytes) && row.sizeBytes >= 0 ? `${row.sizeBytes} B` : '',
            excerpt: '', lastMessageAt: '', candidateAvatars, match: candidateAvatars.length ? 'candidate' : 'unmatched',
            ...dateFields(parts, stamp, true), timeZoneLabel: '本机时间', backupTimeZone: 'local', source: 'qianmu', sourceLabel: '千幕备份' };
    });
}
