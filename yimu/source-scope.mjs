import { sourceRanges } from './stage-contract.mjs';
import { bridgeSourceValid } from './story-contract.mjs';

// Foreign floor numbers never address the current chat. Verification is a
// response-only server proof; a persisted origin is not itself permission.
export function inheritedSourceValid(entry, document, hashes) {
    return !!entry.origin && entry.origin.unresolved !== true && entry.originVerified === true && !!document.lineage && bridgeSourceValid(entry, document, hashes);
}

export function sourceTimelineEnd(entry, document) {
    const parentEnds = entry.kind === 'stage' && document ? (entry.source?.parents || []).map(ref => {
        const parent = document.entries.find(item => item.id === ref.id);
        return parent ? sourceTimelineEnd(parent) - (parent.origin?.offset || 0) : 0;
    }) : [];
    return Math.max(0, entry.placement?.fromFloor || 0, ...parentEnds, ...sourceRanges(entry).map(range => range.end)) + (entry.origin?.offset || 0);
}

export const COMPANION_BOOK_NOTICE = '标注「共读书中内容」的条目是两人一起读的书，谈到这本书时据此回忆，不超出所标已读位置，不当作亲历，也不推定他人知道。';
export const hasCompanionBook = entries => entries.some(entry => entry.companion?.kind === 'book');

export function sourceLabel(entry) {
    if (entry.companion) {
        const { kind, title, readLabel, charName, userName } = entry.companion, book = `《${title}》`;
        if (kind === 'note') return `共读记事 ·${book}`;
        if (kind !== 'book') return `共读交流 ·${book}· ${readLabel ? `读到 ${readLabel}` : '已读部分'}`;
        return `共读书中内容 ·${book}· ${readLabel ? `只读到 ${readLabel}` : '只限已读部分'} · 这是${charName || '角色'}和${userName || '用户'}一起读过的书里的情节，不是亲身经历；只有他们两人读过`;
    }
    const floors = entry.source ? sourceRanges(entry).map(range => `第${range.start}—${range.end}层`).join('、') || '自定义切片阶段（无原文替换权）' : '自定义切片';
    return entry.origin ? `继承来源 ${entry.origin.binding.file} · ${floors}` : floors;
}
