import { textCollectionText } from './qianmu-text-collection.js';

// Offsets always refer to the unmodified captured source, not normalized DOM text.
export function textCollectionParagraphs(value) {
    const text = textCollectionText(value), paragraphs = [];
    for (const match of text.matchAll(/[^\r\n]+/g)) {
        if (match[0].trim()) paragraphs.push(Object.freeze({ start: match.index, end: match.index + match[0].length, text: match[0] }));
    }
    return Object.freeze(paragraphs);
}

export function textCollectionParagraphSelection(text, indices) {
    const paragraphs = textCollectionParagraphs(text);
    if (!Array.isArray(indices) || !indices.length || indices.some(index => !Number.isInteger(index) || index < 0 || index >= paragraphs.length)) throw new TypeError('请选择要收藏的段落');
    const selected = [...new Set(indices)].sort((a, b) => a - b), groups = [];
    for (const index of selected) {
        const previous = groups.at(-1);
        if (previous && previous.last + 1 === index) { previous.end = paragraphs[index].end; previous.last = index; }
        else groups.push({ start: paragraphs[index].start, end: paragraphs[index].end, last: index });
    }
    // For disjoint excerpts range is only the original source envelope. The
    // schema3 captureEdited marker denotes a composed excerpt as well as manual
    // editing; it never claims the intervening, unselected prose was collected.
    return Object.freeze({ start: groups[0].start, end: groups.at(-1).end,
        text: groups.map(group => text.slice(group.start, group.end)).join('\n\n'), disjoint: groups.length > 1 });
}
