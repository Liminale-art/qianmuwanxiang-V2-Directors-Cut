import {captureProseAssistantChatSource} from './qianmu-prose-assistant-source.js';
import {createProseAssistantSession} from './qianmu-prose-assistant-session.js';
import {createProseAssistantRequest} from './qianmu-prose-assistant-request.js';
import {compileProseAssistantMessages} from './qianmu-prose-assistant-messages.js';
import {saveProseAssistantConnection,createProseAssistantAutosave} from './qianmu-prose-assistant-preferences.js';
import {openProseAssistantHistory} from './qianmu-prose-assistant-history-runtime.js';
import {bindProseAssistantWindow} from './qianmu-prose-assistant-window.js';
import {qianmuIconElement} from './qianmu-icon-renderer.js';

// Non-modal conversation window; opening it never reads or displays prose.
export async function openProseAssistantPanel({parent,source,sourceFactory,profiles=[],selection,referenceFloors=3,systemPrompt='',getRequestHeaders,fetchImpl,copy,confirm,isCurrent,preferences,applyIcons,historyFactory=openProseAssistantHistory}={}){
  const document=parent?.ownerDocument,view=document?.defaultView;
  if(!parent?.isConnected||!view||!Array.isArray(profiles)||typeof systemPrompt!=='string'||typeof isCurrent!=='function'||typeof copy!=='function'||typeof confirm!=='function'||typeof historyFactory!=='function')throw TypeError('场外特助面板环境不可用');
  const seed=await captureProseAssistantChatSource(source);
  if(!parent.isConnected||isCurrent()!==true){seed.close();throw Error('场外特助页面已变化');}
  const previousFocus=document.activeElement,dialog=document.createElement('section');dialog.className='qm-prose-assistant-dialog';dialog.tabIndex=-1;dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','false');dialog.setAttribute('aria-label','场外特助');
  let closed=false,busy=false,saving=false,closing=false,sequence=0,resolve,session,observer,history,historyTask=null,historyWorking=true,pendingSnapshot=null,pendingClear=false,disposeWindow,autosave;
  const listeners=[],rows=new Map(),finished=new Promise(done=>{resolve=done;});
  const node=(tag,value)=>{const element=document.createElement(tag);if(value!==undefined)element.textContent=value;return element;};
  const icons={close:'xmark',settings:'gear',back:'arrow-left',send:'arrow-up',stop:'stop',clear:'trash-can',copy:'copy',eye:'eye',save:'check',retry:'rotate-right',resize:'up-right-and-down-left-from-center'};
  const icon=(element,label,name)=>{element.replaceChildren();const glyph=qianmuIconElement('fa-'+(icons[name]||name),{document});if(glyph)element.append(glyph);element.title=label;element.setAttribute('aria-label',label);};
  const button=(label,action,name=action)=>{const element=node('button');element.type='button';element.dataset.paAction=action;icon(element,label,name);return element;};
  const field=(label,element)=>{const wrapper=node('label');wrapper.append(node('span',label),element);return wrapper;};
  const option=(select,value,label)=>{const item=node('option',label);item.value=value;select.append(item);};
  const listen=(element,type,handler)=>{element.addEventListener(type,handler);listeners.push(()=>element.removeEventListener(type,handler));};
  const header=node('header'),title=node('strong','场外特助'),headerActions=node('div'),settingsButton=button('特助设置','settings'),back=button('返回对话','back'),closeButton=button('关闭','close');back.hidden=true;headerActions.append(back,settingsButton,closeButton);header.append(title,headerActions);
  const main=node('main'),transcript=node('section');transcript.dataset.paTranscript='';transcript.setAttribute('aria-label','助手对话');main.append(transcript);
  const config=node('section'),grid=node('div'),profile=node('select'),range=node('input');config.dataset.paSettings='';config.hidden=true;grid.className='qm-pa-config';
  profile.setAttribute('aria-label','助手API预设');option(profile,'','请选择预设');for(const entry of profiles)if(entry&&typeof entry.id==='string')option(profile,'profile:'+entry.id,String(entry.name||entry.id));option(profile,'custom','专用连接');
  range.type='number';range.min='0';range.max='9';range.step='1';range.value=String(Number.isSafeInteger(referenceFloors)&&referenceFloors>=0&&referenceFloors<=9?referenceFloors:3);range.setAttribute('aria-label','参考楼层数');
  const custom=node('div');custom.className='qm-pa-custom';const url=node('input'),model=node('input'),key=node('input'),keyRow=node('div'),eye=button('显示 Key','eye');
  url.type='url';url.placeholder='https://…/v1';url.setAttribute('aria-label','助手API地址');model.setAttribute('aria-label','助手模型');key.type='password';key.autocomplete='off';key.setAttribute('aria-label','助手API Key');keyRow.className='qm-pa-key';keyRow.append(key,eye);custom.append(field('API 地址',url),field('模型',model),field('API Key',keyRow));
  const persona=node('textarea');persona.value=systemPrompt;persona.rows=5;persona.maxLength=20000;persona.setAttribute('aria-label','助手提示词');
  grid.append(field('API 预设',profile),custom,field('参考楼层（含USER，0为不发送）',range));config.append(grid);
  if(selection?.mode==='profile')profile.value='profile:'+selection.profileId;
  if(selection?.mode==='custom'){profile.value='custom';url.value=selection.connection?.apiUrl||'';model.value=selection.connection?.model||'';key.value=selection.connection?.apiKey||'';}custom.hidden=profile.value!=='custom';
  const footer=node('footer'),question=node('textarea'),status=node('p'),historyNotice=node('p'),retry=button('重试保存','retry-history','retry'),clear=button('清空当前对话记录','clear'),send=button('发送','send'),composer=node('div');
  clear.textContent='清空当前对话记录';grid.append(clear,field('助手提示词',persona));
  question.rows=1;question.maxLength=20000;question.setAttribute('aria-label','向场外特助提问');question.dataset.paQuestion='';
  status.dataset.paStatus='';status.setAttribute('role','status');status.setAttribute('aria-live','polite');historyNotice.dataset.paHistory='';historyNotice.setAttribute('role','status');retry.hidden=true;
  composer.className='qm-pa-composer';composer.append(question,send);footer.append(historyNotice,retry,status,composer);
  const resize=node('span');resize.dataset.paResize='';resize.tabIndex=0;resize.setAttribute('role','separator');resize.setAttribute('aria-label','调整窗口大小');dialog.append(header,main,config,footer,resize);
  function dispose(){if(closed)return;const restoreFocus=dialog.contains(document.activeElement);closed=true;sequence++;autosave?.close();session?.close();history?.close();seed.close();disposeWindow?.();observer?.disconnect();listeners.splice(0).forEach(remove=>remove());key.value='';question.value='';rows.clear();dialog.remove();if(restoreFocus&&previousFocus?.isConnected)previousFocus.focus({preventScroll:true});resolve(null);}
  function alive(){if(closed)return false;try{seed.assertCurrent();if(isCurrent()!==true||!parent.isConnected||!dialog.isConnected)throw Error();return true;}catch(_){dispose();return false;}}
  const validRange=()=>range.value!==''&&Number.isSafeInteger(Number(range.value))&&Number(range.value)>=0&&Number(range.value)<=9;
  function controls(){
    const blocked=!session||historyWorking||!!pendingSnapshot;
    send.disabled=busy?closing:saving||closing||blocked||!profile.value||!question.value.trim()||!validRange();
    const action=busy?'stop':'send';if(send.dataset.paAction!==action){send.dataset.paAction=action;icon(send,busy?'停止':'发送',action);}
    clear.disabled=busy||saving||closing||blocked;retry.disabled=historyWorking||closing;closeButton.disabled=closing;
    for(const element of [profile,range,url,model,key,eye,persona])element.disabled=busy||closing||(element===range&&seed.scope.offstage===true);dialog.setAttribute('aria-busy',String(busy||saving||historyWorking));
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
      if(!alive())return;if(autosave&&!await autosave.flush()){status.textContent='设置尚未保存，当前输入已保留，请稍后再试。';return;}if(pendingSnapshot&&!await confirm('还有未确认保存的对话。关闭前可先复制留存，仍要关闭？'))return;if(alive())dispose();
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
  const selectedConnection=()=>!profile.value?null:profile.value==='custom'?{mode:'custom',transport:'st-proxy',connection:{...selection?.connection,apiUrl:url.value,model:model.value,apiKey:key.value}}:{mode:'profile',profileId:profile.value.slice(8),transport:'st-proxy'};
  if(preferences)autosave=createProseAssistantAutosave({read:()=>{if(!validRange())throw Error('range');return {selection:selectedConnection(),referenceFloors:Number(range.value),systemPrompt:persona.value};},
    save:draft=>saveProseAssistantConnection({...draft,...preferences,allowIncomplete:true,guard:()=>seed.guard(),isCurrent:alive}),isCurrent:alive,
    onStatus:state=>{saving=state.saving;if(!alive())return;if(state.failed)status.textContent='设置尚未保存，当前输入已保留，请稍后再试。';else if(!state.dirty)status.textContent='';controls();}});
  async function submit(){
    if(!alive()||busy)return;controls();if(send.disabled)return;const token=++sequence,value=question.value,before=session.view().rows.length;busy=true;controls();status.textContent='';
    try{await seed.guard();if(!alive()||token!==sequence)return;
      if(autosave&&!await autosave.flush())throw Object.assign(Error('设置尚未保存，请稍后重试。'),{code:'prose_assistant_preferences'});
      const count=seed.scope.offstage?0:Number(range.value),requestedSource=count===0?{...source,referenceFloors:0,previousFloors:0}:sourceFactory?await sourceFactory(count):{...source,floor:source.getContext().chat.findLastIndex(message=>message&&!message.is_system),range:undefined,referenceFloors:count,previousFloors:count-1};
      if(!alive()||token!==sequence)return;
      const prompt=persona.value,request=createProseAssistantRequest({selection:selectedConnection(),profiles,getRequestHeaders,fetchImpl,compileMessages:args=>compileProseAssistantMessages({...args,systemPrompt:prompt})});
      await session.run({question:value,source:requestedSource,request:request.send});
      if(alive()&&token===sequence){if(question.value===value)question.value='';controls();}
    }catch(cause){if(alive()&&token===sequence){busy=false;controls();status.textContent=/^prose_assistant_/.test(cause?.code||'')?String(cause.message).slice(0,240):'场外特助暂不可用，请重试';}}
    finally{if(alive()&&token===sequence){busy=false;controls();const snapshot=session.view();if(!snapshot.busy&&snapshot.rows.length>before)await persistHistory(snapshot);}}
  }
  function showSettings(open){config.hidden=!open;main.hidden=open;composer.hidden=open;settingsButton.hidden=open;back.hidden=!open;title.textContent=open?'特助设置':'场外特助';}
  listen(dialog,'click',event=>{
    event.stopPropagation(); // Closing may remove the later isolation listeners synchronously.
    const action=event.target.closest?.('[data-pa-action]')?.dataset.paAction;if(action==='close'){void requestClose();return;}if(!alive())return;
    if(action==='settings')showSettings(true);else if(action==='back')showSettings(false);
    else if(action==='retry-history'){if(!historyWorking&&!closing)void(history?persistHistory(pendingSnapshot):loadHistory());}
    else if(action==='send')void submit();else if(action==='stop'){sequence++;session?.stop();busy=false;controls();status.textContent='';if(session)void persistHistory(session.view());}
    else if(action==='eye'){key.type=key.type==='password'?'text':'password';icon(eye,key.type==='password'?'显示 Key':'隐藏 Key','eye');}
    else if(action==='clear'){if(!clear.disabled){sequence++;void persistHistory({...session.view(),rows:[]},true);}}
    else if(action==='copy'){const id=Number(event.target.closest('[data-pa-turn]')?.dataset.paTurn),value=rows.get(id)?.reply.textContent;if(value)void Promise.resolve().then(()=>{if(alive())return copy(value);}).then(result=>{if(result===false)throw Error();}).catch(()=>{if(alive())status.textContent='复制失败，请手动选择文本';});}
  });
  const settingsChanged=()=>{autosave?.change();controls();};
  listen(profile,'change',()=>{custom.hidden=profile.value!=='custom';settingsChanged();});for(const element of [range,url,model,key,persona])listen(element,'input',settingsChanged);listen(question,'input',controls);
  listen(question,'keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&!event.isComposing){event.preventDefault();void submit();}});
  listen(dialog,'keydown',event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();if(!config.hidden)showSettings(false);else void requestClose();}});
  for(const event of ['pointerdown','pointerup','mousedown','mouseup','touchstart','click'])listen(dialog,event,value=>value.stopPropagation());listen(view,'pagehide',dispose);
  listen(view,'beforeunload',event=>{if(autosave?.state().dirty){event.preventDefault();event.returnValue='';}});
  parent.append(dialog);disposeWindow=bindProseAssistantWindow(dialog,{handle:header,storageKey:'qianmu-assistant-window:'+seed.scope.namespace});
  observer=new view.MutationObserver(()=>{if(!closed)alive();});observer.observe(document.documentElement,{childList:true,subtree:true});controls();dialog.focus({preventScroll:true});await loadHistory();
  return Object.freeze({element:dialog,finished,dispose});
}
