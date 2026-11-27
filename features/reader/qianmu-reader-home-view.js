// 伴读面板（占满千幕面板）的外框、首页与统计页的标记。只拼字符串，数据与事件都在调用方。
import { heatCells, quarterRange, durationText, dayKey, zoneShift } from '../../qianmu-usage-tracker.js?v=1.59.629';

export const READER_PAGES = Object.freeze([
    { id: 'home', name: '首页', icon: 'fa-house' },
    { id: 'shelf', name: '书架', icon: 'fa-book' },
    { id: 'stats', name: '统计', icon: 'fa-chart-simple' },
]);
export const readerPageOf = page => READER_PAGES.some(item => item.id === page) ? page : 'home';

// 首页的几块：顺序与藏起来的可以改，存成 [{ id, hidden }]。
export const HOME_CARDS = Object.freeze([
    { id: 'continue', name: '继续阅读' },
    { id: 'today', name: '今日' },
    { id: 'pal', name: '书友' },
    { id: 'talk', name: '最近对话' },
    { id: 'calendar', name: '阅读日历' },
]);
/** 认不出的去掉、重复的只留一个、新加的块排到最后（显示着）。 */
export function homeCardOrder(saved) {
    const out = [], seen = new Set();
    for (const item of Array.isArray(saved) ? saved : []) {
        const id = String(item?.id || '');
        if (!HOME_CARDS.some(card => card.id === id) || seen.has(id)) continue;
        seen.add(id); out.push({ id, hidden: item.hidden === true });
    }
    for (const card of HOME_CARDS) if (!seen.has(card.id)) out.push({ id: card.id, hidden: false });
    return out;
}
/** 把 id 这一块往前（-1）或往后（+1）挪一格。 */
export function moveHomeCard(order, id, step) {
    const list = homeCardOrder(order), at = list.findIndex(item => item.id === id), to = at + step;
    if (at < 0 || to < 0 || to >= list.length) return list;
    [list[at], list[to]] = [list[to], list[at]];
    return list;
}
export function toggleHomeCard(order, id) { return homeCardOrder(order).map(item => item.id === id ? { ...item, hidden: !item.hidden } : item); }

const charsText = n => { const v = Math.max(0, Math.round(Number(n) || 0)); return v >= 10000 ? `${(v / 10000).toFixed(v >= 100000 ? 0 : 1)} 万字` : `${v} 字`; };
const md = at => { const d = new Date(at); return `${d.getMonth() + 1}月${d.getDate()}日`; };
const initial = name => String(name || '?').trim().slice(0, 1) || '?';

/** 外框：一列导航（首页、书架、统计；底下返回千幕、关闭）＋内容区。窄屏时导航在底部。 */
export function renderReaderShell(page, body) {
    const current = readerPageOf(page);
    const tab = item => `<button type="button" class="sd-coread-nav-tab${item.id === current ? ' active' : ''}" data-coread-page="${item.id}" aria-label="${item.name}"${item.id === current ? ' aria-current="page"' : ''}><i class="fa-solid ${item.icon}"></i><span>${item.name}</span></button>`;
    return `<nav class="sd-coread-nav" aria-label="伴读">
        ${READER_PAGES.map(tab).join('')}
        <span class="sd-coread-nav-gap"></span>
        <button type="button" class="sd-coread-nav-tab sd-coread-back" aria-label="返回千幕"><i class="fa-solid fa-arrow-left"></i><span>千幕</span></button>
        <button type="button" class="sd-coread-nav-tab sd-coread-close" aria-label="关闭"><i class="fa-solid fa-xmark"></i><span>关闭</span></button>
      </nav>
      <main class="sd-body sd-coread-main" data-coread-page="${current}">${body}</main>`;
}

function face(pal, avatarUrl, esc) {
    const url = pal?.avatar || pal?.key ? avatarUrl(pal.avatar || pal.key) : '';
    return `<span class="sd-coread-face">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : ''}<b>${esc(initial(pal?.name))}</b></span>`;
}

/** 那一天写成一行：日期、读了多久、读过多少字。 */
export function heatDayText(cell, chars = 0) { return `${md(cell.time)} · ${cell.ms ? durationText(cell.ms) : '没读'}${chars ? ` · ${charsText(chars)}` : ''}`; }

