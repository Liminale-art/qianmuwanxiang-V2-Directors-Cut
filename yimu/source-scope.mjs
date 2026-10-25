import { sourceRanges } from './stage-contract.mjs';
import { bridgeSourceValid } from './story-contract.mjs';

// Foreign floor numbers never address the current chat. Verification is a
// response-only server proof; a persisted origin is not itself permission.
export function inheritedSourceValid(entry, document, hashes) {
    return !!entry.origin && entry.origin.unresolved !== true && entry.originVerified === true && !!document.lineage && bridgeSourceValid(entry, document, hashes);
}

export function sourceTimelineEnd(entry) {
    return Math.max(0, ...sourceRanges(entry).map(range => range.end)) + (entry.origin?.offset || 0);
}

export function sourceLabel(entry) {
    if (entry.companion) return `${entry.companion.kind === 'book' ? '书中背景（不等于亲历或知情）' : '共同交流记录'} · ${entry.companion.title} · 已确认读至 ${entry.companion.readTo}`;
    const floors = entry.source ? sourceRanges(entry).map(range => `第${range.start}—${range.end}层`).join('、') : '手动补充';
    return entry.origin ? `继承来源 ${entry.origin.binding.file} · ${floors}` : floors;
}
