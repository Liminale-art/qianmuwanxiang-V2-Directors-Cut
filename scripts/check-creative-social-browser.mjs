// Synthetic, isolated renderer QA. No user browser, ST, provider or model access.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { CREATIVE_DETAIL_COUNTS } from '../qianmu-creative-prompts.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const css = await Promise.all(['style.css', 'qianmu-theme-skins.css']
  .map(file => readFile(new URL('../' + file, import.meta.url), 'utf8')));
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
// Exercise the production reading entry's actual social target, including the
// window's click boundary. A modal-only isolated binder hides that boundary bug.
const readingSocialBinding = /^function bindDirectorReadingEvents\(root\)\s*\{\s*(bindCreativeSocialEvents\([^\n]+;)/m.exec(indexSource)?.[1];
assert.ok(readingSocialBinding, 'production social reading binding is present');
const origin = 'https://qianmu.test';
const assets = new Set(['qianmu-creative-social.js', 'qianmu-creative-social.css', 'qianmu-storyboard-utils.js', 'qianmu-icon-renderer.js',
  'qianmu-theme-surfaces.js', 'qianmu-theme-palette.js', 'qianmu-text-collection-floor.css']);
const checks = [], failures = [], pageErrors = [], blocked = [], screenshots = [];
const check = (value, label, detail) => value ? checks.push(label) : failures.push({ label, detail });
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 393, height: 900 }, serviceWorkers: 'block' });
context.setDefaultTimeout(5000);
await context.route('**/*', async route => {
  const url = new URL(route.request().url()), file = url.pathname.slice(1);
  if (url.origin === origin && url.pathname === '/') return route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>' });
  if (url.origin === origin && assets.has(file)) return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript',
    body: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
  blocked.push(route.request().url()); return route.abort();
});
const page = await context.newPage();
page.on('pageerror', error => pageErrors.push(error.message));
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