/** 十三整周的阅读日历，越深读得越久。点一格，下面那一行就换成那一天（默认是今天）。days：每天读过的字。 */
export function renderReaderHeat(time, at = Date.now(), days = {}) {
    const now = at + zoneShift(at, time?.zone), span = quarterRange(now), heat = heatCells(time, span.from, span.to, now);
    const today = heat.cells.find(cell => cell.today && cell.ms !== null);
    const cells = heat.cells.map(cell => { if (cell.ms === null) return `<i data-level="-1" style="--c:${cell.column};--r:${cell.row}"></i>`;
        const text = heatDayText(cell, days?.[dayKey(cell.time)] || 0);
        return `<i data-level="${cell.level}" style="--c:${cell.column};--r:${cell.row}"${cell.today ? ' data-today' : ''}${cell === today ? ' class="on"' : ''} title="${text}" data-day="${dayKey(cell.time)}" data-text="${text}" role="button" tabindex="0"></i>`; }).join('');
    return `<div class="sd-coread-heat" style="--weeks:${heat.weeks}">${cells}</div><p class="sd-coread-heat-day" aria-live="polite">${today ? heatDayText(today, days?.[dayKey(today.time)] || 0) : ''}</p>`;
}

function bars(list, value, row) {
    const most = Math.max(1, ...list.map(value));
    return list.map((item, index) => `<div class="sd-coread-rank-row${index === 0 ? ' is-top' : ''}">${row(item)}<span class="sd-coread-bar"><span style="width:${Math.max(2, Math.round(value(item) / most * 100))}%"></span></span></div>`).join('');
}

/** 首页。current：最后打开的那本书（书架上的元数据）；cover(book)：封面标记。 */
export function renderReaderHome(summary, { current = null, time = null, days = {}, now = Date.now(), esc, avatarUrl = key => key, cover = () => '', cards = null, editing = false } = {}) {
    const s = summary, pal = s.lastPal;
    const progress = Math.max(0, Math.min(100, Math.round(Number(current?.progress) || 0)));
    const continueCard = current ? `<section class="sd-coread-card sd-coread-continue">
        <div class="sd-reader-card-cover sd-coread-cover">${cover(current)}</div>
        <div class="sd-coread-continue-main">
          <strong title="${esc(current.title || '')}">${esc(current.title || '未命名')}</strong>
          ${current.author ? `<small>${esc(current.author)}</small>` : ''}
          <span class="sd-coread-progress"><span style="width:${progress}%"></span></span>
          <small>${progress}%${s.books.find(item => item.id === current.id)?.ms ? ` · ${esc(durationText(s.books.find(item => item.id === current.id).ms))}` : ''}</small>
          <button type="button" class="sd-btn sd-primary sd-coread-open" data-book="${esc(current.id)}">继续阅读</button>
        </div>
      </section>` : `<section class="sd-coread-card sd-coread-continue sd-coread-empty"><button type="button" class="sd-btn sd-coread-goto" data-coread-page="shelf">去书架</button></section>`;
    const today = `<section class="sd-coread-card sd-coread-today">
        <em>今日</em><strong>${esc(durationText(s.today.ms))}</strong><small>${esc(charsText(s.today.chars))}</small>
        <div class="sd-coread-mini"><span><b>${s.read}</b>读过</span><span><b>${s.finished}</b>读完</span><span><b>${s.streak}</b>连续天</span></div>
      </section>`;
    const pals = s.pals.slice(0, 5);
    const palCard = pal ? `<section class="sd-coread-card sd-coread-pal">
        <div class="sd-coread-pal-head">${face(pal, avatarUrl, esc)}<div><strong>${esc(pal.name || '书友')}</strong><small>共读 ${esc(durationText(pal.ms))} · ${esc(charsText(pal.chars))}</small></div></div>
        ${pals.length > 1 ? `<div class="sd-coread-rank">${bars(pals, item => item.ms, item => `${face(item, avatarUrl, esc)}<span class="sd-coread-rank-name">${esc(item.name || '书友')}</span><span class="sd-coread-rank-val">${esc(durationText(item.ms))}</span>`)}</div>` : ''}
      </section>` : '';
    const talk = s.talk ? `<section class="sd-coread-card sd-coread-talk">
        <em>《${esc(s.talk.book?.title || '')}》 · ${esc(md(s.talk.at))}</em>
        ${s.talk.lines.map(line => `<p class="sd-coread-talk-line is-${line.who}"><b>${esc(line.who === 'user' ? (s.talk.user || '我') : (s.talk.pal?.name || '书友'))}</b><span>${esc(line.text)}</span></p>`).join('')}
      </section>` : '';
    const heat = time ? `<section class="sd-coread-card sd-coread-calendar"><em>阅读日历</em>${renderReaderHeat(time, now, days)}</section>` : '';
    const blocks = { continue: continueCard, today, pal: palCard, talk, calendar: heat };
    const order = homeCardOrder(cards);
    // 整理时：每块上面一条（名字、前移、后移、显示与否）；没有内容的块也露出名字，好排它的位置。
    const tools = (item, index) => { const name = HOME_CARDS.find(card => card.id === item.id).name;
        return `<div class="sd-coread-card-tools"><span>${name}</span>
          <button type="button" data-home-move="-1" data-card="${item.id}" aria-label="前移"${index === 0 ? ' disabled' : ''}><i class="fa-solid fa-arrow-up"></i></button>
          <button type="button" data-home-move="1" data-card="${item.id}" aria-label="后移"${index === order.length - 1 ? ' disabled' : ''}><i class="fa-solid fa-arrow-down"></i></button>
          <button type="button" data-home-toggle data-card="${item.id}" aria-label="${item.hidden ? '显示' : '隐藏'}" aria-pressed="${!item.hidden}"><i class="fa-solid ${item.hidden ? 'fa-eye-slash' : 'fa-eye'}"></i></button></div>`; };
    const body = order.map((item, index) => {
        const html = blocks[item.id];
        if (!editing) return item.hidden ? '' : html;
        const inner = html || `<section class="sd-coread-card sd-coread-${item.id} sd-coread-placeholder"></section>`;
        return `<div class="sd-coread-slot sd-coread-slot-${item.id}${item.hidden ? ' is-hidden' : ''}">${tools(item, index)}${inner}</div>`;
    }).join('');
    const head = `<div class="sd-coread-home-head"><button type="button" class="sd-coread-home-edit${editing ? ' active' : ''}" aria-label="${editing ? '完成' : '整理首页'}" title="${editing ? '完成' : '整理首页'}"><i class="fa-solid ${editing ? 'fa-check' : 'fa-pen'}"></i></button></div>`;
    return `<div class="sd-coread-home${editing ? ' is-editing' : ''}">${head}${body}</div>`;
}

