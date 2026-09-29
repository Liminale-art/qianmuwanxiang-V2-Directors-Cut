import {captureProseAssistantChatSource} from './qianmu-prose-assistant-source.js';
import {createProseAssistantSession,PROSE_ASSISTANT_SESSION_LIMITS as sessionLimits} from './qianmu-prose-assistant-session.js';
import {createProseAssistantRequest} from './qianmu-prose-assistant-request.js';
import {compileProseAssistantMessages} from './qianmu-prose-assistant-messages.js';
import {saveProseAssistantConnection,createProseAssistantAutosave} from './qianmu-prose-assistant-preferences.js';
import {openProseAssistantHistory} from './qianmu-prose-assistant-history-runtime.js';
import {bindProseAssistantWindow} from './qianmu-prose-assistant-window.js';
import {qianmuIconElement} from './qianmu-icon-renderer.js';
import {renderProseAssistantMarkdown} from './qianmu-prose-assistant-markdown.js';
import {createProseAssistantThreadKey} from './qianmu-prose-assistant-history-contract.js';
import {createProseAssistantConversationList} from './qianmu-prose-assistant-conversation-list.js';

// Non-modal conversation window; opening it never reads or displays prose.
export async function openProseAssistantPanel({parent,source,sourceFactory,profiles=[],selection,getProfileStream=()=>false,referenceFloors=3,systemPrompt='',getRequestHeaders,fetchImpl,copy,confirm,isCurrent,preferences,applyIcons,historyFactory=openProseAssistantHistory,conversationFactory,retainOnClose=false}={}){
  const document=parent?.ownerDocument,view=document?.defaultView;
  if(!parent?.isConnected||!view||!Array.isArray(profiles)||typeof systemPrompt!=='string'||typeof isCurrent!=='function'||typeof copy!=='function'||typeof confirm!=='function'||typeof historyFactory!=='function')throw TypeError('场外特助面板环境不可用');
  let seed;
  if(!parent.isConnected||isCurrent()!==true)throw Error('场外特助页面已变化');
  let previousFocus=document.activeElement;const dialog=document.createElement('section');dialog.className='qm-prose-assistant-dialog';dialog.tabIndex=-1;dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','false');dialog.setAttribute('aria-label','场外特助');
  let closed=false,busy=false,saving=false,closing=false,sequence=0,resolve,session,observer,observerCheckTimer=0,history,historyTask=null,historyWorking=true,pendingSnapshot=null,disposeWindow,autosave;
  let catalogue=null,currentConversation=null,catalogueWorking=false,catalogueRecovery=null,page='chat',closeTask=null,reopenTask=null;
  const listeners=[],rows=new Map(),finished=new Promise(done=>{resolve=done;});let activeQuestion=null,inputRevision=0,editing=null;
  const node=(tag,value)=>{const element=document.createElement(tag);if(value!==undefined)element.textContent=value;return element;};
  const icons={close:'xmark',settings:'gear',back:'arrow-left',send:'arrow-up',stop:'stop',conversations:'list-ul',copy:'copy',eye:'eye',save:'check',retry:'rotate-right',edit:'pen',resize:'up-right-and-down-left-from-center'};
  const icon=(element,label,name)=>{element.replaceChildren();const glyph=qianmuIconElement('fa-'+(icons[name]||name),{document});if(glyph)element.append(glyph);element.title=label;element.setAttribute('aria-label',label);};
  const button=(label,action,name=action)=>{const element=node('button');element.type='button';element.dataset.paAction=action;icon(element,label,name);return element;};
  const field=(label,element)=>{const wrapper=node('label');wrapper.append(node('span',label),element);return wrapper;};
  const option=(select,value,label)=>{const item=node('option',label);item.value=value;select.append(item);};
  const listen=(element,type,handler)=>{element.addEventListener(type,handler);listeners.push(()=>element.removeEventListener(type,handler));};
  const header=node('header'),title=node('strong','场外特助'),headerLeading=node('div'),headerActions=node('div'),listButton=button('最近对话','conversations'),settingsButton=button('特助设置','settings'),back=button('返回对话','back'),closeButton=button('关闭','close');back.hidden=true;listButton.hidden=!conversationFactory;headerLeading.append(back,listButton,title);headerActions.append(settingsButton,closeButton);header.append(headerLeading,headerActions);
  const main=node('main'),transcript=node('section');transcript.dataset.paTranscript='';transcript.setAttribute('aria-label','助手对话');main.append(transcript);
  const config=node('section'),grid=node('div'),profile=node('select'),range=node('input');config.dataset.paSettings='';config.hidden=true;grid.className='qm-pa-config';
  profile.setAttribute('aria-label','助手API预设');option(profile,'','请选择预设');for(const entry of profiles)if(entry&&typeof entry.id==='string')option(profile,'profile:'+entry.id,String(entry.name||entry.id));option(profile,'custom','自定义');
  range.type='number';range.min='0';range.max='9';range.step='1';range.value=String(Number.isSafeInteger(referenceFloors)&&referenceFloors>=0&&referenceFloors<=9?referenceFloors:3);range.setAttribute('aria-label','参考楼层数');
  let preferredReferenceFloors=Number(range.value);
  const custom=node('div');custom.className='qm-pa-custom';const url=node('input'),model=node('input'),key=node('input'),keyRow=node('div'),eye=button('显示 Key','eye');
  url.type='url';url.placeholder='https://…/v1';url.setAttribute('aria-label','助手API地址');model.setAttribute('aria-label','助手模型');key.type='password';key.autocomplete='off';key.setAttribute('aria-label','助手API Key');keyRow.className='qm-pa-key';keyRow.append(key,eye);custom.append(field('API 地址',url),field('模型',model),field('API Key',keyRow));
  const stream=node('input'),streamRow=node('label');stream.type='checkbox';stream.checked=selection?.connection?.stream!==false;stream.setAttribute('aria-label','流式传输');streamRow.className='qm-pa-stream';streamRow.append(stream,node('span','流式传输'));custom.append(streamRow);
  const persona=node('textarea');persona.value=systemPrompt;persona.rows=5;persona.maxLength=20000;persona.setAttribute('aria-label','助手提示词');persona.dataset.paPrompt='';
  for(const control of [profile,range,url,model,key,persona])control.classList.add('text_pole');
  const referenceField=field('参考楼层（含USER，0为不发送）',range),referenceHint=node('small','当前无可用参考');referenceHint.dataset.paReferenceHint='';referenceHint.hidden=true;referenceField.append(referenceHint);
  grid.append(field('API 预设',profile),custom,referenceField);config.append(grid);
  if(selection?.mode==='profile')profile.value='profile:'+selection.profileId;
  if(selection?.mode==='custom'){profile.value='custom';url.value=selection.connection?.apiUrl||'';model.value=selection.connection?.model||'';key.value=selection.connection?.apiKey||'';}custom.hidden=profile.value!=='custom';
  const footer=node('footer'),question=node('textarea'),status=node('p'),historyNotice=node('p'),retry=button('重试保存','retry-history','retry'),retryCatalogue=button('重试对话操作','retry-conversations','retry'),send=button('发送','send'),composer=node('div');
  grid.append(field('助手提示词',persona));retryCatalogue.hidden=true;
  question.rows=1;question.maxLength=20000;question.setAttribute('aria-label','向场外特助提问');question.dataset.paQuestion='';
  status.dataset.paStatus='';status.setAttribute('role','status');status.setAttribute('aria-live','polite');historyNotice.dataset.paHistory='';historyNotice.setAttribute('role','status');retry.hidden=true;
  composer.className='qm-pa-composer';composer.append(question,send);footer.append(historyNotice,retry,status,retryCatalogue,composer);
  const conversationList=createProseAssistantConversationList({document,onOpen:key=>{void chooseConversation(key);},onNew:()=>{void newConversation();},onDelete:keys=>{void deleteConversations(keys);},onRefresh:()=>{void refreshConversations();}});conversationList.element.hidden=true;
  const resize=node('span');resize.dataset.paResize='';resize.tabIndex=0;resize.setAttribute('role','separator');resize.setAttribute('aria-label','调整窗口大小');dialog.append(header,main,config,conversationList.element,footer,resize);
  function dispose(){if(closed)return;const restoreFocus=dialog.contains(document.activeElement);closed=true;sequence++;if(observerCheckTimer)view.clearTimeout(observerCheckTimer);observerCheckTimer=0;autosave?.close();session?.close();history?.close();catalogue?.close();conversationList.dispose();seed?.close();disposeWindow?.();observer?.disconnect();listeners.splice(0).forEach(remove=>remove());key.value='';question.value='';rows.clear();dialog.remove();if(restoreFocus&&previousFocus?.isConnected)previousFocus.focus({preventScroll:true});resolve(null);}
  function alive(){if(closed)return false;try{seed?.assertCurrent();if(source?.signal?.aborted||isCurrent()!==true||!parent.isConnected||!dialog.isConnected)throw Error();return true;}catch(_){dispose();return false;}}
  const validRange=()=>range.value!==''&&Number.isSafeInteger(Number(range.value))&&Number(range.value)>=0&&Number(range.value)<=9;
  function controls(){
    const blocked=!session||historyWorking||catalogueWorking||!!catalogueRecovery||!!pendingSnapshot;
    send.disabled=busy?closing:saving||closing||blocked||!!editing||!profile.value||!question.value.trim()||!validRange();
    const action=busy?'stop':'send';if(send.dataset.paAction!==action){send.dataset.paAction=action;icon(send,busy?'停止':'发送',action);}
    listButton.disabled=busy||saving||closing||historyWorking||catalogueWorking||!!pendingSnapshot||!!editing||!catalogue;retry.disabled=historyWorking||closing;retryCatalogue.disabled=catalogueWorking||closing;closeButton.disabled=closing||catalogueWorking;question.disabled=catalogueWorking;
    for(const element of [profile,range,url,model,key,eye,persona,stream])element.disabled=!seed||busy||closing||(element===range&&!canReference());
    for(const entry of rows.values()){
      const locked=busy||saving||closing||blocked||!!editing;
      entry.editButton.disabled=locked||entry.status!=='complete';entry.editQuestion.disabled=entry.regenerate.disabled=locked;
      entry.userActions.hidden=entry.status==='running'||(editing?.entry===entry&&editing.kind==='question');
      entry.replyActions.hidden=entry.status==='running'||(editing?.entry===entry&&editing.kind==='reply');
    }
    if(editing)for(const button of editing.box.querySelectorAll('button'))button.disabled=busy||closing;
    paintConversations();dialog.setAttribute('aria-busy',String(busy||saving||historyWorking||catalogueWorking));
  }
  function canReference(){return !!seed&&!seed.scope.offstage&&(!currentConversation||currentConversation.ownerKey===seed.key);}
  function updateReference(){range.value=String(canReference()?preferredReferenceFloors:0);referenceHint.hidden=canReference();referenceHint.textContent=seed?.scope.offstage?'当前无可用参考':'当前对话不引用此聊天';}
  function conversationTitle(){const context=source.getContext();return String(seed.scope.offstage?'独立对话':context.characters?.[context.characterId]?.name||context.name2||seed.scope.target?.avatar?.replace(/\.png$/i,'')||'群组对话').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,200)||'特助对话';}
  function defaultConversation(){
    const data=catalogue?.view(),active=data?.defaults.find(item=>item.ownerKey===seed.key),found=data?.entries.find(item=>item.key===active?.key&&!item.deleted);
    if(found)return found;const known=data?.entries.filter(item=>item.ownerKey===seed.key)||[],remaining=known.filter(item=>!item.deleted).sort((a,b)=>b.lastUsedAt-a.lastUsedAt);
    if(remaining.length)return remaining[0];
    const key=known.length?createProseAssistantThreadKey(seed.key,globalThis.crypto.randomUUID()):seed.key;
    return {key,ownerKey:seed.key,title:conversationTitle(),createdAt:Date.now(),updatedAt:0,lastUsedAt:0,deleted:false};
  }
  function paintConversations(){
    if(!catalogue||page!=='list')return;const entries=catalogue.view().entries;
    if(currentConversation&&session?.view().rows.length&&!entries.some(item=>item.key===currentConversation.key))entries.push(currentConversation);
    const locked=busy||saving||closing||historyWorking||catalogueWorking||!!pendingSnapshot||!!editing;
    conversationList.render({entries:entries.filter(item=>!item.deleted),currentKey:currentConversation?.key,busy:locked||!!catalogueRecovery,refreshable:!!catalogueRecovery&&!locked});
  }
  async function openConversation(entry){
    const loaded=await historyFactory({source:{...seed,key:entry.key},isCurrent:alive});if(!alive()){loaded.close();return;}
    const initial=loaded.initialHistory(),next=createProseAssistantSession({key:entry.key,isCurrent:alive,onChange:render,initialHistory:initial});
    const changed=currentConversation&&currentConversation.key!==entry.key;session?.close();history?.close();history=loaded;session=next;currentConversation={...entry};
    if(initial.updatedAt&&!entry.updatedAt){currentConversation.createdAt=initial.updatedAt;currentConversation.updatedAt=initial.updatedAt;}
    rows.clear();transcript.replaceChildren();if(changed){question.value='';inputRevision++;main.scrollTop=0;}updateReference();render(session.view());historyNotice.textContent='';
  }
  async function ensureConversation(){
    if(!catalogue)return;const known=catalogue.view().entries.find(item=>item.key===currentConversation.key);
    if(known?.deleted)throw Error('这条特助对话已删除，请新建对话');
    if(!known){const registered=await catalogue.ensure(currentConversation);if(!registered)throw Error('这条特助对话已删除，请新建对话');currentConversation=registered;}
  }
  function rememberConversation(){return currentConversation&&session?.view().rows.length&&!catalogue.view().entries.some(item=>item.key===currentConversation.key)?currentConversation:undefined;}
  async function catalogueAction(work,after=async()=>{},failure='对话操作未完成，请重试。'){
    if(!alive()||catalogueWorking)return false;catalogueWorking=true;retryCatalogue.hidden=true;controls();let completed=false;
    try{await work();completed=true;if(!alive())return false;await after();if(!alive())return false;catalogueRecovery=null;status.textContent='';return true;}
    catch(cause){if(alive()){const recoverable=completed||catalogue.status().dirty;catalogueRecovery=recoverable?{after,failure}:null;retryCatalogue.hidden=!recoverable;status.textContent=recoverable?failure:/^prose_assistant_conversations_/.test(cause?.code||'')?String(cause.message).slice(0,240):'对话操作未完成，请刷新列表后再试。';}return false;}
    finally{catalogueWorking=false;if(alive())controls();}
  }
  const canManage=()=>alive()&&catalogue&&!busy&&!saving&&!closing&&!historyWorking&&!catalogueWorking&&!pendingSnapshot&&!catalogueRecovery&&!editing;
  async function permitSwitch(){if(!canManage())return false;return !question.value.trim()||await confirm('放弃当前尚未发送的草稿并切换对话？');}
  async function chooseConversation(key){
    if(!canManage())return;if(key===currentConversation?.key){showPage('chat');return;}
    if(!await permitSwitch()||!canManage())return;
    const selected=catalogue.view().entries.find(item=>item.key===key&&!item.deleted);if(!selected)return;
    await catalogueAction(()=>catalogue.activate(key,{defaultForCurrent:selected.ownerKey===seed.key?seed.key:undefined,remember:rememberConversation()}),async()=>{const selected=catalogue.view().entries.find(item=>item.key===key&&!item.deleted);if(!selected)throw Error();await openConversation(selected);showPage('chat');});
  }
  async function newConversation(){
    if(!await permitSwitch()||!canManage())return;const id=globalThis.crypto.randomUUID(),key=createProseAssistantThreadKey(seed.key,id);
    await catalogueAction(()=>catalogue.create({ownerKey:seed.key,title:conversationTitle(),id,remember:rememberConversation()}),async()=>{const entry=catalogue.view().entries.find(item=>item.key===key&&!item.deleted);if(!entry)throw Error();await openConversation(entry);conversationList.resetSelection();showPage('chat');});
  }
  async function deleteConversations(keys){
    if(!canManage()||!keys.length||!await confirm(`删除选中的 ${keys.length} 条特助对话？不会删除 ST 原聊天；已保存的历史版本仍保留。`)||!canManage())return;
    if(keys.includes(currentConversation?.key)&&!await permitSwitch())return;
    await catalogueAction(()=>catalogue.delete(keys,{remember:rememberConversation()}),async()=>{if(keys.includes(currentConversation?.key))await openConversation(defaultConversation());conversationList.resetSelection();});
  }
  async function refreshConversations(){
    if(!catalogue||busy||saving||closing||historyWorking||catalogueWorking||pendingSnapshot||editing)return;
    await catalogueAction(()=>catalogue.refresh(),async()=>{const entry=catalogue.view().entries.find(item=>item.key===currentConversation?.key);if(entry?.deleted)await openConversation(defaultConversation());else if(entry){currentConversation=entry;updateReference();}conversationList.resetSelection();});
  }
  function historyFailure(cause){historyNotice.textContent=/^prose_assistant_history_/.test(cause?.code||'')?String(cause.message).slice(0,240):'对话保存未确认，请保留本页内容并重试';}
  async function loadHistory(){
    historyWorking=true;retry.hidden=true;controls();
    try{
      if(!seed){const captured=await captureProseAssistantChatSource(source);if(!alive()){captured.close();return;}seed=captured;disposeWindow.setStorageKey('qianmu-assistant-window:'+seed.scope.namespace);}
      if(conversationFactory&&!catalogue){const loaded=await conversationFactory({source:seed,isCurrent:alive});if(!alive()){loaded.close();return;}catalogue=loaded;}
      await openConversation(defaultConversation());}
    catch(cause){if(alive()){historyFailure(cause);icon(retry,'重新读取','retry');retry.hidden=false;}}
    finally{historyWorking=false;if(alive())controls();}
  }
  function persistHistory(snapshot){
    if(historyTask)return historyTask;if(!alive()||!history)return Promise.resolve(false);if(!pendingSnapshot)pendingSnapshot=snapshot;
    historyWorking=true;retry.hidden=true;controls();
    historyTask=Promise.resolve().then(async()=>{if(catalogue){currentConversation=await catalogue.assertEntryLive(currentConversation.key);updateReference();}return history.status().dirty?history.retry():history.save(pendingSnapshot);}).then(async()=>{
      if(!alive())return false;pendingSnapshot=null;historyNotice.textContent='';
      if(catalogue)await catalogueAction(()=>catalogue.saved(currentConversation.key,history.initialHistory().updatedAt),undefined,'对话已保存，列表更新未确认，请重试。');return true;
    }).catch(cause=>{if(alive()){
      if(cause?.code==='prose_assistant_conversations_deleted'){historyNotice.textContent='此对话已从列表删除，本次回复未保存。请先复制回复，再关闭并重新打开。';retry.hidden=true;}
      else{historyFailure(cause);icon(retry,'重试保存','retry');retry.hidden=history.status().code==='prose_assistant_history_conflict';}
    }return false;}).finally(()=>{historyTask=null;historyWorking=false;if(alive())controls();});return historyTask;
  }
  function requestClose(){if(closeTask)return closeTask;closeTask=closeWindow().finally(()=>{closeTask=null;});return closeTask;}
  async function closeWindow(){
    if(!alive()||closing)return;closing=true;controls();
    try{if(editing&&editing.input.value!==editing.original&&!await confirm('放弃尚未保存的修改？'))return;if(editing)closeEditor();
      if(busy){sequence++;const stopped=session?.stop();restoreQuestion();busy=false;if(stopped)await persistHistory(session.view());}else if(historyTask)await historyTask;
      if(!alive())return;if(autosave&&!await autosave.flush()){status.textContent='设置尚未保存，当前输入已保留，请稍后再试。';return;}if(pendingSnapshot&&!await confirm('还有未确认保存的对话。关闭前可先复制留存，仍要关闭？'))return;
      if(alive()){
        if(retainOnClose&&session&&!historyWorking&&!pendingSnapshot&&!editing){dialog.hidden=true;observer?.disconnect();if(previousFocus?.isConnected)previousFocus.focus({preventScroll:true});}
        else dispose();
      }
    }catch(_){}finally{closing=false;if(alive())controls();}
  }
  function render(snapshot){
    if(!alive())return;busy=snapshot.busy;const stick=main.scrollHeight-main.scrollTop-main.clientHeight<64;
    for(const row of snapshot.rows){let entry=rows.get(row.id);if(!entry){
      const article=node('article'),user=node('p'),reply=node('div'),label=node('small'),userActions=node('div'),replyActions=node('div'),copyQuestion=button('复制问题','copy-question','copy'),copyButton=button('复制回复','copy'),editButton=button('编辑回复','edit'),editQuestion=button('编辑问题','edit-question','edit'),regenerate=button('重新生成','regenerate','retry');
      article.dataset.paTurn=String(row.id);user.className='qm-pa-user';reply.className='qm-pa-reply';
      userActions.className='qm-pa-message-actions qm-pa-user-actions';userActions.dataset.paUserActions='';userActions.setAttribute('role','group');userActions.setAttribute('aria-label','问题操作');
      replyActions.className='qm-pa-message-actions qm-pa-reply-actions';replyActions.dataset.paReplyActions='';replyActions.setAttribute('role','group');replyActions.setAttribute('aria-label','回复操作');
      userActions.append(copyQuestion,editQuestion);replyActions.append(copyButton,editButton,regenerate);article.append(user,userActions,reply,label,replyActions);transcript.append(article);entry={article,user,reply,label,userActions,replyActions,copyButton,editButton,editQuestion,regenerate,text:null,status:null};rows.set(row.id,entry);
    }
      if(entry.user.textContent!==row.user)entry.user.textContent=row.user;if(entry.text!==row.assistant){entry.text=row.assistant;entry.reply.classList.toggle('qm-pa-plain',!renderProseAssistantMarkdown(entry.reply,row.assistant));}
      if(entry.status!==row.status){entry.status=row.status;entry.label.replaceChildren();if(row.status==='running'){const dots=node('span');dots.className='qm-pa-typing';dots.setAttribute('role','status');dots.setAttribute('aria-label','回复中');dots.append(node('span'),node('span'),node('span'));entry.label.append(dots);}else entry.label.textContent={complete:'',failed:'回复未完成',cancelled:'已停止'}[row.status];}
      entry.copyButton.disabled=!row.assistant;
    }
    const ids=new Set(snapshot.rows.map(row=>row.id));for(const [id,entry] of rows)if(!ids.has(id)){entry.article.remove();rows.delete(id);}controls();if(stick)main.scrollTop=main.scrollHeight;
  }
  const selectedConnection=()=>!profile.value?null:profile.value==='custom'?{mode:'custom',transport:'st-proxy',connection:{...selection?.connection,apiUrl:url.value,model:model.value,apiKey:key.value,stream:stream.checked}}:{mode:'profile',profileId:profile.value.slice(8),transport:'st-proxy'};
  if(preferences)autosave=createProseAssistantAutosave({read:()=>{if(!validRange())throw Error('range');return {selection:selectedConnection(),referenceFloors:preferredReferenceFloors,systemPrompt:persona.value};},
    save:draft=>saveProseAssistantConnection({...draft,...preferences,allowIncomplete:true,guard:()=>seed.guard(),isCurrent:alive}),isCurrent:alive,
    onStatus:state=>{saving=state.saving;if(!alive())return;if(state.failed)status.textContent='设置尚未保存，当前输入已保留，请稍后再试。';else if(!state.dirty)status.textContent='';controls();}});
  async function submit(replacement){
    if(!alive()||busy)return;controls();if(replacement?(saving||closing||historyWorking||catalogueWorking||catalogueRecovery||pendingSnapshot||!session||!profile.value||!validRange()):send.disabled)return;
    const token=++sequence,value=replacement?.question??question.value,before=JSON.stringify(session.view().rows),revision=inputRevision;busy=true;controls();status.textContent='';
    try{await seed.guard();if(!alive()||token!==sequence)return;
      if(autosave&&!await autosave.flush())throw Object.assign(Error('设置尚未保存，请稍后重试。'),{code:'prose_assistant_preferences'});
      if(catalogue){const registered=await catalogueAction(async()=>{await ensureConversation();currentConversation=await catalogue.assertEntryLive(currentConversation.key);updateReference();});if(!registered)return;}
      const count=canReference()?Number(range.value):0,requestedSource=count===0?{...source,referenceFloors:0,previousFloors:0}:sourceFactory?await sourceFactory(count):{...source,floor:source.getContext().chat.findLastIndex(message=>message&&!message.is_system),range:undefined,referenceFloors:count,previousFloors:count-1};
      if(catalogue){requestedSource.conversationKey=currentConversation.key;requestedSource.conversationOwnerKey=currentConversation.ownerKey;}
      if(!alive()||token!==sequence)return;
      const prompt=persona.value,request=createProseAssistantRequest({selection:selectedConnection(),profiles,profileStream:getProfileStream(),getRequestHeaders,fetchImpl,compileMessages:args=>compileProseAssistantMessages({...args,systemPrompt:prompt})});
      if(replacement&&editing)closeEditor();
      activeQuestion=replacement?null:{value,revision};if(!replacement&&question.value===value)question.value='';
      await session.run({question:value,source:requestedSource,request:request.send,...(replacement?{replaceId:replacement.id}:{})});
      if(alive()&&token===sequence){activeQuestion=null;controls();return true;}
    }catch(cause){if(alive()&&token===sequence){restoreQuestion();busy=false;controls();status.textContent=/^prose_assistant_/.test(cause?.code||'')?String(cause.message).slice(0,240):'场外特助暂不可用，请重试';return false;}}
    finally{if(alive()&&token===sequence){busy=false;controls();const snapshot=session.view();if(!snapshot.busy&&JSON.stringify(snapshot.rows)!==before)await persistHistory(snapshot);}}
  }
  function restoreQuestion(){if(activeQuestion&&inputRevision===activeQuestion.revision&&!question.value)question.value=activeQuestion.value;activeQuestion=null;}
  function closeEditor(){if(!editing)return;editing.box.remove();editing.entry.reply.hidden=false;editing.entry.user.hidden=false;editing=null;controls();}
  function editReply(entry,id,kind='reply'){
    if(editing||(kind==='reply'?entry.editButton:entry.editQuestion).disabled)return;const box=node('div'),input=node('textarea'),save=button(kind==='reply'?'保存修改':'发送修改后的问题','save-reply',kind==='reply'?'save':'send'),cancel=button('取消修改','cancel-reply','close'),original=kind==='reply'?entry.text:entry.user.textContent;box.className='qm-pa-edit';box.dataset.paEditKind=kind;input.classList.add('text_pole');input.value=original;input.rows=6;input.maxLength=kind==='reply'?sessionLimits.reply:sessionLimits.question;input.setAttribute('aria-label',kind==='reply'?'编辑助手回复':'编辑提问');box.append(input,save,cancel);entry[kind==='reply'?'reply':'user'].hidden=true;entry.article.insertBefore(box,kind==='reply'?entry.label:entry.userActions);editing={id,entry,box,input,original,kind};controls();input.focus();
  }
  async function saveReply(){
    if(!editing||busy||closing||historyWorking||catalogueWorking||catalogueRecovery||pendingSnapshot)return;
    if(editing.kind==='question'){void regenerate(editing.id,editing.input.value);return;}const draft=editing;
    if(catalogue&&!await catalogueAction(()=>ensureConversation()))return;if(!alive()||editing!==draft)return;
    try{session.editReply(draft.id,draft.input.value);closeEditor();status.textContent='';await persistHistory(session.view());}catch(cause){if(alive())status.textContent=String(cause.message).slice(0,240);}
  }
  async function regenerate(id,value){
    if(!alive()||busy||saving||closing||historyWorking||pendingSnapshot)return;const snapshot=session?.view(),index=snapshot?.rows.findIndex(row=>row.id===id);if(index===undefined||index<0)return;
    const questionText=value??snapshot.rows[index].user;if(!questionText.trim()){status.textContent='请填写问题';return;}
    if(index<snapshot.rows.length-1){const token=++sequence;busy=true;controls();let approved=false;try{approved=await confirm('重新生成成功后，将替换这一轮并删除之后的问答。继续？');}catch{if(alive())status.textContent='操作未完成，请重试';}finally{if(alive()&&token===sequence){busy=false;controls();}}if(!alive()||token!==sequence||!approved)return;}
    const result=await submit({id,question:questionText});
    if(result===false&&value!==undefined&&alive()&&rows.has(id)&&!editing){editReply(rows.get(id),id,'question');if(editing)editing.input.value=questionText;}
  }
  function showPage(next){page=next;config.hidden=page!=='settings';main.hidden=page!=='chat';conversationList.element.hidden=page!=='list';composer.hidden=page!=='chat';settingsButton.hidden=page!=='chat';listButton.hidden=!conversationFactory||page!=='chat';back.hidden=page==='chat';title.textContent=page==='settings'?'特助设置':page==='list'?'最近对话':'场外特助';paintConversations();}
  listen(dialog,'click',event=>{
    event.stopPropagation(); // Closing may remove the later isolation listeners synchronously.
    const action=event.target.closest?.('[data-pa-action]')?.dataset.paAction;if(action==='close'){void requestClose();return;}if(!alive())return;
    if(action==='settings')showPage('settings');else if(action==='back')showPage('chat');else if(action==='conversations'&&!listButton.disabled)showPage('list');
    else if(action==='retry-conversations'&&catalogueRecovery&&!retryCatalogue.hidden){const recovery=catalogueRecovery;void catalogueAction(()=>catalogue.retry(),recovery.after,recovery.failure);}
    else if(action==='retry-history'){if(!historyWorking&&!closing)void(history?persistHistory(pendingSnapshot):loadHistory());}
    else if(action==='send')void submit();else if(action==='stop'){sequence++;const stopped=session?.stop();restoreQuestion();busy=false;controls();status.textContent='';if(stopped)void persistHistory(session.view());}
    else if(action==='eye'){key.type=key.type==='password'?'text':'password';icon(eye,key.type==='password'?'显示 Key':'隐藏 Key','eye');}
    else if(action==='edit'){const id=Number(event.target.closest('[data-pa-turn]')?.dataset.paTurn),entry=rows.get(id);if(entry)editReply(entry,id);}
    else if(action==='edit-question'){const id=Number(event.target.closest('[data-pa-turn]')?.dataset.paTurn),entry=rows.get(id);if(entry)editReply(entry,id,'question');}
    else if(action==='regenerate'){const id=Number(event.target.closest('[data-pa-turn]')?.dataset.paTurn),entry=rows.get(id);if(entry&&!entry.regenerate.disabled)void regenerate(id);}
    else if(action==='cancel-reply'){if(!busy&&!closing)closeEditor();}
    else if(action==='save-reply')void saveReply();
    else if(action==='copy'||action==='copy-question'){const id=Number(event.target.closest('[data-pa-turn]')?.dataset.paTurn),entry=rows.get(id),value=action==='copy-question'?entry?.user.textContent:entry?.text;if(value){void Promise.resolve().then(()=>{if(alive())return copy(value);}).then(result=>{if(result===false)throw Error();}).catch(()=>{if(alive())status.textContent='复制失败，请手动选择文本';});}}
  });
  const settingsChanged=()=>{autosave?.change();controls();};
  listen(profile,'change',()=>{custom.hidden=profile.value!=='custom';settingsChanged();});listen(range,'input',()=>{if(canReference()&&validRange())preferredReferenceFloors=Number(range.value);settingsChanged();});for(const element of [url,model,key,persona])listen(element,'input',settingsChanged);listen(stream,'change',settingsChanged);listen(question,'input',()=>{inputRevision++;controls();});
  listen(question,'keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&!event.isComposing){event.preventDefault();void submit();}});
  listen(dialog,'keydown',event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();if(editing&&!busy)closeEditor();else if(page!=='chat')showPage('chat');else void requestClose();}});
  for(const event of ['pointerdown','pointerup','mousedown','mouseup','touchstart','click'])listen(dialog,event,value=>value.stopPropagation());listen(view,'pagehide',dispose);
  listen(view,'beforeunload',event=>{if(autosave?.state().dirty){event.preventDefault();event.returnValue='';}});
  if(source?.signal)listen(source.signal,'abort',dispose);
  parent.append(dialog);disposeWindow=bindProseAssistantWindow(dialog,{handle:header});
  observer=new view.MutationObserver(()=>{
    if(closed)return;
    if(!parent.isConnected||!dialog.isConnected){alive();return;}
    // ST may stream many unrelated DOM changes; actions and storage still use
    // their own immediate guards, while this passive lifetime check is bounded.
    if(!observerCheckTimer)observerCheckTimer=view.setTimeout(()=>{observerCheckTimer=0;alive();},50);
  });observer.observe(document.documentElement,{childList:true,subtree:true});controls();dialog.focus({preventScroll:true});const ready=loadHistory();
  return Object.freeze({element:dialog,finished,ready,dispose,get visible(){return !closed&&!dialog.hidden;},reopen(){
    if(reopenTask)return reopenTask;
    reopenTask=(async()=>{if(closeTask)await closeTask;if(closed)return false;try{if(dialog.hidden){previousFocus=document.activeElement;await seed?.guard();}if(!alive())return false;dialog.hidden=false;observer.observe(document.documentElement,{childList:true,subtree:true});dialog.focus({preventScroll:true});return true;}catch{dispose();return false;}})().finally(()=>{reopenTask=null;});return reopenTask;
  }});
}
