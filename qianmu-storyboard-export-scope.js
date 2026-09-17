const fail = message => { throw Object.assign(new Error(message), { code: 'storyboard_export_scope' }); };
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
// The existing portable format is unchanged. A selection narrows only current
// chat stills; settings, shared libraries and their dependency rules stay intact.
export function captureStoryboardExportImages(records) {
    if (!Array.isArray(records) || records.length > 400) fail('当前聊天静帧列表不完整或超过现有备份上限，未裁剪原记录');
    const seen = new Set();
    const rows = Array.from(records, row => {
        if (!row || typeof row !== 'object' || Array.isArray(row) || !id(row.id) || seen.has(row.id)) fail('静帧编号无效或重复，不能猜测备份范围');
        seen.add(row.id);
        return Object.freeze({ id: row.id, floor: Number.isSafeInteger(row.floor) && row.floor >= 0 ? row.floor : null,
            createdAt: Number.isSafeInteger(row.createdAt) && row.createdAt >= 0 && row.createdAt <= 8640000000000000 ? row.createdAt : null,
            label: Array.isArray(row.tags) ? row.tags.filter(tag => typeof tag === 'string').slice(0, 3).join(' · ').slice(0, 240) : '' });
    });
    let baseline;
    try { baseline = JSON.stringify(records); } catch (_) { fail('当前静帧不是可备份的独立记录'); }
    if (new TextEncoder().encode(baseline).byteLength > 32 * 1048576) fail('当前静帧元数据超过 32 MiB，请保全原资料，未裁剪备份');
    const assertCurrent = current => {
        let text; try { text = JSON.stringify(current); } catch (_) { fail('静帧在选择后已变化，请重新选择备份范围'); }
        if (text !== baseline) fail('静帧在选择后已变化，请重新选择备份范围');
    };
    return Object.freeze({ rows: Object.freeze(rows), select(ids) {
        if (!Array.isArray(ids) || ids.length > rows.length || new Set(ids).size !== ids.length || Array.from(ids).some(value => !id(value) || !seen.has(value))
            || rows.length && !ids.length) fail('请至少选择一张当前聊天静帧，未采用空范围或其他聊天记录');
        const selected = new Set(ids);
        return Object.freeze({ count: ids.length, total: rows.length, assertCurrent,
            read(current) { assertCurrent(current); return structuredClone(current.filter(row => selected.has(row.id))); } });
    } });
}
