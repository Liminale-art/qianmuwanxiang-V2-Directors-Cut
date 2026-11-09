const labels = { source: '渠道', model: '模型', width: '生成宽度', height: '生成高度', seed: '种子', steps: '步数', cfg: '引导系数', sampler: '采样器', scheduler: '调度器', prompt: '原始提示词', finalPrompt: '最终提示词', negative: '原始负面提示词', effectiveNegative: '实际负面提示词', artistString: '画师串' };
const recipes = {
    inline: '聊天内保留配方。本页仅读取显示信息，未核验该配方是否完整或仍可复现。',
    'reference-only': '聊天只保留本机配方引用；请在原设备保全本地归档。',
    'server-reference': '聊天保存了服务器配方引用；回到原聊天可按需读取。此处尚未核验归档可用性。',
    unavailable: '原记录已标记精确配方不可用。',
    'not-recorded': '原聊天未记录精确配方来源。',
};
// Uses textContent only; never inject model text as markup or substitute live settings.
export function bindGalleryGenerationDetails(details, { read, isCurrent = () => true } = {}) {
    const container = details.querySelector('[data-directory-generation]'), document = details.ownerDocument;
    let disposed = false, loaded = false, controller, serial = 0;
    const current = token => !disposed && token === serial && details.isConnected && details.open && isCurrent();
    const stop = () => { serial++; controller?.abort(); controller = null; };
    const load = async () => {
        if (disposed || loaded || controller || !details.open || !isCurrent()) return;
        controller = new AbortController(); const signal = controller.signal, token = ++serial;
        container.textContent = '正在读取原聊天生成信息…';
        try {
            const generation = await read({ signal }); if (!current(token)) return;
            const note = document.createElement('p'); note.textContent = '原聊天保存的记录；未记录的值不以当前配置补齐。';
            const list = document.createElement('dl'); list.style.overflowWrap = 'anywhere';
            for (const [key, label] of Object.entries(labels)) {
                const term = document.createElement('dt'), description = document.createElement('dd'); term.textContent = label;
                description.textContent = generation[key] === null ? '未记录' : generation[key] === '' ? '（原记录为空）' : String(generation[key]);
                description.style.whiteSpace = 'pre-wrap'; description.dataset.generationField = key; list.append(term, description);
            }
            const recipe = document.createElement('p'); recipe.textContent = recipes[generation.recipeState]; recipe.dataset.generationRecipe = generation.recipeState;
            container.replaceChildren(note, list, recipe); loaded = true;
        } catch (error) {
            if (!current(token)) return;
            const message = document.createElement('p'); message.textContent = `${error?.message || '生成信息暂未读取'}。未使用当前聊天配置替代。`;
            const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'sd-btn'; retry.textContent = '重试读取'; retry.addEventListener('click', () => void load());
            container.replaceChildren(message, retry);
        } finally { if (serial === token) controller = null; }
    };
    const toggle = () => { if (details.open) void load(); else stop(); };
    details.addEventListener('toggle', toggle); if (details.open) void load();
    return () => { disposed = true; stop(); details.removeEventListener('toggle', toggle); };
}
