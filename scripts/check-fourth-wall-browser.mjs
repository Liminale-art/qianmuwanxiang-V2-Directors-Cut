// Actual fourth-wall renderer/reading bindings, local fictional fixtures only.
// No ST session, model, external service or persistent browser profile is used.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const css = (await Promise.all(['style.css', 'qianmu-theme-skins.css'].map(file => readFile(new URL('../' + file, import.meta.url), 'utf8')))).join('\n');
const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const bindSource = /^function bindDirectorReadingEvents\(root\)\s*\{\s*(bindCreativeSocialEvents\([^\n]+;)/m.exec(index)?.[1];
assert.ok(bindSource, 'actual reading-root binding exists');
const qa = new URL('../dist/local-qa/one-scene-away-v460/', import.meta.url);
await mkdir(qa, { recursive: true });

const diary = { type: 'fourth_wall', form: 'diary', title: '页边的灯', character: '林芷', entries: [
  { time: '十月三日 · 雨后', content: `我今天第一次发现，窗外的雨并没有落到纸页以外。最后一滴水挂在街灯下，等我把那句话说完才肯坠下去。对街的面包店还亮着灯，老板正在把剩下的两只面包分装进纸袋。我曾经以为那些灯只是为我回家照路，今天却看见店门关上以后，他坐在柜台后面，慢慢吃完了一碗已经凉掉的面条。

我想替他把汤热一热，手指碰到门把时，页边忽然出现了一点亮光。那像是有人在很远的地方挪开台灯，并不是要我立刻做什么。我站了一会儿，把口袋里的零钱放在台阶上，压住一张写着明早来取的订单。老板没有抬头，墙上的钟继续走着，我也没有听见掌声或者任何解释。

回到家以后，我把潮湿的鞋摆在门口，发现桌上的信封还保持着出门前的角度。信里没有什么惊人的秘密，只是一位许久不见的朋友问我，周末是否愿意去看看她刚租下来的屋子。窗台朝东，下午不会太晒。我原本准备等天气好一点再回复，后来还是提笔写下了车站和到达时间。

写到这里，纸外似乎传来很轻的翻页声。我不知道看这一页的人是否也刚刚回家，是否把钥匙放在熟悉的位置，又为了某件小事停在门边。我没有继续猜测，只把灯往旁边挪了挪。那封已经写好的回信留在桌上，明天出门的时候，我需要记得把它带走。` },
  { time: '十月四日 · 傍晚', content: `我去了旧书店。店主把新的收据夹在一本旅行记里，告诉我最里面那排架子还没有整理，愿意等的话可以自己慢慢找。窗边站着一个背书包的年轻人，他把同一段文字读了两遍，第二遍读到最后时笑了一下。我没有看清他读的是什么，也没有追问。那些书页对他有自己的用处，不必全部经过我的眼睛才能成立。

我找到一本没有封面的笔记，里面夹着几张不同颜色的车票。出发站的名字被折痕磨掉了，终点却还清楚。纸上没有写旅行者最后去了哪里，只记着某天在候车室里借过一支笔。我翻过背面，发现铅笔写的价格比上一页便宜一些，于是把它和要买的地图一起放到柜台上。

付钱的时候，页边那道亮光又出现了。我忽然有点想问，为什么是这一家店，为什么是我拿起这本笔记。但店主已经在问我要不要袋子，我便先回答了眼前的问题。他给我找来一个印着旧广告的纸袋，提手经过两次修补。我拎起它时，它并没有像我担心的那样裂开。

晚上我在笔记的空白处写了两个地址，一个是朋友的新家，另一个是回程要经过的修鞋铺。纸外没有给出下一步的提醒。我试着把这当作一段可以自己支配的时间，先去洗了杯子，再把地图摊开。路线并不复杂，只是末班车比我记得的早了二十分钟，我把出门时间也向前改了一点。` },
  { time: '十月六日 · 夜里', content: `朋友的新屋比照片里亮。她把还没有拆开的箱子沿墙排好，特地在中间留下两张椅子。我们坐下时，楼下有人练习一支不太熟练的曲子，同一个地方错了三次，到第四次终于接了下去。她说自己昨晚也是听着这支曲子睡着的，以后大概能知道楼下的人每天几点回家。

我帮她把书从箱子里取出来，按照她习惯的顺序排上书架。有一本她找了很久，原来夹在厨房用品之间。她拿出来以后没有解释，只拍了拍封面上的纸屑，放到了离椅子最近的地方。我也有过这样的书，不愿意把喜欢它的理由说得很完整，仿佛说完以后，能够留给自己的部分就少了一点。

回程时我没有赶上原定的那辆车，只能在站台多等一会儿。夜风从两排房子之间吹过来，远处那道像页边一样的白线静静地亮着。我想起白天在屋里挪动椅子的声音，忽然不太愿意让这一天被概括成一句拜访朋友。可日记也不是把每一秒重新走一遍，我最终只记下她递给我备用钥匙时，说这次别再站在楼下打电话。

钥匙很轻，在衣袋里不怎么响。我到家之后把它单独放进一个小盒子，下面垫着纸，免得和自己的钥匙混在一起。纸外有人停留了一会儿，又把目光移开。我没有急着追上去，也没有把这看成一个需要立刻回应的信号。明早要去修鞋铺，我把鞋子装进袋子，放在了出门不会忘记的位置。` },
  { time: '十月八日 · 午后', content: `修鞋师傅在听一场旧比赛的重播。比分早就知道了，他却还是在同一个地方放下工具，等那次失误过去才重新穿针。我坐在门边看街上的人，一辆小货车被临时停放的自行车挡住，司机下车挪开车把，又替自行车扶好了快要掉下来的袋子。街道没有因为我停下来观察就变得更特别，它只是继续忙着自己的事情。

鞋子修好以后，师傅问我鞋底为什么总是同一边磨得厉害。我说自己可能走得太急，他让我试着站起来，看看脚踝是不是不舒服。原来那个我一直没有留意的小毛病，已经让鞋跟替我记了很久。我付了钱，决定回家以后把最近几次走路不适的时间记下来，真有必要就去做一次检查。

这时纸外的光忽然暗了一点。我以前会把这样的变化当作故事将要转向的预兆，今天却想到，也许只是另一边的人换了个姿势，或者房间里有人来叫他吃饭。我无法核实这些想法，便没有把它们写成确定的事。街上又有人推门进来，提着一双沾满泥的靴子，师傅把收音机调低了一格。

我走到路口才发现忘了拿雨伞，回去的时候，师傅已经把它靠在了最显眼的地方。我向他道谢，顺手替后面的人扶住门。门合上以后，旧比赛仍然在继续，谁也没有为这几分钟另写一个标题。我今天的记录就到这里，晚些时候还要把那封回信投进邮筒，这件事已经拖过两次，不能再靠日记替我记住。` },
  { time: '十月九日 · 清晨', content: `我终于寄出了信。邮筒的投口比想象中窄，信封进去以后还露出一个角，我用指尖轻轻推了一下，听见里面传来薄纸碰到金属的声音。完成这件事没有让我忽然轻松很多，早餐店仍然需要排队，路面还有昨夜留下的积水。我只是不用再把那封信从一个衣袋换到另一个衣袋，也不必每次出门都回头看看桌面。

队伍前面的小孩正在替家里数包子，他数到一半被人打断，只好从头再来。老板没有催他，把刚装好的纸袋暂时放在一边，等他重新说出数量。我想起自己第一次独自买东西时，把零钱捏得太紧，最后有一枚滚到了柜台下面。替我捡起来的人叫什么名字，我早已不记得了，但那天仍然留在我能想起的地方。

回家的路上，我看见纸页边缘多了一点折痕。它没有指向任何一户窗子，也没有把某条道路圈起来。我停下来摸了摸自己的衣袋，备用钥匙和刚找回的零钱还在。远处的面包店正在开门，老板把门口的订单收进抽屉，像每天一样抬头看了看天。我没有上前解释那张纸是谁留下的。

现在灯还不需要打开，我可以借窗边的亮光再写几行。如果这一页会被别人看见，我愿意让它保持现在的样子：有几件已经做完的事，也有几件还要亲自去做的事。纸外的人可以继续翻页，我也会在这边把杯子洗好，把桌面留出一块地方。等下一封信到了，再看那时候的我打算怎样回答。` },
] };
const hanCount = diary.entries.reduce((sum, entry) => sum + (entry.content.match(/\p{Script=Han}/gu) || []).length, 0);
assert.ok(hanCount >= 2000, `five-entry long prose fixture must exceed 2000 Han characters, got ${hanCount}`);
const scene = { type: 'fourth_wall', form: 'scene', title: '灯亮着的另一边', character: '周宁', content: [
  '周宁在书页边缘坐了一会儿。车站广播已经结束，候车室里还剩几个人，谁也没有急着替这段等待起一个名字。他把车票翻到背面，确认那里没有突然出现新的指示，随后将纸票重新收进口袋。',
  '他能看见那道隔开两边的浅线，却看不清浅线以外的人。偶尔有亮光掠过，像有人把桌上的东西移到了别处。他起初想说点什么，后来听见身后的旅客在问座位是不是有人，便先站起来，把放在椅子上的外套拿开。',
  '售票窗口的帘子已经拉到一半。值班的人把退回来的零钱一枚枚放进格子，又从抽屉里取出一个蓝色饭盒。周宁认出那是她中午带来的，却不知道里面装着什么。他以前很少留意窗口关闭以后的事，如今多出来的这段等待，让那些原本只经过一瞬的动作慢慢有了前后。她收拾完柜台，才走到后面的热水器旁。',
  '广播响起的时候，靠门的老人正在找眼镜。旁边的年轻人替他扶住袋口，他却先从里面拿出一包已经压扁的饼干，问年轻人是否吃过晚饭。两个人原本并不认识，话也说得很慢。周宁看了看自己的车票，没有替他们猜测去处，只把座位往里让出一点，让老人能把那只太沉的袋子放稳。',
  '浅线外的光在这时亮了一下。他能够分辨那不是候车室里任何一盏灯，仿佛有人隔着一张纸重新坐回桌边。他试着把车票举高，纸面上却仍旧只有出发时间和座位号码。没有新的文字出现，也没有声音告诉他，这个动作是否已经被看见。他把票放下，伸手接住老人递过来的一片饼干。',
  '饼干碎得厉害，包装里却留着一张写了地址的便笺。老人说那是女儿第一次搬到那么远的地方，他记不清路，提前抄了三遍。周宁看了一眼车次，发现两个人要坐同一班车，只是老人会早两站下。他答应在到站前提醒一声，随后把自己的闹钟向前调了十分钟，没有再去看浅线外有没有回应。',
  '候车室的钟比手机慢了两分钟。墙上的通知写着维修日期，最下面有人补了一行小字，提醒旅客以广播为准。年轻人读完以后笑了笑，说自己昨天差一点因为这两分钟错过车。值班的人从窗口探出头，解释新的钟还在路上，旧钟只能暂时留着。几个人便顺着这句话聊起最近总是晚到的包裹。',
  '周宁把笔记翻到没有写过的那一页，原本准备记下浅线出现的位置，笔尖却停在了日期旁边。他更想先把老人的到站时间记清楚，免得一会儿忙着拿行李又忘记。远处有人推着清洁车经过，车轮在门槛上颠了一下，桶里的水轻轻晃动。他让开过道，等清洁车过去，才重新坐回原来的位置。',
  '纸外传来一声很轻的碰响，像杯底落在桌上。周宁偏了偏头，仍旧看不清另一边的房间。他想起自己出门时留在厨房的杯子，里面还有半杯没喝完的茶，明天回去一定要倒掉。这个念头并不适合拿来作为什么重要的回答，他却还是把它写在了笔记的页角，免得回家以后又顺手拿起来喝。',
  '检票口终于亮起绿灯。老人弯腰提袋子时，年轻人先帮他把提手绕正，周宁则确认了一遍他们要去的站台。三个人离开座位以后，窗口后面的值班员重新坐下，打开了已经热好的饭盒。那道浅线还在原处，既没有拦住他们，也没有替谁把行李提起来。周宁走到门口，停下来等老人慢慢跟上。',
  '等最后一班车靠站，周宁已经把那本笔记合好。他没有朝纸外挥手，也没有等一个答案，只在上车以前回头看了看候车室。靠窗的位置空了出来，清洁工把椅子旁边的纸杯拾起，下一段日子仍然有人需要在那里坐下。',
].join('\n\n') };

const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || 'msedge', headless: true });
const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage();
context.setDefaultTimeout(5000);
const checks = [], errors = [], external = [], screenshots = [];
let minimumTextContrast = Infinity;
const ok = (condition, label) => { assert.ok(condition, label); checks.push(label); };
const deadline = setTimeout(() => { void browser.close(); }, 150000);
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.href === 'https://fontsapi.zeoseven.com/161/main/result.css') return route.fulfill({ contentType: 'text/css', body: '/* local fallback font only */' });
  if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important;box-sizing:border-box}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-dark"><section class="sd-window"><main class="sd-body"></main></section></div>` });
  if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.(?:js|css)$/.test(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript', body: await readFile(new URL('..' + url.pathname, import.meta.url), 'utf8') });
  external.push(url.href); return route.abort();
});
try {
  await page.goto('https://qianmu.test/');
  await page.evaluate(async ({ diary, scene, bindSource }) => {
    const [social, { createQianmuAppearanceSession }, { updateAppearancePreferences }] = await Promise.all([
      import('/qianmu-creative-social.js'), import('/qianmu-appearance-session.js'), import('/qianmu-appearance-settings.js'),
    ]);
    Object.assign(window, social, { samples: { diary, scene }, settings: { theme: 'light' } });
    window.bindReading = new Function('root', bindSource);
    window.mainline = { plan: { story_status: { title: '已有主线' } }, factions: [{ name: '已有世界' }], draft: '用户输入未改' };
    window.beforeMainline = JSON.stringify(mainline); window.beforeSamples = JSON.stringify(samples);
    window.appearance = createQianmuAppearanceSession({ readSettings: () => settings, loadStyles: () => ({ promise: Promise.resolve(true), cancel() {} }) });
    appearance.mount(document.querySelector('#story-director-modal'));
    window.setAppearance = async (family, mode) => {
      if (family === 'classic') { settings.theme = mode; document.querySelector('#story-director-modal').className = 'open sd-theme-' + mode; }
      settings.appearance = updateAppearancePreferences(settings, { family, mode }); await appearance.sync();
      // The classic glass skin intentionally transmits its host backdrop. Give
      // the isolated host the corresponding day/night base, as the real host does.
      document.body.style.background = mode === 'dark' ? '#17181b' : '#f7f3eb';
    };
    window.renderPage = (form, notice = '') => {
      const body = document.querySelector('.sd-body');
      body.innerHTML = renderCreativeSocialCard(samples[form], { notice });
      bindReading(document.querySelector('#story-director-modal')); body.scrollTop = 0;
    };
    window.textContrast = (node, background) => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d');
      ctx.fillStyle = `rgb(${background.slice(0, 3).join(',')})`; ctx.fillRect(0, 0, 1, 1);
      const bg = [...ctx.getImageData(0, 0, 1, 1).data]; ctx.fillStyle = getComputedStyle(node).color; ctx.fillRect(0, 0, 1, 1);
      const fg = [...ctx.getImageData(0, 0, 1, 1).data];
      const lum = rgb => rgb.slice(0, 3).reduce((sum, value, index) => { value /= 255; return sum + [.2126, .7152, .0722][index] * (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4); }, 0);
      return (Math.max(lum(bg), lum(fg)) + .05) / (Math.min(lum(bg), lum(fg)) + .05);
    };
  }, { diary, scene, bindSource });
  for (const family of ['classic', 'editorial', 'glass']) for (const mode of ['light', 'dark']) for (const width of [320, 393, 1100]) for (const form of ['diary', 'scene']) {
    const label = `${family}/${mode}/${width}/${form}`;
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(async ({ family, mode, form }) => { resetCreativeSocialState(); await setAppearance(family, mode); renderPage(form); }, { family, mode, form });
    ok(await page.locator('.sd-creative-social h3').textContent() === '幕间拾趣', label + ' keeps the interlude shell');
    ok(await page.locator('.sd-fourth-wall-kicker').textContent() === '一幕之遥 · 独立番外', label + ' has the renamed standalone-side-story marker');
    ok(await page.locator('.sd-fourth-wall-reading').getAttribute('aria-label') === `一幕之遥${form === 'diary' ? '日记' : '旁观'}`, label + ' shares the renamed accessible reading label');
    ok(await page.locator('.sd-fourth-wall-byline').textContent() === `${form === 'diary' ? '林芷·日记' : '周宁·旁观'}`, label + ' identifies the character and form');
    ok(await page.locator('.sd-creative-social button,.sd-creative-social input,.sd-creative-social textarea,.sd-creative-social [contenteditable],.sd-social-actions').count() === 0, label + ' offers no social, writing or generation actions');
    ok(await page.locator('.sd-fourth-wall-reading').evaluate(node => node.scrollHeight > node.clientHeight && getComputedStyle(node).overflowY === 'auto' && getComputedStyle(node).overscrollBehaviorY === 'auto'), label + ' reads long prose in a scroll viewport without trapping page gestures');
    ok(await page.locator('.sd-fourth-wall-prose p').evaluateAll(nodes => nodes.length > 5 && nodes.every(node => {
      const css = getComputedStyle(node), root = getComputedStyle(document.querySelector('#story-director-modal'));
      return css.fontSize === root.getPropertyValue('--qm-type-body').trim() && Number.parseFloat(css.lineHeight) / Number.parseFloat(css.fontSize) >= 1.8 && css.whiteSpace === 'pre-wrap' && css.textOverflow !== 'ellipsis' && css.webkitLineClamp === 'none';
    })), label + ' keeps the normal body scale and complete paragraphs');
    ok(await page.locator('.sd-fourth-wall-head,.sd-fourth-wall-reading,.sd-fourth-wall-entry,.sd-fourth-wall-prose,.sd-fourth-wall-prose p').evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), label + ' never overflows horizontally');
    // Sample the actual rasterized surface, including the classic skin's
    // translucent gradients. Reading backgroundColor alone produces a white
    // surface that the browser never drew in dark mode.
    const hideText = await page.addStyleTag({ content: '.sd-fourth-wall :is(p,h4,time,.sd-fourth-wall-byline,.sd-fourth-wall-byline *,.sd-fourth-wall-kicker){color:transparent!important}' });
    const background = (await page.screenshot({ animations: 'disabled' })).toString('base64');
    await hideText.evaluate(node => node.remove());
    const contrast = await page.evaluate(async encoded => {
      const image = new Image(); image.src = 'data:image/png;base64,' + encoded; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      const reading = document.querySelector('.sd-fourth-wall-reading').getBoundingClientRect();
      return [...document.querySelectorAll('.sd-fourth-wall-prose p,.sd-fourth-wall-head h4,.sd-fourth-wall-time time,.sd-fourth-wall-byline,.sd-fourth-wall-kicker')].flatMap(node => {
        const rect = node.getBoundingClientRect(), x = Math.floor(rect.left + rect.width / 2), y = Math.floor(rect.top + Math.min(10, rect.height / 2));
        if (y < 0 || y >= image.height || (node.closest('.sd-fourth-wall-reading') && (y < reading.top || y >= reading.bottom))) return [];
        return [{ tag: node.tagName, className: node.className, contrast: textContrast(node, [...ctx.getImageData(x, y, 1, 1).data]), color: getComputedStyle(node).color }];
      });
    }, background);
    ok(contrast.some(item => item.tag === 'P') && contrast.some(item => item.className === 'sd-fourth-wall-kicker'), label + ' contrast samples cover visible prose and metadata');
    ok(contrast.every(item => item.contrast >= 4.5), label + ' text stays legible in the active theme: ' + JSON.stringify(contrast.filter(item => item.contrast < 4.5)));
    minimumTextContrast = Math.min(minimumTextContrast, ...contrast.map(item => item.contrast));
    ok(await page.evaluate(form => {
      const text = content => content.replace(/\r\n?/g, '\n').split(/\n[\t ]*\n+/);
      if (form === 'scene') return JSON.stringify([...document.querySelectorAll('.sd-fourth-wall-prose p')].map(node => node.textContent)) === JSON.stringify(text(samples.scene.content));
      const entries = [...document.querySelectorAll('.sd-fourth-wall-entry')];
      return entries.length === samples.diary.entries.length && entries.every((node, index) => node.querySelector('time').textContent === samples.diary.entries[index].time
        && JSON.stringify([...node.querySelectorAll('p')].map(p => p.textContent)) === JSON.stringify(text(samples.diary.entries[index].content)));
    }, form), label + ' retains exact source prose and diary order');
    const viewport = page.locator('.sd-fourth-wall-reading');
    await viewport.focus();
    ok(await viewport.evaluate(node => document.activeElement === node && getComputedStyle(node).outlineStyle === 'solid'), label + ' is keyboard-focusable with a visible outline');
    await page.keyboard.press('PageDown');
    // Chromium's native keyboard scroll animates after the event; let it finish
    // before assigning an exact restoration target rather than racing that scroll.
    await page.waitForTimeout(250);
    ok(await viewport.evaluate(node => node.scrollTop > 0), label + ' supports keyboard page scrolling');
    const savedScroll = await viewport.evaluate(node => { node.scrollTop = Math.min(260, node.scrollHeight - node.clientHeight); node.dispatchEvent(new Event('scroll')); return node.scrollTop; });
    await page.evaluate(form => renderPage(form), form);
    ok(await page.locator('.sd-fourth-wall-reading').evaluate((node, expected) => Math.abs(node.scrollTop - expected) <= 1, savedScroll), label + ' restores reading position on same-result remount');
    await page.locator('.sd-fourth-wall-reading').evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
    ok(await page.locator('.sd-fourth-wall-reading').evaluate(node => {
      const rect = node.getBoundingClientRect(), end = [...node.querySelectorAll('p')].at(-1).getBoundingClientRect();
      return end.bottom <= rect.bottom + 1 && end.bottom > rect.top;
    }), label + ' final source paragraph remains reachable');
    ok(await page.evaluate(() => JSON.stringify(mainline) === beforeMainline && JSON.stringify(samples) === beforeSamples), label + ' cannot mutate mainline or source records');
    if (width === 393) {
      await page.locator('.sd-fourth-wall-reading').evaluate(node => { node.scrollTop = 0; node.blur(); });
      const path = fileURLToPath(new URL(`${family}_${mode}_${form}_${width}.png`, qa));
      await page.locator('.sd-creative-social').screenshot({ path, animations: 'disabled' }); screenshots.push(path);
    }
  }
  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(async () => { await setAppearance('glass', 'dark'); resetCreativeSocialState(); renderPage('diary', '本幕返回不完整'); });
  ok(await page.locator('.sd-director-section-notice').textContent() === '本幕返回不完整' && await page.locator('.sd-fourth-wall-entry').count() === 5, 'partial notice preserves received diary pages');
  ok(await page.locator('.sd-creative-social').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'short narrow screen keeps title and partial notice bounded');
  const partialPath = fileURLToPath(new URL('glass_dark_diary_partial_320.png', qa)); await page.screenshot({ path: partialPath, animations: 'disabled' }); screenshots.push(partialPath);
  ok(await page.evaluate(() => {
    const original = samples.diary; samples.diary = { ...original, title: '长标题'.repeat(80), character: '很长的角色身份'.repeat(30), entries: [{ time: '无法拆词的时间标签'.repeat(30), content: 'UnbrokenLongText'.repeat(300) + '\n\n末段仍可完整阅读。' }] };
    renderPage('diary', '本幕返回不完整');
    const bounded = [...document.querySelectorAll('.sd-fourth-wall-head,.sd-fourth-wall-time,.sd-fourth-wall-prose,.sd-fourth-wall-prose p')].every(node => node.scrollWidth <= node.clientWidth + 1);
    const intact = document.querySelector('.sd-fourth-wall-prose p').textContent === samples.diary.entries[0].content.split('\n\n')[0]; samples.diary = original; return bounded && intact;
  }), 'long names, times and unbroken text wrap without truncation');
  ok(await page.evaluate(() => {
    const attack = '<img src="https://example.test/x" onerror="window.injected=true"><script>window.injected=true</script>';
    const body = document.querySelector('.sd-body'); body.innerHTML = renderCreativeSocialCard({ type: 'fourth_wall', form: 'diary', title: attack, character: attack, entries: [{ time: attack, content: attack }] }, { notice: attack });
    return !body.querySelector('img,script,a,iframe') && !window.injected && body.querySelector('.sd-fourth-wall-prose p').textContent === attack;
  }), 'untrusted strings remain literal text in the real DOM');
  ok(await page.evaluate(() => {
    const body = document.querySelector('.sd-body'); body.innerHTML = renderCreativeSocialCard({ type: 'fourth_wall', form: 'unknown', content: '不得伪造类型' });
    return body.querySelector('.sd-social-empty')?.textContent === '尚未生成' && !body.querySelector('.sd-fourth-wall-reading');
  }), 'unknown form uses the ordinary empty state');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({ passed: checks.length, errors, external, diaryHanCharacters: hanCount, minimumTextContrast, screenshots, scope: 'actual renderer and reading binding, three themes/day-night/320-393-1100; local fictional fixtures, no ST/model/persistence' }, null, 2));
} finally { clearTimeout(deadline); await context.close(); await browser.close(); }
