// One floor and one action. Validation/planning remain internal, not another page.
export function createStoryView({document = globalThis.document, onAction, onNotice = () => {}, pageMode = false} = {}) {
    const el = (tag, cls = '', text) => {const node=document.createElement(tag);node.className=cls;if(text!==undefined)node.textContent=text;return node;};
    const button = (text, action) => {const node=el('button','ym-button',text);node.type='button';node.setAttribute('aria-label',text);node.addEventListener('click',action);return node;};
    const node=el(pageMode?'section':'details',`ym-story ${pageMode?'ym-subpage-section':'ym-card'}`);
    if(!pageMode)node.append(el('summary','','故事续接'));
    const body=el('div','ym-story-body'), cutoff=el('input');cutoff.type='number';cutoff.min='1';cutoff.step='1';cutoff.setAttribute('aria-label','续接楼层');
    const field=el('label','ym-field ym-story-cutoff');field.append(el('span','','续接楼层'),cutoff);
    const create=button('建立新聊天',()=>{
        const story=state.story||{},receipt=story.result?.receipt||story.receipt;
        if(receipt?.status==='complete')return invoke('storyOpen');
        if(story.pending||story.operation||story.operationId)return invoke('storyCreate',{retry:true});
        return invoke('storyContinue',{cutoff:Number(cutoff.value)});
    });create.className+=' ym-primary';
    const controls=el('div','ym-story-controls');controls.append(field,create);
    body.append(controls);node.append(body);
    let state={},scope='',alive=true,working=false,revision=0;
    const count=()=>state.snapshot?.messages?.length||0;
    async function invoke(type,payload={}){
        if(!alive||working||state.story?.busy)return;
        if(type==='storyContinue'&&(!Number.isSafeInteger(payload.cutoff)||payload.cutoff<1||payload.cutoff>count())){onNotice('请输入当前聊天内有效的续接楼层。','warning');return;}
        const ticket=revision;working=true;update();
        try{
            const result=await onAction?.(type,payload);
            if(!alive)return;
            const notice=(message,tone)=>onNotice(result?.transferNote?`${message.replace(/[。；]+$/u,'')}；${result.transferNote}。`:message,
                result?.transferNote&&tone==='success'?'warning':tone);
            if(type==='storyOpen')notice(result?.opened?'已打开忆幕续接聊天。':result?.message||'打开尚未确认，请稍后重试。',result?.opened?'success':'warning');
            else if(result?.receipt?.status==='complete')notice(result.openResult?.opened===false
                ? `续接聊天已建立；${result.openResult.message||'请再次点击建立按钮打开。'}`:'已建立忆幕续接聊天。',result.openResult?.opened===false?'warning':'success');
        }catch(caught){if(alive&&ticket===revision)onNotice(caught.message||'续接聊天建立失败。','error');}
        finally{if(ticket===revision){working=false;update();}}
    }
    function update(){
        const story=state.story||{},busy=working||story.busy,available=!!state.snapshot&&!!state.document&&!state.loading&&state.sourceAvailable!==false;
        const receipt=story.result?.receipt||story.receipt,complete=receipt?.status==='complete',pending=!complete&&!!(story.pending||story.operation||story.operationId);
        cutoff.max=String(count());cutoff.disabled=!available||!!busy||pending||complete;
        create.disabled=!available||!!busy||!!state.busy;
        create.textContent=busy?'正在建立…':'建立新聊天';
        create.title=complete?'打开本次已建立的聊天，不重复建立':pending?'继续核对本次建立，不重复创建':'';
        node.setAttribute('aria-busy',String(!!busy));
    }
    cutoff.addEventListener('input',update);
    return{node,render(next){state=next||{};const key=JSON.stringify(state.snapshot?.binding||null);if(key!==scope){scope=key;revision++;working=false;cutoff.value=String(count());if(!pageMode)node.open=false;}update();},destroy(){alive=false;revision++;node.remove();}};
}
