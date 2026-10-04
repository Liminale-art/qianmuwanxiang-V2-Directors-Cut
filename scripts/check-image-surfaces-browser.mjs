// Isolated UI acceptance. No running ST, account, private prose, network API or provider.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {checkStoryboardImageSurfacesBrowser} from '../tests/helpers/storyboard-image-surfaces-browser.mjs';

const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext(),page=await context.newPage();
const origin='https://qianmu.test',external=[],errors=[],requests=[];
page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(error.message));
const css=(await readFile(new URL('../style.css',import.meta.url),'utf8'))+'\n'+(await readFile(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8'));
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!==origin){external.push(url.origin);await route.abort();return;}
  if(route.request().method()!=='GET'){requests.push(route.request().method()+' '+url.pathname);await route.abort();return;}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>
    /* Deliberately no global border-box: do not mask production width errors. */
    body{margin:0;background:#16181a;color:#e6e6e6;font:16px Arial,sans-serif}
    dialog{background:rgb(25,27,29);color:rgb(230,230,230);padding:32px;border:1px solid #596478}
    input,textarea,select,.text_pole{background:rgb(12,14,16);color:rgb(230,230,230);border:1px solid #607086;padding:10px}
    button{background:#17191c;color:#e6e6e6}body{transform:translateZ(0)}
    </style></head><body><dialog id="host-sentinel">Host stays dark</dialog></body></html>`});
  if(/^\/qianmu-[a-z0-9-]+\.(?:js|css)$/.test(url.pathname)||/^\/vendor\/noble-hashes-2\.4\.0\/[a-z0-9_-]+\.js$/.test(url.pathname))return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url))});
  requests.push('Unexpected local resource '+url.pathname);await route.abort();
});
try{
  await page.goto(origin);const result=await checkStoryboardImageSurfacesBrowser(page);
  assert.deepEqual(external,[],'external requests must remain blocked/unused');assert.deepEqual(requests,[],'no APIs or unexpected resources');assert.deepEqual(errors,[],'page errors');
  assert.equal(await page.locator('#host-sentinel').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(25, 27, 29)');
  if(process.env.QIANMU_CAPTURE_SURFACES){
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(async()=>{await setAppearance('glass','light');openInfo();});
    await page.waitForSelector('.sd-image-info-dialog');
    await page.screenshot({path:process.env.QIANMU_CAPTURE_SURFACES+'-detail-top.png'});
    await page.locator('[data-image-info-positive]').scrollIntoViewIfNeeded();
    await page.screenshot({path:process.env.QIANMU_CAPTURE_SURFACES+'-detail-fields.png'});
    await page.locator('.sd-image-info-dialog > footer [data-image-info-close]').click();
  }
  console.log(JSON.stringify({...result,external,errors,requests,hostUnaffected:true,productionWrites:0,providerRequests:0},null,2));
}catch(error){console.error(JSON.stringify({external,errors,requests,status:await page.locator('.sd-image-info-status').textContent().catch(()=>null)}));throw error;}
finally{await context.close();await browser.close();}
