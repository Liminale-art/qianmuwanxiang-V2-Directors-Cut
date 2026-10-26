// Story clocks are text from evidence, not wall-clock dates or inferred common knowledge.
const fail = message => { throw Object.assign(new Error(message), { status: 400, statusCode: 400 }); };
const text = (value, limit = 240) => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail('切片时空标记无效');
    return value.trim();
};
const natures = new Set(['present', 'memory', 'dream', 'hypothetical', 'parallel', 'unknown']);
export const unknownScenes = () => [{ world: '', timeline: '', date: '', period: '', place: '', event: '', characters: [], nature: 'unknown', evidence: { floors: [] } }];

export function validateScenes(value, { start = 1, end = Infinity, allowUser = true } = {}) {
    if (value === undefined || value === null || Array.isArray(value) && !value.length) return unknownScenes();
    if (!Array.isArray(value) || value.length > 16) fail('切片场景数量无效');
    return value.map(scene => {
        if (!scene || typeof scene !== 'object' || Array.isArray(scene)) fail('切片场景无效');
        const result = Object.fromEntries(['world', 'timeline', 'date', 'period', 'place'].map(key => [key, text(scene[key])]));
        result.event = text(scene.event, 1000);
        if (scene.characters !== undefined && (!Array.isArray(scene.characters) || scene.characters.length > 32)) fail('切片场景人物无效');
        result.characters = [...new Set((scene.characters || []).map(value => text(value, 120)).filter(Boolean))];
        result.nature = scene.nature || 'unknown';
        if (!natures.has(result.nature)) fail('切片叙事性质无效');
        const evidence = scene.evidence || {}, floors = evidence.floors || [];
        if (!Array.isArray(floors) || floors.length > 2000 || floors.some(floor => !Number.isSafeInteger(floor) || floor < start || floor > end)) fail('切片时空标记的依据楼层无效');
        result.evidence = { floors: [...new Set(floors)] };
        if (allowUser && evidence.user === true) result.evidence.user = true;
        if (evidence.inheritedFrom !== undefined) {
            const ref = evidence.inheritedFrom;
            if (!ref || typeof ref.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(ref.id) || !Number.isSafeInteger(ref.revision) || ref.revision < 1) fail('切片时空继承依据无效');
            result.evidence.inheritedFrom = { id: ref.id, revision: ref.revision };
        }
        // Unproven model metadata is never upgraded to an asserted date/place.
        if (!result.evidence.floors.length && !result.evidence.inheritedFrom && !result.evidence.user) {
            for (const key of ['world', 'timeline', 'date', 'period', 'place']) result[key] = '';
            result.event = ''; result.characters = []; result.nature = 'unknown';
        }
        return result;
    });
}

export function sceneDependenciesValid(entry, document) {
    return (entry.scenes || []).every(scene => {
        const ref = scene.evidence?.inheritedFrom;
        if (!ref) return true;
        return document.entries.some(parent => parent.id === ref.id && parent.revision === ref.revision && parent.status === 'active');
    });
}

export function sceneLabel(scene) {
    return [scene.world || scene.timeline || '时间线未注明', scene.date || '日期未注明', scene.period || '时段未注明', scene.place || '地点未注明',
        scene.characters?.length ? scene.characters.join('、') : '人物未注明',
        ({present: '当前叙事', memory: '回忆', dream: '梦境', hypothetical: '假设', parallel: '同时异地', unknown: '叙事性质未注明'})[scene.nature] || '叙事性质未注明'].join(' · ');
}

/** The model needs story meaning, not storage proof or repeated empty form fields. */
export function sceneProjection(scenes) {
    const projected = (scenes || []).map(scene => {
        const value = {};
        for (const key of ['world', 'timeline', 'date', 'period', 'place', 'event']) if (scene[key]) value[key] = scene[key];
        if (scene.characters?.length) value.characters = [...scene.characters];
        if (scene.nature && scene.nature !== 'unknown') value.nature = scene.nature;
        return Object.keys(value).length ? value : { note: '时空未注明' };
    });
    return !projected.length || projected.every(value => value.note === '时空未注明') ? '未注明' : projected;
}

/** Unicode code points of generated visible prose, not JSON keys, whitespace or model-reported usage. */
export function generatedTextLength(entry) {
    const visible = [typeof entry?.text === 'string' ? entry.text : ''];
    for (const scene of entry?.scenes || []) {
        for (const key of ['world', 'timeline', 'date', 'period', 'place', 'event']) if (typeof scene[key] === 'string') visible.push(scene[key]);
        visible.push(...(scene.characters || []).filter(value => typeof value === 'string'));
        const nature = { present: '当前叙事', memory: '回忆', dream: '梦境', hypothetical: '假设', parallel: '同时异地' }[scene.nature];
        if (nature) visible.push(nature);
    }
    return Array.from(visible.join('').replace(/\s/gu, '')).length;
}

export function validateGeneratedLength(entry, settings = {}) {
    if (!['summary', 'stage'].includes(entry?.kind)) return entry;
    const cap = entry.kind === 'stage' ? settings.stageChars ?? 3000 : settings.sliceChars ?? 2000;
    if (!Number.isSafeInteger(cap) || cap < 1) fail('生成切片字数上限无效');
    const length = generatedTextLength(entry);
    if (length > cap) fail(`${entry.kind === 'stage' ? '阶段摘要' : '记忆切片'}共 ${length} 字，超过 ${cap} 字上限，本次结果未保存；原片保留，请调整范围或上限后重试`);
    return entry;
}

export const SCENE_PROMPT = `每份切片分别附 scenes 数组：每项 {"world":"设定中的世界","timeline":"时间线标识","date":"原文日期或相对时间","period":"早/中/晚等原文时段","place":"地点","characters":["本场人物"],"event":"这些人物在此时此地发生何事的简短绑定，不重复全摘要","nature":"present|memory|dream|hypothetical|parallel|unknown","evidence":{"floors":[依据楼层]}}。未注明字段用空字符串，不补造年月日，不将系统日期或消息发送日期当故事日期。回忆、梦境、穿越前后、不同世界时钟、同时异地多视角分别列项；不可把甲地角色与乙地事件合成同场或共同知情。只有原文明示场景连续才沿用有据背景；相对时间保留原貌，没有确定锚点不折算日期。`;
