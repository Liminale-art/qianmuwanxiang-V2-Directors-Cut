const FIELDS = [['world', '世界'], ['timeline', '时间线'], ['date', '日期'], ['period', '时段'], ['place', '地点'], ['characters', '涉及角色']];
const NATURES = [['present', '当前叙事'], ['parallel', '同时异地'], ['memory', '回忆'], ['dream', '梦境'], ['hypothetical', '假设／预见'], ['unknown', '未注明']];
export function renderSceneLabels(container, scenes = [], { document = container.ownerDocument } = {}) {
    const list = Array.isArray(scenes) && scenes.length ? scenes : [{}];
    for (const scene of list) {
        const row = document.createElement('div'); row.className = 'ym-scene-row';
        const where = [scene.world, scene.timeline].filter(Boolean).join('／');
        const when = [scene.date || '日期未注明', scene.period || '时段未注明'].join(' · ');
        const who = scene.characters?.length ? `${scene.characters.join('、')} · ` : '';
        const nature = NATURES.find(([key]) => key === scene.nature)?.[1];
        const anchor = document.createElement('span'); anchor.className = 'ym-muted';
        anchor.textContent = `${who}${where ? `${where} · ` : ''}${when}｜${scene.place || '地点未注明'}${nature && !['present', 'unknown'].includes(scene.nature) ? ` · ${nature}` : ''}`;
        row.append(anchor);
        if (scene.event) { const event = document.createElement('p'); event.textContent = scene.event; row.append(event); }
        container.append(row);
    }
}
export function mountSceneEditor({ document = globalThis.document, scenes = [] } = {}) {
    const element = document.createElement('details'); element.className = 'ym-scene-editor';
    const summary = document.createElement('summary'); summary.textContent = '时空标记'; element.append(summary);
    const body = document.createElement('div'); body.className = 'ym-scenes'; element.append(body);
    const records = [];
    function add(scene = {}) {
        const row = document.createElement('section'); row.className = 'ym-scene-fields';
        const controls = {};
        for (const [key, label] of [...FIELDS, ['event', '此时空发生的事']]) {
            const field = document.createElement('label'), title = document.createElement('span'), input = document.createElement(key === 'event' ? 'textarea' : 'input');
            title.textContent = label; input.setAttribute('aria-label', `场景${records.length + 1}${label}`);
            input.placeholder = '未注明'; input.value = key === 'characters' ? (scene[key] || []).join('、') : scene[key] || '';
            field.append(title, input); row.append(field); controls[key] = input;
        }
        const nature = document.createElement('select'); nature.setAttribute('aria-label', `场景${records.length + 1}叙述性质`);
        for (const [value, label] of NATURES) { const option = document.createElement('option'); option.value = value; option.textContent = label; nature.append(option); }
        nature.value = scene.nature || 'unknown'; row.append(nature);
        const record = { scene, controls, nature, row }; records.push(record);
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'ym-button'; remove.textContent = '移除此场景';
        remove.addEventListener('click', () => { records.splice(records.indexOf(record), 1); row.remove(); }); row.append(remove); body.append(row);
    }
    for (const scene of scenes) add(scene);
    const plus = document.createElement('button'); plus.type = 'button'; plus.className = 'ym-button'; plus.textContent = '添加时空／视角';
    plus.addEventListener('click', () => add()); element.append(plus);
    return { element, value() { return records.map(({ scene, controls, nature }) => ({ ...scene,
        ...Object.fromEntries(Object.entries(controls).map(([key, node]) => [key, key === 'characters' ? node.value.split(/[、,，]/).map(text => text.trim()).filter(Boolean) : node.value.trim()])),
        nature: nature.value,
    })); } };
}
