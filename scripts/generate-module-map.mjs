// Generates MODULES.md: a feature map of the flat repository root.
// Read-only over tracked sources (local untracked notes stay out); it never moves files. `--check` exits non-zero when MODULES.md is stale.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const OUTPUT = 'MODULES.md';

// Feature groups by the first name segment after `qianmu-`; unlisted prefixes fall into "其他".
const GROUPS = [
  ['分镜（storyboard）', ['storyboard', 'director', 'shot', 'scene', 'take']],
  ['Comfy／RunningHub 出图', ['comfy', 'runninghub', 'workflow']],
  ['图库与图片', ['gallery', 'image', 'illustration', 'cover', 'zoom']],
  ['Vibe／NAI', ['vibe', 'nai', 'novel']],
  ['视频', ['video']],
  ['正文辅助（prose）与蜂巢', ['prose', 'hive', 'assistant', 'quick']],
  ['角色、世界与设定', ['character', 'world', 'user', 'persona', 'lore']],
  ['聊天、历史与保存', ['chat', 'historical', 'history', 'save', 'backup', 'source']],
  ['专注／阅读／文本', ['focus', 'reader', 'reading', 'text', 'notes', 'note', 'narrative']],
  ['合奏、配方与包', ['ensemble', 'recipe', 'bundle', 'creative']],
  ['语音（TTS）', ['tts', 'voice', 'audio']],
  ['外观、主题、字体与图标', ['appearance', 'theme', 'font', 'icon', 'iconsax', 'line', 'logo', 'visual', 'style']],
  ['模型、配置与账户', ['model', 'config', 'account', 'mapping', 'api', 'st', 'storage', 'memory', 'llm', 'openai', 'portable', 'yimu']],
  ['提示词、美术方向与剧场', ['art', 'artist', 'composition', 'prompt', 'still', 'classic', 'tag', 'tags', 'theaters', 'production', 'film', 'plan']],
  ['基础设施（存储、日志、迁移、加载）', ['blobstore', 'data', 'document', 'feature', 'idle', 'input', 'json', 'mutation', 'resource',
    'service', 'client', 'release', 'library', 'verified', 'main', 'native', 'current', 'original', 'feedback']],
];
const prefixGroup = new Map(GROUPS.flatMap(([title, prefixes]) => prefixes.map(prefix => [prefix, title])));

function describe(source) {
  for (const raw of source.split(/\r?\n/).slice(0, 4)) {
    const line = raw.trim();
    const match = line.match(/^(?:\/\/+|\/\*+|\*)\s*(.*?)\s*(?:\*\/)?$/);
    if (match && match[1]) return match[1].length > 140 ? `${match[1].slice(0, 137)}…` : match[1];
    if (line && !line.startsWith('//') && !line.startsWith('/*')) break;
  }
  return '';
}

const escape = text => text.replace(/\|/g, '\\|');

export async function buildModuleMap() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: fileURLToPath(root), encoding: 'utf8' }).split('\0').filter(Boolean);
  const entries = tracked.filter(name => !name.includes('/') && !name.startsWith('.')).sort();
  const folders = new Map();
  for (const name of tracked.filter(name => name.includes('/'))) {
    const [top, second] = name.split('/');
    const key = ['assets', 'vendor'].includes(top) && name.split('/').length > 2 ? `${top}/${second}` : top;
    folders.set(key, (folders.get(key) || 0) + 1);
  }
  const release = new Set(JSON.parse(await readFile(new URL('release-files.json', root), 'utf8')).files || []);
  const buckets = new Map([...GROUPS.map(([title]) => [title, []]), ['其他模块', []]]);
  const rootFiles = [], docs = [];
  for (const name of entries) {
    if (name === OUTPUT) continue;
    if (/\.md$/.test(name)) { docs.push(name); continue; }
    const match = name.match(/^qianmu-([a-z0-9]+)(?:-[^.]*)?(?:\.[a-z0-9]+)*\.(?:js|css)$/);
    if (!match) { rootFiles.push(name); continue; }
    buckets.get(prefixGroup.get(match[1]) || '其他模块').push(name);
  }
  const row = async name => {
    const note = /\.(?:js|css|mjs)$/.test(name) ? describe(await readFile(new URL(name, root), 'utf8')) : '';
    return `| \`${name}\` | ${release.has(name) ? '是' : '否'} | ${escape(note)} |`;
  };
  const table = async names => ['| 文件 | 发行 | 首行说明 |', '| --- | --- | --- |', ...await Promise.all(names.map(row))].join('\n');
  const total = [...buckets.values()].reduce((sum, list) => sum + list.length, 0);
  const sections = [
    '# 千幕根目录功能地图',
    '',
    '> 由 `scripts/generate-module-map.mjs` 生成，勿手改；新增或删除根目录文件后运行 `node scripts/generate-module-map.mjs`。',
    '> 只是导航：文件仍平铺在根目录，分组按文件名前缀推断，“首行说明”取自文件开头注释（无则留空）。“发行”指是否列入 `release-files.json`。',
    '',
    `根目录文件 ${entries.filter(name => name !== OUTPUT).length} 个，其中 \`qianmu-*\` 模块 ${total} 个。`,
    '',
    '## 入口、宿主与安装',
    '',
    await table(rootFiles),
    '',
    '## 子目录（已归档的文件）',
    '',
    '| 目录 | 跟踪文件数 |',
    '| --- | --- |',
    ...[...folders].sort(([a], [b]) => a.localeCompare(b)).map(([folder, count]) => `| \`${folder}/\` | ${count} |`),
    '',
    '## 文档',
    '',
    await table(docs),
  ];
  for (const [title, names] of buckets) {
    if (!names.length) continue;
    sections.push('', `## ${title}（${names.length}）`, '', await table(names));
  }
  return `${sections.join('\n')}\n`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const next = await buildModuleMap();
  const current = await readFile(new URL(OUTPUT, root), 'utf8').catch(() => '');
  if (process.argv.includes('--check')) {
    if (current !== next) { console.error(`${OUTPUT} is stale; run node scripts/generate-module-map.mjs`); process.exit(1); }
    console.log(`${OUTPUT} is current`);
  } else if (current !== next) {
    await writeFile(new URL(OUTPUT, root), next);
    console.log(`${OUTPUT} written`);
  } else console.log(`${OUTPUT} unchanged`);
}
