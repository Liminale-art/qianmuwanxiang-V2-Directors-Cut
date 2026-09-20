import {captureProseAssistantChatSource} from './qianmu-prose-assistant-source.js';
import {createProseAssistantSession} from './qianmu-prose-assistant-session.js';
import {createProseAssistantRequest} from './qianmu-prose-assistant-request.js';
import {compileProseAssistantMessages} from './qianmu-prose-assistant-messages.js';
import {saveProseAssistantConnection} from './qianmu-prose-assistant-preferences.js';
import {openProseAssistantHistory} from './qianmu-prose-assistant-history-runtime.js';
import {bindProseAssistantWindow} from './qianmu-prose-assistant-window.js';
import {qianmuIconElement} from './qianmu-icon-renderer.js';

// Non-modal conversation window; opening it never reads or displays prose.
export async function openProseAssistantPanel({parent,source,sourceFactory,profiles=[],selection,referenceFloors=3,systemPrompt='',getRequestHeaders,fetchImpl,copy,confirm,isCurrent,preferences,applyIcons,historyFactory=openProseAssistantHistory}={}){
  const document=parent?.ownerDocument,view=document?.defaultView;
  if(!parent?.isConnected||!view||!Array.isArray(profiles)||typeof systemPrompt!=='string'||typeof isCurrent!=='function'||typeof copy!=='function'||typeof confirm!=='function'||typeof historyFactory!=='function')throw TypeError('正文助手面板环境不可用');
  const seed=await captureProseAssistantChatSource(source);
  if(!parent.isConnected||isCurrent()!==true){seed.close();throw Error('正文助手页面已变化');}
  const previousFocus=document.activeElement,dialog=document.createElement('section');dialog.className='qm-prose-assistant-dialog';dialog.tabIndex=-1;dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','false');dialog.setAttribute('aria-label','正文助手');
  let closed=false,busy=false,saving=false,closing=false,sequence=0,resolve,session,observer,history,historyTask=null,historyWorking=true,pendingSnapshot=null,pendingClear=false,disposeWindow;
  const listeners=[],rows=new Map(),finished=new Promise(done=>{resolve=done;});
  const node=(tag,value)=>{const element=document.createElement(tag);if(value!==undefined)element.textContent=value;return element;};
  const icons={close:'xmark',settings:'gear',back:'arrow-left',send:'arrow-up',stop:'stop',clear:'trash-can',copy:'copy',eye:'eye',save:'check',retry:'rotate-right',resize:'up-right-and-down-left-from-center'};
  const icon=(element,label,name)=>{element.replaceChildren();const glyph=qianmuIconElement('fa-'+(icons[name]||name),{document});if(glyph)element.append(glyph);element.title=label;element.setAttribute('aria-label',label);};
  const button=(label,action,name=action)=>{const element=node('button');element.type='button';element.dataset.paAction=action;icon(element,label,name);return element;};
  const field=(label,element)=>{const wrapper=node('label');wrapper.append(node('span',label),element);return wrapper;};
  const option=(select,value,label)=>{const item=node('option',label);item.value=value;select.append(item);};
  const listen=(element,type,handler)=>{element.addEventListener(type,handler);listeners.push(()=>element.removeEventListener(type,handler));};
  const header=node('header'),title=node('strong','正文助手'),headerActions=node('div'),settingsButton=button('助手设置','settings'),back=button('返回对话','back'),closeButton=button('关闭','close');back.hidden=true;headerActions.append(back,settingsButton,closeButton);header.append(title,headerActions);
  const main=node('main'),transcript=node('section');transcript.dataset.paTranscript='';transcript.setAttribute('aria-label','助手对话');main.append(transcript);
  const config=node('section'),grid=node('div'),profile=node('select'),range=node('input');config.dataset.paSettings='';config.hidden=true;grid.className='qm-pa-config';
  profile.setAttribute('aria-label','助手API预设');option(profile,'','请选择预设');for(const entry of profiles)if(entry&&typeof entry.id==='string')option(profile,'profile:'+entry.id,String(entry.name||entry.id));option(profile,'custom','专用连接');
  range.type='number';range.min='1';range.max='9';range.step='1';range.value=String(Number.isSafeInteger(referenceFloors)&&referenceFloors>=1&&referenceFloors<=9?referenceFloors:3);range.setAttribute('aria-label','参考楼层数');
  const custom=node('div');custom.className='qm-pa-custom';const url=node('input'),model=node('input'),key=node('input'),keyRow=node('div'),eye=button('显示 Key','eye');
  url.type='url';url.placeholder='https://…/v1';url.setAttribute('aria-label','助手API地址');model.setAttribute('aria-label','助手模型');key.type='password';key.autocomplete='off';key.setAttribute('aria-label','助手API Key');keyRow.className='qm-pa-key';keyRow.append(key,eye);custom.append(field('API 地址',url),field('模型',model),field('API Key',keyRow));
  const save=button('保存设置','save-connection','save');save.hidden=!preferences;
  grid.append(field('API 预设',profile),custom,field('参考楼层（含你的回复）',range));config.append(grid,save);
  if(selection?.mode==='profile')profile.value='profile:'+selection.profileId;
  if(selection?.mode==='custom'){profile.value='custom';url.value=selection.connection?.apiUrl||'';model.value=selection.connection?.model||'';key.value=selection.connection?.apiKey||'';}custom.hidden=profile.value!=='custom';
  const footer=node('footer'),question=node('textarea'),status=node('p'),historyNotice=node('p'),retry=button('重试保存','retry-history','retry'),clear=button('清空对话','clear'),send=button('发送','send'),composer=node('div');
  question.rows=1;question.maxLength=20000;question.placeholder='聊聊当前故事…';question.setAttribute('aria-label','向正文助手提问');question.dataset.paQuestion='';
  status.dataset.paStatus='';status.setAttribute('role','status');status.setAttribute('aria-live','polite');historyNotice.dataset.paHistory='';historyNotice.setAttribute('role','status');retry.hidden=true;
  if(!systemPrompt.trim())status.textContent='助手提示词尚未配置，暂不能发送。';
  composer.className='qm-pa-composer';composer.append(clear,question,send);footer.append(historyNotice,retry,status,composer);
  const resize=button('调整窗口大小','resize');resize.dataset.paResize='';dialog.append(header,main,config,footer,resize);
  function dispose(){if(closed)return;const restoreFocus=dialog.contains(document.activeElement);closed=true;sequence++;session?.close();history?.close();seed.close();disposeWindow?.();observer?.disconnect();listeners.splice(0).forEach(remove=>remove());key.value='';question.value='';rows.clear();dialog.remove();if(restoreFocus&&previousFocus?.isConnected)previousFocus.focus({preventScroll:true});resolve(null);}
  function alive(){if(closed)return false;try{seed.assertCurrent();if(isCurrent()!==true||!parent.isConnected||!dialog.isConnected)throw Error();return true;}catch(_){dispose();return false;}}
  const validRange=()=>Number.isSafeInteger(Number(range.value))&&Number(range.value)>=1&&Number(range.value)<=9;
  function controls(){
    const blocked=!session||historyWorking||!!pendingSnapshot;
    send.disabled=busy?closing:saving||closing||blocked||!systemPrompt.trim()||!profile.value||!question.value.trim()||!validRange();
    const action=busy?'stop':'send';if(send.dataset.paAction!==action){send.dataset.paAction=action;icon(send,busy?'停止':'发送',action);}save.disabled=busy||saving||closing||!profile.value||!validRange();
    clear.disabled=busy||saving||closing||blocked;retry.disabled=historyWorking||closing;closeButton.disabled=closing;
    for(const element of [profile,range,url,model,key,eye])element.disabled=busy||saving||closing;dialog.setAttribute('aria-busy',String(busy||saving||historyWorking));
  }
  function historyFailure(cause){historyNotice.textContent=/^prose_assistant_history_/.test(cause?.code||'')?String(cause.message).slice(0,240):'对话保存未确认，请保留本页内容并重试';}
  async function loadHistory(){
    historyWorking=true;retry.hidden=true;controls();
    try{const loaded=await historyFactory({source:seed,isCurrent:alive});if(!alive()){loaded.close();return;}history=loaded;session=createProseAssistantSession({key:seed.key,isCurrent:alive,onChange:render,initialHistory:history.initialHistory()});render(session.view());historyNotice.textContent='';}
    catch(cause){if(alive()){historyFailure(cause);icon(retry,'重新读取','retry');retry.hidden=false;}}
    finally{historyWorking=false;if(alive())controls();}
  }
  function persistHistory(snapshot,clearAfter=false){
    if(historyTask)return historyTask;if(!alive()||!history)return Promise.resolve(false);if(!pendingSnapshot){pendingSnapshot=snapshot;pendingClear=clearAfter;}
    historyWorking=true;retry.hidden=true;controls();
    historyTask=Promise.resolve().then(()=>history.status().dirty?history.retry():history.save(pendingSnapshot)).then(()=>{
      if(!alive())return false;if(pendingClear)session.clear();pendingSnapshot=null;pendingClear=false;historyNotice.textContent='';return true;
    }).catch(cause=>{if(alive()){historyFailure(cause);icon(retry,'重试保存','retry');retry.hidden=history.status().code==='prose_assistant_history_conflict';}return false;}).finally(()=>{historyTask=null;historyWorking=false;if(alive())controls();});return historyTask;
  }
  async function requestClose(){
    if(!alive()||closing)return;closing=true;controls();
    try{if(busy){sequence++;session?.stop();busy=false;if(session)await persistHistory(session.view());}else if(historyTask)await historyTask;
      if(!alive())return;if(pendingSnapshot&&!await confirm('还有未确认保存的对话。关闭前可先复制留存，仍要关闭？'))return;if(alive())dispose();
    }catch(_){}finally{closing=false;if(alive())controls();}
  }
  function render(snapshot){
    if(!alive())return;busy=snapshot.busy;const stick=main.scrollHeight-main.scrollTop-main.clientHeight<64;
    for(const row of snapshot.rows){let entry=rows.get(row.id);if(!entry){const article=node('article'),user=node('p'),reply=node('pre'),label=node('small'),copyButton=button('复制回复','copy');article.dataset.paTurn=String(row.id);user.className='qm-pa-user';reply.className='qm-pa-reply';article.append(user,reply,label,copyButton);transcript.append(article);entry={article,user,reply,label,copyButton};rows.set(row.id,entry);}
      if(entry.user.textContent!==row.user)entry.user.textContent=row.user;if(entry.reply.textContent!==row.assistant)entry.reply.textContent=row.assistant;
      entry.label.textContent={running:'回复中…',complete:'',failed:'回复未完成',cancelled:'已停止'}[row.status];entry.copyButton.disabled=!row.assistant;
    }
    const ids=new Set(snapshot.rows.map(row=>row.id));for(const [id,entry] of rows)if(!ids.has(id)){entry.article.remove();rows.delete(id);}controls();if(stick)main.scrollTop=main.scrollHeight;
  }
  const selectedConnection=()=>profile.value==='custom'?{mode:'custom',transport:'st-proxy',connection:{...selection?.connection,apiUrl:url.value,model:model.value,apiKey:key.value}}:{mode:'profile',profileId:profile.value.slice(8),transport:'st-proxy'};
  async function saveConnection(){
    if(!alive()||busy||saving||closing||!preferences||save.disabled)return;const token=sequence;saving=true;controls();
    try{const result=await saveProseAssistantConnection({selection:selectedConnection(),referenceFloors:Number(range.value),...preferences,guard:()=>seed.guard(),isCurrent:()=>alive()&&token===sequence});if(alive()&&token===sequence)status.textContent=result.status==='applied'?'设置已应用':result.status==='reverted'?'保存未确认，已恢复原设置':'设置未确认保存，请重试';}
    catch(cause){if(alive()&&token===sequence)status.textContent=/^prose_assistant_/.test(cause?.code||'')?String(cause.message).slice(0,240):'设置未确认保存，请重试';}finally{saving=false;if(alive())controls();}
  }
  async function submit(){
    if(!alive()||busy)return;controls();if(send.disabled)return;const token=++sequence,value=question.value,before=session.view().rows.length;busy=true;controls();status.textContent='';
    try{await seed.guard();if(!alive()||token!==sequence)return;
      const count=Number(range.value),requestedSource=sourceFactory?await sourceFactory(count):{...source,floor:source.getContext().chat.findLastIndex(message=>message&&!message.is_system),range:undefined,previousFloors:count-1};
      if(!alive()||token!==sequence)return;
      const request=createProseAssistantRequest({selection:selectedConnection(),profiles,getRequestHeaders,fetchImpl,compileMessages:args=>compileProseAssistantMessages({...args,systemPrompt})});
      await session.run({question:value,source:requestedSource,request:request.send});
      if(alive()&&token===sequence){if(question.value===value)question.value='';controls();}
    }catch(cause){if(alive()&&token===sequence){busy=false;controls();status.textContent=/^prose_assistant_/.test(cause?.code||'')?String(cause.message).slice(0,240):'正文助手暂不可用，请重试';}}
    finally{if(alive()&&token===sequence){busy=false;controls();const snapshot=session.view();if(!snapshot.busy&&snapshot.rows.length>before)await persistHistory(snapshot);}}
  }
  function showSettings(open){config.hidden=!open;main.hidden=open;composer.hidden=open;settingsButton.hidden=open;back.hidden=!open;title.textContent=open?'助手设置':'正文助手';}
  listen(dialog,'click',event=>{
    event.stopPropagation(); // Closing may remove the later isolation listeners synchronously.
    const action=event.target.closest?.('[data-pa-action]')?.dataset.paAction;if(action==='close'){void requestClose();return;}if(!alive())return;
    if(action==='settings')showSettings(true);else if(action==='back')showSettings(false);
    else if(action==='retry-history'){if(!historyWorking&&!closing)void(history?persistHistory(pendingSnapshot):loadHistory());}
    else if(action==='save-connection')void saveConnection();else if(action==='send')void submit();else if(action==='stop'){sequence++;session?.stop();busy=false;controls();status.textContent='';if(session)void persistHistory(session.view());}
    else if(action==='eye'){key.type=key.type==='password'?'text':'password';icon(eye,key.type==='password'?'显示 Key':'隐藏 Key','eye');}
    else if(action==='clear')void(async()=>{if(clear.disabled)return;const token=sequence;if(await confirm('清空当前聊天的助手对话？不会删除正文。')&&alive()&&token===sequence&&!clear.disabled){sequence++;await persistHistory({...session.view(),rows:[]},true);}})().catch(()=>{});
    else if(action==='copy'){const id=Number(event.target.closest('[data-pa-turn]')?.dataset.paTurn),value=rows.get(id)?.reply.textContent;if(value)void Promise.resolve().then(()=>{if(alive())return copy(value);}).then(result=>{if(result===false)throw Error();}).catch(()=>{if(alive())status.textContent='复制失败，请手动选择文本';});}
  });
  listen(profile,'change',()=>{custom.hidden=profile.value!=='custom';controls();});listen(range,'input',controls);listen(question,'input',controls);
  listen(question,'keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&!event.isComposing){event.preventDefault();void submit();}});
  listen(dialog,'keydown',event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();if(!config.hidden)showSettings(false);else void requestClose();}});
  for(const event of ['pointerdown','pointerup','mousedown','mouseup','touchstart','click'])listen(dialog,event,value=>value.stopPropagation());listen(view,'pagehide',dispose);
  parent.append(dialog);disposeWindow=bindProseAssistantWindow(dialog,{handle:header,storageKey:'qianmu-assistant-window:'+seed.scope.namespace});
  observer=new view.MutationObserver(()=>{if(!closed)alive();});observer.observe(document.documentElement,{childList:true,subtree:true});controls();dialog.focus({preventScroll:true});await loadHistory();
  return Object.freeze({element:dialog,finished,dispose});
}
