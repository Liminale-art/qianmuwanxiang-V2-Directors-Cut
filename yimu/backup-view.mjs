// Selection starts import immediately; only ambiguous targets need an inline choice.
export function createBackupView({document = globalThis.document, onAction, pageMode = false} = {}) {
    const el = (tag, cls = '', text) => {const n = document.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n;};
    const button = (text, action) => {const n = el('button','ym-button',text); n.type = 'button'; n.setAttribute('aria-label',text); n.addEventListener('click',action); return n;};
    const node = el(pageMode ? 'section':'details', `ym-backup ${pageMode ? 'ym-subpage-section':'ym-card'}`);
    if (!pageMode) node.append(el('summary','','记忆备份'));
    const body = el('div','ym-backup-body'); node.append(body);
    let state = {}, alive = true, working = false, error = '', planKey = '', itemsKey = '', exportMode='',exportScope='',exportTicket=0;
    const choices = new Map(), targets = new Map();
    const exportButton = button('导出记忆',()=>{exportTicket++;exportScope=JSON.stringify(state.snapshot?.binding||null);exportMode='question';error='';update();});
    const exportRow = el('div','ym-actions ym-backup-actions');
    const sources = el('div','ym-backup-sources'); sources.hidden = true;
    const question=el('dialog','ym-backup-question'),questionText=el('p','','是否将相关聊天文件一起打包？'),questionActions=el('div','ym-actions ym-backup-question-actions');question.hidden=true;question.setAttribute('aria-label','导出记忆');
    const questionNotice=el('p','ym-inline-warning');questionNotice.setAttribute('aria-live','polite');questionNotice.hidden=true;
    const dismissExport=()=>{exportTicket++;exportMode='';error='';update();};
    question.addEventListener('cancel',event=>{event.preventDefault();event.stopPropagation();dismissExport();});
    question.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();dismissExport();}});
    question.addEventListener('click',event=>{if(event.target===question){event.stopPropagation();dismissExport();}});
    const yes=button('是，一起打包',async()=>{
        const ticket=++exportTicket;exportMode='planning';update();const plan=await invoke('backupPlan');
        if(!alive||ticket!==exportTicket||exportScope!==JSON.stringify(state.snapshot?.binding||null))return;
        const value=plan?.planId?plan:state.backup?.exportPlan;
        if(!value?.planId){exportMode='question';update();return;}
        const available=(value.sources||[]).filter(source=>source.available);
        if(!available.length){error='聊天文件当前不可读取，可选择“否”仅导出记忆。';exportMode='question';update();return;}
        if(available.length===1&&available[0].id===value.primarySourceId){exportMode='';update();await invoke('backupQuickExport',{includeOriginals:true,planId:value.planId,sourceIds:[value.primarySourceId]});}
        else{exportMode='sources';planKey='';update();}
    });
    const no=button('否，仅导出记忆',()=>{exportTicket++;exportMode='';update();void invoke('backupQuickExport',{includeOriginals:false});});
    const cancelExport=button('取消导出',dismissExport);
    yes.textContent='是';no.textContent='否';cancelExport.textContent='取消';
    const pack=button('打包并导出',()=>{const plan=state.backup?.exportPlan;exportMode='';update();void invoke('backupQuickExport',{includeOriginals:true,planId:plan?.planId,sourceIds:[...choices].filter(([,input])=>input.checked).map(([id])=>id)});});
    questionActions.append(yes,no,cancelExport,pack);question.append(questionText,sources,questionNotice,questionActions);
    const pick = el('input'); pick.type = 'file'; pick.accept = '.yimu.gz'; pick.multiple = true; pick.hidden = true; pick.setAttribute('aria-label','忆幕备份文件');
    const choose = button('导入记忆',()=>{if(alive&&!pick.disabled){pick.value='';pick.click();}});exportRow.append(exportButton,choose);
    const notice = el('p','ym-muted'); notice.setAttribute('aria-live','polite'); notice.hidden = true;
    const results = el('div','ym-backup-list'); results.setAttribute('aria-live','polite');
    body.append(exportRow,question,pick,notice,results);
    async function invoke(type,payload={}) {
        if(!alive||working||state.backup?.busy)return;
        working=true;error='';update();
        try{return await onAction?.(type,payload);}catch(caught){if(alive)error=caught.message||'备份操作未完成';}
        finally{if(alive){working=false;update();}}
    }
    pick.addEventListener('cancel',event=>event.stopPropagation?.());
    pick.addEventListener('change',()=>{const files=Array.from(pick.files||[]);pick.value='';if(files.length)void invoke('backupImport',{files});});
    function renderSources(disabled) {
        const plan=state.backup?.exportPlan;sources.hidden=exportMode!=='sources';
        if(exportMode!=='sources')return;
        const key=JSON.stringify([plan?.planId,plan?.binding]);
        if(key!==planKey){
            planKey=key;choices.clear();sources.replaceChildren();
            for(const source of plan?.sources||[]){
                const input=el('input');input.type='checkbox';input.checked=source.id===plan.primarySourceId&&source.available;
                input.addEventListener('change',()=>update());
                input.setAttribute('aria-label',source.label||source.binding?.file||source.id);input.dataset.ymBackupSource=source.id;
                const row=el('label','ym-backup-check');row.append(input,el('span','',`${source.label||source.binding?.file||source.id}${source.available?'':'（原件不可读）'}`));sources.append(row);choices.set(source.id,input);
            }
        }
        for(const source of plan?.sources||[])choices.get(source.id).disabled=disabled||!source.available;
    }
    function renderItems(disabled) {
        const items=state.backup?.items||[],key=JSON.stringify([items.map(({file,...item})=>item),disabled]);
        if(itemsKey===key)return;itemsKey=key;results.replaceChildren();
        for(const item of items){
            const card=el('section','ym-backup-section');card.dataset.ymBackupItem=item.id;
            const label={queued:'等待处理',uploading:'正在读取并核对备份',matching:'正在匹配并合并记忆',restoring:'正在找回聊天原件',selection:'请选择目标',complete:'已完成',failed:'未完成','upload-unknown':'上传结果待核对','merge-unknown':'导入结果待核对',cancelled:'已取消'}[item.status]||item.status;
            card.append(el('h4','',item.name),el('p',item.error?'ym-inline-warning':'ym-muted',item.error||item.message||label));
            if(item.status==='selection'){
                const select=el('select');select.setAttribute('aria-label',`导入目标 ${item.name}`);
                const placeholder=el('option','','请选择聊天或角色');placeholder.value='';select.append(placeholder);
                for(const [index,candidate]of(item.candidates||[]).entries()){
                    const option=el('option','',`${candidate.label}${candidate.exact?' · 原文一致':' · 原文待核对'}`);option.value=`chat:${index}`;select.append(option);
                }
                const attached=item.archive?.sources?.some(source=>source.id===item.archive.primarySourceId&&source.included);
                if(attached)for(const role of state.backup?.roles||[]){const option=el('option','',`另建聊天至 ${role.name} · ${role.avatar}`);option.value=`role:${role.avatar}`;select.append(option);}
                select.value=targets.get(item.id)||'';select.disabled=disabled;
                const confirm=button('确认导入至所选目标',()=>{
                    if(select.value.startsWith('chat:'))void invoke('backupResolve',{itemId:item.id,targetBinding:item.candidates[Number(select.value.slice(5))]?.binding});
                    else if(select.value.startsWith('role:'))void invoke('backupResolve',{itemId:item.id,targetAvatar:select.value.slice(5)});
                });confirm.disabled=disabled||!select.value;
                select.addEventListener('change',()=>{targets.set(item.id,select.value);confirm.disabled=disabled||!select.value;});
                const cancel=button('取消本次关联',()=>invoke('backupCancel',{itemId:item.id}));cancel.disabled=disabled;card.append(select,confirm,cancel);
                if(!item.candidates?.length&&!attached)card.append(el('p','ym-muted','尚无可关联的聊天。可先在 ST 中导入原聊天，再重新导入此备份。'));
            }else if(['upload-unknown','merge-unknown','failed'].includes(item.status)){
                const retry=button('核对并继续本次导入',()=>invoke('backupRetry',{itemId:item.id}));retry.disabled=disabled;card.append(retry);
            }
            results.append(card);
        }
    }
    function update(){
        const backup=state.backup||{},busy=working||backup.busy,disabled=!!busy||['error','mismatch','checking'].includes(state.service?.status);
        const binding=JSON.stringify(state.snapshot?.binding||null),matches=JSON.stringify(backup.exportPlan?.binding||null)===binding;
        if(exportMode&&exportScope!==binding){exportMode='';exportTicket++;}
        exportButton.disabled=disabled||!state.snapshot||!state.document;choose.disabled=pick.disabled=disabled;
        question.hidden=!exportMode;
        if(exportMode&&!question.open){if(typeof question.showModal==='function')question.showModal();else question.setAttribute('open','');}
        else if(!exportMode&&question.open){if(typeof question.close==='function')question.close();else question.removeAttribute('open');}
        yes.hidden=exportMode==='sources';pack.hidden=exportMode!=='sources';yes.disabled=no.disabled=disabled;pack.disabled=disabled||!matches;
        cancelExport.disabled=false;questionText.textContent=exportMode==='sources'?'选择一起打包的相关聊天文件：':'是否将相关聊天文件一起打包？';
        renderSources(disabled);pack.disabled=disabled||!matches||![...choices.values()].some(input=>input.checked);renderItems(disabled);
        questionNotice.textContent=error||backup.error||'';questionNotice.hidden=!questionNotice.textContent;
        notice.textContent=error||backup.error||backup.status||(busy?'正在处理备份…':'');notice.hidden=!!exportMode||!notice.textContent;
        notice.className=error||backup.error?'ym-inline-warning':'ym-muted';node.setAttribute('aria-busy',String(!!busy));
    }
    return{node,render(next){state=next||{};update();},destroy(){alive=false;targets.clear();choices.clear();node.remove();}};
}
