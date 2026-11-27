// 幕外 · 续写：让一幕剧场成为可以接着往下写的番外支线（用户 2026-11-26 定）。
// 用户写一段（自己角色的言行、想让发生的事或一句指引），模型接着写，往复都记在这一幕里（scene.turns）。
// 续写跟着这一幕走：在最近几幕里就在，被挤出就一起去掉；收藏的连同续写一直留。不进忆幕心迹三项。
// 这里只放数据整理、提示词拼装与渲染；请求与存盘在 index.js。

export const THEATER_TURN_CHARS_LIMIT = 80_000;   // 一幕续写的总字数上限（设置随账户同步，不能无限长）
export const THEATER_TURN_INPUT_LIMIT = 4_000;

const text = value => (typeof value === 'string' ? value : '');
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);

export function sceneTurns(scene) {
    return (Array.isArray(scene?.turns) ? scene.turns : []).filter(plain).map(turn => ({
        id: text(turn.id) || `turn-${Math.random().toString(36).slice(2, 10)}`,
        role: turn.role === 'user' ? 'user' : 'assistant',
        content: text(turn.content),
        createdAt: text(turn.createdAt),
    })).filter(turn => turn.content.trim());
}

export function turnChars(turns) { return turns.reduce((sum, turn) => sum + turn.content.length, 0); }
export function canContinue(scene) {
    return !!scene && !scene.isHtml && turnChars(sceneTurns(scene)) < THEATER_TURN_CHARS_LIMIT;
}

// 续写的固定句（创作层；改动要先给用户审）。
export const THEATER_CONTINUE_GUIDE = '这是主线之外的一段番外支线。请顺着这一幕接着往下写：承接已经写出的情节、人物状态与口吻，回应用户这一回写下的内容（可能是用户角色的言行、想让剧情发生的事，或一句旁白式的指引），让这一幕自然地往前推进。只写新的部分，不要复述或改写前文；番外可以自由延展，但不要与正文已发生的事实冲突。';
export const THEATER_CONTINUE_FORMAT = '【输出格式】请把新写出的正文完整包裹在 <幕外正文> 与 </幕外正文> 标签之间。任何思考、分析、自我提示都放在标签之外，标签内只保留纯净的正文本身。';

// 消息：缘起（背景＋最初的此幕指令）→ 这一幕正文 → 每一回的用户与续写 → 这一回的用户输入＋要求。
// body 取 <幕外正文> 里的部分；extract 由调用方传入（与阅读页同一个函数）。
export function buildContinueMessages({background = '', scene, input, userName = '用户', extract = value => value}) {
    const opening = [background.trim(), `【此幕指令】\n${text(scene?.instruction).trim() || '（即兴）'}`].filter(Boolean).join('\n\n');
    const messages = [{role: 'user', content: opening}, {role: 'assistant', content: extract(text(scene?.content)).trim()}];
    for (const turn of sceneTurns(scene)) {
        const content = turn.role === 'user' ? `【${userName}这一回】\n${turn.content.trim()}` : extract(turn.content).trim();
        messages.push({role: turn.role, content});
    }
    messages.push({role: 'user', content: `【${userName}这一回】\n${text(input).trim()}\n\n${THEATER_CONTINUE_GUIDE}\n\n${THEATER_CONTINUE_FORMAT}`});
    return messages;
}

// 走 ST 自己的生成时只能送一段文字：按顺序拼成带标记的稿。
export function flattenContinueMessages(messages) {
    return messages.map((message, index) => {
        if (index === 0 || message.role === 'user') return message.content;
        return `【已经写出的这一幕${index === 1 ? '' : '（续）'}】\n${message.content}`;
    }).join('\n\n');
}

// 阅读页里正文之后的续写与输入框。esc／markdown／extract 由调用方给（与正文渲染一致）。
export function renderTheaterTurns(scene, {busy = false, pendingId = '', userName = '我', esc, markdown, extract, draft = '', readonly = false, scale = ''}) {
    if (!scene || scene.isHtml) return '';
    const turns = sceneTurns(scene), lastAssistant = [...turns].reverse().find(turn => turn.role === 'assistant');
    const blocks = turns.map(turn => turn.role === 'user'
        ? `<div class="sd-theater-turn is-user" data-turn="${esc(turn.id)}"><span class="sd-theater-turn-who">${esc(userName)}</span><div class="sd-theater-turn-text">${esc(turn.content).replace(/\n/g, '<br>')}</div></div>`
        : `<div class="sd-theater-turn is-story" data-turn="${esc(turn.id)}">${markdown(extract(turn.content))}${turn.id === lastAssistant?.id && !busy && !readonly ? `<div class="sd-theater-turn-tools">
              <button type="button" class="sd-icon-btn sd-icon-sm sd-theater-turn-redo" title="重写这一段" aria-label="重写这一段"><i class="fa-solid fa-rotate-right"></i></button>
              <button type="button" class="sd-icon-btn sd-icon-sm sd-theater-turn-drop" title="撤回这一回" aria-label="撤回这一回"><i class="fa-solid fa-rotate-left"></i></button>
            </div>` : ''}</div>`).join('');
    const pending = busy && pendingId ? `<div class="sd-theater-turn is-story is-pending" data-pending="${esc(pendingId)}"><span class="sd-theater-turn-wait">续写中…</span><div class="sd-theater-turn-live"></div></div>` : '';
    const box = `<div class="sd-theater-turns sd-reader-prose"${scale ? ` data-scale="${esc(scale)}"` : ''}>`;
    if (readonly) return turns.length ? `${box}${blocks}</div>` : '';
    const full = turnChars(turns) >= THEATER_TURN_CHARS_LIMIT;
    const composer = full
        ? '<p class="sd-muted sd-theater-turn-full">这一幕已写到上限</p>'
        : `<div class="sd-theater-composer">
            <textarea class="text_pole sd-theater-turn-input" rows="2" maxlength="${THEATER_TURN_INPUT_LIMIT}" spellcheck="false" placeholder="接着写……"${busy ? ' disabled' : ''}>${esc(draft)}</textarea>
            <button type="button" class="sd-icon-btn sd-theater-turn-send${busy ? ' sd-as-stop' : ''}" title="${busy ? '停止' : '续写'}" aria-label="${busy ? '停止' : '续写'}"><i class="fa-solid ${busy ? 'fa-stop' : 'fa-feather-pointed'}"></i></button>
          </div>`;
    return `${box}${blocks}${pending}</div>${composer}`;
}
