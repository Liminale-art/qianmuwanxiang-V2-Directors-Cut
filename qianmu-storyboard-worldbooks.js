import {readPersonaWorldBindings, normalizePersonaWorldSelections, activePersonaWorldSelections, personaWorldSelectionKey} from './qianmu-storyboard-persona-world.js';
import {renderStoryboardWorldbookView} from './qianmu-storyboard-worldbook-view.js';

const unique = values => [...new Set(values.filter(value => typeof value === 'string' && value))];
const enabled = item => item?.enabled !== false && item?.disable !== true;
const unavailable = message => Object.assign(new Error(message), {code:'storyboard_context_unavailable'});
const changed = () => Object.assign(new Error('人设或世界书选择已变化，请重新确认后提取'), {code:'storyboard_input_changed',inputChangeReason:'preparation_context_changed'});
const rowsFor = (book, entries) => entries.map((item,index) => ({book,item,index,
  id:`${book}::${Array.isArray(item?.uid ?? item?.id ?? item?.key ?? item?.keys) ? (item.uid ?? item.id ?? item.key ?? item.keys).join('|') : String(item?.uid ?? item?.id ?? item?.key ?? item?.keys ?? index)}`.slice(0,512),
  title:String(item?.name || item?.comment || (Array.isArray(item?.key) ? item.key.join(', ') : item?.key) || `世界书条目 ${index+1}`).trim().slice(0,160)}));

