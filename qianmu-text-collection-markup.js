// 正文收藏「全文」的原文处理：标签规则（与取材同一套模型：屏蔽／提取）只作用在楼层原文上，
// 剩下的部分保留原样标记；纯文本由（格式化后的）标记去掉标签得到，供搜索、列表预览、复制与书摘成图。
export const TEXT_COLLECTION_DEFAULT_TAG_RULES = Object.freeze([Object.freeze({name: 'thinking', action: 'remove'})]);
export const TEXT_COLLECTION_TAG_RULE_LIMIT = 40;
const NAME = /^[A-Za-z_][\w.:-]{0,63}$/;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cleanName = name => String(name ?? '').trim().replace(/^<\/?|\/?>$/g, '').trim();

// 设置里存的样子：未设置过用默认；空名的行保留给正在填写的界面，应用时才略过。
export function normalizeTextCollectionTagRules(value) {
    if (!Array.isArray(value)) return TEXT_COLLECTION_DEFAULT_TAG_RULES.map(rule => ({...rule}));
    return value.slice(0, TEXT_COLLECTION_TAG_RULE_LIMIT).filter(rule => rule && typeof rule === 'object')
        .map(rule => ({name: cleanName(rule.name), action: rule.action === 'extract' ? 'extract' : 'remove'}));
}

function activeRules(rules) {
    return normalizeTextCollectionTagRules(rules).filter(rule => NAME.test(rule.name));
}

// 有提取规则时只留这些标签里的内容（按出现先后，段间空一行）；否则删去屏蔽标签整段。其余标记原样保留。
export function applyTextCollectionTagRules(raw, rules) {
    const value = String(raw ?? ''), active = activeRules(rules);
    const block = name => new RegExp(`<${escape(name)}\\b[^>]*>([\\s\\S]*?)<\\/${escape(name)}\\s*>`, 'gi');
    const extract = active.filter(rule => rule.action === 'extract');
    if (extract.length) {
        const found = [];
        for (const rule of extract) {
            for (const match of value.matchAll(block(rule.name))) found.push({index: match.index, text: match[1].trim()});
        }
        return found.sort((left, right) => left.index - right.index).map(part => part.text).filter(Boolean).join('\n\n');
    }
    let result = value;
    for (const rule of active) result = result.replace(block(rule.name), '');
    return result.replace(/\n[\t ]*\n(?:[\t ]*\n)+/g, '\n\n').trim();
}

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
function decode(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
        if (name[0] === '#') {
            const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
            return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
        }
        return ENTITIES[name.toLowerCase()] ?? match;
    });
}

const BLOCK = 'p|div|li|ul|ol|blockquote|pre|tr|table|thead|tbody|section|article|header|footer|details|summary|h[1-6]|hr';
// 标记 → 纯文本：块级元素断行（与楼层取字一致，相邻两块之间成为分段），<br> 换行，脚本、样式与注释不算正文。
export function textCollectionPlainText(markup) {
    const text = String(markup ?? '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style|template|noscript|custom-style|iframe)\b[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<br\b[^>]*>/gi, '\n')
        .replace(new RegExp(`<\\/?(?:${BLOCK})\\b[^>]*>`, 'gi'), '\n')
        .replace(/<[^>]*>/g, '');
    return decode(text).replace(/\r\n?/g, '\n').replace(/[\t ]+\n/g, '\n').replace(/\n[\t ]*/g, '\n')
        .replace(/\n{3,}/g, '\n\n').trim();
}
