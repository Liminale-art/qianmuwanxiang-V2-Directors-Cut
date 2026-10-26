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
    const prefix = sceneText(entry), text = String(value).trim();
    if (prefix && text.startsWith(`${prefix}\n\n`)) return { text: text.slice(prefix.length + 2).trim(), scenes: entry.scenes || [] };
    // A free edit to the scene lines is authoritative prose. Do not re-inject
    // stale structured dates/places or guess how to split the user's wording.
    return { text, scenes: [] };
}
export function renderSceneLabels(container, scenes = [], { document = container.ownerDocument } = {}) {
    const list = Array.isArray(scenes) ? scenes.filter(hasScene) : [];
    for (const scene of list) {
        const row = document.createElement('div'); row.className = 'ym-scene-row';
        const anchor = document.createElement('span'); anchor.className = 'ym-muted';
        anchor.textContent = anchorText(scene);
        row.append(anchor);
        if (scene.event) { const event = document.createElement('p'); event.textContent = scene.event; row.append(event); }
        container.append(row);
    }
}
