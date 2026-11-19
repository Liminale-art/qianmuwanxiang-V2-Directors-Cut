// 记忆的流动状态：久不被想起的记忆沉下去，被提起时浮上来。
// 衰减按剧情进度算，不按现实时间——隔三天没聊，记忆不该凭空淡掉；故事往前走很多层，才会淡。
// 状态只是选入门槛与显示差异，沉底不等于删除：任何一条都还能被强线索唤起。
export const FRESH = 'fresh', FADING = 'fading', SUNKEN = 'sunken';

/** 阈值都按「剧情走了多少层」计。调大＝忘得慢。 */
export const DECAY = Object.freeze({
    freshWithin: 60,     // 覆盖楼层距今 60 层内，一律鲜活
    fadingWithin: 220,   // 60–220 层为淡去，再远沉底
    recallWindow: 80,    // 被想起后，80 层内保持鲜活
});

const coveredEnd = entry => entry?.source?.end ?? entry?.source?.ranges?.at(-1)?.end ?? entry?.placement?.fromFloor ?? 0;

/**
 * @param {object} entry 记忆条目
 * @param {{ floor?: number, lastUsedFloor?: number, settings?: object }} context
 *   floor 为当前最新楼层；lastUsedFloor 为这条下一次被带入时的楼层（本机记录，跨设备不回传）。
 */
export function memoryWarmth(entry, { floor = 0, lastUsedFloor = null, settings = {} } = {}) {
    if (entry?.pinned) return FRESH;                       // 钉住的不参与衰减
    // 阶段总结是故事的主干，不参与沉底：旧楼已按原生方式隐藏，细切片又会随剧情推进淡去，
    // 若主干也跟着沉，故事早期就既没有原文也没有记忆。细切片照旧遗忘。
    if (entry?.kind === 'stage') return FRESH;
    if (entry?.kind !== 'summary') return FRESH; // 自定义切片与回查补充由人自己管
    const decay = { ...DECAY, ...(settings.decay || {}) };
    const age = Number.isFinite(floor) && floor > 0 ? Math.max(0, floor - coveredEnd(entry)) : 0;
    // 被想起过就回暖：以「最近一次被带入的楼层」为新的起点重新计算。
    const sinceRecall = Number.isFinite(lastUsedFloor) && lastUsedFloor > 0 ? Math.max(0, floor - lastUsedFloor) : Infinity;
    if (sinceRecall <= decay.recallWindow) return FRESH;
    if (age <= decay.freshWithin) return FRESH;
    return age <= decay.fadingWithin ? FADING : SUNKEN;
}

/**
 * 带入资格。鲜活的有相关性即可；淡去的需要更强的线索；沉底的只有明确点名才唤起
 * （正文直接出现这条记忆里的专名，或有人在问「你还记得……吗」）。
 * @param {{ warmth: string, score: number, strong?: boolean }} admission
 */
export function admitsAtWarmth({ warmth, score, strong = false }) {
    if (warmth === FRESH) return score > 0;
    if (warmth === FADING) return score >= 2 || strong;
    return strong;
}

/** 正文是否在问「你还记得……」——这类问句本身就该把沉底的记忆捞起来。 */
export function asksToRemember(text) {
    const said = String(text || '');
    return /(还记得|记得.{0,6}(吗|么|不)|想起|回忆|以前|那次|当年|曾经)/u.test(said);
}
