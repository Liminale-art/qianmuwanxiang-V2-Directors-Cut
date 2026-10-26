// One floor and one action. Validation/planning remain internal, not another page.
export function createStoryView({document = globalThis.document, onAction, pageMode = false} = {}) {
    const el = (tag, cls = '', text) => {const node=document.createElement(tag);node.className=cls;if(text!==undefined)node.textContent=text;return node;};
    const button = (text, action) => {const node=el('button','ym-button',text);node.type='button';node.setAttribute('aria-label',text);node.addEventListener('click',action);return node;};
    const node=el(pageMode?'section':'details',`ym-story ${pageMode?'ym-subpage-section':'ym-card'}`);
    if(!pageMode)node.append(el('summary','','故事续接'));
    const body=el('div','ym-story-body'), cutoff=el('input');cutoff.type='number';cutoff.min='1';cutoff.step='1';cutoff.setAttribute('aria-label','续接楼层');
    const field=el('label','ym-field');field.append(el('span','','续接楼层'),cutoff);
    const create=button('建立新聊天',()=>invoke('storyContinue',{cutoff:Number(cutoff.value)}));create.className+=' ym-primary';
    const fee=el('p','ym-muted','如需整理截止处的切片，将使用当前整理连接，可能计费。');fee.hidden=true;
    const result=el('p','ym-muted'),open=button('打开已建立的聊天',()=>invoke('storyOpen'));
    const retry=button('继续本次建立',()=>invoke('storyCreate',{retry:true}));
    const notice=el('p','ym-muted');notice.setAttribute('aria-live','polite');notice.hidden=true;
    const controls=el('div','ym-story-controls');controls.append(field,create);
    const actions=el('div','ym-actions');actions.append(open,retry);body.append(controls,fee,actions,result,notice);node.append(body);
    let state={},scope='',alive=true,working=false,error='',revision=0;
    const count=()=>state.snapshot?.messages?.length||0;
    async function invoke(type,payload={}){
        if(!alive||working||state.story?.busy)return;
        if(type==='storyContinue'&&(!Number.isSafeInteger(payload.cutoff)||payload.cutoff<1||payload.cutoff>count())){error='请输入当前聊天内有效的续接楼层。';update();return;}
        const ticket=revision;working=true;error='';update();
        try{await onAction?.(type,payload);}catch(caught){if(ticket===revision)error=caught.message||'故事尚未建立';}
        finally{if(ticket===revision){working=false;update();}}
    }
    function update(){
        const story=state.story||{},busy=working||story.busy,available=!!state.snapshot&&!!state.document&&!state.loading&&state.sourceAvailable!==false;
        const receipt=story.result?.receipt||story.receipt,complete=receipt?.status==='complete',pending=!complete&&!!(story.pending||story.operation||story.operationId);
        cutoff.max=String(count());cutoff.disabled=!available||!!busy||pending||complete;
        create.disabled=!available||!!busy||!!state.busy||pending||complete;
        create.hidden=!!pending;
        open.hidden=!complete;open.disabled=!!busy||!available;retry.hidden=!pending;retry.disabled=!!busy||!available;
        result.textContent=complete?`已建立：${receipt.target?.file||story.result?.binding?.file||''}`:pending?'建立结果尚未确认；继续会核对本次操作，不重复创建聊天。':'';
        const floor=Number(cutoff.value),limit=(state.document?.lineage?.offset||0)+floor;
        fee.hidden=!(state.document?.entries||[]).some(entry=>entry.kind==='summary'&&!entry.edited&&entry.status==='active'&&entry.source
            &&(entry.origin?.offset??state.document?.lineage?.offset??0)+entry.source.start<=limit
            &&(entry.origin?.offset??state.document?.lineage?.offset??0)+entry.source.end>limit);
        notice.textContent=error||story.error||story.status||(busy?'正在核对并建立新聊天…':'');notice.hidden=!notice.textContent;
        notice.className=error||story.error?'ym-inline-warning':'ym-muted';node.setAttribute('aria-busy',String(!!busy));
    }
    cutoff.addEventListener('input',()=>{error='';update();});
    return{node,render(next){state=next||{};const key=JSON.stringify(state.snapshot?.binding||null);if(key!==scope){scope=key;revision++;working=false;error='';cutoff.value=String(count());if(!pageMode)node.open=false;}update();},destroy(){alive=false;revision++;node.remove();}};
}
