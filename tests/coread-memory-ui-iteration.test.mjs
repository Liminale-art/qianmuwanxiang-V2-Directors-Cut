import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

const setup = source.slice(source.indexOf('function renderCompanionSetupBody'), source.indexOf('function renderReaderVoiceClips'));
assert.ok(setup.indexOf('renderCoreadSpoilerGuard(m)') < setup.indexOf('对话与可见范围'), '防剧透卡必须位于对话与可见范围上方');
assert.match(setup, /sd-reader-setup-compact-grid[\s\S]*字数上限[\s\S]*每次回复条数[\s\S]*参考近期对话条数[\s\S]*语音条缓存上限/, '四项数值设置必须使用紧凑网格');
assert.match(setup, /sd-reader-identity-card[\s\S]*renderCoreadIdentity\('书友'[\s\S]*renderCoreadIdentity\('我'[\s\S]*sd-reader-context-card[\s\S]*参考上下文层数/, '头像身份标签与参考上下文必须拆为两张卡');
assert.doesNotMatch(setup, /控制书友能看见多少|超长篇按比例截取/, '设定页指定说明小字必须移除');
assert.doesNotMatch(setup, /身份与正文联动|身份跟随 ST 当前角色与用户|独立于主线选择|伴读世界书<\/label>|伴读预设<\/label>/, '设定页指定旧标题和取材说明必须移除');
assert.match(css, /\.sd-reader-setup-compact-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2/, '紧凑设置在窄屏也应保持二列基础布局');

const records = source.slice(source.indexOf('function renderMemRecordsTab'), source.indexOf('function renderMemInjectTab'));
assert.doesNotMatch(records, /开发测试|sd-reader-test-selftest|sd-reader-test-lore/, '记忆档案不得暴露开发测试卡');
assert.match(records, /世界书同步[\s\S]*仅存至千幕档案（本地存储）[\s\S]*同步到千幕伴读世界书[\s\S]*同步至正文记忆插件所用世界书/, '千幕档案必须主存储，世界书只提供三档可选镜像');
assert.match(records, /默认方案/, '总结预设默认项必须命名为默认方案');
assert.match(records, /DEFAULT_DISTILL_TEXT_PROMPT[\s\S]*DEFAULT_MAINLINE_SUMMARY_PROMPT/, '蒸馏和主线提示词必须显示各自内置默认');
assert.doesNotMatch(records, /sd-reader-distillprompt-restore|sd-reader-mainlineprompt-restore|sd-reader-sumitem-badge/, '提示词只保留整体恢复且不再突出内置标签');
assert.match(records, /sd-reader-guide-replay/, '记忆档案末尾必须提供重看引导入口');
assert.match(css, /\.sd-reader-promptblock[^{]*\{[^}]*border:[^}]*border-radius:/, '三类提示词必须使用统一折叠卡');

const guide = source.slice(source.indexOf('const COREAD_GUIDE_STEPS'), source.indexOf('function renderCompanionMoreBody'));
assert.match(guide, /tab: 'api'[\s\S]*target: 'sources'[\s\S]*target: 'dialog-summary'[\s\S]*target: 'mainline-summary'[\s\S]*target: 'records'[\s\S]*tab: 'inject'[\s\S]*target: 'transfer'/, '首次教程必须覆盖接口、取材、伴读总结、主线总结、档案、注入和迁移');
assert.match(guide, /sd-reader-tour-prev[\s\S]*sd-reader-tour-next/, '逐步教程必须提供箭头式上一步和下一步');
assert.match(source, /if \(!m\.guideSeen && coreadGuideStep === null\) coreadGuideStep = 0/, '首次进入伴读中心必须自动启动逐步引导');
assert.match(css, /\.sd-reader-tour-target[^{]*\{[^}]*outline:[^}]*animation:/, '当前引导卡必须有明确高亮视觉');
assert.match(css, /\.sd-reader-tour\s*\{[^}]*position:\s*absolute/, '引导说明卡必须跟随当前高亮区定位而非固定在页顶');
const centerScroll = source.slice(source.indexOf('// 只移动伴读中心自己的滚动层'), source.indexOf('const rerenderSetup'));
assert.match(centerScroll, /sd-reader-morepage-body[\s\S]*scroller\.scrollTo[\s\S]*scrollMoreTarget/, '引导定位只能滚动伴读中心正文容器');
assert.match(centerScroll, /positionGuide[\s\S]*contentY[\s\S]*tour\.style\.top/, '引导说明卡必须计算并放置在高亮卡上方');
assert.doesNotMatch(centerScroll, /\.scrollIntoView\(/, '引导切步不得调用会牵动外层千幕面板的 scrollIntoView');
assert.match(css, /\.sd-reader-morepage-body[^}]*overscroll-behavior:\s*contain/, '伴读中心滚动必须阻止继续传递到外层面板');

const inject = source.slice(source.indexOf('function renderMemInjectTab'), source.indexOf('function renderCompanionSetupBody'));
assert.match(inject, /语境扫描对话条数[\s\S]*sd-reader-inj-scan/, '语境扫描条数必须允许用户设置');
assert.match(inject, /最近 \$\{scanN\} 条对话/, '召回管线必须按对话条数展示扫描范围');
assert.doesNotMatch(inject, /末240字|fa-circle-info|真正注入了哪些|② 锚定词/, '注入页旧说明和移动端不可见注释必须移除');
assert.match(inject, /② 关键词锚定/, '锚定词必须改名为关键词锚定');
assert.match(inject, />向量<\/span>[\s\S]*>重排<\/span>/, '向量和重排状态只以标签颜色表达');
assert.match(inject, /检索词典 <span class="sd-reader-inj-tag">\$\{dictPairs\.length\}<\/span><span class="sd-reader-inj-tag\$\{curBound/, '词典绑定状态必须紧跟词典数量同排显示');
assert.doesNotMatch(inject, /sd-reader-pipeline-state|召回管线可用|上次召回已降级/, '注入状态页不得再展示冗余的召回管线可用状态卡');
assert.match(source, /async function coreadWithRetry[\s\S]*attempt <= retries[\s\S]*coreadRetryableError[\s\S]*openUntil: Date\.now\(\) \+ 30000/, '检索异步阶段必须执行三次静默重试并在最终失败后短暂熔断');
assert.match(source, /status === 408 \|\| status === 429 \|\| status >= 500/, '只应重试网络、408、429 与服务端错误');
assert.match(source, /coreadPipelineFailed\('vector'[\s\S]*return bm25\.slice/, '向量最终失败必须回退 BM25 且不中断回复');
assert.match(source, /coreadPipelineFailed\('rerank'[\s\S]*已使用未重排的融合结果/, '重排最终失败必须保留融合结果');
assert.match(source, /sd-coread-notice-layer[\s\S]*document\.body\.appendChild/, '最终失败提示必须挂到 body 顶层通知层');
assert.match(css, /#sd-coread-notice-layer[^}]*z-index:\s*2147483647/, '召回失败提示必须显示在伴读中心与 ST 弹层之上');

const picker = source.slice(source.indexOf('function coreadMainlinePageData'), source.indexOf('async function coreadOpenSliceManagerDialog'));
assert.match(picker, /sd-reader-mlrow-copy[\s\S]*sd-reader-mlrow-floor[\s\S]*楼层 \$\{it\.floor\}/, '主线消息必须以正文开头和楼层号组成折叠卡');
assert.ok(picker.indexOf('${ruleField}') < picker.indexOf('sd-reader-mllist'), '文本清理规则必须放到正文楼层列表上方');
assert.match(picker, /sd-reader-mlpick-all[\s\S]*sd-reader-mlselected-count/, '主线选择页必须提供全选和已选计数');
assert.match(picker, /sd-reader-mljump-input[\s\S]*sd-reader-mljump-go/, '主线选择页必须支持输入楼层快速定位');
assert.doesNotMatch(picker, /new Popup|POPUP_TYPE|<small>高级<\/small>/, '主线选择必须是中心子页面且移除高级小字');
assert.match(css, /\.sd-reader-mlrow-sum\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:/, '正文楼层头必须使用防重叠网格布局');

assert.ok(records.indexOf('从主线选择总结') < records.indexOf('书籍蒸馏'), '从主线选择总结必须独立成卡并放在书籍蒸馏上方');

const manual = source.slice(source.indexOf("if (e.target.closest('.sd-reader-manual-go'))"), source.indexOf("if (e.target.closest('.sd-reader-compress-go'))"));
assert.match(manual, /effectiveFrom[\s\S]*effectiveTo[\s\S]*检测到重复总结/, '手动总结重叠时必须扩展完整旧区间并二次确认');
assert.match(manual, /if \(!overlaps\.length\) run\(\)/, '无重复区间时应直接执行');

console.log('Coread memory UI iteration contract OK');
