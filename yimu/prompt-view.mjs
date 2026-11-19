import {DEFAULT_PROMPTS,BUILTIN_PROMPT_PRESET,PROMPT_KINDS,resolvePromptConfig,validatePromptConfig,importPromptPreset,exportPromptPreset,mergeImportedPromptConfig,selectPromptPreset} from './prompt-settings.mjs';
import {createYimuIcon} from './icons.mjs';

const LABELS={identity:'忆幕履职',summary:'切片总结',stage:'阶段总结',recall:'原文回查'},clone=value=>structuredClone(value),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
/** Committed configuration and per-entry text drafts are deliberately separate. */
export function mountPromptView(container,{document=container?.ownerDocument||globalThis.document,onSave=async()=>{},onError=()=>{},onExport,showTitle=true,autosaveMs=1200}={}){
    const autosaveTimers=new Set();
    if(!container||!document?.createElement)throw new TypeError('总结提示词缺少容器');
    const el=(tag,cls='',text='')=>{const node=document.createElement(tag);node.className=cls;node.textContent=text;return node;};
    const scopes=new Map(),rowNodes=new Map(),buttons=new Set();
    let state={},scope='',kind='summary',disposed=false,serial=0,dragId='',confirmationAction=null;
    const createId=()=>globalThis.crypto?.randomUUID?.()||`prompt_${Date.now()}_${++serial}`;
    const record=()=>scopes.get(scope);
    const card=el('section','ym-card ym-prompts');card.setAttribute('aria-label','总结提示词');
    const heading=el('div','ym-prompt-heading');if(showTitle)heading.append(el('h3','','总结提示词'));
    const badge=el('span','ym-muted ym-prompt-unsaved');heading.append(badge);
    const button=(label,glyph,action)=>{
        const node=el('button','ym-button ym-icon-button');node.type='button';node.title=label;node.setAttribute('aria-label',label);node.append(createYimuIcon(glyph,{document}));
        node.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();if(!node.disabled)action();});buttons.add(node);return node;
    };
    const preset=el('select');preset.setAttribute('aria-label','总结提示词预设');
    const toolbar=el('div','ym-prompt-presets ym-prompt-toolbar ym-prompt-preset-row');
    const nameRow=el('div','ym-prompt-name'),name=el('input');name.type='text';name.maxLength=160;name.placeholder='预设名称';name.setAttribute('aria-label','总结提示词预设名称');nameRow.hidden=true;
    const file=el('input');file.type='file';file.accept='application/json,.json';file.hidden=true;file.setAttribute('aria-label','导入忆幕提示词文件');
    const confirmation=el('div','ym-prompt-confirm ym-status'),confirmText=el('span');confirmation.hidden=true;
    function ask(text,action){confirmText.textContent=text;confirmationAction={scope,action};confirmation.hidden=false;}
    confirmation.append(confirmText,button('确认提示词操作','check',()=>{const pending=confirmationAction;confirmation.hidden=true;confirmationAction=null;if(pending?.scope===scope)pending.action();}),button('取消提示词操作','close',()=>{confirmation.hidden=true;confirmationAction=null;}));
    const add=button('新增条目','plus',()=>{
        const entry={id:createId(),name:'自定义提示词',enabled:true,text:''},group=kind;
        enqueue(value=>{value.groups[group].push(clone(entry));return value;});
        const row=rowNodes.get(rowKey(scope,group,entry.id));if(row){row.node.open=true;row.titleInput.focus();}
    });
    const savePreset=button('保存为预设','save',()=>{name.value='';nameRow.hidden=false;name.focus();});
    const removePreset=button('删除提示词预设','trash',()=>{
        const selected=record()?.config.presets.find(value=>value.id===preset.value);if(!selected)return;
        // 直接删除，不再二次确认：删的只是预设这个存档，当前条目保留。
        enqueue(value=>{value.presets=value.presets.filter(item=>item.id!==selected.id);if(value.selectedPreset===selected.id)value.selectedPreset='';return value;});
    });
    const download=button('导出','download',()=>{try{
        const data=exportPromptPreset(record().config);if(onExport)return onExport(data);
        const window=document.defaultView||globalThis,Url=window.URL,BlobClass=window.Blob||globalThis.Blob;
        if(!Url?.createObjectURL||!BlobClass)throw new Error('当前环境不能导出文件');
        const url=Url.createObjectURL(new BlobClass([data],{type:'application/json'})),anchor=el('a');anchor.href=url;anchor.download='忆幕-总结提示词.json';document.body.append(anchor);anchor.click();anchor.remove();Url.revokeObjectURL(url);
    }catch(error){fail(record(),error);}});
    toolbar.append(preset,add,savePreset,button('导入','upload',()=>file.click()),download,removePreset);
    nameRow.append(name,button('确认保存提示词预设','save',()=>{
        const title=name.value.trim();if(!title)return fail(record(),new Error('请填写预设名称'));
        const config=record().config,previous=config.presets.find(item=>item.name===title),id=previous?.id||createId(),groups=clone(config.groups);
        const save=()=>{nameRow.hidden=true;enqueue(value=>{value.presets=[...value.presets.filter(item=>item.id!==id),{id,name:title,groups:clone(groups)}];value.selectedPreset=id;return value;});};
        if(previous)ask(`覆盖同名预设「${title}」？`,save);else save();
    }),button('取消预设命名','close',()=>{nameRow.hidden=true;}));
    const groups=el('div','ym-prompt-groups');groups.setAttribute('role','tablist');groups.setAttribute('aria-label','提示词用途');
    const groupButtons=new Map();
    const recallVisible=()=>state.recallEnabled??state.settings?.recall!==false;
    for(const key of PROMPT_KINDS){const node=button(LABELS[key],{identity:'book',summary:'edit',stage:'book',recall:'eye'}[key],()=>{if(key==='recall'&&!recallVisible())return;kind=key;renderRows();update();});node.className='ym-button';node.replaceChildren(el('span','',LABELS[key]));node.setAttribute('role','tab');groupButtons.set(key,node);groups.append(node);}
    const list=el('div','ym-prompt-list'),empty=el('p','ym-muted','此组没有条目，可新增或选择内置默认。');
    const status=el('p','ym-muted ym-prompt-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const retry=button('重试本次提示词保存','refresh',()=>{const rec=record();if(rec.remote){rec.saved=clone(rec.remote.config);rec.revision=rec.remote.revision;}rec.error='';rec.failed=false;rebuildConfig(rec);void drain(rec);});
    const cancelOperation=button('取消本次提示词操作','close',()=>{const rec=record();if(rec.saving)return;rec.queue.shift();rec.failed=false;rec.error='';if(!rec.queue.length&&rec.remote?.revision>rec.revision){rec.saved=clone(rec.remote.config);rec.revision=rec.remote.revision;}rebuildConfig(rec);renderRows();update();void drain(rec);});
    const recovery=el('div','ym-actions ym-prompt-recovery');recovery.append(retry,cancelOperation);recovery.hidden=true;
    card.append(heading,toolbar,nameRow,file,confirmation,groups,list,empty,status,recovery);container.append(card);
    const rowKey=(owner,group,id)=>JSON.stringify([owner,group,id]);
    function fail(rec,error){if(!rec)return;rec.error=error?.message||'提示词操作未完成';if(!disposed&&rec.scope===scope){update();onError(error);}}
    function rebuildConfig(rec){
        let value=clone(rec.saved);
        try{for(const item of rec.queue)value=validatePromptConfig(item.transform(value));rec.config=value;}
        catch(error){fail(rec,error);}
    }
    function enqueue(transform,{draftKey,draftVersion}={}){
        const rec=record();if(!rec||disposed)return;
        try{rec.config=validatePromptConfig(transform(clone(rec.config)));}catch(error){fail(rec,error);return;}
        const item={transform,draftKey,draftVersion};
        if(rec.failed&&draftKey&&rec.queue[0]?.draftKey===draftKey){
            rec.queue[0]=item;rec.failed=false;if(rec.remote){rec.saved=clone(rec.remote.config);rec.revision=rec.remote.revision;}rebuildConfig(rec);
        }else rec.queue.push(item);
        rec.error='';renderPresets();renderRows();update();if(!rec.failed)void drain(rec);
    }
    async function drain(rec){
        if(disposed||rec.saving||rec.failed||!rec.queue.length||rec.scope!==scope||state.disabled)return;
        const item=rec.queue[0];let value;
        try{value=validatePromptConfig(item.transform(clone(rec.saved)));}catch(error){rec.failed=true;fail(rec,error);return;}
        const base=rec.revision;rec.saving={item,value};rec.message='';update();
        try{
            if(await onSave(value,{scope:rec.scope,revision:base,snapshot:clone(rec.snapshot||null)})===false)throw new Error('提示词尚未保存，请重试');
            rec.saved=clone(value);rec.revision=Math.max(base+1,rec.remote&&same(rec.remote.config,value)?rec.remote.revision:base+1);
            if(!rec.remote||rec.remote.revision<=rec.revision)rec.remote={config:clone(value),revision:rec.revision};
            if(rec.queue[0]===item)rec.queue.shift();
            const draft=rec.drafts.get(item.draftKey);if(draft&&draft.version===item.draftVersion)rec.drafts.delete(item.draftKey);
            rec.message='';rebuildConfig(rec);
        }catch(error){rec.failed=true;fail(rec,error);}
        finally{rec.saving=null;if(!disposed&&rec.scope===scope){renderPresets();renderRows();update();if(!rec.failed)void drain(rec);}}
    }
    function renderPresets(){
        const rec=record();if(!rec)return;
        const defaultActive=!rec.config.selectedPreset&&same(rec.config.groups,DEFAULT_PROMPTS.groups);
        // 下拉里只有「内置默认」与用户存的预设。条目被改过、又不属于任何预设时，下拉不选中任何一项（留空），这样再选「内置默认」仍能恢复。
        const items=[[BUILTIN_PROMPT_PRESET,'内置默认'],...rec.config.presets.map(value=>[value.id,value.name])],signature=JSON.stringify(items);
        if(preset._ymOptions!==signature){preset._ymOptions=signature;preset.replaceChildren(...items.map(([id,text])=>{const option=el('option','',text);option.value=id;return option;}));}
        preset.value=rec.config.selectedPreset|| (defaultActive?BUILTIN_PROMPT_PRESET:'');
    }
    preset.addEventListener('change',()=>{const selected=preset.value;if(!selected){renderPresets();return;}enqueue(value=>selectPromptPreset(value,selected));});
    function move(id,target,group=kind){const g=group;enqueue(value=>{const entries=value.groups[g],from=entries.findIndex(entry=>entry.id===id);if(from<0||target<0||target>=entries.length)return value;const [entry]=entries.splice(from,1);entries.splice(target,0,entry);return value;});}
    function createRow(rec,group,id){
        const key=rowKey(rec.scope,group,id),node=el('details','ym-prompt-item');node.dataset.promptId=id;
        const head=el('summary','ym-prompt-item-head'),drag=el('span','ym-prompt-drag');drag.append(createYimuIcon('drag',{document}));drag.draggable=true;drag.title='拖动排序';drag.setAttribute('aria-hidden','true');
        const title=el('span','ym-prompt-item-title'),tools=el('span','ym-actions ym-prompt-item-tools'),enabled=el('input','ym-switch');enabled.type='checkbox';
        const current=()=>rec.config.groups[group].find(entry=>entry.id===id),local=()=>rec.drafts.get(key),active=()=>!disposed&&scope===rec.scope;
        enabled.addEventListener('click',event=>event.stopPropagation());enabled.addEventListener('change',()=>{if(!active())return;const checked=enabled.checked;enqueue(value=>{const entry=value.groups[group].find(entry=>entry.id===id);if(!entry)throw new Error('此条目已被删除，草稿仍保留');entry.enabled=checked;return value;});});
        const up=button('上移条目','up',()=>{if(active())move(id,rec.config.groups[group].findIndex(entry=>entry.id===id)-1,group);}),down=button('下移条目','down',()=>{if(active())move(id,rec.config.groups[group].findIndex(entry=>entry.id===id)+1,group);});
        const remove=button('删除条目','trash',()=>{if(!active())return;rec.drafts.delete(key);enqueue(value=>{value.groups[group]=value.groups[group].filter(entry=>entry.id!==id);return value;});});
        head.append(drag,title);
        const body=el('div','ym-prompt-item-body'),editHeading=el('div','ym-prompt-edit-heading'),titleInput=el('input');titleInput.type='text';titleInput.maxLength=160;
        const content=el('textarea');content.rows=7;content.maxLength=120000;
        const save=button('保存此条提示词','save',()=>{if(!active())return;const draft=local();if(!draft)return;const patch={name:draft.name,text:draft.text};enqueue(value=>{const entry=value.groups[group].find(entry=>entry.id===id);if(!entry)throw new Error('此条目已被另一端删除，草稿仍保留');Object.assign(entry,patch);return value;},{draftKey:key,draftVersion:draft.version});});
        const cancel=button('撤销此条修改','undo',()=>{if(!active())return;rec.drafts.delete(key);const saving=rec.saving?.item,oldHead=rec.queue[0];rec.queue=rec.queue.filter(item=>item===saving||item.draftKey!==key);if(!rec.saving&&rec.failed&&rec.queue[0]!==oldHead){rec.failed=false;rec.error='';}if(!rec.queue.length&&rec.remote?.revision>rec.revision){rec.saved=clone(rec.remote.config);rec.revision=rec.remote.revision;}rebuildConfig(rec);renderRows();update();void drain(rec);});
        const edited=()=>{if(!active())return;const entry=current()||local()?.base;if(!entry)return;const previous=local();rec.drafts.set(key,{name:titleInput.value,text:content.value,version:(previous?.version||0)+1,base:clone(entry)});update();};
        // 自动保存：停手片刻或离开输入框就保存，不再需要手动点保存图标（图标保留在结构里但不显示）。
        // 上一次保存失败后不自动重发——失败要由用户明确点「重试」；同一版草稿已在排队或保存中时也不重复提交。
        save.hidden=true;save.dataset.rowOwned='true';cancel.dataset.rowOwned='true';
        let autosaveTimer=null;
        const commit=()=>{clearTimeout(autosaveTimer);autosaveTimers.delete(autosaveTimer);autosaveTimer=null;if(!active()||state.disabled||rec.failed)return;const draft=local();if(!draft)return;
            if(rec.saving?.item.draftKey===key&&rec.saving.item.draftVersion===draft.version||rec.queue.some(item=>item.draftKey===key&&item.draftVersion===draft.version))return;save.click();};
        const schedule=()=>{clearTimeout(autosaveTimer);autosaveTimers.delete(autosaveTimer);autosaveTimer=setTimeout(commit,autosaveMs);autosaveTimers.add(autosaveTimer);};
        titleInput.addEventListener('input',()=>{edited();schedule();});content.addEventListener('input',()=>{edited();schedule();});
        titleInput.addEventListener('change',commit);content.addEventListener('change',commit);
        // 排序只靠拖动（上下箭头与它重复，不再显示）。拖动时被拖的条目变淡，落点处画一条线：
        // 往下拖落在目标之后、往上拖落在目标之前，与松手后的实际位置一致。
        up.hidden=true;down.hidden=true;
        const indexOf=entryId=>rec.config.groups[group].findIndex(entry=>entry.id===entryId);
        const clearMarks=()=>{for(const row of rowNodes.values()){delete row.node.dataset.drop;delete row.node.dataset.dragging;}};
        const markDrop=()=>{for(const row of rowNodes.values())delete row.node.dataset.drop;if(dragId&&dragId!==id)node.dataset.drop=indexOf(dragId)<indexOf(id)?'after':'before';};
        drag.addEventListener('dragstart',event=>{if(state.disabled||rec.saving){event.preventDefault();return;}dragId=id;node.dataset.dragging='true';event.dataTransfer?.setData('text/plain',id);});drag.addEventListener('dragend',()=>{dragId='';clearMarks();});
        node.addEventListener('dragover',event=>{if(dragId&&dragId!==id){event.preventDefault();markDrop();}});node.addEventListener('dragleave',()=>{delete node.dataset.drop;});
        node.addEventListener('drop',event=>{if(state.disabled||rec.saving||!dragId||dragId===id)return;event.preventDefault();const moved=dragId;dragId='';clearMarks();move(moved,indexOf(id));});
        // 触屏没有原生拖放：按住把手拖动时自己找手指下面是哪一条，松手落位。
        drag.addEventListener('pointerdown',event=>{
            if(event.pointerType==='mouse'||state.disabled||rec.saving||!active())return;
            event.preventDefault();dragId=id;node.dataset.dragging='true';let target=null;
            const over=moveEvent=>{moveEvent.preventDefault?.();const hit=document.elementFromPoint?.(moveEvent.clientX,moveEvent.clientY)?.closest?.('.ym-prompt-item');
                const row=[...rowNodes.values()].find(item=>item.node===hit&&item.scope===rec.scope&&item.group===group&&item.id!==id)||null;
                for(const item of rowNodes.values())delete item.node.dataset.drop;target=row;if(row)row.node.dataset.drop=indexOf(id)<indexOf(row.id)?'after':'before';};
            const finish=()=>{drag.removeEventListener?.('pointermove',over);drag.removeEventListener?.('pointerup',finish);drag.removeEventListener?.('pointercancel',finish);
                const destination=target;dragId='';clearMarks();if(destination&&!state.disabled&&!rec.saving)move(id,indexOf(destination.id));};
            try{drag.setPointerCapture?.(event.pointerId);}catch{}
            drag.addEventListener('pointermove',over);drag.addEventListener('pointerup',finish);drag.addEventListener('pointercancel',finish);
        });
        // 条目名：双击标题就地改名，点别处（或回车）自动保存，Esc 放弃。展开后的正文区不再另放名称输入框。
        titleInput.className='ym-prompt-title-input';titleInput.hidden=true;title.title='双击改名';
        const closeRename=()=>{if(titleInput.hidden)return;titleInput.hidden=true;title.hidden=false;};
        title.addEventListener('dblclick',event=>{event.preventDefault?.();event.stopPropagation?.();if(!active()||state.disabled||titleInput.disabled)return;title.hidden=true;titleInput.hidden=false;titleInput.focus?.();titleInput.select?.();});
        // 输入框在 summary 里：点它、在里面按空格都不该把条目展开或收起。
        titleInput.addEventListener('click',event=>{event.preventDefault?.();event.stopPropagation?.();});
        titleInput.addEventListener('keyup',event=>{if(event.key===' ')event.preventDefault?.();event.stopPropagation?.();});
        titleInput.addEventListener('keydown',event=>{event.stopPropagation?.();
            if(event.key==='Enter'){event.preventDefault?.();titleInput.blur?.();if(!titleInput.blur)titleInput.emit?.('blur');}
            else if(event.key==='Escape'){event.preventDefault?.();const entry=current()||local()?.base;titleInput.value=entry?.name??titleInput.value;edited();if(entry&&local()?.text===entry.text){rec.drafts.delete(key);update();}closeRename();}});
        titleInput.addEventListener('blur',()=>{if(titleInput.hidden)return;if(!titleInput.value.trim()){titleInput.value=(current()||local()?.base)?.name??'';edited();}title.textContent=titleInput.value;closeRename();commit();});
        tools.append(enabled,up,down,cancel,remove);head.append(titleInput,tools,createYimuIcon('expand',{document}));
        editHeading.hidden=true;editHeading.append(save);body.append(editHeading,content);node.append(head,body);
        const row={node,title,enabled,titleInput,content,up,down,remove,save,cancel,key,scope:rec.scope,group,id};rowNodes.set(key,row);return row;
    }
    function renderRows(){
        const rec=record();if(!rec)return;
        const groups=kind==='summary'?['identity','summary']:[kind];
        const allEntries=[];
        for(const g of groups){const entries=[...rec.config.groups[g]],ids=new Set(entries.map(entry=>entry.id));for(const [key,draft]of rec.drafts){const [owner,group,id]=JSON.parse(key);if(owner===scope&&group===g&&!ids.has(id)){entries.push(draft.base);ids.add(id);}}allEntries.push({group:g,entries});}
        const desired=[];
        for(const {group:g,entries} of allEntries){entries.forEach((entry,index)=>{
            const key=rowKey(scope,g,entry.id),row=rowNodes.get(key)||createRow(rec,g,entry.id),draft=rec.drafts.get(key);
            row.node.className='ym-prompt-item'+(g==='identity'?' ym-prompt-item--identity':'');
            row.title.textContent=draft?.name??entry.name;row.enabled.checked=entry.enabled;row.enabled.setAttribute('aria-label',`启用${entry.name}`);
            for(const [node,label]of[[row.up,`上移${entry.name}`],[row.down,`下移${entry.name}`],[row.remove,`删除${entry.name}`],[row.save,`保存${entry.name}`],[row.cancel,`撤销${entry.name}修改`]]){node.title=label;node.setAttribute('aria-label',label);}
            row.titleInput.setAttribute('aria-label',`${LABELS[g]}条目名称`);row.content.setAttribute('aria-label',`${entry.name}提示词正文`);
            if(!draft){row.titleInput.value=entry.name;row.content.value=entry.text;}else{if(row.titleInput.value!==draft.name)row.titleInput.value=draft.name;if(row.content.value!==draft.text)row.content.value=draft.text;}
            row.up.dataset.edgeDisabled=String(index===0);row.down.dataset.edgeDisabled=String(index===entries.length-1);desired.push(row.node);
        });}
        for(const child of [...list.children])if(!desired.includes(child))child.remove();
        desired.forEach((node,index)=>{if(list.children[index]!==node)list.insertBefore(node,list.children[index]||null);});
        empty.hidden=allEntries.reduce((n,{entries})=>n+entries.length,0)>0;
    }
    function update(){
        const rec=record();if(!rec)return;const disabled=state.disabled===true&&!rec.saving;
        // 每个按钮只写一次最终值：先统一放开再个别禁用会让按钮在一次刷新里来回切换。
        const noPreset=!rec.config.presets.some(value=>value.id===preset.value);
        for(const node of buttons){if(node.dataset.rowOwned==='true')continue;const off=disabled||node.dataset.edgeDisabled==='true'||node===removePreset&&noPreset;if(node.disabled!==off)node.disabled=off;}preset.disabled=disabled;name.disabled=disabled;file.disabled=disabled;
        for(const row of rowNodes.values())if(row.scope===scope){const draft=rec.drafts.get(row.key),ownSaving=rec.saving?.item.draftKey===row.key;row.titleInput.disabled=disabled;row.content.disabled=disabled;row.enabled.disabled=disabled;const idle=disabled||!draft||ownSaving;if(row.save.disabled!==idle)row.save.disabled=idle;if(row.cancel.disabled!==idle)row.cancel.disabled=idle;row.node.dataset.dirty=String(!!draft);}
        badge.textContent=rec.saving||rec.queue.length?'正在保存':rec.drafts.size?'有条目草稿':'';badge.hidden=!badge.textContent;
        recovery.hidden=!rec.failed;retry.disabled=disabled||!!rec.saving;cancelOperation.disabled=disabled||!!rec.saving;
        status.textContent=rec.error||rec.message||'';status.hidden=!status.textContent;
        for(const [key,node]of groupButtons){node.hidden=(key==='recall'&&!recallVisible())||key==='identity';node.setAttribute('aria-selected',String(kind===key));node.tabIndex=kind===key?0:-1;}
        card.setAttribute('aria-busy',String(!!rec.saving));
    }
    file.addEventListener('cancel',event=>event.stopPropagation?.());
    file.addEventListener('change',async()=>{
        const picked=file.files?.[0],owner=scope;file.value='';if(!picked)return;
        try{if(picked.size>2*1024*1024)throw new Error('提示词文件超过 2 MiB');const candidate=importPromptPreset(await picked.text());if(disposed||owner!==scope)return;
            ask(`导入「${picked.name}」并替换当前条目？已有预设和条目草稿保留。`,()=>enqueue(value=>mergeImportedPromptConfig(value,candidate,createId)));
        }catch(error){if(owner===scope)fail(record(),error);}
    });
    function render(next={}){
        if(disposed)return;const nextScope=String(next.scope??JSON.stringify(next.snapshot?.binding||null)),switched=scope!==nextScope;scope=nextScope;state=next;
        const incoming=resolvePromptConfig(next.settings);
        if(!scopes.has(scope))scopes.set(scope,{scope,saved:clone(incoming),config:clone(incoming),revision:next.revision??0,snapshot:clone(next.snapshot||null),drafts:new Map(),queue:[],saving:null,failed:false,error:'',message:''});
        const rec=record();if(!rec.remote||(next.revision??0)>=rec.remote.revision)rec.remote={config:clone(incoming),revision:next.revision??0};rec.snapshot=clone(next.snapshot||null);
        if(!rec.saving&&!rec.queue.length&&(next.revision??0)>=rec.revision){rec.saved=clone(incoming);rec.config=clone(incoming);rec.revision=next.revision??rec.revision;}
        if(switched){nameRow.hidden=true;confirmation.hidden=true;confirmationAction=null;}
        if(kind==='recall'&&!recallVisible())kind='summary';
        if(kind==='identity')kind='summary';
        renderPresets();renderRows();update();if(!rec.failed)void drain(rec);
    }
    render();
    return{render,destroy(){if(disposed)return;disposed=true;for(const timer of autosaveTimers)clearTimeout(timer);autosaveTimers.clear();scopes.clear();rowNodes.clear();buttons.clear();card.remove();}};
}
