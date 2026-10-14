import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// Uses the real shelf renderers, handlers, appearance runtime and collection dialog.
// Only the host Popup, shelf metadata and persistence adapter are synthetic.
export async function checkShelfRefinementBrowser(page) {
  const qa=new URL('../../dist/local-qa/reader-library/',import.meta.url);
  await mkdir(qa,{recursive:true});
  await page.evaluate(async()=>{
    const [{createQianmuAppearanceSession},{updateAppearancePreferences}]=await Promise.all([
      import('/qianmu-appearance-session.js'),import('/qianmu-appearance-settings.js')]);
    window.shelfAppearance=createQianmuAppearanceSession({readSettings:()=>settings,
      loadStyles:()=>({promise:Promise.resolve(true),cancel(){}}),loadFont:()=>({promise:Promise.resolve(true),cancel(){}})});
    shelfAppearance.mount(document.getElementById('story-director-modal'));
    window.setShelfAppearance=async(family,mode,accent='#7789a6')=>{
      settings.theme=mode==='dark'?'dark':'light';
      const root=document.getElementById('story-director-modal');root.classList.toggle('sd-theme-dark',mode==='dark');
      settings.appearance=updateAppearancePreferences(settings,{family,mode,accent,source:'manual'});await shelfAppearance.sync();
    };
  });
  let assertions=0;const verify=(value,label)=>{assert.ok(value,label);assertions++;};
  for(const family of ['classic','editorial','glass'])for(const mode of ['light','dark'])for(const width of [320,393,1100]) {
    const label=`${family}-${mode}-${width}`;
    await page.setViewportSize({width,height:898});
    await page.evaluate(async({family,mode})=>{
      prepareCollectionMutation();shelfData.books[0].title='永恒的终结（阿西莫夫）';shelfData.books[0].author='阿西莫夫';
      shelfData.libViewMode='grid';renderModal();await setShelfAppearance(family,mode);
    },{family,mode});
    if(mode==='light'){
      // Resolve real computed gradient colors, including color-mix(), at both stops.
      const contrast=await page.locator('.sd-reader-card[data-book="a"] .sd-reader-cover-ph').evaluate(el=>{
        const style=getComputedStyle(el),ctx=document.createElement('canvas').getContext('2d');
        const rgb=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(x=>x/255);};
        const lum=c=>c.map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
        const stops=style.backgroundImage.match(/color\([^)]*\)|rgba?\([^)]*\)/g)||[];
        return ['.sd-reader-cover-title','.sd-reader-cover-author'].flatMap(selector=>{
          const text=getComputedStyle(el.querySelector(selector)),ink=rgb(text.color),alpha=Number(text.opacity);
          return stops.map(stop=>{const bg=rgb(stop),fg=ink.map((v,i)=>v*alpha+bg[i]*(1-alpha));return(lum(fg)+.05)/(lum(bg)+.05);});
        });
      });
      verify(contrast.length===4&&contrast.every(ratio=>ratio>=4.5),label+' high contrast text cover '+JSON.stringify(contrast));
    }
    if(width===393&&mode==='light')await page.screenshot({path:fileURLToPath(new URL(label+'-cover.png',qa))});
    await page.locator('.sd-reader-view-toggle').click();
    verify(!await page.locator('.sd-reader-batch-actions').isVisible(),label+' actions collapsed');
    verify(await page.locator('.sd-reader-book-check:visible').count()===0,label+' checks hidden');
    await page.locator('.sd-reader-row[data-book="a"] .sd-reader-row-title').click();
    verify(await page.evaluate(()=>shelfCalls.filter(c=>c[0]==='open').length)===1,label+' ordinary row opens book');
    if(width===393&&family==='glass'&&mode==='light')await page.screenshot({path:fileURLToPath(new URL(label+'-list-collapsed.png',qa))});
    await page.locator('.sd-reader-batch-mode').focus();await page.keyboard.press('Enter');
    verify(await page.locator('.sd-reader-batch-mode').getAttribute('aria-expanded')==='true',label+' keyboard expands');
    verify(await page.locator('.sd-reader-book-check:visible').count()===2,label+' checks exposed');
    await page.locator('.sd-reader-row[data-book="a"] .sd-reader-row-title').click();
    verify(await page.locator('.sd-reader-book-check[data-book="a"]').isChecked(),label+' selection mode row selects');
    verify(await page.evaluate(()=>shelfCalls.filter(c=>c[0]==='open').length)===1,label+' selection does not open');
    verify(await page.locator('.sd-reader-batch-toggle-all').getAttribute('aria-pressed')==='false',label+' partial selection is not all selected');
    await page.locator('.sd-reader-search').fill('阿西莫夫');
    verify(await page.locator('.sd-reader-book-check:visible').count()===1&&await page.locator('.sd-reader-batch-toggle-all').getAttribute('aria-pressed')==='true',label+' search updates all-selected state for the visible selected book');
    await page.locator('.sd-reader-search').fill('');
    verify(await page.locator('.sd-reader-book-check:visible').count()===2&&await page.locator('.sd-reader-batch-toggle-all').getAttribute('aria-pressed')==='false',label+' clearing search restores partial-selection state');
    await page.locator('.sd-reader-batch-toggle-all').click();
    verify(await page.locator('.sd-reader-book-check:checked').count()===2,label+' select all');
    const geometry=await page.locator('.sd-reader-batch-actions').evaluate(el=>{
      const buttons=[...el.querySelectorAll('button')],rects=buttons.map(b=>b.getBoundingClientRect());
      return {oneRow:rects.every(r=>Math.abs(r.top-rects[0].top)<1),contained:rects.every(r=>r.left>=0&&r.right<=innerWidth),
        fontSizes:buttons.map(b=>parseFloat(getComputedStyle(b).fontSize)),icon:!!buttons.at(-1).querySelector('i,svg')};
    });
    verify(geometry.oneRow&&geometry.contained,label+' one action row');
    verify(geometry.fontSizes[1]===geometry.fontSizes[2]&&Math.abs(geometry.fontSizes[0]-geometry.fontSizes[1]-1)<.05,label+' smaller equal action font');
    verify(!geometry.icon,label+' delete action text only');
    if(width===393&&family==='glass'&&mode==='light')await page.screenshot({path:fileURLToPath(new URL(label+'-list-expanded.png',qa))});
    await page.locator('.sd-reader-batch-delete').click();await page.locator('#shelf-popup-cancel').click();
    verify(await page.evaluate(()=>shelfData.books.length)===3,label+' canceled deletion preserves books');
    await page.locator('.sd-reader-batch-mode').focus();await page.keyboard.press('Space');
    verify(await page.locator('.sd-reader-book-check:checked').count()===0&&!await page.locator('.sd-reader-batch-actions').isVisible(),label+' collapse clears selection');
    await page.locator('.sd-reader-batch-mode').click();verify(await page.locator('.sd-reader-batch-collect').isDisabled(),label+' reopen starts empty');
    await page.locator('.sd-reader-book-check[data-book="a"]').check();await page.locator('.sd-reader-batch-collect').click();
    verify(await page.locator('.sd-reader-collection-pick option[value=""]').count()===0,label+' unclassified has no remove choice');
    await page.locator('#shelf-popup-cancel').click();
    await page.evaluate(()=>{window.shelfPickResult=null;void coreadChooseCollectionForBooks(['a','f']).then(result=>shelfPickResult=result);});
    await page.locator('.sd-reader-collection-pick').waitFor();
    verify(await page.locator('.sd-reader-collection-pick option[value=""]').count()===1,label+' mixed ownership allows remove');
    await page.locator('.sd-reader-collection-pick').selectOption('');await page.locator('#shelf-popup-ok').click();
    await page.waitForFunction(()=>shelfPickResult!==null);
    verify(await page.evaluate(()=>shelfPickResult&&shelfData.collections[0].bookIds.length===0&&shelfData.books.length===3),label+' mixed remove retains books');
    verify(await page.locator('.sd-reader-lib').evaluate(el=>el.scrollWidth<=el.clientWidth+1),label+' no shelf overflow');
  }
  await page.evaluate(()=>shelfAppearance.reset());
  return {assertions,layouts:18,realTemplates:true,realEvents:true,realCollectionDialog:true};
}
