// Main-panel tabs only. The fixed shell owns the two equal gutters; scrolling
// never consumes them and revealing a tab cannot move the body or host page.
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const selectionAnimations=new WeakMap();
const selectionThemes=new WeakMap(),navigationListeners=new WeakMap();
function cancelSelectionAnimation(bar){
 for(const animation of selectionAnimations.get(bar)||[])animation.cancel();
 selectionAnimations.delete(bar);
}
export function renderQianmuMainTabs(tabs,active){
 return `<div class="sd-tabs-shell"><nav class="sd-tabs" aria-label="千幕栏目">${tabs.map(([id,label])=>`<button type="button" class="sd-tab${active===id?' active':''}" data-tab="${escape(id)}"${active===id?' aria-current="page"':''}><span class="sd-tab-label">${escape(label)}</span><span class="sd-tab-mark" aria-hidden="true"></span><span class="sd-tab-dot" aria-hidden="true"></span><svg class="sd-tab-capsule" aria-hidden="true" focusable="false"><rect width="100%" height="100%" ry="50%" pathLength="1"/></svg></button>`).join('')}</nav></div>`;
}
// Retain only the small navigation shell, never renderer-owned page content.
// No computed-style snapshots or forced layout are needed for these WAAPI decorations.
export function preserveQianmuMainTabs(root,enabled=true){
 let shell=root?.querySelector('.sd-tabs-shell'),bar=shell?.querySelector('.sd-tabs');
 if(!bar)return()=>false;
 if(!enabled){cancelSelectionAnimation(bar);return()=>false;}
 const scroll=bar.scrollLeft,document=root.ownerDocument;
 let focused=shell.contains(document?.activeElement)?document.activeElement:null;
 return()=>{
  const previous=shell,previousBar=bar,focus=focused;shell=null;bar=null;focused=null;
  if(!previousBar)return false;
  const next=root.isConnected?root.querySelector('.sd-tabs-shell'):null,nextBar=next?.querySelector('.sd-tabs');
  if(next===previous)return false;
  const before=[...previousBar.children],after=[...(nextBar?.children||[])],keys=before.map(tab=>tab.dataset.tab);
  if(!nextBar||!keys.length||new Set(keys).size!==keys.length||before.length!==after.length||before.some((tab,i)=>
   tab.dataset.tab!==after[i].dataset.tab||tab.querySelector('.sd-tab-label')?.textContent!==after[i].querySelector('.sd-tab-label')?.textContent)){
   cancelSelectionAnimation(previousBar);return false;
  }
  for(let i=0;i<before.length;i++){
   before[i].classList.toggle('active',after[i].classList.contains('active'));
   const current=after[i].getAttribute('aria-current');
   if(current===null)before[i].removeAttribute('aria-current');else before[i].setAttribute('aria-current',current);
   before[i].disabled=after[i].disabled;
  }
  next.replaceWith(previous);previousBar.scrollLeft=scroll;
  if(focus&&document.activeElement===document.body)focus.focus({preventScroll:true});
  return true;
 };
}
export function bindQianmuMainTabNavigation(root,onNavigate){
 for(const tab of root.querySelectorAll('.sd-tabs .sd-tab')){
  const previous=navigationListeners.get(tab);if(previous)tab.removeEventListener('click',previous);
  const listener=()=>{if(!tab.disabled)onNavigate(tab);};
  tab.addEventListener('click',listener);navigationListeners.set(tab,listener);
 }
}
export function sizeQianmuTabs(bar){
 if(!bar?.children?.length)return;
 const available=bar.clientWidth;if(!available)return;
 const style=getComputedStyle(bar),key=[available,style.font,style.gap].join('|');
 if(bar.dataset.tabLayout===key)return;
 cancelSelectionAnimation(bar);
 const tabs=[...bar.children],gap=parseFloat(style.columnGap)||0,x=bar.scrollLeft;
 for(const tab of tabs)tab.style.flexBasis='';
 const minimum=Math.max(56,...tabs.map(tab=>tab.getBoundingClientRect().width));
 if(minimum*tabs.length+gap*(tabs.length-1)>available){
  const slots=Math.max(2,Math.floor((available+gap)/(minimum+gap)));
  const width=(available-gap*(slots-1))/slots;
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
 const theme=bar.closest?.('#story-director-modal')?.dataset.qmTheme||'classic';
 const changedTheme=selectionThemes.has(bar)&&selectionThemes.get(bar)!==theme;selectionThemes.set(bar,theme);
 if(changedTheme||globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches){cancelSelectionAnimation(bar);return;}
 const next=bar?.querySelector('.sd-tab.active'),old=[...(bar?.children||[])].find(tab=>tab.dataset.tab===previous);
 if(next===old&&next)return; // A quiet page repaint must not stop the in-flight decoration.
 if(!next||!old){cancelSelectionAnimation(bar);return;}
 const previousMark=old.querySelector('.sd-tab-mark'),previousDot=old.querySelector('.sd-tab-dot');
 // Rapid reversals start at the actually painted line/dot, not the prior button's center.
 const moving=theme==='classic'&&(selectionAnimations.get(bar)||[]).some(animation=>['running','pending'].includes(animation.playState));
 const painted=moving?previousMark?.getBoundingClientRect():null;
 const lineOpacity=moving?parseFloat(getComputedStyle(previousMark).opacity):1,dotOpacity=moving?parseFloat(getComputedStyle(previousDot).opacity):0;
 cancelSelectionAnimation(bar);
 const animations=[];
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
  const mark=next.querySelector('.sd-tab-mark'),dot=next.querySelector('.sd-tab-dot');
  const a=painted||old.getBoundingClientRect(),b=next.getBoundingClientRect(),delta=(a.left+a.width/2)-(b.left+b.width/2);
  const width=mark?.getBoundingClientRect().width,oldWidth=previousMark?.getBoundingClientRect().width||width;
  const position=distance=>`translate(calc(-50% + ${distance}px), 50%)`;
  if(Number.isFinite(delta)&&width>0){
   animate(mark,[
    {transform:`${position(delta)} scaleX(${(painted?.width||oldWidth)/width})`,opacity:lineOpacity},
    {transform:`${position(delta*.8)} scaleX(${5/width})`,opacity:0,offset:.28},
    {transform:`${position(delta*.15)} scaleX(${5/width})`,opacity:0,offset:.7},
    {transform:'translate(-50%, 50%) scaleX(1)',opacity:1}
   ],360);
   animate(dot,[
    {transform:position(delta),opacity:dotOpacity},
    {transform:position(delta*.8),opacity:1,offset:.28},
    {transform:position(delta*.15),opacity:1,offset:.7},
    {transform:'translate(-50%, 50%)',opacity:0}
   ],360);
  }
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
