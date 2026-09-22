import { createStoryboardMessageReference, createStoryboardParagraphAnchor, sortStoryboardInlineRecords } from './qianmu-storyboard.js?v=1.59.301';
import { hashText } from './qianmu-storyboard-utils.js';

const text = value => String(value ?? '');
const anchorText = value => text(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const referenceKey = ref => JSON.stringify([ref.messageKey, ref.revisionId, ref.revisionHash, ref.swipeId]);
const add = (map, key, row) => { const rows = map.get(key) || []; rows.push(row); map.set(key, rows); };
const eligible = message => message && !message.is_user && !message.is_system && typeof message.mes === 'string' && message.mes.trim();
export const GALLERY_NARRATIVE_PAGE_SIZE = 12;
export const GALLERY_UNPLACED = 'unplaced';

/** Read-only projection of the OPEN chat, not a cross-chat media catalog.
 * No Blob/snapshot reads, source repairs, fuzzy matches or floor-number fallback.
 * Build message identities once; duplicate evidence is intentionally unplaced.
 */
export function buildGalleryNarrative({ records = [], messages = [], chatKey = '', paragraphs }) {
    const exact = new Map(), legacy = new Map(), floors = new Map(), sources = new Map(), unplaced = new Set();
    const ids = new Map();
    for (const record of records) if (record?.id) add(ids, text(record.id), record);
    if (chatKey) messages.forEach((message, floor) => {
        if (!eligible(message)) return;
        const reference = createStoryboardMessageReference({ message, floor, chatKey, now: 1 });
        const row = { message, floor, reference, rawHash: hashText(message.mes) };
        add(exact, referenceKey(reference), row);
        add(legacy, JSON.stringify([row.rawHash, reference.swipeId]), row);
    });
    const parsed = new Map();
    for (const record of records) {
        if (!record?.id) continue;
        const id = text(record.id), ref = record.messageRef, anchor = record.paragraphAnchor;
        const owners = [record.chatKey, ref?.chatKey, anchor?.chatKey].filter(Boolean);
        let matches = [];
        if (chatKey && ids.get(id)?.length === 1 && !record.restoreLinkReview && !owners.some(owner => owner !== chatKey)) {
            if (ref?.messageKey && ref.revisionId && ref.revisionHash && Number.isSafeInteger(ref.swipeId)) {
                matches = exact.get(referenceKey(ref)) || [];
            } else if (!ref && record.messageHash && Number.isSafeInteger(record.swipeId)) {
                matches = legacy.get(JSON.stringify([record.messageHash, record.swipeId])) || [];
            }
        }
        const match = matches.length === 1 ? matches[0] : null;
        if (!match || record.messageHash && record.messageHash !== match.rawHash
            || record.swipeId != null && record.swipeId !== match.reference.swipeId) { unplaced.add(id); continue; }
        const key = referenceKey(match.reference);
        if (!floors.has(key)) floors.set(key, { key, floor: match.floor, name: text(match.message.name).slice(0, 120),
            preview: '', ids: new Set(), paragraphs: new Map() });
        const node = floors.get(key); node.ids.add(id);
        if (!parsed.has(key)) {
            let rows = [];
            // Use the same non-executing parser as manual source-link review. Oversized
            // or unsupported text remains available at floor level, never truncated into a match.
            if (match.message.mes.length <= 2 * 1048576) {
                try { rows = paragraphs?.(match.message.mes) || []; } catch (_) { /* no guessed paragraph */ }
            }
            if (!Array.isArray(rows) || rows.length > 240 || rows.some(row => typeof row !== 'string')) rows = [];
            parsed.set(key, { rows, messageHash: createStoryboardParagraphAnchor({ messageText: match.message.mes }).messageHash,
                anchors: rows.map(paragraphText => createStoryboardParagraphAnchor({ paragraphText })) });
            node.preview = rows[0]?.slice(0, 160) || '正文段落暂不可定位';
        }
        const { rows, messageHash, anchors } = parsed.get(key), index = anchor?.paragraphIndex;
        const paragraph = Number.isSafeInteger(index) && index >= 0 ? rows[index] : undefined;
        const validAnchor = paragraph && anchor?.paragraphHash && anchorText(anchor.paragraphText)
            && anchor.messageHash === messageHash
            && anchor.swipeId === match.reference.swipeId
            && anchors[index].paragraphHash === anchor.paragraphHash
            && anchorText(paragraph).slice(0, 1200) === anchorText(anchor.paragraphText);
        let paragraphKey = '';
        if (validAnchor) {
            paragraphKey = JSON.stringify([key, index, anchor.paragraphHash]);
            if (!node.paragraphs.has(paragraphKey)) node.paragraphs.set(paragraphKey, { key: paragraphKey, index, preview: paragraph.slice(0, 160), ids: new Set() });
            node.paragraphs.get(paragraphKey).ids.add(id);
        }
        sources.set(id, { floorKey: key, paragraphKey, paragraphIndex: validAnchor ? index : null });
    }
    return { floors: [...floors.values()].sort((a, b) => b.floor - a.floor), sources, unplaced,
        allIds: new Set(records.filter(row => row?.id).map(row => text(row.id))) };
}

/** In-memory navigation only. A changed chat/account owner resets selection;
 * a changed reply keeps an empty, explicit stale selection until the user clears it.
 */
export function createGalleryNarrativeSession() {
    let owner, chatKey, epoch, model, plans = [], floorKey = '', paragraphKey = '', query = '', page = 0, open = false;
    function currentFloor() { return model?.floors.find(row => row.key === floorKey); }
    function selection() {
        if (!floorKey) return null;
        if (floorKey === GALLERY_UNPLACED) return { ids: model.unplaced, label: '未定位画面' };
        const floor = currentFloor();
        const paragraph = paragraphKey && floor?.paragraphs.get(paragraphKey);
        if (!floor || paragraphKey && !paragraph) return { ids: new Set(), label: '原位置已变化，请重新选择', stale: true };
        return { ids: paragraph ? paragraph.ids : floor.ids, label: `第 ${floor.floor + 1} 层${paragraph ? ` · 第 ${paragraph.index + 1} 段` : ' · 全部静帧'}` };
    }
    return Object.freeze({
        reset() { owner = undefined; chatKey = undefined; epoch = undefined; model = undefined; plans = []; floorKey = ''; paragraphKey = ''; query = ''; page = 0; open = false; },
        update(input) {
            if (input.owner !== owner || input.chatKey !== chatKey || input.epoch !== epoch) {
                owner = input.owner; chatKey = input.chatKey; epoch = input.epoch;
                floorKey = ''; paragraphKey = ''; query = ''; page = 0; open = false;
            }
            plans = Array.isArray(input.plans) ? input.plans : []; model = buildGalleryNarrative(input); return this;
        },
        get owner() { return owner; }, get chatKey() { return chatKey; }, get epoch() { return epoch; },
        get selected() { return selection(); }, get sourceCount() { return model?.floors.length || 0; },
        filter(records) { const selected = selection(); return selected ? records.filter(row => selected.ids.has(text(row.id))) : records; },
        orderGroups(groups) {
            if (!floorKey || floorKey === GALLERY_UNPLACED || selection()?.stale) return groups;
            const ordered = sortStoryboardInlineRecords(groups.map(group => group.variants[0]),{plans});
            const rank = new Map(ordered.map((record, index) => [record, index]));
            const paragraph = group => model.sources.get(text(group.variants[0]?.id))?.paragraphIndex ?? Number.MAX_SAFE_INTEGER;
            return [...groups].sort((a, b) => paragraph(a) - paragraph(b) || rank.get(a.variants[0]) - rank.get(b.variants[0]));
        },
        sourceFor(record) { return model?.sources.get(text(record?.id)); },
        selectRecord(record) {
            const source = this.sourceFor(record); if (!source) return false;
            floorKey = source.floorKey; paragraphKey = source.paragraphKey; query = ''; page = 0; open = false; return true;
        },
        choose(key) {
            if (key === GALLERY_UNPLACED && model.unplaced.size) { floorKey = key; paragraphKey = ''; }
            else if (floorKey && currentFloor()?.paragraphs.has(key)) paragraphKey = key;
            else if (model.floors.some(row => row.key === key)) { floorKey = key; paragraphKey = ''; }
            else return false;
            page = 0; query = ''; open = !paragraphKey; return true;
        },
        clear() { floorKey = ''; paragraphKey = ''; query = ''; page = 0; },
        allFloor() { paragraphKey = ''; query = ''; page = 0; },
        setOpen(value) { open = Boolean(value); },
        search(value) { query = text(value).slice(0, 120); page = 0; },
        move(delta) { page += delta; },
        view() {
            const floor = currentFloor(), selected = selection();
            const rows = floor ? [...floor.paragraphs.values()].sort((a, b) => a.index - b.index).map(row => ({
                ...row, label: `第 ${row.index + 1} 段`, count: row.ids.size,
            })) : (model?.floors || []).map(row => ({ ...row, label: `第 ${row.floor + 1} 层 · ${row.name || '正文'}`, count: row.ids.size }));
            const wanted = query.trim().toLocaleLowerCase(), results = rows.filter(row => !wanted || `${row.label} ${row.preview}`.toLocaleLowerCase().includes(wanted));
            const pages = Math.max(1, Math.ceil(results.length / GALLERY_NARRATIVE_PAGE_SIZE)); page = Math.min(Math.max(0, page), pages - 1);
            return { open, query, page, pages, total: results.length, floorKey, paragraphKey, inFloor: Boolean(floor), selected,
                unplaced: model?.unplaced.size || 0, partial: floor ? floor.ids.size - new Set([...floor.paragraphs.values()].flatMap(row => [...row.ids])).size : 0,
                rows: results.slice(page * GALLERY_NARRATIVE_PAGE_SIZE, (page + 1) * GALLERY_NARRATIVE_PAGE_SIZE) };
        },
    });
}
