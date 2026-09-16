// Existing classic descriptors and hive fills, shared without changing their values.
// Keys map to sd-theme-<key>; style.css owns their panel colours. Menu dots stay single-colour.
export const THEMES = [
  { key: 'light', name: '日间', dot: '#fdfcefff' },
  { key: 'dark', name: '夜间', dot: '#181818ff' },
  { key: 'summer', name: '柠夏', dot: '#9be84a' },
  { key: 'candy', name: '粉糯', dot: '#ffc7c9ff' },
  { key: 'kraft', name: '旧笺', dot: '#c7a877' },
  { key: 'dream', name: '幻梦', dot: '#9b8fd0' },
];
export const THEME_KEYS = THEMES.map((t) => t.key);
export const QUICK_HIVE_THEME_PALETTES = Object.freeze({
  light: {
    lightFill: 'rgba(248, 247, 243, .30)', darkFill: 'rgba(43, 44, 44, .38)',
    lightIcon: '#4b4b49', darkIcon: '#f7f3ea',
    edges: ['#77736d', '#c99b51', '#ddd8cd'], mainEdge: '#c99b51', mainFill: 'rgba(255, 255, 255, .22)',
  },
  dark: {
    lightFill: 'rgba(68, 72, 70, .32)', darkFill: 'rgba(35, 37, 38, .44)',
    lightIcon: '#f7f3ea', darkIcon: '#f7f3ea',
    edges: ['#8faf9b', '#d8ddd8', '#777c79'], mainEdge: '#8faf9b', mainFill: 'rgba(43, 44, 44, .34)',
  },
  summer: {
    lightFill: 'rgba(248, 249, 246, .30)', darkFill: 'rgba(45, 48, 47, .38)',
    lightIcon: '#4b4b49', darkIcon: '#f7f3ea',
    edges: ['#c6df4e', '#83cbb4', '#ddd8cd', '#77736d'], mainEdge: '#9fca62', mainFill: 'rgba(255, 255, 255, .22)',
  },
  candy: {
    lightFill: 'rgba(249, 247, 247, .30)', darkFill: 'rgba(46, 43, 45, .38)',
    lightIcon: '#4b4b49', darkIcon: '#f7f3ea',
    edges: ['#e5c971', '#e8a7bd', '#ddd8cd', '#77736d'], mainEdge: '#e3a0b8', mainFill: 'rgba(255, 255, 255, .22)',
  },
  kraft: {
    lightFill: 'rgba(248, 246, 241, .30)', darkFill: 'rgba(45, 43, 40, .38)',
    lightIcon: '#4b4b49', darkIcon: '#f7f3ea',
    edges: ['#a77b45', '#d8b66e', '#ddd8cd', '#77736d'], mainEdge: '#c99b51', mainFill: 'rgba(255, 255, 255, .22)',
  },
  dream: {
    lightFill: 'rgba(249, 248, 250, .30)', darkFill: 'rgba(44, 43, 48, .38)',
    lightIcon: '#4b4b49', darkIcon: '#f7f3ea',
    edges: ['#b7a5e3', '#8ec9c0', '#e6a8c7', '#e4cd8e', '#ddd8cd', '#77736d'], mainEdge: '#b7a5e3', mainFill: 'rgba(255, 255, 255, .22)',
  },
});

export const READER_PORTAL_BG = Object.freeze({ light: '#f3efe7', dark: '#1c1e22', summer: '#e9f5ee', candy: '#faf0f4', kraft: '#f1e7cf', dream: '#f0eff8' });