/** 统计页：总数、阅读日历、按书与按书友的排行。 */
export function renderReaderStats(summary, { time = null, days = {}, now = Date.now(), esc, avatarUrl = key => key } = {}) {
    const s = summary;
    const cell = (title, value, small = '') => `<div class="sd-coread-stat"><em>${title}</em><strong>${esc(value)}</strong>${small ? `<small>${esc(small)}</small>` : ''}</div>`;
    const totals = `<section class="sd-coread-stats">
        ${cell('今日', durationText(s.today.ms), charsText(s.today.chars))}
        ${cell('本周', durationText(s.week))}
        ${cell('本月', durationText(s.month))}
        ${cell('累计', durationText(s.all.ms), charsText(s.all.chars))}
        ${cell('读过', `${s.read} 本`, `读完 ${s.finished} 本`)}
        ${cell('连续', `${s.streak} 天`, `最长 ${s.longest} 天`)}
      </section>`;
    const books = s.books.slice(0, 10), pals = s.pals.slice(0, 10);
    const bookRank = books.length ? `<section class="sd-coread-card"><em>书</em><div class="sd-coread-rank">${bars(books, item => item.ms, item => `<span class="sd-coread-rank-name">${esc(item.book?.title || '')}${item.done ? ' <i class="fa-solid fa-check"></i>' : ''}</span><span class="sd-coread-rank-val">${esc(durationText(item.ms))} · ${esc(charsText(item.chars))}</span>`)}</div></section>` : '';
    const palRank = pals.length ? `<section class="sd-coread-card"><em>书友</em><div class="sd-coread-rank">${bars(pals, item => item.ms, item => `${face(item, avatarUrl, esc)}<span class="sd-coread-rank-name">${esc(item.name || '书友')}</span><span class="sd-coread-rank-val">${esc(durationText(item.ms))} · ${esc(charsText(item.chars))}</span>`)}</div></section>` : '';
    const heat = time ? `<section class="sd-coread-card sd-coread-calendar"><em>阅读日历</em>${renderReaderHeat(time, now, days)}</section>` : '';
    return `<div class="sd-coread-statspage">${totals}${heat}${bookRank}${palRank}</div>`;
}
