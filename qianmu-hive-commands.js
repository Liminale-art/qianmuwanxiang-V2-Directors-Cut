// Shared built-in commands; no runtime state or network dependencies.
export const QIANMU_HIVE_COMMANDS = Object.freeze([
  { id: 'dashboard', label: '推演', icon: 'fa-clapperboard', glyph: 'dashboard' },
  { id: 'focus', label: '专注', icon: 'fa-hourglass-half', glyph: 'focus' },
  { id: 'notes', label: '便笺', icon: 'fa-note-sticky', glyph: 'notes' },
  { id: 'assistant', label: '场外特助', icon: 'fa-comments', glyph:'assistant' },
  { id: 'text-collection', label: '正文收藏', icon: 'fa-star', glyph:'bookmarks' },
  { id: 'tasksnodes', label: '任务', icon: 'fa-list-check', glyph: 'tasks' },
  { id: 'castworld', label: '世界', icon: 'fa-earth-asia', glyph: 'world' },
  { id: 'context', label: '取材', icon: 'fa-box-archive', glyph: 'context' },
  { id: 'settings', label: '幕后', icon: 'fa-feather-pointed', glyph: 'backstage' },
  { id: 'theater', label: '幕外', icon: 'fa-masks-theater', glyph: 'theater' },
  { id: 'tts', label: '配音', icon: 'fa-microphone-lines', glyph: 'qm-duotone-microphone-stage' },
  { id: 'coread', label: '书架', icon: 'fa-book-open', glyph: 'coread-entry' },
  { id: 'geopolitics', label: '世界格局', icon: 'fa-atom', glyph: 'world-map' },
  { id: 'plug', label: 'API与日志', icon: 'fa-gear', glyph: 'qm-duotone-gear' },
  { id: 'imagegen', label: '分镜', icon: 'fa-video', glyph: 'qm-regular-aperture' },
  { id: 'floor', label: '楼层跳转', icon: 'fa-layer-group', glyph: 'floor-tools' },
]);

export function upgradeProseHiveCommands(settings) {
  const retired = new Set(['collections']);
  for (const key of ['quickWheelCustomOrder', 'quickWheelCustomEnabled']) {
    if (Array.isArray(settings[key])) settings[key] = [...new Set(settings[key].filter(id => !retired.has(id)))];
  }
  if (!(settings.proseHiveVersion >= 3)) {
    for (const key of ['quickWheelCustomOrder', 'quickWheelCustomEnabled']) {
      if (Array.isArray(settings[key]) && !settings[key].includes('text-collection')) settings[key].push('text-collection');
    }
    settings.proseHiveVersion = 3;
  }
}
