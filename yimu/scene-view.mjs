const NATURES = [['present', '当前叙事'], ['parallel', '同时异地'], ['memory', '回忆'], ['dream', '梦境'], ['hypothetical', '假设／预见'], ['unknown', '未注明']];
const anchorText = scene => {
    const where = [scene.world, scene.timeline].filter(Boolean).join('／');
    const when = [scene.date || '日期未注明', scene.period || '时段未注明'].join(' · ');
    const who = scene.characters?.length ? `${scene.characters.join('、')} · ` : '';
    const nature = NATURES.find(([key]) => key === scene.nature)?.[1];
    return `${who}${where ? `${where} · ` : ''}${when}｜${scene.place || '地点未注明'}${nature && !['present', 'unknown'].includes(scene.nature) ? ` · ${nature}` : ''}`;
};
const hasScene = scene => ['world', 'timeline', 'date', 'period', 'place', 'event'].some(key => scene[key]) || scene.characters?.length;
const sceneText = entry => (entry.scenes || []).filter(hasScene).map(scene => [anchorText(scene), scene.event].filter(Boolean).join('\n')).join('\n\n');
/** One human-readable editor; no user-facing metadata form or brittle text parsing. */
export function editableMemoryText(entry) {
    const text = entry.kind === 'excerpt' ? entry.quoteText || '' : entry.text || '';
    return [sceneText(entry), text].filter(Boolean).join('\n\n');
}
export function editedMemoryValue(value, entry) {
    const prefix = sceneText(entry), text = String(value).trim().replace(/\r\n?/g, '\n');
    if (prefix && text.startsWith(`${prefix}\n\n`)) return { text: text.slice(prefix.length + 2).trim(), scenes: entry.scenes || [] };
    // 场景几行被改过（比如改了地点）：按原来的写法逐段读回来，改了哪项就更新哪项，头段排版照旧。
    // 读不回来（行数、分隔对不上）才把整段当成用户自己写的正文，不猜。
    const parsed = prefix ? reparseScenes(text, entry) : null;
    if (parsed) return parsed;
    return { text, scenes: [] };
}
const UNKNOWN_DATE = '日期未注明', UNKNOWN_PERIOD = '时段未注明', UNKNOWN_PLACE = '地点未注明';
function reparseScenes(text, entry) {
    const shown = (entry.scenes || []).filter(hasScene);
    if (!shown.length) return null;
    const blocks = text.split(/\n{2,}/);
    if (blocks.length <= shown.length) return null; // 场景之后必须还有正文
    const scenes = [];
    for (let index = 0; index < shown.length; index++) {
        const original = shown[index], [anchor, ...rest] = blocks[index].split('\n');
        const cut = anchor.indexOf('｜');
        if (cut < 0) return null;
        const front = anchor.slice(0, cut).split(' · '), back = anchor.slice(cut + 1).split(' · ');
        if (front.length < 2) return null;
        const period = front.pop(), date = front.pop();
        let place = back.shift() || '', nature = original.nature;
        if (back.length) {
            const label = back.join(' · '), found = NATURES.find(([, name]) => name === label);
            if (!found) return null;
            nature = found[0];
        }
        const next = { ...original, date: date === UNKNOWN_DATE ? '' : date, period: period === UNKNOWN_PERIOD ? '' : period, place: place === UNKNOWN_PLACE ? '' : place,
            event: rest.join(' ').trim() };
        // 前面剩下的是「人物」与「世界／时间线」：带「／」或与原来的世界写法相同的是世界，其余是人物。
        const originalWhere = [original.world, original.timeline].filter(Boolean).join('／');
        let who = null, where = null;
        for (const part of front) {
            const isWhere = part.includes('／') || (originalWhere && part === originalWhere) || (front.length === 1 && originalWhere && !original.characters?.length);
            if (isWhere && where === null) where = part;
            else if (!isWhere && who === null) who = part.split('、').map(name => name.trim()).filter(Boolean);
            else return null;
        }
        next.characters = who ?? [];
        const [world = '', timeline = ''] = String(where ?? '').split('／');
        if (original.timeline && !original.world && !String(where ?? '').includes('／')) { next.world = ''; next.timeline = world; }
        else { next.world = world; next.timeline = timeline; }
        scenes.push(next);
    }
    const body = blocks.slice(shown.length).join('\n\n').trim();
    return body ? { text: body, scenes } : null;
}
// Reading view: short labelled chips for the fields that are actually known, in a
// fixed order (时间 → 地点 → 人物 → 世界 → 性质), then the one-line event. Unknown
// fields are omitted rather than repeated as “未注明” noise; the full anchor stays
// available as the row tooltip and in the editor text above.
const sceneChips = scene => {
    const nature = NATURES.find(([key]) => key === scene.nature)?.[1];
    return [
        ['when', '时间', [scene.date, scene.period].filter(Boolean).join(' · ')],
        ['where', '地点', scene.place || ''],
        ['who', '人物', scene.characters?.length ? scene.characters.join('、') : ''],
        ['world', '世界', [scene.world, scene.timeline].filter(Boolean).join('／')],
        ['nature', '', nature && !['present', 'unknown'].includes(scene.nature) ? nature : ''],
    ].filter(([, , value]) => value);
};
export function renderSceneLabels(container, scenes = [], { document = container.ownerDocument } = {}) {
    const list = Array.isArray(scenes) ? scenes.filter(hasScene) : [];
    for (const scene of list) {
        const row = document.createElement('div'); row.className = 'ym-scene-row';
        row.title = anchorText(scene);
        const chips = sceneChips(scene);
        if (chips.length) {
            const meta = document.createElement('div'); meta.className = 'ym-scene-meta';
            for (const [kind, label, value] of chips) {
                const chip = document.createElement('span'); chip.className = 'ym-scene-chip'; chip.dataset.kind = kind;
                if (label) { const key = document.createElement('span'); key.className = 'ym-scene-key'; key.textContent = label; chip.append(key); }
                const content = document.createElement('span'); content.textContent = value; chip.append(content);
                meta.append(chip);
            }
            row.append(meta);
        }
        if (scene.event) { const event = document.createElement('p'); event.className = 'ym-scene-event'; event.textContent = scene.event; row.append(event); }
        container.append(row);
    }
}
