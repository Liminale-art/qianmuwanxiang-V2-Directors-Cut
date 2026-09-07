import {createStoryboardTagIndex,searchStoryboardTags,storyboardTagFragment,storyboardTagText,insertStoryboardTag} from './qianmu-tags.js';

let sequence=0;
export function mountStoryboardTagComplete(root,{items=()=>[],source=()=> 'novel',format=()=> 'tags',isCurrent=()=>true,onUse=()=>{},onNotice=()=>{}}={}){
  const selector='.sd-storyboard-prompt,.sd-storyboard-negative,.sd-storyboard-artist-edit-positive,.sd-storyboard-artist-edit-negative';
  const doc=root.ownerDocument,win=doc.defaultView,id=`sd-tag-complete-${++sequence}`,listeners=[];
  let field=null,popup=null,mirror=null,observer=null,frame=0,timer=0,composing=false,disposed=false,press=null,suppressClick=0;
  let index=[],rows=[],total=0,offset=0,active=0,polarity='all',snapshot=null,previousAttributes=null;
  const current=()=>!disposed&&root.isConnected&&isCurrent()&&(!field||field.isConnected&&root.contains(field));
  const on=(node,event,callback,options)=>{node.addEventListener(event,callback,options);listeners.push(()=>node.removeEventListener(event,callback,options));};
  const restore=()=>{if(!field||!previousAttributes)return;for(const [key,value]of Object.entries(previousAttributes)){if(value===null)field.removeAttribute(key);else field.setAttribute(key,value);}previousAttributes=null;};
  const hide=()=>{
    win.clearTimeout(timer);timer=0;if(frame)win.cancelAnimationFrame(frame);frame=0;
    popup?.remove();mirror?.remove();popup=null;mirror=null;restore();snapshot=null;rows=[];press=null;
  };
  function dispose(){if(disposed)return;disposed=true;hide();observer?.disconnect();observer=null;listeners.forEach(remove=>remove());field=null;index=[];}
  const selectedField=target=>target?.matches?.(selector)&&root.contains(target)&&!target.disabled&&!target.readOnly;
  const viewport=()=>{const v=win.visualViewport;return {left:v?.offsetLeft||0,top:v?.offsetTop||0,width:v?.width||win.innerWidth,height:v?.height||win.innerHeight};};
  function position(){
    frame=0;if(!current()){dispose();return;}if(!popup)return;
    const rect=field.getBoundingClientRect(),style=win.getComputedStyle(field),view=viewport();
    mirror ||= doc.createElement('div');if(!mirror.isConnected){mirror.setAttribute('aria-hidden','true');doc.body.append(mirror);}
    mirror.style.cssText='position:fixed;visibility:hidden;pointer-events:none;white-space:pre-wrap;overflow-wrap:break-word;overflow:hidden;';
    for(const key of ['boxSizing','paddingTop','paddingBottom','paddingLeft','paddingRight','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','borderStyle','fontFamily','fontSize','fontWeight','fontStyle','lineHeight','letterSpacing','textIndent','textTransform','textAlign','wordBreak','tabSize'])mirror.style[key]=style[key];
    mirror.style.left=`${rect.left}px`;mirror.style.top=`${rect.top}px`;mirror.style.width=`${rect.width}px`;
    mirror.textContent=field.value.slice(0,field.selectionStart);const marker=doc.createElement('span');marker.textContent=field.value[field.selectionStart]||'\u200b';mirror.append(marker);
    const caret=marker.getBoundingClientRect(),width=Math.min(360,Math.max(0,view.width-16));popup.style.width=`${width}px`;
    popup.style.maxHeight=`${Math.max(40,Math.min(260,view.height-16))}px`;
    const height=popup.getBoundingClientRect().height,x=Math.max(view.left+8,Math.min(caret.left-field.scrollLeft,view.left+view.width-width-8));
    const below=caret.bottom-field.scrollTop+5,above=caret.top-field.scrollTop-height-5;
    const y=Math.max(view.top+8,Math.min(below+height<=view.top+view.height-8?below:above,view.top+view.height-height-8));
    popup.style.left=`${x}px`;popup.style.top=`${y}px`;
  }
  const schedulePosition=()=>{if(popup&&!frame)frame=win.requestAnimationFrame(position);};
  function show(){
    if(popup)return;
    popup=doc.createElement('section');popup.className='sd-tag-complete';popup.id=id;popup.setAttribute('aria-label','Tag 联想');
    const theme=win.getComputedStyle(root);for(const variable of ['--sd-accent','--sd-text','--sd-muted','--sd-card','--sd-hairline']){const value=theme.getPropertyValue(variable);if(value)popup.style.setProperty(variable,value);}
    previousAttributes=Object.fromEntries(['aria-autocomplete','aria-controls','aria-expanded','aria-activedescendant'].map(key=>[key,field.getAttribute(key)]));
    field.setAttribute('aria-autocomplete','list');field.setAttribute('aria-controls',id+'-list');field.setAttribute('aria-expanded','true');doc.body.append(popup);
    popup.addEventListener('pointerdown',event=>{const button=event.target.closest('button');if(!button)return;press={button,x:event.clientX,y:event.clientY,moved:false};if(event.pointerType==='mouse')event.preventDefault();});
    popup.addEventListener('pointermove',event=>{if(press&&Math.hypot(event.clientX-press.x,event.clientY-press.y)>8)press.moved=true;});
    popup.addEventListener('pointercancel',()=>{press=null;});
    popup.addEventListener('pointerup',event=>{const button=event.target.closest('button'),start=press;press=null;if(!start||start.moved||start.button!==button)return;event.preventDefault();suppressClick=Date.now()+400;activate(button);});
    popup.addEventListener('click',event=>{if(Date.now()<suppressClick)return;const button=event.target.closest('button');if(button)activate(button);});
  }
  function activate(button){
    if(!current()){hide();return;}
    if(button.dataset.polarity){polarity=polarity===button.dataset.polarity?'all':button.dataset.polarity;offset=0;refresh();field.focus({preventScroll:true});return;}
    if(button.dataset.page){offset=Math.max(0,offset+Number(button.dataset.page)*40);refresh();field.focus({preventScroll:true});return;}
    const choice=rows.find(row=>row.item.id===button.dataset.tagId);if(choice)accept(choice);
  }
  function highlight(){
    popup?.querySelectorAll('[data-tag-id]').forEach((button,i)=>button.setAttribute('aria-selected',String(i===active)));
    const button=popup?.querySelectorAll('[data-tag-id]')[active];if(button){field.setAttribute('aria-activedescendant',button.id);const list=button.parentElement,b=button.getBoundingClientRect(),r=list.getBoundingClientRect();if(b.top<r.top)list.scrollTop+=b.top-r.top;else if(b.bottom>r.bottom)list.scrollTop+=b.bottom-r.bottom;}else field.removeAttribute('aria-activedescendant');
  }
  function refresh(){
    win.clearTimeout(timer);timer=0;if(composing||!current()||!field){hide();return;}
    const fragment=storyboardTagFragment(field.value,field.selectionStart,field.selectionEnd,{format:format(field)});
    if(fragment.query.length>120){hide();return;}
    const result=searchStoryboardTags(index,{query:fragment.query,polarity,offset,limit:40});rows=result.rows;total=result.total;
    if(!total&&polarity==='all'){hide();return;}
    show();popup.replaceChildren();snapshot={value:field.value,start:field.selectionStart,end:field.selectionEnd};
    const header=doc.createElement('header');for(const [key,label]of [['positive','正面'],['negative','负面']]){const button=doc.createElement('button');button.type='button';button.dataset.polarity=key;button.textContent=label;button.setAttribute('aria-pressed',String(polarity===key));header.append(button);}popup.append(header);
    const list=doc.createElement('div');list.id=id+'-list';list.className='sd-tag-complete-options';list.setAttribute('role','listbox');list.setAttribute('aria-label','匹配标签');
    rows.forEach((row,i)=>{const button=doc.createElement('button');button.type='button';button.tabIndex=-1;button.dataset.tagId=row.item.id;button.id=`${id}-item-${i}`;button.setAttribute('role','option');button.className=(row.item.positive===false?'negative':'positive')+(row.item.name?' is-group':'');button.textContent=row.label.length>80?row.label.slice(0,80)+'…':row.label;button.title=row.value;list.append(button);});popup.append(list);
    if(total>40){const footer=doc.createElement('footer');for(const [direction,label,disabled]of [[-1,'上一页',offset===0],[1,'下一页',offset+40>=total]]){const button=doc.createElement('button');button.type='button';button.dataset.page=String(direction);button.textContent=label;button.disabled=disabled;footer.append(button);}popup.append(footer);}
    active=fragment.query?0:-1;highlight();position();
  }
  function accept(choice){
    if(!snapshot||!current()||composing)return;
    if(snapshot.value!==field.value||snapshot.start!==field.selectionStart||snapshot.end!==field.selectionEnd){offset=0;refresh();return;}
    const live=items().find(item=>item.id===choice.item.id);if(!live||storyboardTagText(live,source(field))!==choice.value){hide();onNotice('Tag 已变化，请重新选择');return;}
    const result=insertStoryboardTag(field.value,field.selectionStart,field.selectionEnd,choice.value,{format:format(field),maxLength:field.maxLength>0?field.maxLength:12000});
    if(!result.changed){hide();onNotice(result.reason==='limit'?'已到输入长度上限':result.reason==='duplicate'?'此 Tag 已在当前输入中':'未插入');return;}
    const target=field;hide();target.focus({preventScroll:true});target.setRangeText(result.insert,result.replaceStart,result.replaceEnd,'end');target.setSelectionRange(result.start,result.end);
    onUse(live);target.dispatchEvent(new win.Event('input',{bubbles:true}));
  }
  function focus(target){
    if(!selectedField(target)||!current())return;if(field!==target){hide();field=target;polarity='all';offset=0;index=createStoryboardTagIndex(items(),source(field));}refresh();
  }
  const schedule=()=>{win.clearTimeout(timer);offset=0;timer=win.setTimeout(refresh,65);};
  on(root,'focusin',event=>focus(event.target));on(root,'input',event=>{if(selectedField(event.target)){if(field!==event.target)focus(event.target);else if(!composing)schedule();}});
  on(root,'compositionstart',event=>{if(selectedField(event.target)){composing=true;hide();}});
  on(root,'compositionend',event=>{if(selectedField(event.target)){composing=false;field=event.target;index=createStoryboardTagIndex(items(),source(field));schedule();}});
  on(root,'pointerup',event=>{if(selectedField(event.target))focus(event.target);});
  on(root,'keyup',event=>{if(event.target===field&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)&&!composing)schedule();});
  on(root,'keydown',event=>{
    if(event.target!==field||composing||event.isComposing||event.keyCode===229||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;
    if(event.key==='Escape'&&popup){event.preventDefault();event.stopPropagation();hide();return;}
    if(!popup||!['ArrowDown','ArrowUp','Enter'].includes(event.key))return;
    if(timer)refresh();if(!popup)return;
    if(event.key==='Enter'){if(!rows[active])return;event.preventDefault();event.stopPropagation();accept(rows[active]);}
    else{event.preventDefault();active=Math.max(0,Math.min(rows.length-1,active+(event.key==='ArrowDown'?1:-1)));highlight();}
  });
  on(root,'focusout',()=>win.setTimeout(()=>{if(!press&&doc.activeElement!==field&&!popup?.contains(doc.activeElement))hide();},0));
  on(doc,'pointerdown',event=>{if(popup&&!popup.contains(event.target)&&event.target!==field)hide();},true);
  on(doc,'scroll',schedulePosition,true);on(win,'resize',schedulePosition);if(win.visualViewport){on(win.visualViewport,'resize',schedulePosition);on(win.visualViewport,'scroll',schedulePosition);}
  observer=new win.MutationObserver(()=>{if(!current())dispose();});for(let ancestor=root.parentElement;ancestor;ancestor=ancestor.parentElement)observer.observe(ancestor,{childList:true});
  if(selectedField(doc.activeElement))focus(doc.activeElement);
  return dispose;
}
