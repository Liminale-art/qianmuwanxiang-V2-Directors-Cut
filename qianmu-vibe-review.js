import {createVibeServiceClient} from './qianmu-vibe-service-client.js';
export {createVibeServiceClient};
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const statuses={reserved:'等待核查',submitting:'提交状态待核查',unknown:'结果未确认',rejected:'已明确拒绝',ready:'已缓存'};
const rowKey=row=>`${row.cacheKey}:${row.attemptId}`;
export function createVibeReviewActions({namespace,call,guard,service,locks=globalThis.navigator?.locks}){
  const check=async()=>{await guard();};
  return {
    async list(){await check();const rows=await call('encoding-list',{namespace});await check();return rows.slice().sort((a,b)=>b.updatedAt-a.updatedAt);},
    async receive(row){
      await check();if(row.namespace!==namespace)throw Error('编码记录不属于当前账户');
      if(typeof locks?.request!=='function')throw Error('当前浏览器无法安全核查在途请求，请换用支持跨页协调的浏览器');
      // Existing generation (including older frontends) holds this shared maintenance lock throughout Vibe preparation.
      return locks.request('qianmu:nai-maintenance',{mode:'exclusive',ifAvailable:true},async lock=>{
        if(!lock)throw Error('仍有 NAI 画面正在等待或生成，请结束后领取原编码');
        await check();const expected=await call('encoding-get',{namespace,cacheKey:row.cacheKey});await check();
        if(JSON.stringify(expected)!==JSON.stringify(row))throw Error('原编码记录已变化，请刷新后领取');
        const prepared={cacheKey:row.cacheKey,identity:row.identity},remote=await service.query(prepared);await check();
        if(remote?.status!=='ready')throw Error(remote?.status==='pending'?'原服务编码仍在处理，请稍后刷新':remote?.status==='rejected'?'服务已明确拒绝原编码；未重新提交':remote?'原服务结果尚未确认，请核查渠道任务或账单':'此服务未找到原编码；未切换渠道或重新提交');
        const result=await service.result(prepared);await check();
        if(result.serviceAttemptId!==remote.attemptId)throw Error('领取期间原服务请求已变化，请刷新');
        const args={namespace,cacheKey:row.cacheKey,identity:row.identity,encoding:result.encoding};
        try{
          const saved=await call('recover-encoding',{...args,expected,serviceAttemptId:result.serviceAttemptId,serviceDelivery:result.serviceDelivery});await check();
          if(!saved.sourceMissing)return saved;
        }catch(error){
          await check();
          // A failed local write is not evidence of a refund. Still allow exporting already received bytes without another POST.
          const blob=await call('export-encoding',args);await check();return {blob,warning:'编码已取回，但本地关联未完成；请保存下载文件，原记录仍待核查'};
        }
        const blob=await call('export-encoding',args);await check();return {blob,warning:'原图已缺失，已准备独立编码文件；请保存下载文件，原记录仍待核查'};
      });
    },
    async export(assetRef,selection){await check();if(assetRef?.namespace!==namespace)throw Error('编码文件不属于当前账户');const blob=await call('export-reviewed',{...selection,namespace,id:assetRef.id});await check();return blob;},
  };
}
export function createVibeReviewController({actions,onAdd,onClose,onNotice=()=>{},icons=()=>{},isCurrent=()=>true}){
  let host,disposed=false,revision=0,rows=[],visible=40,busy=false,message='',loaded=false;const recovered=new Map(),urls=new Map();
  const live=()=>!disposed&&isCurrent()&&host?.isConnected;
  function download(blob){const url=URL.createObjectURL(blob),link=host.ownerDocument.createElement('a');link.href=url;link.download='qianmu-recovered.naiv4vibe';host.ownerDocument.body.append(link);link.click();link.remove();urls.set(url,setTimeout(()=>{URL.revokeObjectURL(url);urls.delete(url);},30000));}
  async function refresh(){const token=++revision;busy=true;render();try{const next=await actions.list();if(!live()||token!==revision)return;rows=next;loaded=true;message='';}catch(error){if(live()&&token===revision)message=error.message;}finally{if(live()&&token===revision){busy=false;render();}}}
  const run=callback=>async event=>{event.preventDefault();if(busy||!live())return;const token=revision,active=()=>live()&&token===revision;busy=true;render();try{await callback(active);}catch(error){if(active())message=error.message;}finally{if(active()){busy=false;render();}}};
  function render(){
    if(!live())return;
    host.innerHTML=`<section class="sd-vibe-review"><header><h3>编码记录</h3><button type="button" class="sd-icon-btn sd-vibe-review-refresh" aria-label="刷新记录" ${busy?'disabled':''}><i class="fa-solid fa-rotate"></i></button><button type="button" class="sd-icon-btn sd-vibe-review-close" aria-label="返回 Vibe 库"><i class="fa-solid fa-xmark"></i></button></header><p class="sd-vibe-review-status" role="status">${escape(message||(busy?'正在读取…':'领取只读取原结果，不会重新编码。未确认的费用记录不会自动清除。'))}</p><div class="sd-vibe-review-rows">${rows.slice(0,visible).map((row,index)=>{
      const ref=row.status==='ready'?row.assetRef:recovered.get(rowKey(row)),transport=row.delivery?.transport==='service'?'增强服务':row.delivery?.transport==='direct'?'浏览器直连':'旧记录 · 来源未绑定';
      return `<article data-vibe-review-row="${index}" data-state="${escape(row.status)}"><b>${escape(statuses[row.status]||'待核查')}</b><time>${escape(new Date(row.updatedAt).toLocaleString())}</time><span>${escape(row.identity.remoteModelId)}</span><span>信息提取 ${escape(row.identity.parameters.information_extracted)} · ${escape(transport)}</span><div>${row.status!=='ready'?`<button type="button" class="sd-btn sd-vibe-review-receive" ${busy?'disabled':''}>${row.delivery?.transport==='service'?'领取原结果':'查服务缓存'}</button>`:''}${ref?`<button type="button" class="sd-btn sd-vibe-review-add" ${busy?'disabled':''}>加入 Vibe 库</button><button type="button" class="sd-icon-btn sd-vibe-review-export" aria-label="导出编码文件" ${busy?'disabled':''}><i class="fa-solid fa-download"></i></button>`:''}</div>${row.status!=='ready'?'<small>仍在运行或没有完成证据的请求，不能在此清锁或直接重发。</small>':''}</article>`;
    }).join('')}</div>${rows.length>visible?'<button type="button" class="sd-btn sd-vibe-review-more">加载更多</button>':''}</section>`;
    host.querySelector('.sd-vibe-review-close').onclick=()=>{revision++;onClose();};host.querySelector('.sd-vibe-review-refresh').onclick=()=>void refresh();
    host.querySelector('.sd-vibe-review-more')?.addEventListener('click',()=>{visible+=40;render();});
    for(const article of host.querySelectorAll('[data-vibe-review-row]')){
      const row=rows[Number(article.dataset.vibeReviewRow)],ref=row.status==='ready'?row.assetRef:recovered.get(rowKey(row)),selection={model:row.identity.capabilityModelId,information:row.identity.parameters.information_extracted,expectedSourceId:row.identity.sourceId};
      article.querySelector('.sd-vibe-review-receive')?.addEventListener('click',run(async active=>{
        const result=await actions.receive(row);if(!active())return;
        if(result.blob){download(result.blob);message=result.warning;onNotice(message);return;}
        recovered.set(rowKey(row),result.assetRef);const next=await actions.list();if(!active())return;rows=next;
        message=result.reconciled?'原编码已领取并关联，无需再次编码':'已领取为独立素材；原记录的发送来源无法核实，费用状态仍保留';
      }));
      article.querySelector('.sd-vibe-review-add')?.addEventListener('click',run(async active=>{await onAdd(ref,selection);if(active())message='已加入 Vibe 库，未改变当前生成配置';}));
      article.querySelector('.sd-vibe-review-export')?.addEventListener('click',run(async active=>{const blob=await actions.export(ref,selection);if(active())download(blob);}));
    }icons(host);
  }
  return {mount(node){this.detach();host=node;render();if(!loaded)void refresh();},detach(){revision++;host=null;busy=false;},dispose(){this.detach();disposed=true;recovered.clear();for(const [url,timer] of urls){clearTimeout(timer);URL.revokeObjectURL(url);}urls.clear();}};
}
