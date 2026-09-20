// Main-panel tabs only. The fixed shell owns the two equal gutters; scrolling
// never consumes them and revealing a tab cannot move the body or host page.
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function renderQianmuMainTabs(tabs,active){
 return `<div class="sd-tabs-shell"><nav class="sd-tabs" aria-label="千幕栏目">${tabs.map(([id,label])=>`<button type="button" class="sd-tab${active===id?' active':''}" data-tab="${escape(id)}"${active===id?' aria-current="page"':''}><span>${escape(label)}</span></button>`).join('')}</nav></div>`;
}
export function keepQianmuTabVisible(bar,tab=bar?.querySelector('.sd-tab.active')){
 if(!tab||!bar?.contains(tab))return;
 const viewport=bar.getBoundingClientRect(),item=tab.getBoundingClientRect();
 if(item.left<viewport.left)bar.scrollLeft+=item.left-viewport.left;
 else if(item.right>viewport.right)bar.scrollLeft+=item.right-viewport.right;
}
export function updateTabsFade(bar){
 const max=Math.max(0,bar.scrollWidth-bar.clientWidth),x=Math.max(0,Math.min(max,bar.scrollLeft));
 bar.classList.toggle('sd-tabs-fade-left',max>2&&x>2);
 bar.classList.toggle('sd-tabs-fade-right',max>2&&x<max-2);
}
export function bindTabsScrollControls(bar){
 bar.addEventListener('wheel',event=>{
  if(!event.deltaY||bar.scrollWidth-bar.clientWidth<=2||Math.abs(event.deltaX)>Math.abs(event.deltaY))return;
  bar.scrollLeft+=event.deltaY;event.preventDefault();
 },{passive:false});
 let dragging=false,startX=0,startScroll=0,moved=0;
 bar.addEventListener('pointerdown',event=>{
  if(event.pointerType!=='mouse'||event.button!==0)return;
  dragging=true;moved=0;startX=event.clientX;startScroll=bar.scrollLeft;
 });
 bar.addEventListener('pointermove',event=>{
  if(!dragging)return;
  const dx=event.clientX-startX;moved=Math.max(moved,Math.abs(dx));
  bar.scrollLeft=startScroll-dx;
  if(moved>3){bar.classList.add('sd-tabs-dragging');if(bar.hasPointerCapture?.(event.pointerId)===false)try{bar.setPointerCapture(event.pointerId);}catch{}event.preventDefault();}
 });
 const finish=event=>{
  if(!dragging)return;dragging=false;bar.classList.remove('sd-tabs-dragging');
  try{bar.releasePointerCapture?.(event.pointerId);}catch{}
  if(moved>3){const swallow=click=>{click.stopPropagation();click.preventDefault();};bar.addEventListener('click',swallow,{capture:true,once:true});setTimeout(()=>bar.removeEventListener('click',swallow,true),0);}
 };
 for(const type of ['pointerup','pointercancel','pointerleave'])bar.addEventListener(type,finish);
 bar.addEventListener('focusin',event=>{if(dragging)return;const tab=event.target.closest?.('.sd-tab');if(tab){keepQianmuTabVisible(bar,tab);updateTabsFade(bar);}});
}
