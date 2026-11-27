// 伴读面板（占满千幕面板）的外框、首页与统计页的标记。只拼字符串，数据与事件都在调用方。
import { heatCells, quarterRange, durationText, dayKey, zoneShift } from '../../qianmu-usage-tracker.js?v=1.59.628';

export const READER_PAGES = Object.freeze([
    { id: 'home', name: '首页', icon: 'fa-house' },
    { id: 'shelf', name: '书架', icon: 'fa-book' },
    { id: 'stats', name: '统计', icon: 'fa-chart-simple' },
]);
export const readerPageOf = page => READER_PAGES.some(item => item.id === page) ? page : 'home';

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

/** 十三整周的阅读日历，越深读得越久。 */
export function renderReaderHeat(time, at = Date.now()) {
    const now = at + zoneShift(at, time?.zone), span = quarterRange(now), heat = heatCells(time, span.from, span.to, now);
    const cells = heat.cells.map(cell => `<i data-level="${cell.level}" style="--c:${cell.column};--r:${cell.row}"${cell.today ? ' data-today' : ''}${cell.ms === null ? '' : ` title="${md(cell.time)} · ${cell.ms ? durationText(cell.ms) : '没读'}" data-day="${dayKey(cell.time)}"`}></i>`).join('');
    return `<div class="sd-coread-heat" style="--weeks:${heat.weeks}">${cells}</div>`;
}

function bars(list, value, row) {
    const most = Math.max(1, ...list.map(value));
    return list.map((item, index) => `<div class="sd-coread-rank-row${index === 0 ? ' is-top' : ''}">${row(item)}<span class="sd-coread-bar"><span style="width:${Math.max(2, Math.round(value(item) / most * 100))}%"></span></span></div>`).join('');
}

/** 首页。current：最后打开的那本书（书架上的元数据）；cover(book)：封面标记。 */
export function renderReaderHome(summary, { current = null, time = null, now = Date.now(), esc, avatarUrl = key => key, cover = () => '' } = {}) {
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
    const heat = time ? `<section class="sd-coread-card sd-coread-calendar"><em>阅读日历</em>${renderReaderHeat(time, now)}</section>` : '';
    return `<div class="sd-coread-home">${continueCard}${today}${palCard}${talk}${heat}</div>`;
}

/** 统计页：总数、阅读日历、按书与按书友的排行。 */
export function renderReaderStats(summary, { time = null, now = Date.now(), esc, avatarUrl = key => key } = {}) {
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
    const heat = time ? `<section class="sd-coread-card sd-coread-calendar"><em>阅读日历</em>${renderReaderHeat(time, now)}</section>` : '';
    return `<div class="sd-coread-statspage">${totals}${heat}${bookRank}${palRank}</div>`;
}
