// Production API-log renderer and theme styles, with synthetic in-memory records only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const start = index.indexOf('const LOG_STATUS_LABELS ='), end = index.indexOf('\nfunction renderTtsVoiceMapRows', start);
assert.ok(start > 0 && end > start);
const source = index.slice(start, end);
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8') + '\n' + await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const require = createRequire(import.meta.url), { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage(), checks = [], errors = [];
let external = 0;
const deadline = setTimeout(() => { void browser.close(); }, 90000);
const ok = (name, result) => { assert.ok(result, name); checks.push(name); };
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin === 'https://qianmu.test' && url.pathname === '/') return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-dark"><section class="sd-window"><main class="sd-body"><section class="sd-card"><h3>日志</h3><div class="sd-log-list"></div></section></main></section></div>`});
  if (url.origin === 'https://qianmu.test' && /^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname)) return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname, import.meta.url))});
  external++; return route.abort();
});
try {
  await page.goto('https://qianmu.test/');
  await page.evaluate(async source => {
    const [utils, {createQianmuAppearanceSession}, {updateAppearancePreferences}] = await Promise.all([import('/qianmu-storyboard-utils.js'),import('/qianmu-appearance-session.js'),import('/qianmu-appearance-settings.js')]);
    for (const name of ['htmlEscape','infoTag','estimateTokens']) window[name] = utils[name];
    window.settings = {theme:'dark',logOpenState:{}};
    (0, eval)(source);
    window.appearance = createQianmuAppearanceSession({readSettings:()=>settings,loadStyles:()=>({promise:Promise.resolve(true),cancel(){}})});
    appearance.mount(document.querySelector('#story-director-modal'));
    window.renderFixture = async (family, mode) => {
      settings.theme = mode === 'light' ? 'light' : 'dark';
      document.querySelector('#story-director-modal').className = `open sd-theme-${settings.theme}`;
      settings.appearance = updateAppearancePreferences(settings, {family,mode}); await appearance.sync();
      const records = ['success','error','cancelled','loading','none','future'].map((status,index)=>({id:`log-${index}`,status,kind:index%2?'theater':'director',time:'2026/9/17 19:00',duration:'18.5s',request:'原始请求 <script>bad()</script>',response:'原始回复 {"kept":true}',error:status==='error'?'已保留失败原文':''}));
      document.querySelector('.sd-log-list').innerHTML = records.map(renderLogEntry).join('');
    };
    window.inspectSignals = async backgroundUrl => {
      const luminance = c => c.slice(0,3).reduce((sum,v,i)=>{v/=255;return sum+[.2126,.7152,.0722][i]*(v<=.04045?v/12.92:((v+.055)/1.055)**2.4);},0);
      const image=new Image();image.src=backgroundUrl;await image.decode();
      const canvas = document.createElement('canvas'); canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const draw=canvas.getContext('2d');draw.drawImage(image,0,0);
      return [...document.querySelectorAll('.sd-log-status')].map(node=>{
        const style=getComputedStyle(node), rect=node.getBoundingClientRect(), summary=node.closest('summary'), meta=summary.querySelector('.sd-log-meta');
        const bg=[...draw.getImageData(Math.floor(rect.x+rect.width/2),Math.floor(rect.y+rect.height/2),1,1).data];
        draw.clearRect(0,0,1,1);draw.fillStyle=`rgb(${bg.slice(0,3).join(',')})`;draw.fillRect(0,0,1,1);draw.fillStyle=style.backgroundColor;draw.fillRect(0,0,1,1);
        const fg=[...draw.getImageData(0,0,1,1).data], a=luminance(bg),b=luminance(fg);
        return {label:node.getAttribute('aria-label'),title:node.title,role:node.getAttribute('role'),text:node.textContent,width:rect.width,height:rect.height,radius:style.borderRadius,color:style.backgroundColor,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),metaSize:parseFloat(getComputedStyle(meta).fontSize),summarySize:parseFloat(getComputedStyle(summary).fontSize)};
      });
    };
  }, source);
  for (const family of ['classic','editorial','glass']) for (const mode of ['light','dark']) for (const width of [320,393,1100]) {
    const label=`${family}/${mode}/${width}`;
    await page.setViewportSize({width,height:898});
    await page.evaluate(({family,mode})=>renderFixture(family,mode),{family,mode});
    // Sample the actual gradient/glass background rather than pretending transparent CSS colors are opaque.
    await page.evaluate(()=>document.querySelectorAll('.sd-log-status').forEach(node=>node.style.visibility='hidden'));
    const background=await page.screenshot();
    await page.evaluate(()=>document.querySelectorAll('.sd-log-status').forEach(node=>node.style.removeProperty('visibility')));
    const signals=await page.evaluate(url=>inspectSignals(url),'data:image/png;base64,'+background.toString('base64'));
    ok(label+' accessible status meaning',signals.map(x=>x.label).join('|')==='成功|失败|已取消|生成中|状态未知|状态未知' && signals.every(x=>x.title===x.label && x.role==='img' && x.text===''));
    ok(label+' round small stable signals',signals.every(x=>x.width===8 && x.height===8 && x.radius==='50%'));
    ok(label+' yellow active/cancelled and neutral unknown',signals[2].color===signals[3].color && signals[4].color===signals[5].color && new Set([signals[0].color,signals[1].color,signals[2].color,signals[4].color]).size===4);
    ok(label+' graphical contrast at least 3:1 '+signals.map(x=>x.contrast.toFixed(2)).join(','),signals.every(x=>x.contrast>=3));
    ok(label+' date and duration use smaller type',signals.every(x=>x.metaSize<x.summarySize));
    await page.locator('.sd-log-entry > summary').first().focus(); await page.keyboard.press('Enter');
    ok(label+' keyboard details preserve original response',await page.evaluate(()=>document.querySelector('.sd-log-entry').open && document.querySelector('.sd-log-entry .sd-log-detail').textContent.includes('原始回复 {"kept":true}') && !document.querySelector('.sd-log-list script')));
    ok(label+' no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  }
  ok('no external network and no browser errors',external===0 && errors.length===0);
  console.log(JSON.stringify({passed:checks.length,checks,external,errors},null,2));
} finally { clearTimeout(deadline); await browser.close(); }