// Owns only the existing world's directory/read cache and an unsaved edit draft.
// Manual choices stay in worldBookNames/worldEntryIds; confirmed persona choices
// have one persistent source in personaWorldSelections, never a merged copy.
export function createStoryboardWorldbookController(host) {
  let modules, loadingModules, cache, draft, notice = '', action = 0;
  const state = () => host.state();
  const context = () => host.context();
  const binding = () => readPersonaWorldBindings(context(), {userAvatar:modules?.main.user_avatar,worldInfo:modules?.world.getWorldInfoSettings().world_info});
  const owner = () => [state(),host.chatKey(),host.epoch(),context().chatMetadata];
  const sameOwner = value => value.every((item,index) => item === owner()[index]);
  const scope = () => ({owner:owner(),signature:binding().signature});
  const current = value => {try{return sameOwner(value.owner) && value.signature === binding().signature;}catch(_){return false;}};
  const selection = compiler => JSON.stringify([compiler.worldBookNames,compiler.worldEntryIds,normalizePersonaWorldSelections(compiler.personaWorldSelections)]);
  const records = compiler => normalizePersonaWorldSelections(compiler.personaWorldSelections);
  const bookOwners = (bindings,book) => bindings.owners.filter(row => row.books.includes(book));
  const matches = (record,bindings) => bookOwners(bindings,record.book).some(row => row.kind===record.kind && row.id===record.owner);
  const confirmed = (compiler,bindings,book) => records(compiler).filter(record => record.book===book && matches(record,bindings));
  const manual = (compiler,book) => (compiler.worldBookNames || []).includes(book);
  const pending = (compiler,bindings) => unique(bindings.owners.flatMap(row=>row.books)).filter(book => !manual(compiler,book) && !confirmed(compiler,bindings,book).length);
  const active = (compiler,bindings) => activePersonaWorldSelections(compiler.personaWorldSelections,bindings);
  function effective(compiler,bindings) {
    const books = unique([...(compiler.worldBookNames || []),...active(compiler,bindings).map(row=>row.book)]);
    return new Map(books.map(book=>[book,new Set([...(manual(compiler,book) ? (compiler.worldEntryIds || []).filter(id=>id.startsWith(book+'::')) : []),
      ...active(compiler,bindings).filter(row=>row.book===book).flatMap(row=>row.entryIds)])]));
  }
  async function ready() {
    if (modules) return;
    loadingModules ||= host.loadModules().then(value=>{
      if (typeof value?.world?.getWorldInfoSettings !== 'function') throw unavailable('无法读取人设世界书绑定，请重新打开当前聊天');
      modules=value;
    }).finally(()=>{loadingModules=null;});
    await loadingModules;
  }
  async function loadBook(book, token=cache, fresh=false) {
    if (!token || !current(token)) throw changed();
    if (!fresh && token.books.has(book)) return token.books.get(book);
    const entries=await host.entries(book);
    if (!current(token) || cache!==token) throw changed();
    if (!Array.isArray(entries)) throw unavailable('世界书未能完整读取，请刷新后重新确认');
    const rows=rowsFor(book,entries);
    if (rows.length>1000 || new Set(rows.map(row=>row.id)).size!==rows.length) throw unavailable('世界书条目过多或编号重复，未截断发送，请整理后重试');
    token.books.set(book,rows);
    return rows;
  }
  async function warm({force=false,rerender=false}={}) {
    if(force){action++;draft=null;}
    const before=owner();
    try {
      await ready();
      if (!sameOwner(before)) throw changed();
      const bindings=binding(), captured=scope();
      if (!force && cache && current(cache)) {
        if (cache.loading) await cache.loading;
        return cache;
      }
      const token={...captured,bindings,names:[],books:new Map(),loading:null,error:''};cache=token;
      if (draft && !current(draft)) draft=null;
      token.loading=(async()=>{
        const names=await host.names();
        if (!current(token) || cache!==token) throw changed();
        token.names=unique([...bindings.owners.flatMap(row=>row.books),...names]);
        const compiler=state().promptCompiler;
        for (const book of unique([...effective(compiler,bindings).keys(),compiler.worldBookView]).filter(name=>token.names.includes(name))) await loadBook(book,token);
        if (!current(token) || cache!==token) throw changed();
        if (compiler.worldBookView && !token.names.includes(compiler.worldBookView)) {compiler.worldBookView='';host.save();}
        notice='';return token;
      })();
      try{return await token.loading;}catch(error){if(cache===token)token.error=error.message;throw error;}
      finally{if(cache===token){token.loading=null;if(rerender)host.render();}}
    } catch(error) {
      if(sameOwner(before))notice=error.message;
      throw error;
    }
  }
  function watchChanges() {
    let invalidated=false;const cleanups=[];
    const source=context().eventSource, types=context().eventTypes || {};
    for(const type of unique([types.PERSONA_CHANGED,types.PERSONA_UPDATED,types.CHAT_CHANGED,types.CHARACTER_EDITED,types.WORLDINFO_UPDATED,types.WORLDINFO_SETTINGS_UPDATED])) {
      const handler=()=>{invalidated=true;};source?.on?.(type,handler);cleanups.push(()=>source?.removeListener?.(type,handler));
    }
    return {changed:()=>invalidated,close(){cleanups.forEach(fn=>fn());}};
  }
  function guardFor(captured, compiler) {
    let closed=false;const expected=selection(compiler), watch=watchChanges();
    const isCurrent=()=>!closed&&!watch.changed()&&current(captured)&&selection(compiler)===expected;
    return {isCurrent,assertCurrent(){if(!isCurrent())throw changed();},close(){closed=true;watch.close();}};
  }
  async function prepare(target, inputGuard) {
    const before=owner(), watch=watchChanges();
    try {
      await ready();
      inputGuard.assertCurrent();if(watch.changed()||!sameOwner(before)||target!==state())throw changed();
      inputGuard.worldbooks?.close();
      inputGuard.worldbooks=guardFor(scope(),target.promptCompiler);
    } finally {watch.close();}
    inputGuard.worldbooks.assertCurrent();
    if(pending(target.promptCompiler,binding()).length)throw unavailable('请先在分镜「世界书」中确认人设条目，也可以选择不引用此书；本次未发送');
  }
  async function read(target, inputGuard) {
    if (!inputGuard?.worldbooks) throw unavailable('世界书准备未完成，请重新提取');
    inputGuard.assertCurrent();await warm();inputGuard.assertCurrent();
    const requested=effective(target.promptCompiler,binding()), selected=[];
    for(const [book,ids] of requested) {
      if(!ids.size)continue;
      const rows=await loadBook(book,cache,true);inputGuard.assertCurrent();
      if([...ids].some(id=>!rows.some(row=>row.id===id)))throw unavailable('部分已选世界书条目未能读取，请刷新后重试；未发送不完整上下文。');
      selected.push(...rows.filter(row=>ids.has(row.id)&&enabled(row.item)));
    }
    const texts=[];
    for(const row of selected){const text=host.clean(await host.resolve(String(row.item?.content ?? row.item?.text ?? '')));inputGuard.assertCurrent();if(text)texts.push(`【${row.book} · ${row.title}】\n${text}`);}
    return {text:texts.join('\n\n'),rows:selected,fallback:false};
  }
  async function edit(book, request=++action) {
    await warm();const captured=scope(), target=state(), compiler=target.promptCompiler;
    const rows=await loadBook(book);if(request!==action||!current(captured))throw changed();
    const owners=bookOwners(binding(),book);if(!owners.length)throw changed();
    const saved=confirmed(compiler,binding(),book), fromManual=manual(compiler,book);
    const ids=fromManual ? (compiler.worldEntryIds||[]).filter(id=>rows.some(row=>row.id===id)) : saved.length ? saved.filter(row=>row.enabled).flatMap(row=>row.entryIds) : rows.filter(row=>enabled(row.item)).map(row=>row.id);
    draft={...captured,book,owners,selection:selection(compiler),entryIds:new Set(ids),manual:fromManual};
    compiler.worldBookView=book;host.render();
  }
  function checkDraft() {
    if(!draft || !current(draft) || draft.selection!==selection(state().promptCompiler)) {draft=null;throw changed();}
    return draft;
  }
  function confirm(skip=false) {
    action++;
    const value=checkDraft(), compiler=state().promptCompiler, rows=cache?.books.get(value.book);
    if(!rows)throw changed();
    const ids=skip ? [] : rows.filter(row=>enabled(row.item)&&value.entryIds.has(row.id)).map(row=>row.id);
    const keys=new Set(value.owners.map(row=>personaWorldSelectionKey({kind:row.kind,owner:row.id,book:value.book})));
    compiler.personaWorldSelections=[...records(compiler).filter(row=>!keys.has(personaWorldSelectionKey(row))),
      ...value.owners.map(row=>({kind:row.kind,owner:row.id,book:value.book,entryIds:[...ids],enabled:!skip}))];
    if(value.manual){compiler.worldBookNames=compiler.worldBookNames.filter(book=>book!==value.book);compiler.worldEntryIds=compiler.worldEntryIds.filter(id=>!id.startsWith(value.book+'::'));}
    draft=null;host.save();host.render();
  }
  async function viewBook(book) {
    const request=++action;
    await warm();const token=cache;await loadBook(book,token);
    if(request!==action||!current(token))throw changed();
    state().promptCompiler.worldBookView=book;
    if(bookOwners(binding(),book).length && !manual(state().promptCompiler,book) && !confirmed(state().promptCompiler,binding(),book).length)return edit(book,request);
    draft=null;host.save();host.render();
  }
  async function toggleBook(book,on) {
    const request=++action;
    await warm();const compiler=state().promptCompiler, bindings=binding(), owners=bookOwners(bindings,book);
    if(request!==action)throw changed();
    if(owners.length && !manual(compiler,book)) {
      if(on)return edit(book,request);
      const saved=records(compiler);compiler.personaWorldSelections=saved.map(row=>row.book===book && matches(row,bindings)?{...row,enabled:false}:row);
    }else{
      const token=cache, rows=on?await loadBook(book,token):[];if(request!==action||!current(token))throw changed();
      const selected=new Set(compiler.worldBookNames||[]);if(on)selected.add(book);else selected.delete(book);
      if(selected.size>100)throw unavailable('已选世界书过多，未截断保存，请减少选择');
      if(on && !(compiler.worldBookInitializedNames||[]).includes(book)) {
        const ids=unique([...(compiler.worldEntryIds||[]),...rows.filter(row=>enabled(row.item)).map(row=>row.id)]);
        if(ids.length>1000 || selected.size>100)throw unavailable('已选世界书条目过多，未截断保存，请减少选择');
        compiler.worldEntryIds=ids;compiler.worldBookInitializedNames=unique([...(compiler.worldBookInitializedNames||[]),book]);
      }
      compiler.worldBookNames=[...selected];
    }
    compiler.worldBookView=book;draft=null;host.save();host.render();
  }
  function toggleEntry(id,on) {
    action++;
    if(draft){const value=checkDraft();if(on)value.entryIds.add(id);else value.entryIds.delete(id);return;}
    const compiler=state().promptCompiler, rows=cache?.books.get(compiler.worldBookView)||[];
    if(!cache || !current(cache) || !manual(compiler,compiler.worldBookView) || !rows.some(row=>row.id===id&&enabled(row.item)))throw changed();
    const selected=new Set(compiler.worldEntryIds||[]);if(on)selected.add(id);else selected.delete(id);
    if(selected.size>1000)throw unavailable('已选世界书条目过多，未截断保存，请减少选择');
    compiler.worldEntryIds=[...selected];host.save();
  }
  function view(target) {
    let bindings={owners:[]};try{if(modules)bindings=binding();}catch(error){return {error:error.message,books:[],entries:[]};}
    const compiler=target.promptCompiler, valid=cache&&current(cache), names=valid?cache.names:unique(bindings.owners.flatMap(row=>row.books));
    if(draft && (!current(draft) || draft.selection!==selection(compiler)))draft=null;
    const pendingBooks=pending(compiler,bindings), selected=effective(compiler,bindings), viewName=names.includes(compiler.worldBookView)?compiler.worldBookView:'';
    const owners=bookOwners(bindings,viewName), editing=draft?.book===viewName, manualBook=manual(compiler,viewName);
    const entryIds=editing?draft.entryIds:selected.get(viewName)||new Set();
    return {loading:!!cache?.loading,error:notice||cache?.error||'',books:names.map(name=>({name,labels:bookOwners(bindings,name).map(row=>row.kind==='char'?'角色绑定':'USER绑定'),
      selected:manual(compiler,name)||confirmed(compiler,bindings,name).some(row=>row.enabled),manual:manual(compiler,name),pending:pendingBooks.includes(name)})),
      viewName,editing:!!editing,bound:!!owners.length,manual:manualBook,ownerLabel:owners.length>1?'当前角色与 User':owners[0]?.kind==='char'?'当前角色':'当前 User',
      entries:valid?(cache.books.get(viewName)||[]).filter(row=>enabled(row.item)).map(row=>({id:row.id,title:row.title,content:row.item?.content??row.item?.text??'',checked:entryIds.has(row.id)})):[]};
  }
  function render(target){return renderStoryboardWorldbookView(target,view(target),host.format);}
  function bind(root) {
    const run=fn=>Promise.resolve().then(fn).catch(error=>{host.toast(error.message);});
    root.querySelector('.sd-storyboard-refresh-worldbooks')?.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();draft=null;void run(()=>warm({force:true,rerender:true}));});
    root.querySelectorAll('.sd-storyboard-toggle-worldbook').forEach(input=>input.addEventListener('change',()=>void run(()=>toggleBook(input.dataset.name,input.checked))));
    root.querySelectorAll('.sd-storyboard-world-name').forEach(button=>button.addEventListener('click',()=>void run(()=>viewBook(button.dataset.name))));
    root.querySelectorAll('[data-storyboard-world-entry]').forEach(input=>input.addEventListener('change',()=>void run(()=>toggleEntry(input.dataset.storyboardWorldEntry,input.checked))));
    root.querySelector('.sd-storyboard-edit-persona-world')?.addEventListener('click',()=>void run(()=>edit(state().promptCompiler.worldBookView)));
    root.querySelector('.sd-storyboard-confirm-persona-world')?.addEventListener('click',()=>void run(()=>confirm()));
    root.querySelector('.sd-storyboard-skip-persona-world')?.addEventListener('click',()=>void run(()=>confirm(true)));
    root.querySelector('.sd-storyboard-cancel-persona-world')?.addEventListener('click',()=>{action++;draft=null;host.render();});
  }
  return {warm,prepare,read,render,bind,view,edit,confirm,toggleBook,toggleEntry,viewBook,cancel(){action++;draft=null;}};
}
