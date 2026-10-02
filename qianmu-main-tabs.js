// Main-panel tabs only. The fixed shell owns the two equal gutters; scrolling
// never consumes them and revealing a tab cannot move the body or host page.
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const selectionAnimations=new WeakMap();
function cancelSelectionAnimation(bar){
 for(const animation of selectionAnimations.get(bar)||[])animation.cancel();
 selectionAnimations.delete(bar);
}
export function renderQianmuMainTabs(tabs,active){
 return `<div class="sd-tabs-shell"><nav class="sd-tabs" aria-label="千幕栏目">${tabs.map(([id,label])=>`<button type="button" class="sd-tab${active===id?' active':''}" data-tab="${escape(id)}"${active===id?' aria-current="page"':''}><span class="sd-tab-label">${escape(label)}</span><span class="sd-tab-mark" aria-hidden="true"></span><svg class="sd-tab-capsule" aria-hidden="true" focusable="false"><rect width="100%" height="100%" ry="50%" pathLength="1"/></svg></button>`).join('')}</nav></div>`;
}
export function sizeQianmuTabs(bar){
 if(!bar?.children?.length||!bar.clientWidth)return;
 const style=getComputedStyle(bar),key=[bar.clientWidth,style.font,style.gap].join('|');
 if(bar.dataset.tabLayout===key)return;
 cancelSelectionAnimation(bar);
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
 if(!bar)return;
 cancelSelectionAnimation(bar);
 const next=bar?.querySelector('.sd-tab.active'),old=[...(bar?.children||[])].find(tab=>tab.dataset.tab===previous);
 if(!next||!old||next===old||globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
 const animations=[],theme=bar.closest?.('#story-director-modal')?.dataset.qmTheme||'classic';
 const animate=(node,frames,duration)=>{
  if(!node?.animate)return;
  try{animations.push(node.animate(frames,{duration,easing:'cubic-bezier(.25,.7,.3,1)'}));}catch{}
 };
 if(theme==='glass'){
  animate(next.querySelector('.sd-tab-capsule rect'),[
   {strokeDasharray:'1',strokeDashoffset:'.92',opacity:.55},
   {strokeDasharray:'1',strokeDashoffset:'0',opacity:1}
  ],380);
 }else if(theme==='editorial'){
  animate(next.querySelector('.sd-tab-mark'),[
   {transform:'translate(-50%, 50%) scale(.25)',opacity:.4},
   {transform:'translate(-50%, 50%) scale(1.15)',opacity:1,offset:.7},
   {transform:'translate(-50%, 50%) scale(1)',opacity:1}
  ],300);
  animate(next.querySelector('.sd-tab-label'),[
   {transform:'translateY(0)'},{transform:'translateY(-4px)',offset:.5},{transform:'translateY(-2px)'}
  ],300);
 }else{
  const mark=next.querySelector('.sd-tab-mark'),previousMark=old.querySelector('.sd-tab-mark');
  const a=old.getBoundingClientRect(),b=next.getBoundingClientRect(),delta=(a.left+a.width/2)-(b.left+b.width/2);
  const width=mark?.getBoundingClientRect().width,oldWidth=previousMark?.getBoundingClientRect().width||width;
  if(Number.isFinite(delta)&&width>0)animate(mark,[
   {transform:`translate(calc(-50% + ${delta}px), 50%)`,width:`${oldWidth}px`,height:'2.5px'},
   {transform:`translate(calc(-50% + ${delta*.8}px), 50%)`,width:'5px',height:'5px',offset:.28},
   {transform:`translate(calc(-50% + ${delta*.15}px), 50%)`,width:'5px',height:'5px',offset:.7},
   {transform:'translate(-50%, 50%)',width:`${width}px`,height:'2.5px'}
  ],360);
 }
 // Decorations alone animate: labels can rise, but buttons and their hitboxes never move.
 if(animations.length)selectionAnimations.set(bar,animations);
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
