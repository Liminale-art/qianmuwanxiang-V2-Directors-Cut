// 把 yimu/heart/ 下的三套主题页面打进一个模块（yimu/heart-themes.mjs），随忆幕的前端包一起加载。
// 主题页面在独立的 iframe 里显示，所以样式与千幕、忆幕本体的主题互不影响。改了主题页面后重新运行本脚本。
import { readFile, writeFile } from 'node:fs/promises';

export const HEART_THEME_SOURCES = [
    { id: 'yanweidie', name: '燕尾蝶', file: 'yanweidie.html' },
    { id: 'xianying', name: '显影', file: 'xianying.html' },
    { id: 'sujian', name: '素笺', file: 'sujian.html' },
];
export async function renderHeartThemes(root = new URL('../yimu/', import.meta.url)) {
    const themes = [];
    for (const theme of HEART_THEME_SOURCES) themes.push({ id: theme.id, name: theme.name, html: (await readFile(new URL(`heart/${theme.file}`, root), 'utf8')).replace(/\r\n/g, '\n') });
    return `// 由 scripts/generate-yimu-heart.mjs 生成，不要手改；源文件在 yimu/heart/。\nexport const HEART_THEMES = Object.freeze(${JSON.stringify(themes, null, 0)}.map(Object.freeze));\n`;
}
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
    const target = new URL('../yimu/heart-themes.mjs', import.meta.url);
    await writeFile(target, await renderHeartThemes());
    console.log('heart-themes.mjs written');
}
