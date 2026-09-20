// Main-panel tabs only. The fixed shell owns the two equal gutters; scrolling
// never consumes them and revealing a tab cannot move the body or host page.
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function renderQianmuMainTabs(tabs,active){
 return `<div class="sd-tabs-shell"><nav class="sd-tabs" aria-label="千幕栏目">${tabs.map(([id,label])=>`<button type="button" class="sd-tab${active===id?' active':''}" data-tab="${escape(id)}"${active===id?' aria-current="page"':''}><span>${escape(label)}</span></button>`).join('')}</nav></div>`;
}
export function sizeQianmuTabs(bar){
 if(!bar?.children?.length||!bar.clientWidth)return;
 const style=getComputedStyle(bar),key=[bar.clientWidth,style.font,style.gap].join('|');
 if(bar.dataset.tabLayout===key)return;
 const tabs=[...bar.children],gap=parseFloat(style.columnGap)||0,x=bar.scrollLeft;
 for(const tab of tabs)tab.style.flexBasis='';
 const minimum=Math.max(56,...tabs.map(tab=>tab.getBoundingClientRect().width));
 if(minimum*tabs.length+gap*(tabs.length-1)>bar.clientWidth){
  const slots=Math.max(2,Math.floor((bar.clientWidth+gap)/(minimum+gap)));
  const width=(bar.clientWidth-gap*(slots-1))/slots;
  for(const tab of tabs)tab.style.flexBasis=width+'px';
 }
 bar.dataset.tabLayout=key;bar.scrollLeft=x;
}
export function keepQianmuTabVisible(bar,tab=bar?.querySelector('.sd-tab.active')){
 sizeQianmuTabs(bar);
 if(!tab||!bar?.contains(tab))return;
 const viewport=bar.getBoundingClientRect(),item=tab.getBoundingClientRect();
 if(item.left<viewport.left)bar.scrollLeft+=item.left-viewport.left;
 else if(item.right>viewport.right)bar.scrollLeft+=item.right-viewport.right;
}
export function animateQianmuTabSelection(bar,previous){
 const next=bar?.querySelector('.sd-tab.active'),old=[...(bar?.children||[])].find(tab=>tab.dataset.tab===previous);
 if(!next||!old||next===old||!next.animate||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
 const delta=old.getBoundingClientRect().left-next.getBoundingClientRect().left;
 for(const pseudoElement of ['::before','::after'])try{
  const animation=next.animate([
   {transform:`translateX(${delta}px)`,opacity:.65},{transform:'translateX(0)',opacity:1}
  ],{duration:260,easing:'cubic-bezier(.22,.75,.25,1)',pseudoElement});
  // Older engines must never move the actual button if pseudo effects are ignored.
  if(animation.effect?.pseudoElement!==pseudoElement)animation.cancel();
 }catch{} // The selected contour remains immediately usable without animation.
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
