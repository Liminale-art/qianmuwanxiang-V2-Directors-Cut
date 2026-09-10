// Weekly image generation owns no persistent state and downloads only after successful PNG encoding.
function focusClockRoundRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

export async function exportFocusWeekImage({getStats, getTheme, createCanvas, weekStart, dateKey, download, notify}) {
  const stats = getStats();
  if (!stats.history.length) { notify('本周还没有可导出的专注记录。', 'warning'); return; }
  const palettes = {
    dark: { bg: '#18201d', card: '#222c28', text: '#eef4f0', muted: '#9fb0a7', accent: '#94c2a8', bar: '#b8dac6' },
    summer: { bg: '#eff6df', card: '#fbfff2', text: '#344233', muted: '#788a73', accent: '#9fbd45', bar: '#c4d969' },
    candy: { bg: '#fff0f3', card: '#fff9f7', text: '#554146', muted: '#9b7f86', accent: '#d78fa2', bar: '#efb6c5' },
    kraft: { bg: '#eee3cf', card: '#faf4e8', text: '#51483c', muted: '#8d806e', accent: '#b18b54', bar: '#d3b77f' },
    dream: { bg: '#eeeafb', card: '#f9f7ff', text: '#453f5e', muted: '#857d9d', accent: '#9b8bd0', bar: '#c3b7e8' },
    light: { bg: '#edf2ed', card: '#fafcf8', text: '#354239', muted: '#7a897f', accent: '#718f7c', bar: '#a8c2af' },
  };
  const palette = palettes[getTheme()] || palettes.light;
  const canvas = createCanvas();
  canvas.width = 1200;
  canvas.height = 820;
  const context = canvas.getContext('2d');
  if (!context) { notify('当前浏览器无法生成记录图片。', 'error'); return; }
  const gradient = context.createLinearGradient(0, 0, 1200, 820);
  gradient.addColorStop(0, palette.bg);
  gradient.addColorStop(1, palette.card);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1200, 820);
  context.fillStyle = palette.card;
  focusClockRoundRect(context, 68, 62, 1064, 696, 34);
  context.fill();
  context.fillStyle = palette.text;
  context.font = '600 46px "Noto Serif SC", "Songti SC", serif';
  context.fillText('千幕 · 本周专注', 120, 142);
  const start = weekStart();
  const end = new Date(start); end.setDate(start.getDate() + 6);
  context.fillStyle = palette.muted;
  context.font = '26px "Noto Sans SC", sans-serif';
  context.fillText(`${start.getMonth() + 1}月${start.getDate()}日 — ${end.getMonth() + 1}月${end.getDate()}日`, 120, 188);
  const summary = [[stats.minutes, '专注分钟'], [stats.count, '完成段数'], [stats.readingMinutes, '伴读分钟']];
  summary.forEach(([value, label], index) => {
    const x = 120 + index * 300;
    context.fillStyle = palette.text;
    context.font = '600 42px "Noto Sans SC", sans-serif';
    context.fillText(String(value), x, 282);
    context.fillStyle = palette.muted;
    context.font = '23px "Noto Sans SC", sans-serif';
    context.fillText(label, x, 321);
  });
  const chartX = 120, chartY = 390, chartW = 960, chartH = 252;
  const maxMinutes = Math.max(1, ...stats.days.map((day) => day.minutes));
  const slot = chartW / 7;
  const weekLabels = ['一', '二', '三', '四', '五', '六', '日'];
  stats.days.forEach((day, index) => {
    const barW = 62;
    const barH = Math.max(day.minutes ? 12 : 4, day.minutes / maxMinutes * 188);
    const x = chartX + slot * index + (slot - barW) / 2;
    const y = chartY + 196 - barH;
    context.fillStyle = day.minutes ? palette.bar : `${palette.muted}35`;
    focusClockRoundRect(context, x, y, barW, barH, 22);
    context.fill();
    context.fillStyle = palette.text;
    context.font = '600 21px "Noto Sans SC", sans-serif';
    context.textAlign = 'center';
    if (day.minutes) context.fillText(String(day.minutes), x + barW / 2, y - 14);
    context.fillStyle = palette.muted;
    context.font = '22px "Noto Sans SC", sans-serif';
    context.fillText(`周${weekLabels[index]}`, x + barW / 2, chartY + 236);
  });
  context.textAlign = 'left';
  context.fillStyle = palette.accent;
  context.font = '24px "Noto Serif SC", serif';
  context.fillText('一蝶振翅，万象入幕', 120, 704);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) { notify('本周记录图片生成失败。', 'error'); return; }
  download(blob, `千幕-本周专注-${dateKey(start)}.png`);
  notify('本周记录图片已导出。', 'success');
}