try {
  await page.goto(origin);
  for (const content of css) await page.addStyleTag({ content });
  await page.evaluate(async ({ readingSocialBinding }) => {
    Object.assign(window, await import('/qianmu-creative-social.js'));
    window.bindActualSocialReadingRoot = new Function('root', readingSocialBinding);
    const theme = await import('/qianmu-theme-surfaces.js');
    window.samples = {
      forum: { type: 'forum', title: '桥头摸鱼办', posts: [
        { author: '卖花的周姨', handle: 'zhou_flower', time: '刚刚', content: '买了花却忘记带伞的人，可以回来躲雨。花也可以。', replies: [
          { author: '小林', content: '人已经进门了，花还在外面等快递。' }, { author: '卖花的周姨', content: '那让花也进来。今天不查购买记录。' }] },
        { author: '桥头夜班', handle: 'night_shift', time: '一刻钟前', content: '今晚桥修好了，回家的路少绕一条街。值班室那张绕行地图终于可以退役了。', replies: [
          { author: '老陈', content: '地图别扔，画得比我家那幅山水好。' }] },
        { author: '小雨', handle: 'before_rain', time: '半小时前', content: '我爸用十年没碰过的相机拍了晚霞。他说胶卷得洗出来才能给我看。\n我现在每天都在等一家不存在的照相馆营业。', replies: [
          { author: '邮差', content: '桥西那家还在。老板星期四去钓鱼，其他时候都在。' }] },
        { author: '楼下阿姨', handle: 'downstairs', time: '一小时前', content: '楼道里是谁的猫把我的鞋排成一列了？还留了个空位。', replies: [
          { author: '四楼', content: '它在等你另一只拖鞋。' }, { author: '楼下阿姨', content: '另一只在它窝里，破案了。' }, { author: '四楼', reply_to: '楼下阿姨', content: '那是它的候车室。' }] },
        { author: '旧物交换', handle: 'second_hand', time: '午后', content: '送一个没用过的花盆，有一点歪，不影响种葱。桥南自取。', replies: [
          { author: '小孟', content: '种蒜可以吗？我的葱也歪。' }] },
        { author: '阿麦', handle: 'bread_today', time: '两小时前', content: '今天最后一炉面包比平常晚半小时，来之前不用赶。', replies: [
          { author: '夜班', content: '刚下班，正好。' }, { author: '阿麦', reply_to: '夜班', content: '给你留一只热的。' }] },
        { author: '新手钓鱼', handle: 'first_cast', time: '上午', content: '一上午只钓起自己的帽子，今晚暂时不请客了。', replies: [
          { author: '桥西老张', content: '至少没空手回家。' }] },
        { author: '骑车的陈姐', handle: 'two_wheels', time: '早上', content: '河边那条小路的树荫长了，今天骑过去几乎没晒到太阳。', replies: [
          { author: '散步的人', content: '拐角有点积水，慢一点。' }, { author: '陈姐', content: '记下了，明早带雨鞋。' }] },
      ] },
      phone: { type: 'phone', title: '夜班续命互助群', owner: '林芷', conversation_kind: 'group', messages: [
        { sender: '周宁', content: '谁在茶水间留下了一只非常郑重的保温桶？', time: '21:03' },
        { sender: '林芷', content: '我。明早吃。', time: '21:03' },
        { sender: '小陈', content: '我听见这句话时已经打开了。', time: '21:04' },
        { sender: '林芷', content: '那明早你带。', time: '21:04' },
        { sender: '小陈', content: '我只是确认它是否安全。还原得很完整。', time: '21:05' },
        { sender: '周宁', content: '他把盖子装反了。', time: '21:05' },
        { sender: '林芷', content: '明早两份。', time: '21:06' },
        { sender: '小陈', content: '收到。申请把安全检查交还专业人员。', time: '21:06' },
        { sender: '周宁', content: '顺便问一下，明天有谁走河边那条路？', time: '21:07' },
        { sender: '林芷', content: '我骑车，怎么了？', time: '21:07' },
        { sender: '周宁', content: '帮我看看花店开没开，我想下班买一束。', time: '21:08' },
        { sender: '林芷', content: '好，路过给你拍一下门口牌子。', time: '21:08' },
      ] },
    };
    samples.moments = { type: 'phone', view_type: 'moments', owner: '林芷', title: '朋友圈', posts: [
      { author: '周宁', display_name: '周宁', time: '刚刚', content: '妈把阳台那盆栀子养开了。特意打电话让我听一听，差点以为花也会讲话。', likes: 12, replies: [{ author: '林芷', content: '先替我闻一下。' }, { author: '周宁', reply_to: '林芷', content: '她说周末来吃饭，自己闻。' }] },
      { author: '阿麦', display_name: '阿麦 · 面包店', time: '二十分钟前', content: '试了三次，终于没把吐司的边烤硬。留了一条给夜班的人，别走错后门。', likes: 8, replies: [{ author: '小陈', content: '已经绕到前门了，这就折回去。' }] },
      { author: '陈姐', time: '一小时前', content: '车修好了，明早重新骑河边那条路。停骑一周，突然很想念那段没人的树荫。', likes: 6, replies: [] },
      { author: '林芷', time: '午后', content: '抽屉终于清出来了。一半是空笔芯，另一半是觉得总有一天会有用的票根。', likes: 9, replies: [{ author: '周宁', content: '那张轮渡票留着，下次认路靠它。' }] },
      { author: '许老师', time: '三小时前', content: '今日练字作业，最后一个字写坏了。不补，明天再来。', likes: 15, replies: [] },
      { author: '老陈', time: '早上', content: '晒好的被子收进来，屋里都是太阳味。今天就不出远门了。', likes: 4, replies: [{ author: '陈姐', content: '爸，菜我下班顺路带。' }] },
    ] };
    samples.microblog = { type: 'phone', view_type: 'microblog', owner: '林芷', title: '沿途', posts: [
      { author: '路边观察员', display_name: '路边观察员', handle: 'street_notes', time: '刚刚', content: '那座旧桥修了两个月，今天围挡终于撤了。最先过去的是一位推着空菜车的阿姨，比剪彩还郑重。', likes: 38, replies: [{ author: '桥南散步', handle: 'walk_south', content: '这下每天能少绕十五分钟。' }, { author: '路边观察员', reply_to: '桥南散步', content: '桥头的早餐摊也回来了。' }] },
      { author: '听雨的人', display_name: '听雨的人', handle: 'rain_radio', time: '十八分钟前', content: '整理旧录音时听见车站的报站声。有些地方已经改了名字，耳朵还留在原来的站台。', likes: 21, replies: [{ author: '旧城声音档案', handle: 'city_tapes', content: '愿意的话可以把年份写下来，很多人正在找那一版报站。' }] },
      { author: '慢慢做饭', handle: 'slow_kitchen', time: '四十分钟前', content: '番茄炒蛋到底先炒谁，我家已经争论三代了。今天决定点外卖，暂停历史问题。', likes: 106, replies: [] },
      { author: '野外笔记', handle: 'field_notes', time: '一小时前', content: '河岸新来的小鸟不是迷路，只是在等风停。观察记录里最常用的一句话：今天先别急着解释。', likes: 57, replies: [{ author: '窗边', content: '这句话也适合留给自己。' }] },
      { author: '末班车窗', handle: 'last_window', time: '两小时前', content: '司机今晚多等了几秒，让抱着一捆花的人上了车。整辆车突然有了很轻的香气。', likes: 19, replies: [] },
      { author: '纸上小店', handle: 'paper_shop', time: '午后', content: '收到了读者寄回来的书签，背面写着另一种结尾。暂时夹回书里，让两种结尾一起住着。', likes: 42, replies: [{ author: '阿页', content: '我也喜欢那种不急着说完的故事。' }] },
    ] };
    window.mount = (kind, themeName, mode = 'light') => {
      window.surface?.dispose();
      document.body.innerHTML = `<button id="host-control" style="font:17px serif;background:rgb(30,40,50);color:rgb(220,230,240)">宿主</button>
        <div id="story-director-modal" class="sd-theme-${mode} open"><div class="sd-backdrop"></div><section class="sd-window" role="dialog" aria-label="千幕">
        <header class="sd-header"><div class="sd-titlebox"><h2>千幕</h2></div></header>
        <main class="sd-body">${renderCreativeSocialCard(samples[kind])}</main></section></div>`;
      const root = document.getElementById('story-director-modal');
      root.querySelector('.sd-window').addEventListener('click', event => event.stopPropagation());
      window.surface = theme.createQianmuThemeSurfaceController(); surface.register(root);
      surface.setTheme(themeName === 'classic' ? null : { theme: themeName, mode, accent: '#4a618f' });
      bindActualSocialReadingRoot(root); bindActualSocialReadingRoot(root);
    };
  }, { readingSocialBinding });

  for (const width of [320, 393, 1440]) for (const theme of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) for (const kind of ['forum', 'phone', 'moments', 'microblog']) {
    const label = `${theme}/${mode}/${width}/${kind}`;
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(({ theme, kind, mode }) => { resetCreativeSocialState(); mount(kind, theme, mode); }, { theme, kind, mode });
    await frame();
    const layout = await page.evaluate(() => {
      const root = document.getElementById('story-director-modal'), win = root.querySelector('.sd-window'), box = win.getBoundingClientRect();
      const overflow = [...root.querySelectorAll('.sd-body,.sd-creative-social,.sd-social-panel,.sd-social-post,.sd-social-message-main')]
        .filter(node => node.getClientRects().length && getComputedStyle(node).display !== 'none')
        .map(node => ({ className: node.className, delta: node.scrollWidth - node.clientWidth, box: node.getBoundingClientRect().toJSON() }))
        .filter(node => node.delta > 2 || node.box.left < box.left - 2 || node.box.right > box.right + 2);
      const hostStyle = getComputedStyle(document.getElementById('host-control'));
      const expected = getComputedStyle(root).getPropertyValue('--qm-type-body').trim();
      const paragraphs = [...root.querySelectorAll('.sd-social-post-content,.sd-social-message-main p')].map(node => getComputedStyle(node).fontSize);
      return { overflow, pageOverflow: document.documentElement.scrollWidth - innerWidth, windowInside: box.left >= -1 && box.right <= innerWidth + 1,
        expected, paragraphs, host: [hostStyle.fontSize, hostStyle.fontFamily, hostStyle.color, hostStyle.backgroundColor],
        title: root.querySelector('.sd-section-title h3').textContent,
        outgoing: root.querySelectorAll('form,textarea,input,[contenteditable],a').length };
    });
    check(layout.overflow.length === 0 && layout.pageOverflow <= 2 && layout.windowInside, `${label}: no overflow`, layout);
    check(layout.paragraphs.length > 0 && layout.paragraphs.every(size => size === layout.expected), `${label}: shared body scale`, layout);
    check(JSON.stringify(layout.host) === JSON.stringify(['17px', 'serif', 'rgb(220, 230, 240)', 'rgb(30, 40, 50)']), `${label}: host unchanged`, layout);
    check(layout.title === '幕间拾趣' && layout.outgoing === 0, `${label}: fictional reading panel has no sending or navigation`, layout);
    check(await page.locator('.sd-section-title > span').count() === 0, `${label}: no superfluous corner caption`);
    const viewport = await page.locator('[data-qm-social-scroll]').evaluate(node => ({
      height: node.getBoundingClientRect().height, overflow: getComputedStyle(node).overflowY,
      overscroll: getComputedStyle(node).overscrollBehaviorY,
      focusable: node.tabIndex, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
    }));
    check(viewport.height <= Math.min(900 * .58, 520) + 1 && viewport.overflow === 'auto' && viewport.overscroll === 'auto' && viewport.focusable === 0,
      `${label}: panel content has responsive bounded accessible scrolling`, viewport);

    if (kind !== 'phone') {
      check(await page.locator('.sd-social-post').count() === (kind === 'forum' ? CREATIVE_DETAIL_COUNTS.forumPosts.min : 6),
        `${label}: every requested post is retained in the bounded feed`);
      const like = page.locator('[data-qm-social-action="like"]').first();
      const initial = await like.evaluate(node => [getComputedStyle(node).backgroundColor, getComputedStyle(node).borderColor]);
      await like.focus(); await page.keyboard.press('Enter');
      check(await like.getAttribute('aria-pressed') === 'true' && await like.locator('span').textContent() === (kind === 'forum' ? '已赞' : kind === 'moments' ? '已赞 13' : '已赞 39'), `${label}: keyboard like once despite repeat binding`);
      const selected = await like.evaluate(node => [getComputedStyle(node).backgroundColor, getComputedStyle(node).borderColor]);
      check(JSON.stringify(initial) !== JSON.stringify(selected), `${label}: visible selected state`);
      await like.click(); check(await like.getAttribute('aria-pressed') === 'false', `${label}: like toggles off`);
      check(await page.locator('[data-qm-social-action="bookmark"]').count() === 0, `${label}: collection action removed`);
      const replies = page.locator('[data-qm-social-action="replies"]').first();
      await replies.click(); check(await replies.getAttribute('aria-expanded') === 'true' && await page.locator('.sd-social-replies').first().isVisible(), `${label}: reply list opens`);
      await page.evaluate(({ theme, kind, mode }) => mount(kind, theme, mode), { theme, kind, mode });
      check(await page.locator('[data-qm-social-action="bookmark"]').count() === 0
        && await page.locator('[data-qm-social-action="replies"]').first().getAttribute('aria-expanded') === 'true', `${label}: remount keeps local choices`);
      await page.locator('[data-qm-social-action="replies"]').first().click();
      check(!await page.locator('.sd-social-replies').first().isVisible(), `${label}: replies close`);
      if (kind !== 'forum') {
        check(await page.locator(`.sd-social-phone-${kind}`).count() === 1 && await page.locator('.sd-social-messages,[role="tablist"],[role="tab"],img').count() === 0,
          `${label}: one phone view without navigation, chat duplication or image placeholders`);
        check(await page.locator('.sd-social-phone-author > span').count() === (kind === 'microblog' ? 6 : 0), `${label}: public handles distinguish short posts from familiar names`);
        const top = await page.locator('[data-qm-social-scroll]').evaluate(node => { node.scrollTop = 200; node.dispatchEvent(new Event('scroll')); return node.scrollTop; });
        await page.evaluate(({ theme, kind, mode }) => mount(kind, theme, mode), { theme, kind, mode });
        check(top > 0 && Math.abs(await page.locator('[data-qm-social-scroll]').evaluate(node => node.scrollTop) - top) <= 1, `${label}: phone feed reading position survives remount`);
        await page.locator('[data-qm-social-scroll]').evaluate(node => { node.scrollTop = 0; });
      }
    } else {
      check(await page.locator('.sd-social-message:visible').count() === CREATIVE_DETAIL_COUNTS.phoneMessages.min && await page.locator('.sd-social-expand').count() === 0,
        `${label}: all messages available without a second expand control`);
      const messages = page.locator('.sd-social-messages');
      await messages.focus(); await page.keyboard.press('End');
      await frame();
      const scrollTop = await messages.evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); return node.scrollTop; });
      check(scrollTop > 0, `${label}: long conversation scrolls inside panel`);
      await page.evaluate(({ theme, mode }) => mount('phone', theme, mode), { theme, mode });
      check(Math.abs(await messages.evaluate(node => node.scrollTop) - scrollTop) <= 1, `${label}: remount retains reading position`);
      await messages.evaluate(node => { node.scrollTop = 0; }); await frame();
    }
    if (process.env.QIANMU_SOCIAL_QA_DIR && width === 393 && theme === 'glass') {
      await mkdir(process.env.QIANMU_SOCIAL_QA_DIR, { recursive: true });
      await page.locator('.sd-body').evaluate(node => { node.scrollTop = 0; });
      if (kind === 'moments' || kind === 'microblog') await page.locator('[data-qm-social-action="replies"]').first().click();
      const path = join(process.env.QIANMU_SOCIAL_QA_DIR, `social_${theme}_${mode}_${kind}_${width}.png`);
      await page.screenshot({ path }); screenshots.push(path);
    }
  }

  await page.setViewportSize({ width: 393, height: 640 });
  await page.evaluate(() => {
    // Longer examples deliberately exceed the retired 12-post / 20-message
    // quotas. Generation now has only a floor; these are not upper limits.
    samples.longForum = { ...samples.forum, posts: Array.from({ length: 13 }, (_, index) => ({ ...samples.forum.posts[index % samples.forum.posts.length], content: `${index + 1}：${samples.forum.posts[index % samples.forum.posts.length].content.repeat(3)}` })) };
    samples.longPhone = { ...samples.phone, messages: Array.from({ length: 21 }, (_, index) => ({ ...samples.phone.messages[index % samples.phone.messages.length], time: `22:${String(index).padStart(2, '0')}` })) };
    resetCreativeSocialState(); mount('longForum', 'editorial');
  });
  const longFeed = page.locator('.sd-social-feed');
  const longScroll = await longFeed.evaluate(node => {
    node.scrollTop = 300; node.dispatchEvent(new Event('scroll'));
    return { top: node.scrollTop, height: node.getBoundingClientRect().height, canScroll: node.scrollHeight > node.clientHeight };
  });
  check(longScroll.top > 0 && longScroll.canScroll && longScroll.height <= 640 * .58 + 1, 'long forum feed scrolls within a short viewport', longScroll);
  check(await page.locator('.sd-social-post').count() === 13, 'longer 13-post forum renders without truncation');
  await longFeed.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const lastPostInside = await page.locator('.sd-social-post').last().evaluate(node => {
    const box = node.getBoundingClientRect(), viewport = node.closest('[data-qm-social-scroll]').getBoundingClientRect();
    return box.bottom <= viewport.bottom + 2 && box.bottom > viewport.top;
  });
  check(lastPostInside, 'last post of longer forum remains reachable');
  await longFeed.evaluate((node, top) => { node.scrollTop = top; node.dispatchEvent(new Event('scroll')); }, longScroll.top);
  await page.evaluate(() => mount('longForum', 'glass'));
  check(Math.abs(await longFeed.evaluate(node => node.scrollTop) - longScroll.top) <= 1, 'theme changes preserve forum reading position');
  await page.evaluate(() => { resetCreativeSocialState(); mount('longForum', 'glass'); });
  check(await longFeed.evaluate(node => node.scrollTop) === 0, 'reset clears remembered feed position');

  await page.evaluate(() => { resetCreativeSocialState(); mount('longPhone', 'glass'); });
  check(await page.locator('.sd-social-message').count() === 21, 'longer 21-message phone renders without truncation');
  const lastMessageInside = await page.locator('.sd-social-messages').evaluate(node => {
    node.scrollTop = node.scrollHeight;
    const box = node.lastElementChild.getBoundingClientRect(), viewport = node.getBoundingClientRect();
    return box.bottom <= viewport.bottom + 2 && box.bottom > viewport.top && node.scrollWidth <= node.clientWidth + 2;
  });
  check(lastMessageInside, 'last message of longer phone remains reachable without horizontal overflow');

  const edges = await page.evaluate(() => {
    const root = document.getElementById('story-director-modal');
    samples.attack = { type: 'forum', title: '<img src="https://outside.test/avatar" onerror="alert(1)">', posts: [{ author: '<script>x</script>', content: '<a href="https://outside.test">open</a>' + 'unbroken'.repeat(200), replies: [] }] };
    mount('attack', 'glass');
    const card = document.querySelector('.sd-creative-social');
    return { blockedMarkup: card.querySelectorAll('script,img,a').length === 0,
      visibleText: card.textContent.includes('<img src='), controls: card.querySelectorAll('button').length,
      fits: card.scrollWidth - card.clientWidth <= 2 };
  });
  check(edges.blockedMarkup && edges.visibleText, 'all model HTML/URLs are text only', edges);
  check(edges.fits && edges.controls === 2, 'long unbroken content wraps in structured feed', edges);

  for (const kind of ['moments', 'microblog']) {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.evaluate(kind => {
      const long = '很长的称呼与说明'.repeat(8), injection = '<img src="https://outside.test/avatar">';
      samples.feedBoundary = { ...samples[kind], owner: long, title: long, posts: [
        { author: long, display_name: long, handle: 'unbroken'.repeat(30), time: long, content: injection + 'unbroken'.repeat(80), replies: [{ author: long, content: '完整评论'.repeat(40), reply_to: long }] },
        ...samples[kind].posts,
      ] };
      resetCreativeSocialState(); mount('feedBoundary', 'editorial', 'dark');
    }, kind);
    await page.locator('[data-qm-social-action="replies"]').first().click();
    const boundary = await page.evaluate(() => {
      const card = document.querySelector('.sd-creative-social'), scroll = card.querySelector('[data-qm-social-scroll]');
      scroll.scrollTop = scroll.scrollHeight;
      const last = scroll.lastElementChild.getBoundingClientRect(), box = scroll.getBoundingClientRect();
      return { fits: [...card.querySelectorAll('.sd-social-phone-post-main,.sd-social-feed-reply,.sd-social-phone-author')].every(node => node.scrollWidth <= node.clientWidth + 2),
        lastReachable: last.bottom <= box.bottom + 2 && last.bottom > box.top,
        bounded: scroll.clientHeight <= 568 * .58 + 2, noMarkup: !card.querySelector('img,a,script'), posts: card.querySelectorAll('.sd-social-post').length };
    });
    check(boundary.fits && boundary.lastReachable && boundary.bounded && boundary.noMarkup && boundary.posts === 7, `${kind}: long fields, expanded comments and final post remain readable in a short narrow viewport`, boundary);
  }

  await page.evaluate(() => { resetCreativeSocialState(); mount('forum', 'editorial'); });
  await page.locator('[data-qm-social-action="like"]').first().click();
  await page.evaluate(() => mount('forum', 'glass'));
  check(await page.locator('[data-qm-social-action="like"]').first().getAttribute('aria-pressed') === 'true', 'theme changes retain current-result local reaction');
  await page.evaluate(() => { resetCreativeSocialState(); mount('forum', 'glass'); });
  check(await page.locator('[data-qm-social-action="like"]').first().getAttribute('aria-pressed') === 'false', 'new result/chat reset clears local reactions');
  await page.evaluate(() => bindActualSocialReadingRoot(document.querySelector('.sd-body')));
  await page.locator('[data-qm-social-action="like"]').first().click();
  check(await page.locator('[data-qm-social-action="like"]').first().getAttribute('aria-pressed') === 'true', 'stream-host nested in a bound modal handles click once');
  check(await page.locator('[data-qm-social-action="like"]').first().locator('svg').count() === 1, 'reaction retains icon markup while updating only its label');
  check(pageErrors.length === 0, 'no page errors', pageErrors);
  check(blocked.length === 0, 'no unlisted or external requests', blocked);
  console.log(JSON.stringify({ passed: checks.length, failures, screenshots, pageErrors, blocked,
    scope: 'isolated synthetic renderer and real theme CSS; no deployment or model-quality claim' }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally { await context.close(); await browser.close(); }
