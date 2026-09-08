import {VIBE_PRESERVATION_TABLES} from './qianmu-vibe-preservation.js';
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function createVibePreservationActions({namespace,call,guard}){
  return {
    async page(section,after=''){await guard();const result=await call('preservation-page',{namespace,section,after});await guard();return result;},
    async export(section,key,confirm){
      await guard();const yes=await confirm('导出原始保全文件','仅导出所选原始条目，不修复、不清理、不恢复任务或授权收费。文件可能包含账户、渠道及其他隐私，请仅本机保留、勿公开分享。它不能作为可直接导入的 Vibe 素材包。');
      await guard();if(yes!==true)return null;const blob=await call('preservation-export',{namespace,section,key});await guard();return blob;
    },
  };
}
export function createVibePreservationController({actions,onClose,confirm=async()=>false,icons=()=>{},isCurrent=()=>true}){
  let host,disposed=false,epoch=0,busy=false,section='heads',page=null,after='',message='';const back=[],urls=new Map();
  const live=()=>!disposed&&isCurrent()&&host?.isConnected;
  const run=work=>async event=>{event?.preventDefault();if(!live()||busy)return;const ticket=epoch,active=()=>live()&&ticket===epoch;busy=true;render();
    try{await work(active);}catch(error){if(active())message=error.message;}finally{if(active()){busy=false;render();}}};
  async function load(active){const result=await actions.page(section,after);if(active()){page=result;message='';}}
  function render(){
    if(!live())return;const rows=page?.rows||[];
    host.innerHTML=`<section class="sd-vibe-review sd-vibe-preservation"><header><h3>原始数据保全</h3><button type="button" class="sd-icon-btn sd-preserve-close" aria-label="返回"><i class="fa-solid fa-xmark"></i></button></header>
      <p role="status">${escape(message||(busy?'正在读取…':'只读 · 当前设备与 ST 账户'))}</p><p class="sd-vibe-review-file-info">目录或计值损坏时可从这里逐项保全。仅按编号列出，不判断内容有效性；没有清理或恢复操作。不能确认账户归属的条目不导出。</p>
      <div class="sd-vibe-review-tools"><select class="text_pole sd-preserve-section" aria-label="保全分区" ${busy?'disabled':''}>${VIBE_PRESERVATION_TABLES.map(row=>`<option value="${row.id}" ${row.id===section?'selected':''}>${row.label}</option>`).join('')}</select><button type="button" class="sd-icon-btn sd-preserve-refresh" aria-label="刷新原始条目" ${busy?'disabled':''}><i class="fa-solid fa-rotate"></i></button></div>
      <small class="sd-vibe-review-file-info">每页最多 40 项。列表不读取图片/编码正文；选择导出后才读取单项。${page?.missing?'本机尚无此分区，未创建或升级数据库。':''}</small>
      <div class="sd-vibe-review-rows">${rows.map((row,i)=>`<article><span>${escape(row.key)}</span><button type="button" class="sd-btn" data-preserve-row="${i}" ${busy||!row.readable?'disabled':''}>${row.readable?'导出此项':'无法确认归属'}</button></article>`).join('')}</div>
      <div class="sd-vibe-review-tools"><button type="button" class="sd-btn sd-preserve-prev" ${busy||!back.length?'disabled':''}>上一页</button><button type="button" class="sd-btn sd-preserve-next" ${busy||!page?.next?'disabled':''}>下一页</button></div></section>`;
    host.querySelector('.sd-preserve-close').onclick=()=>{epoch++;onClose();};
    host.querySelector('.sd-preserve-section').onchange=event=>{section=event.target.value;page=null;after='';back.length=0;void run(load)();};
    host.querySelector('.sd-preserve-refresh').onclick=run(load);
    host.querySelector('.sd-preserve-prev').onclick=run(async active=>{after=back.pop()||'';page=null;await load(active);});
    host.querySelector('.sd-preserve-next').onclick=run(async active=>{back.push(after);after=page.next;page=null;await load(active);});
    for(const button of host.querySelectorAll('[data-preserve-row]'))button.onclick=run(async active=>{
      const row=rows[Number(button.dataset.preserveRow)],blob=await actions.export(section,row.key,async(...args)=>{if(!active())return false;const yes=await confirm(...args);return active()&&yes===true;});if(!active())return;
      if(!blob){message='已取消，原数据未改动';return;}
      const url=URL.createObjectURL(blob),link=host.ownerDocument.createElement('a');link.href=url;link.download=`qianmu-vibe-preservation-${section}-${Date.now()}.json`;host.ownerDocument.body.append(link);link.click();link.remove();urls.set(url,setTimeout(()=>{URL.revokeObjectURL(url);urls.delete(url);},30000));
      message='已发起保全下载，请确认文件已保存。原数据仍在；此文件不能直接恢复任务。';
    });icons(host);
  }
  return {mount(node){this.detach();host=node;render();void run(load)();},detach(){epoch++;host=null;busy=false;},dispose(){this.detach();disposed=true;page=null;for(const [url,timer] of urls){clearTimeout(timer);URL.revokeObjectURL(url);}urls.clear();}};
}
