// Prompt-only cleanup for chat source text. It never mutates ST messages or
// source hashes; the original floor remains the source of truth.
const TAG = /^[A-Za-z][A-Za-z0-9:_-]{0,63}$/;
const MAX_TAGS = 32;
// Presentation-only containers commonly emitted around a chat response.
// Inner-thought tags are not blocked by default: they may be part of a user's
// chosen narrative and can be added explicitly in the card when appropriate.
export const DEFAULT_BLOCKED_TAGS = Object.freeze(['status', 'status-bar', 'statusbar', 'progress', 'progress-bar', 'style', 'script', 'svg']);
export const DEFAULT_INCLUDED_TAGS = Object.freeze(['content']);
export const DEFAULT_CONTEXT_RULES = Object.freeze({ stripComments: true, blockedTags: DEFAULT_BLOCKED_TAGS, includedTags: DEFAULT_INCLUDED_TAGS });

const clone = value => structuredClone(value);
const pieces = value => Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,，、;；]+/) : [];
export function normalizeTag(value) {
    const raw = String(value ?? '').trim().replace(/^<\s*\/?/, '').replace(/\/?\s*>$/, '').trim().toLowerCase();
    return TAG.test(raw) ? raw : '';
}
export function normalizeTagList(value, fallback = []) {
    const source = value === undefined || value === null ? fallback : pieces(value);
    return [...new Set(source.map(normalizeTag).filter(Boolean))].slice(0, MAX_TAGS);
}
export function normalizeContextRules(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const blockedTags = normalizeTagList(source.blockedTags ?? source.blockTags ?? source.blocked, DEFAULT_BLOCKED_TAGS);
    const includedTags = normalizeTagList(source.includedTags ?? source.extractTags ?? source.extract, DEFAULT_INCLUDED_TAGS);
    return { stripComments: source.stripComments !== false, blockedTags, includedTags: includedTags.filter(tag => !blockedTags.includes(tag)) };
}
export function validateContextRules(value) {
    if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('正文提取规则格式无效');
    const source = value && typeof value === 'object' ? value : {};
    if (Object.hasOwn(source, 'stripComments') && typeof source.stripComments !== 'boolean') throw new Error('正文注释处理开关无效');
    for (const key of ['blockedTags', 'includedTags']) {
        if (source[key] !== undefined && !Array.isArray(source[key]) && typeof source[key] !== 'string') throw new Error('正文标签规则格式无效');
        const values = pieces(source[key]);
        if (values.length > MAX_TAGS) throw new Error('正文标签规则过多');
        if (values.some(tag => !normalizeTag(tag))) throw new Error('正文标签名无效');
    }
    return clone(normalizeContextRules(source));
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function removeTagBlocks(text, tag) {
    const name = escapeRegExp(tag);
    const paired = new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${name}\\s*>`, 'gi');
    const selfClosing = new RegExp(`<${name}(?:\\s[^>]*)?\\/\\s*>`, 'gi');
    const opening = new RegExp(`<${name}(?:\\s[^>]*)?>`, 'gi');
    const closing = new RegExp(`<\\/${name}\\s*>`, 'gi');
    let previous = '';
    for (let attempt = 0; attempt < 4 && previous !== text; attempt++) {
        previous = text;
        text = text.replace(paired, '').replace(selfClosing, '').replace(opening, '').replace(closing, '');
    }
    return text;
}
function extractTaggedText(text, tags) {
    const matches = [];
    tags.forEach((tag, tagOrder) => {
        const name = escapeRegExp(tag);
        const pattern = new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${name}\\s*>`, 'gi');
        for (const match of text.matchAll(pattern)) {
            matches.push({ index: match.index ?? 0, tagOrder, text: match[0]
                .replace(new RegExp(`^<${name}(?:\\s[^>]*)?>`, 'i'), '')
                .replace(new RegExp(`<\\/${name}\\s*>$`, 'i'), '') });
        }
    });
    // A missing <content> wrapper must not make an entire chat disappear.
    // When one is present, however, it is the explicit narrative boundary.
    return matches.length ? matches.sort((a, b) => a.index - b.index || a.tagOrder - b.tagOrder).map(match => match.text).join('\n') : text;
}

export function filterContextText(value, rules = DEFAULT_CONTEXT_RULES) {
    let text = String(value ?? '').replace(/\r/g, '');
    const config = normalizeContextRules(rules);
    if (config.stripComments) text = text.replace(/<!--[\s\S]*?-->/g, '');
    for (const tag of config.blockedTags) text = removeTagBlocks(text, tag);
    if (config.includedTags.length) text = extractTaggedText(text, config.includedTags);
    return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
export const contextTextIsEmpty = (value, rules = DEFAULT_CONTEXT_RULES) => !filterContextText(value, rules);
