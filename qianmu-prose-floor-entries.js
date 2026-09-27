// Shared prose-floor helpers used by storyboard floor actions.
// The storyboard shortcut and assistant source reader both need these small,
// read-only DOM operations without importing their heavier panels.
export function floorProseText(element){
  if(!element)return '';
  const copy=element.cloneNode(true);
  const originals=element.querySelectorAll('*'),copies=copy.querySelectorAll('*'),view=element.ownerDocument.defaultView;
  originals.forEach((node,index)=>{const style=view.getComputedStyle(node);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse')copies[index].remove();});
  copy.querySelectorAll('script,style,iframe,img,video,audio,svg,button,[hidden],[data-qianmu-transient],.sd-storyboard-inline,.sd-tts-inline,.mes_reasoning').forEach(node=>node.remove());
  copy.querySelectorAll('br').forEach(node=>node.replaceWith('\n'));
  for(const node of copy.querySelectorAll('p,div,li,blockquote,pre,tr,h1,h2,h3,h4,h5,h6')){node.before('\n');node.after('\n');}
  return String(copy.textContent||'').trim();
}

// Keep the per-message storyboard shortcut separate from the assistant so its
// floor wiring remains lightweight.
export function injectStoryboardMessageButtons(chatRoot,{floorOf,getContext,getState,planForMessage,applyIcons}){
  chatRoot.querySelectorAll('.mes').forEach((message)=>{
    const floor=floorOf(message),chatMessage=Number.isInteger(floor)?getContext().chat?.[floor]:null;
    if(!chatMessage||chatMessage.is_system||message.querySelector('.sd-storyboard-message-action'))return;
    const toolbar=message.querySelector('.mes_buttons .extraMesButtons, .mes_buttons .mes_buttons_inner, .mes_buttons');if(!toolbar)return;
    const button=chatRoot.ownerDocument.createElement('button');button.type='button';button.className='mes_button interactable sd-storyboard-message-action';
    button.dataset.storyboardChatAction = 'capture-floor';
    const plan=planForMessage(getState(),floor,chatMessage);
    button.title=plan?.shots?.some((shot)=>shot.hasPrompt||String(shot.prompt||'').trim())?`重新提取第 ${floor} 层生成词`:`提取第 ${floor} 层生成词`;
    button.setAttribute('aria-label',button.title);button.innerHTML='<i class="fa-solid fa-video" data-qm-icon="qm-regular-aperture"></i>';toolbar.appendChild(button);applyIcons(button);
  });
}
