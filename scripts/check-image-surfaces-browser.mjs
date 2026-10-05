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
const artwork=process.env.QIANMU_SURFACE_ARTWORK?{src:'data:image/png;base64,'+(await readFile(process.env.QIANMU_SURFACE_ARTWORK)).toString('base64'),crop:JSON.parse(process.env.QIANMU_SURFACE_ARTWORK_CROP||'null')}:null;
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin!==origin){external.push(url.origin);await route.abort();return;}
  if(route.request().method()!=='GET'){requests.push(route.request().method()+' '+url.pathname);await route.abort();return;}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>
    /* Deliberately no global border-box: do not mask production width errors. */
    body{margin:0;background:#16181a;color:#e6e6e6;font:22px Georgia,serif}
    dialog{background:rgb(25,27,29);color:rgb(230,230,230);padding:32px;border:1px solid #596478}
    input,textarea,select,.text_pole{background:rgb(12,14,16);color:rgb(230,230,230);border:1px solid #607086;padding:10px}
    button{background:#17191c;color:#e6e6e6}body{transform:translateZ(0)}
    </style></head><body><dialog id="host-sentinel">Host stays dark</dialog><script>window.surfaceArtwork=${JSON.stringify(artwork)};</script></body></html>`});
  if(/^\/qianmu-[a-z0-9-]+\.(?:js|css)$/.test(url.pathname)||/^\/vendor\/noble-hashes-2\.4\.0\/[a-z0-9_-]+\.js$/.test(url.pathname))return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url))});
  requests.push('Unexpected local resource '+url.pathname);await route.abort();
});
try{
  await page.goto(origin);const result=await checkStoryboardImageSurfacesBrowser(page);
  assert.deepEqual(external,[],'external requests must remain blocked/unused');assert.deepEqual(requests,[],'no APIs or unexpected resources');assert.deepEqual(errors,[],'page errors');
  assert.equal(await page.locator('#host-sentinel').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(25, 27, 29)');
  if(process.env.QIANMU_CAPTURE_SURFACES){
    await page.evaluate(()=>{
      records[0].tags=['独处','日常','室内','午后','安静'];records[0].collectionIds=['fixture'];
      window.fixtureCollections=[{id:'fixture',name:'日常片段'}];window.galleryRecordSourceCharacter=()=> '测试角色';
      const saved=snapshots.get(records[0].id);saved.payload.shotSpec.characters[0].name='测试角色';
      saved.payload.prompt='1girl, pink hair, medium hair, blue eyes, white blouse, navy pleated skirt, sitting on bed, looking at viewer, sunlit bedroom, soft shadows, natural lighting, medium shot';
      Object.assign(saved.payload.parameters,{width:696,height:1048,steps:28,cfg:6.5,seed:248573061,sampler:'euler',scheduler:'normal'});
    });
    for(const family of ['classic','glass','editorial'])for(const mode of ['light','dark']){
      await page.setViewportSize({width:390,height:844});
      await page.evaluate(async({family,mode})=>{await setAppearance(family,mode);openGalleryInfo();},{family,mode});
      await page.waitForSelector('.sd-image-info-readonly');
      await page.screenshot({path:process.env.QIANMU_CAPTURE_SURFACES+`-${family}-${mode}-top.png`});
      await page.locator('.sd-image-info-cast').evaluate(node=>node.scrollIntoView({block:'start'}));
      await page.screenshot({path:process.env.QIANMU_CAPTURE_SURFACES+`-${family}-${mode}-fields.png`});
      await page.locator('.sd-image-info-parameters summary').click();
      await page.locator('.sd-image-info-parameter-grid').scrollIntoViewIfNeeded();
      await page.screenshot({path:process.env.QIANMU_CAPTURE_SURFACES+`-${family}-${mode}-parameters.png`});
      await page.locator('[data-image-info-back]').click();
    }
  }
  console.log(JSON.stringify({...result,external,errors,requests,hostUnaffected:true,productionWrites:0,providerRequests:0},null,2));
}catch(error){console.error(JSON.stringify({external,errors,requests,status:await page.locator('.sd-image-info-status').textContent().catch(()=>null)}));throw error;}
finally{await context.close();await browser.close();}
