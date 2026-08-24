import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

assert.ok(source.includes('function currentDirectorInjectionText('), '必须有预览与实际注入共用的当前文本入口');
assert.match(source, /active \? currentDirectorInjectionText\(store\.plan\) : ''/, '扩展提示注入必须读取手动覆盖层');
assert.match(source, /const digest = currentDirectorInjectionText\(store\.plan\)/, '拦截器兜底注入必须读取同一覆盖层');
assert.match(source, /sd-edit-injection[\s\S]*fa-pencil/, '当前注入内容标题后必须保留铅笔入口');
assert.match(source, /target === 'sd-inject-preview'[\s\S]*injectOverride[\s\S]*applyDirectorInjection/, '保存修改后必须持久化并即时刷新实际注入');
assert.ok(source.includes('sd-editor-reset-injection'), '注入编辑页必须能够恢复自动生成');
assert.match(source, /injectionEditor \? '<button[^']*aria-label="返回"[^']*<\/button>'/, '注入编辑页返回按钮必须只有图标');
assert.match(source, /aria-label="恢复自动生成"><i[^>]*><\/i><\/button><button[^']*aria-label="保存"><i[^>]*><\/i><\/button>/, '注入编辑页恢复与保存按钮必须只有图标');
assert.equal((source.match(/sd-editor-tool-icon/g) || []).length, 3, '注入编辑页返回、恢复与保存必须共用同一图标规格');
assert.doesNotMatch(css, /\.sd-editor-tool-icon\.sd-editor-save i[^}]*transform:/, '保存与恢复图标必须使用完全相同的尺寸规则');
assert.match(source, /const editorLayout = !!editorView \|\| \(activeTab === 'theater' && !!theaterView\)/, '通用文本编辑与幕外全部子视图必须启用同一独立滚动布局');
assert.match(source, /sd-body\$\{editorLayout \? ' sd-editor-body'/, '编辑态必须为主内容区挂载专用布局类');
assert.match(source, /sd-reader-card sd-editor-card sd-theater-view-card\$\{editing \? ' sd-reader-editor-card'/, '幕外阅读与编辑必须接入固定卡片布局');
assert.match(css, /\.sd-sticky-bar\s*\{[^}]*z-index:\s*5[^}]*background:\s*var\(--sd-sticky-bg/, '同类顶栏必须使用主题实色隔离层防止正文穿透');
assert.match(css, /\.sd-sticky-bar\s*\{[^}]*border:\s*0 !important[^}]*box-shadow:\s*none !important/, '固定顶栏不得再以阴影或分割线割裂页面');
assert.ok((css.match(/--sd-sticky-bg:/g) || []).length >= 6, '六套外观都必须提供不透明顶栏底色');
assert.match(css, /\.sd-body\.sd-editor-body\s*\{[^}]*overflow:\s*hidden/, '编辑页外层不得继续承接正文滚动');
assert.match(css, /\.sd-editor-body > \.sd-editor-card\s*\{[^}]*flex:\s*1 1 0[^}]*overflow:\s*hidden/, '编辑卡必须固定占满剩余空间');
assert.match(css, /\.sd-theater-reader-scroll\s*\{[^}]*flex:\s*1 1 0[^}]*overflow:\s*auto/, '幕外正文必须在独立区域滚动，不能再穿透工具栏');
assert.match(css, /\.sd-editor-area\s*\{[^}]*flex:\s*1 1 0[^}]*overflow:\s*auto[^}]*resize:\s*none/, '编辑框必须固定尺寸并自行滚动');
assert.match(css, /\.sd-editor-card:not\(\.sd-theater-view-card\)[\s\S]*background:\s*transparent !important[\s\S]*box-shadow:\s*none !important/, '编辑页不得再用整块卡片底色包住顶栏按钮');
assert.match(css, /\.sd-editor-bar\s*\{[^}]*background:\s*transparent !important/, '编辑页顶栏按钮下方必须保持无感透明');
assert.match(css, /\.sd-editor-bar\s*\{[^}]*margin:\s*10px 0/, '透明编辑顶栏仍须与主导航留出稳定的顶部呼吸间距');
assert.doesNotMatch(source.slice(source.indexOf('const tabs = ['), source.indexOf('const wasOpen')), /\['blueprint', '编剧'\]/, '编剧不得继续占用顶层 tab');
assert.match(source, /renderBackstageBlueprintCard\(\)[\s\S]*data-acc="director-law"/, '编剧卡必须并入剧组之律卡之前');
assert.match(source, /sd-backstage-blueprint sd-director-title-fold[\s\S]*<summary><b>编剧<\/b>/, '编剧标题必须移除图标并使用幕后统一标题规格');
assert.equal((source.match(/sd-director-title-fold/g) || []).length, 2, '编剧与剧组之律必须共用标题规格');
assert.match(css, /\.sd-director-title-fold > summary b\s*\{[^}]*font-size:\s*1\.06em[^}]*letter-spacing:\s*\.03em/, '幕后折叠卡标题必须与剧情推演标题字号一致');
assert.ok((source.match(/delete (?:store|getChatStore\(\))\.injectOverride/g) || []).length >= 3, '新推演、清空与载入历史必须解除旧覆盖');
assert.match(css, /sd-tts-fav-row\.sd-playing \.sd-tts-txt\.is-overflowing/, '收藏标题只能在播放且溢出时滚动');
assert.match(css, /prefers-reduced-motion: reduce/, '标题滚动必须尊重系统减少动态效果设置');

console.log('Director injection edit contract OK');
