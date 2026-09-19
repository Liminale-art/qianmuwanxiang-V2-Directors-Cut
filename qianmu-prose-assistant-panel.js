import {captureProseAssistantSource} from './qianmu-prose-assistant-source.js';
import {createProseAssistantSession} from './qianmu-prose-assistant-session.js';
import {createProseAssistantRequest} from './qianmu-prose-assistant-request.js';
import {compileProseAssistantMessages} from './qianmu-prose-assistant-messages.js';
import {createPlainTextRangeMapper} from './qianmu-plain-text-range.js';
import {saveProseAssistantConnection} from './qianmu-prose-assistant-preferences.js';
import {openProseAssistantHistory} from './qianmu-prose-assistant-history-runtime.js';

// Explicit panel; host settings scheduling is injected, conversation remains local.
export async function openProseAssistantPanel({parent,source,profiles=[],selection,systemPrompt='',getRequestHeaders,fetchImpl,copy,confirm,isCurrent,preferences}={}){
  const document=parent?.ownerDocument,view=document?.defaultView;
  if(!parent?.isConnected||!view||!Array.isArray(profiles)||typeof systemPrompt!=='string'||typeof isCurrent!=='function'||typeof copy!=='function'||typeof confirm!=='function')throw TypeError('正文助手面板环境不可用');
  const seed=await captureProseAssistantSource({...source,range:undefined});
  if(!parent.isConnected||isCurrent()!==true){seed.close();throw Error('正文助手页面已变化');}
  const text=seed.reference.text,mapper=createPlainTextRangeMapper(text),previousFocus=document.activeElement;
  const dialog=document.createElement('dialog');dialog.className='qm-prose-assistant-dialog';dialog.setAttribute('aria-label','正文助手');
  let closed=false,busy=false,saving=false,closing=false,sequence=0,resolve,session,observer,history,historyTask=null,historyWorking=true,pendingSnapshot=null,pendingClear=false;const listeners=[],rows=new Map(),finished=new Promise(done=>{resolve=done;});
  let start=source.range?.start??0,end=source.range?.end??text.length;
  const node=(tag,value)=>{const element=document.createElement(tag);if(value!==undefined)element.textContent=value;return element;};
  const button=(label,action)=>{const element=node('button',label);element.type='button';element.dataset.paAction=action;return element;};
  const field=(label,element)=>{const wrapper=node('label');wrapper.append(node('span',label),element);return wrapper;};
  const option=(select,value,label)=>{const item=node('option',label);item.value=value;select.append(item);};
  const listen=(element,type,handler)=>{element.addEventListener(type,handler);listeners.push(()=>element.removeEventListener(type,handler));};
  const header=node('header');header.append(node('strong','正文助手'),button('关闭','close'));
  const main=node('main'),reference=node('details'),refTitle=node('summary'),mode=node('select'),preview=node('textarea');
  reference.dataset.paReference='';reference.open=true;option(mode,'floor','本层全文');option(mode,'selection','选择片段');mode.value=source.range?'selection':'floor';mode.setAttribute('aria-label','引用范围');
  const scopeNotice=node('p');scopeNotice.dataset.paScope='';
  preview.value=text;preview.readOnly=true;preview.spellcheck=false;preview.setAttribute('aria-label','选择引用正文');preview.dataset.paPreview='';reference.append(refTitle,mode,scopeNotice,preview);
  const config=node('details'),configTitle=node('summary','助手连接'),grid=node('div'),profile=node('select'),transport=node('select');grid.className='qm-pa-config';config.open=true;
  profile.setAttribute('aria-label','助手API预设');option(profile,'','请选择预设');
  for(const entry of profiles)if(entry&&typeof entry.id==='string')option(profile,'profile:'+entry.id,String(entry.name||entry.id));option(profile,'custom','专用连接');
  transport.setAttribute('aria-label','请求路径');option(transport,'st-proxy','经 ST 转发');option(transport,'direct','浏览器直连');
  const custom=node('div');custom.className='qm-pa-custom';
  const url=node('input'),model=node('input'),key=node('input'),keyRow=node('div'),eye=button('显示','eye');
  url.type='url';url.placeholder='https://…/v1';url.setAttribute('aria-label','助手API地址');model.setAttribute('aria-label','助手模型');key.type='password';key.autocomplete='off';key.setAttribute('aria-label','助手API Key');
  keyRow.className='qm-pa-key';keyRow.append(key,eye);custom.append(field('API 地址',url),field('模型',model),field('API Key',keyRow));
  const save=button('保存连接','save-connection');save.hidden=!preferences;
  grid.append(field('API 预设',profile),field('请求路径',transport),custom);config.append(configTitle,grid,save);
  if(selection?.mode==='profile')profile.value='profile:'+selection.profileId;
  if(selection?.mode==='custom'){profile.value='custom';url.value=selection.connection?.apiUrl||'';model.value=selection.connection?.model||'';key.value=selection.connection?.apiKey||'';}
  if(['st-proxy','direct'].includes(selection?.transport))transport.value=selection.transport;custom.hidden=profile.value!=='custom';
  const transcript=node('section');transcript.dataset.paTranscript='';transcript.setAttribute('aria-label','助手对话');main.append(reference,config,transcript);
  const footer=node('footer'),question=node('textarea'),notice=node('p'),status=node('p'),actions=node('div'),send=button('发送','send'),stop=button('停止','stop');
  question.rows=3;question.maxLength=20000;question.placeholder='与助手聊聊这段正文…';question.setAttribute('aria-label','向正文助手提问');question.dataset.paQuestion='';
  notice.className='qm-pa-notice';notice.textContent=(systemPrompt.trim()?'':'系统提示词尚未配置，暂不能发送。')+(preferences?'连接需点击保存才保留；专用 Key 不进入配置导出。':'此处连接临时保留。')+'终态对话按账户与聊天保存在本浏览器，不写入正文、不跨设备同步；刷新或强制离开可能丢失未保存内容。';
  const historyNotice=node('p'),retry=button('重试保存','retry-history'),clear=button('清空对话','clear');historyNotice.dataset.paHistory='';historyNotice.setAttribute('role','status');historyNotice.textContent='正在读取本机助手历史…';retry.hidden=true;
  status.dataset.paStatus='';status.setAttribute('role','status');status.setAttribute('aria-live','polite');actions.className='qm-pa-actions';actions.append(clear,stop,send);footer.append(notice,historyNotice,retry,question,status,actions);dialog.append(header,main,footer);
  function dispose(){if(closed)return;closed=true;sequence++;session?.close();history?.close();seed.close();observer?.disconnect();listeners.splice(0).forEach(remove=>remove());key.value='';question.value='';rows.clear();if(dialog.open)dialog.close();dialog.remove();if(previousFocus?.isConnected)previousFocus.focus({preventScroll:true});resolve(null);}
  function alive(){if(closed)return false;try{seed.assertCurrent();if(isCurrent()!==true||!parent.isConnected||!dialog.isConnected)throw Error();return true;}catch(_){dispose();return false;}}
  const rangeValid=()=>mode.value==='floor'||mapper.isBoundary(start)&&mapper.isBoundary(end)&&end>start&&text.slice(start,end).trim();
  function controls(){
    refTitle.textContent=`第 ${seed.reference.floor+1} 层 · ${mode.value==='floor'?'全文':`已选 ${Math.max(0,end-start)} 字符`} · 最多参考前 2 层`;
    const historyBlocked=!session||historyWorking||!!pendingSnapshot;
    send.disabled=busy||saving||closing||historyBlocked||!systemPrompt.trim()||!profile.value||!question.value.trim()||!rangeValid();stop.disabled=!busy;save.disabled=busy||saving||closing||!profile.value;
    clear.disabled=busy||saving||closing||historyBlocked;retry.disabled=historyWorking||closing;header.querySelector('button').disabled=closing;
    for(const element of [profile,transport,mode,preview,url,model,key,eye])element.disabled=busy||saving||closing;dialog.setAttribute('aria-busy',String(busy||saving||historyWorking));
  }
  function historyFailure(cause){historyNotice.textContent=/^prose_assistant_history_/.test(cause?.code||'')?String(cause.message).slice(0,240):'助手历史未确认保存，请保留本页内容并重试';}
  async function loadHistory(){
    historyWorking=true;retry.hidden=true;controls();
    try{
      const loaded=await openProseAssistantHistory({source:seed,isCurrent:alive});if(!alive()){loaded.close();return;}
      history=loaded;session=createProseAssistantSession({key:seed.key,isCurrent:alive,onChange:render,initialHistory:history.initialHistory()});render(session.view());historyNotice.textContent='本机历史已读取；不会自动重发请求';
    }catch(cause){if(alive()){historyFailure(cause);retry.textContent='重新读取';retry.hidden=false;}}
    finally{historyWorking=false;if(alive())controls();}
  }
  function persistHistory(snapshot,clearAfter=false){
    if(historyTask)return historyTask;if(!alive()||!history)return Promise.resolve(false);
    if(!pendingSnapshot){pendingSnapshot=snapshot;pendingClear=clearAfter;}
    historyWorking=true;retry.hidden=true;historyNotice.textContent=pendingClear?'正在确认清空本机对话…':'正在保存本机对话…';controls();
    historyTask=Promise.resolve().then(()=>history.status().dirty?history.retry():history.save(pendingSnapshot)).then(()=>{
      if(!alive())return false;if(pendingClear)session.clear();pendingSnapshot=null;pendingClear=false;historyNotice.textContent='本机对话已保存';return true;
    }).catch(cause=>{if(alive()){historyFailure(cause);retry.textContent='重试保存';retry.hidden=history.status().code==='prose_assistant_history_conflict';}return false;}).finally(()=>{historyTask=null;historyWorking=false;if(alive())controls();});return historyTask;
  }
  async function requestClose(){
    if(!alive()||closing)return;closing=true;controls();
    try{
      if(busy){sequence++;session?.stop();busy=false;if(session)await persistHistory(session.view());}
      else if(historyTask)await historyTask;
      if(!alive())return;
      if(pendingSnapshot&&!await confirm('尚有未确认保存的助手对话，关闭会丢失本页未存内容。建议先复制需要的文字。仍要关闭？'))return;
      if(alive())dispose();
    }catch(_){/* A failed confirmation never grants permission to discard. */}
    finally{closing=false;if(alive())controls();}
  }
  function render(snapshot){
    if(!alive())return;busy=snapshot.busy;const stick=main.scrollHeight-main.scrollTop-main.clientHeight<64;
    for(const row of snapshot.rows){let entry=rows.get(row.id);if(!entry){const article=node('article'),user=node('p'),reply=node('pre'),label=node('small'),copyButton=button('复制回复','copy');article.dataset.paTurn=String(row.id);article.append(user,label,reply,copyButton);transcript.append(article);entry={article,user,reply,label,copyButton};rows.set(row.id,entry);}
      if(entry.user.textContent!==row.user)entry.user.textContent=row.user;if(entry.reply.textContent!==row.assistant)entry.reply.textContent=row.assistant;
      entry.label.textContent={running:'回复中',complete:'已完成',failed:'未完成 · 不纳入后续历史',cancelled:'已停止 · 不纳入后续历史'}[row.status];entry.copyButton.disabled=!row.assistant;
    }
    const ids=new Set(snapshot.rows.map(row=>row.id));for(const [id,entry] of rows)if(!ids.has(id)){entry.article.remove();rows.delete(id);}
    controls();if(stick)main.scrollTop=main.scrollHeight;
  }
  function captureSelection(){if(!alive()||busy||mode.value!=='selection'||document.activeElement!==preview)return;start=mapper.toSource(preview.selectionStart);end=mapper.toSource(preview.selectionEnd);controls();}
  const selectedConnection=()=>profile.value==='custom'?{mode:'custom',transport:transport.value,connection:{...selection?.connection,apiUrl:url.value,model:model.value,apiKey:key.value}}:{mode:'profile',profileId:profile.value.slice(8),transport:transport.value};
  async function saveConnection(){
    if(!alive()||busy||saving||closing||!preferences||!profile.value)return;const token=sequence;saving=true;controls();status.textContent='正在核对连接设置…';
    try{
      const result=await saveProseAssistantConnection({selection:selectedConnection(),...preferences,guard:()=>seed.guard(),isCurrent:()=>alive()&&token===sequence});
      if(alive()&&token===sequence)status.textContent=result.status==='applied'?'连接已应用并请求保存；未进行连通测试':result.status==='reverted'?'本页已恢复原连接；保存结果未确认，请核对后重试':'连接未确认保存，请保留填写内容并检查设置';
    }catch(cause){if(alive()&&token===sequence)status.textContent=/^prose_assistant_/.test(cause?.code||'')?String(cause.message).slice(0,240):'连接未确认保存，请核对后重试';}
    finally{saving=false;if(alive())controls();}
  }
  async function submit(){
    if(!alive()||busy)return;captureSelection();controls();if(send.disabled)return;const token=++sequence,value=question.value;
    const selected=selectedConnection();
    const requestedSource={...source,range:mode.value==='selection'?{start,end}:undefined},before=session.view().rows.length;busy=true;controls();status.textContent='正在核对引用…';historyNotice.textContent='本轮尚未保存，回复结束或停止后保存';
    try{
      await seed.guard();if(!alive()||token!==sequence)return;
      const request=createProseAssistantRequest({selection:selected,profiles,getRequestHeaders,fetchImpl,compileMessages:args=>{
        if(alive()){const summary=args.context.summary;scopeNotice.textContent=`实际参考前文：${summary.previousIncluded.map(floor=>floor+1).join('、')||'无'}；历史问答 ${summary.historyPairs} 组${summary.previousOmitted.length?`；另有 ${summary.previousOmitted.length} 层未纳入`:''}`;}
        return compileProseAssistantMessages({...args,systemPrompt});
      }});
      busy=true;controls();status.textContent='正在回复…';
      await session.run({question:value,source:requestedSource,request:request.send});
      if(alive()&&token===sequence){status.textContent='回复已完成';if(question.value===value)question.value='';controls();}
    }catch(cause){if(alive()&&token===sequence){busy=false;controls();status.textContent=/^prose_assistant_/.test(cause?.code||'')?String(cause.message).slice(0,240):'正文助手暂不可用，请重新打开后重试';}}
    finally{if(alive()&&token===sequence){const snapshot=session.view();if(!snapshot.busy&&snapshot.rows.length>before)await persistHistory(snapshot);else historyNotice.textContent='本机历史未改变';}}
  }
  listen(dialog,'click',event=>{
    const action=event.target.closest?.('[data-pa-action]')?.dataset.paAction;if(action==='close'){void requestClose();return;}if(!alive())return;
    if(action==='retry-history'){if(!historyWorking&&!closing)void(history?persistHistory(pendingSnapshot):loadHistory());}
    else if(action==='save-connection')void saveConnection();else if(action==='send')void submit();else if(action==='stop'){sequence++;session.stop();busy=false;controls();status.textContent='已停止等待；已收到的内容保留供复制';void persistHistory(session.view());}
    else if(action==='eye'){key.type=key.type==='password'?'text':'password';eye.textContent=key.type==='password'?'显示':'隐藏';}
    else if(action==='clear')void(async()=>{if(clear.disabled)return;const token=sequence;if(await confirm('清空当前聊天在本浏览器的助手对话？不会删除正式聊天。')&&alive()&&token===sequence&&!clear.disabled){sequence++;if(await persistHistory({...session.view(),rows:[]},true))status.textContent='对话已清空';}})().catch(()=>{});
    else if(action==='copy'){const id=Number(event.target.closest('[data-pa-turn]')?.dataset.paTurn),value=rows.get(id)?.reply.textContent;if(value)void Promise.resolve().then(()=>{if(alive())return copy(value);}).then(result=>{if(result===false)throw Error();if(alive())status.textContent='已复制回复';}).catch(()=>{if(alive())status.textContent='复制失败，请手动选择文本';});}
  });
  listen(mode,'change',()=>{start=0;end=mode.value==='floor'?text.length:0;controls();if(mode.value==='selection'){preview.focus({preventScroll:true});preview.setSelectionRange(0,0);}});
  listen(profile,'change',()=>{custom.hidden=profile.value!=='custom';controls();});listen(question,'input',controls);
  listen(question,'keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&!event.isComposing){event.preventDefault();void submit();}});
  for(const name of ['select','keyup','pointerup','touchend'])listen(preview,name,captureSelection);listen(send,'pointerdown',captureSelection);
  listen(dialog,'cancel',event=>{event.preventDefault();void requestClose();});listen(dialog,'close',dispose);listen(view,'pagehide',dispose);
  parent.append(dialog);observer=new view.MutationObserver(()=>{if(!closed)alive();});observer.observe(document.documentElement,{childList:true,subtree:true});controls();
  try{if(alive()){dialog.showModal();await loadHistory();}}catch(_){dispose();}
  return Object.freeze({element:dialog,finished,dispose});
}
