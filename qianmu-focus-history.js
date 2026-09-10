import { focusClockDateKey, focusClockWeekStart } from './qianmu-focus-time.js';

// Read-only projections. The caller still owns normalization, retention and persistence.
export function focusWeekHistory(history, now) {
  const start = focusClockWeekStart(now).getTime();
  return history.filter((item) => item?.kind === 'focus' && Number(item.finishedAt || item.startedAt) >= start);
}

export function focusTodayHistory(history, now) {
  const today = focusClockDateKey(now);
  return history.filter((item) => item?.kind === 'focus' && focusClockDateKey(item.finishedAt || item.startedAt) === today);
}

export function focusWeekStats(records, now) {
  const history = focusWeekHistory(records, now);
  const start = focusClockWeekStart(now);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return { date, key: focusClockDateKey(date), minutes: 0, count: 0, readingMinutes: 0 };
  });
  for (const item of history) {
    const day = days.find((entry) => entry.key === focusClockDateKey(item.finishedAt || item.startedAt));
    if (!day) continue;
    const minutes = Math.max(1, Math.round((Number(item.durationMs) || 0) / 60000));
    day.minutes += minutes;
    day.count += 1;
    if (item.activity === 'reading') day.readingMinutes += minutes;
  }
  return {
    history,
    days,
    minutes: days.reduce((sum, day) => sum + day.minutes, 0),
    count: days.reduce((sum, day) => sum + day.count, 0),
    readingMinutes: days.reduce((sum, day) => sum + day.readingMinutes, 0),
  };
}
