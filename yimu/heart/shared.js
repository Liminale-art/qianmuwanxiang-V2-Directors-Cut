// 三套主题共用的部分：把数据里的文字转义、退出与换主题、删除单条、日期筛选（日／周，前后翻，月历）。
// 主题页面只需提供 window.yimuPaint(D, raw)：D 是按所选日期筛过、已转义的数据，可以反复调用。
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const safe = value => Array.isArray(value) ? value.map(safe) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safe(v)])) : typeof value === 'string' ? esc(value) : value;
const tell = type => parent.postMessage({ yimuHeart: type }, '*');
document.getElementById('ym-exit').addEventListener('click', () => tell('exit'));
document.getElementById('ym-theme').addEventListener('click', () => tell('theme'));
addEventListener('keydown', event => { if (event.key === 'Escape') { if (YM.open) { YM.open = false; drawDate(); } else tell('exit'); } });

// 删除单条：主题在每条印象、心迹、年表条目里放 rm(kind, id) 给出的小「×」。点一下变「再点删除」，几秒内再点才删。
// 「还在留意的」不放。在捕获阶段接住点击，条目自己的展开不会跟着触发。
const rm = (kind, id) => id ? `<button type="button" class="ym-rm" data-rm-kind="${kind}" data-rm-id="${id}" aria-label="删除">×</button>` : '';
let rmArmed = null, rmTimer = 0;
const rmDisarm = () => { clearTimeout(rmTimer); if (rmArmed) { rmArmed.removeAttribute('data-armed'); rmArmed.textContent = '×'; rmArmed.setAttribute('aria-label', '删除'); } rmArmed = null; };
document.addEventListener('click', event => {
    const button = event.target.closest?.('.ym-rm');
    if (!button) { rmDisarm(); return; }
    event.preventDefault(); event.stopPropagation();
    if (rmArmed !== button) {
        rmDisarm(); rmArmed = button; button.setAttribute('data-armed', 'true'); button.textContent = '再点删除'; button.setAttribute('aria-label', '再点删除');
        rmTimer = setTimeout(rmDisarm, 4000);
        return;
    }
    rmDisarm(); button.disabled = true;
    parent.postMessage({ yimuHeart: 'remove', kind: button.dataset.rmKind, id: button.dataset.rmId }, '*');
}, true);

// 日期按「记下的那一刻」（系统时间）算。默认停在最新有记录的那一天。
const DAY = 86400000, WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const dayStart = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const weekStart = ms => { const d = new Date(dayStart(ms)); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return d.getTime(); }; // 周一起
const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
const YM = { raw: { impressions: [], loose: [], thoughts: [], events: [] }, mode: 'day', anchor: 0, month: 0, open: false };
const stamps = raw => [...raw.loose.map(item => item.at), ...raw.thoughts.map(item => item.at), ...raw.impressions.flatMap(item => [item.at, ...(item.stamps || [])])].filter(Number.isFinite);
const recordDays = () => [...new Set(stamps(YM.raw).map(dayStart))].sort((a, b) => a - b);
const span = () => { const from = YM.mode === 'week' ? weekStart(YM.anchor) : YM.anchor; return [from, addDays(from, YM.mode === 'week' ? 7 : 1)]; };
const within = at => { const [from, to] = span(); return at >= from && at < to; };
const md = ms => { const d = new Date(ms); return `${d.getMonth() + 1}月${d.getDate()}日`; };
const spanLabel = () => { const [from, to] = span(); return YM.mode === 'week' ? `${md(from)} – ${md(addDays(to, -1))}` : `${md(from)} 周${WEEKDAYS[new Date(from).getDay()]}`; };
function picked(raw) {
    return { ...raw, impressions: raw.impressions.filter(item => within(item.at) || (item.stamps || []).some(within)), loose: raw.loose.filter(item => within(item.at)),
        thoughts: raw.thoughts.filter(item => within(item.at)), events: raw.events.map(item => ({ ...item, now: within(item.at) })), period: spanLabel() };
}
function drawDate() {
    const host = document.getElementById('ym-date');
    if (!host) return;
    const days = recordDays(), [from, to] = span(), before = days.filter(day => day < from).at(-1), after = days.find(day => day >= to);
    const first = new Date(YM.month); first.setDate(1); first.setHours(0, 0, 0, 0);
    const lead = (first.getDay() + 6) % 7, count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate(), has = new Set(days), today = dayStart(Date.now());
    const cells = Array.from({ length: lead }, () => '<i></i>').concat(Array.from({ length: count }, (_, index) => {
        const at = new Date(first.getFullYear(), first.getMonth(), index + 1).getTime();
        return `<button type="button" data-day="${at}" class="${[has.has(at) ? 'has' : '', at >= from && at < to ? 'on' : '', at === today ? 'today' : ''].join(' ').trim()}">${index + 1}</button>`;
    }));
    host.innerHTML = `<button type="button" data-go="${before ?? ''}" aria-label="往前" ${before === undefined ? 'disabled' : ''}>‹</button>
      <button type="button" id="ym-date-label" aria-haspopup="dialog" aria-expanded="${YM.open}">${spanLabel()}</button>
      <button type="button" data-go="${after ?? ''}" aria-label="往后" ${after === undefined ? 'disabled' : ''}>›</button>
      <span class="ym-date-mode"><button type="button" data-mode="day" aria-pressed="${YM.mode === 'day'}">日</button><button type="button" data-mode="week" aria-pressed="${YM.mode === 'week'}">周</button></span>
      <div class="ym-cal" role="dialog" aria-label="选日期" ${YM.open ? '' : 'hidden'}><div class="ym-cal-head"><button type="button" data-month="-1" aria-label="上个月">‹</button><b>${first.getFullYear()} 年 ${first.getMonth() + 1} 月</b><button type="button" data-month="1" aria-label="下个月">›</button></div>
      <div class="ym-cal-grid">${['一', '二', '三', '四', '五', '六', '日'].map(name => `<span>${name}</span>`).join('')}${cells.join('')}</div></div>`;
}
function repaint() { drawDate(); window.yimuPaint?.(safe(picked(YM.raw)), YM.raw); }
document.addEventListener('click', event => {
    const target = event.target.closest?.('#ym-date button');
    if (!target) { if (YM.open && !event.target.closest?.('.ym-cal')) { YM.open = false; drawDate(); } return; }
    if (target.id === 'ym-date-label') { YM.open = !YM.open; YM.month = YM.anchor; drawDate(); return; }
    if (target.dataset.month) { const d = new Date(YM.month); d.setDate(1); d.setMonth(d.getMonth() + Number(target.dataset.month)); YM.month = d.getTime(); drawDate(); return; }
    if (target.dataset.mode) YM.mode = target.dataset.mode;
    else if (target.dataset.go) YM.anchor = Number(target.dataset.go);
    else if (target.dataset.day) { YM.anchor = Number(target.dataset.day); YM.open = false; }
    else return;
    YM.month = YM.anchor; repaint();
});
window.yimuRender = raw => {
    const data = raw && typeof raw === 'object' ? raw : {};
    YM.raw = { ...data, impressions: data.impressions || [], loose: data.loose || [], thoughts: data.thoughts || [], events: data.events || [] };
    if (!YM.anchor) { YM.anchor = recordDays().at(-1) ?? dayStart(Date.now()); YM.month = YM.anchor; }
    repaint();
};
