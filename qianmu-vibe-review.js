import {createVibeServiceClient} from './qianmu-vibe-service-client.js';
import {matchesVibeServiceDelivery} from './qianmu-vibe-encoding-store.js';
export {createVibeServiceClient};
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const statuses={reserved:'等待核查',submitting:'提交状态待核查',unknown:'结果未确认',rejected:'已明确拒绝',ready:'已缓存',reviewed:'已核查 · 原费用未知'};
const rowKey=row=>`${row.cacheKey}:${row.attemptId}`;
export function createVibeReviewActions({namespace,call,guard,service,locks=globalThis.navigator?.locks}){
  const check=async()=>{await guard();};
  return {
    async list(){await check();const rows=await call('encoding-list',{namespace});await check();return rows.slice().sort((a,b)=>b.updatedAt-a.updatedAt);},
    async archivePage(after=''){await check();const page=await call('encoding-archive-page',{namespace,after});await check();return page;},
    async reviewHistory(row){await check();if(row?.namespace!==namespace)throw Error('核查明细不属于当前账户');const result=await call('encoding-review-history',{namespace,cacheKey:row.cacheKey,expected:row});await check();return result;},
    async compactReviews(row,confirm){
      if(row?.namespace!==namespace||!Array.isArray(row.pastReviews)||row.pastReviews.length<16||row.pastReviews.length>32)throw Error('累积至少 16 次旧核查明细后可整理');
      const expected=structuredClone(row);await check();
      const yes=await confirm('整理旧核查明细',`将 ${expected.pastReviews.length} 次旧核查明细移入完整历史档案，释放当前明细名额。\n当前请求、原时间与费用状态不会改变，未知费用仍未知；旧编号仍禁止重复使用。\n此操作不重新编码、不退款、不释放磁盘，也不代表已授权下一笔请求。`);
      await check();if(yes!==true)return {cancelled:true};
      const result=await call('encoding-compact-reviews',{namespace,cacheKey:expected.cacheKey,expected,confirmed:true});await check();return result;
    },
    async archiveCompleted(selected,confirm){
      if(!Array.isArray(selected)||!selected.length||selected.length>40||new Set(selected.map(row=>row?.cacheKey)).size!==selected.length
        ||selected.some(row=>row?.namespace!==namespace||row.status!=='ready'))throw Error('请选择 1～40 条已完成编码；未决记录不能归档');
      const expected=structuredClone(selected);await check();
      const yes=await confirm('归档已完成编码',`将这 ${expected.length} 条已完成记录移入本机历史档案，腾出当前记录名额。\n完整请求、原结果引用和费用核查历史均保留；归档不释放磁盘，不重新编码，也不把历史未知费用改为已结清。\n历史档案可继续查看、导出和复用，文件缺失时需恢复原文件。`);
      await check();if(yes!==true)return {cancelled:true};
      const result=await call('encoding-archive',{namespace,expected,confirmed:true});await check();return result;
    },
    async exportPage(selected){await check();const expected=structuredClone(selected);if(!Array.isArray(expected)||expected.some(row=>row?.namespace!==namespace))throw Error('编码记录不属于当前账户');
      const blob=await call('encoding-export-page',{namespace,expected});await check();return blob;},
    async exportRecords(row){
      await check();if(row&&row.namespace!==namespace)throw Error('编码记录不属于当前账户');
      const blob=await call('encoding-export',{namespace,...(row?{cacheKey:row.cacheKey,expected:row}:{})});await check();return blob;
    },
    async inspectFile(file){await check();const result=await call('encoding-inspect-file',{namespace,file});await check();return result;},
    async review(row,confirm){
      await check();if(row.namespace!==namespace)throw Error('编码记录不属于当前账户');
      if(typeof locks?.request!=='function')throw Error('当前浏览器无法安全协调核查，请更换支持跨页协调的浏览器');
      return locks.request('qianmu:nai-maintenance',{mode:'exclusive',ifAvailable:true},async lock=>{
        if(!lock)throw Error('仍有 NAI 请求正在等待或生成，请结束后再核查');
        await check();const expected=await call('encoding-get',{namespace,cacheKey:row.cacheKey});await check();
        if(JSON.stringify(expected)!==JSON.stringify(row))throw Error('原费用记录已变化，请刷新');
        if(row.delivery?.transport!=='service'){
          const proof=await call('encoding-review-local-plan',{namespace,cacheKey:row.cacheKey,expected});await check();
          const yes=await confirm('人工核查原编码',
            `${row.delivery?.transport==='direct'?'这是浏览器直连记录。':'这是来源未绑定的旧记录。'}请先到原渠道核对任务和账单，确认任务已经结束；仍在运行或无法判断时请取消。\n本机无法证明上游是否出结果或扣费，原未知事实和记录会保留。\n确认仅允许之后另行授权新编码，不会重发、退款，也不会解除服务端占用。`);
          await check();if(yes!==true)return {cancelled:true};
          const result=await call('encoding-review-local',{namespace,cacheKey:row.cacheKey,expected,proof,confirmed:true});await check();return result;
        }
        let plan=await service.review(row);await check();
        if(plan.requestDigest!==row.cacheKey||!matchesVibeServiceDelivery(row,plan.attemptId,plan.serviceDelivery))throw Error('此服务凭据不能对应原编码提交，未清除本机费用记录');
        if(!plan.reviewed){
          if(!plan.canReview)throw Error(plan.message);
          const yes=await confirm('核查原编码','请先在渠道确认原任务已结束，并核对账单。\n原结果及费用仍可能无法确认，此事实会保留。\n继续只解除此原请求的限制，不会重新编码或生图；新编码仍须另行确认费用。');
          await check();if(yes!==true)return {cancelled:true};
          const latest=await call('encoding-get',{namespace,cacheKey:row.cacheKey});await check();if(JSON.stringify(latest)!==JSON.stringify(expected))throw Error('核查期间本机记录已变化，请刷新');
          plan=await service.confirmReview(row,plan.confirmation);await check();
        }
        if(!plan.reviewed||plan.requestDigest!==row.cacheKey||!matchesVibeServiceDelivery(row,plan.attemptId,plan.serviceDelivery))throw Error('原核查结果尚未匹配，请刷新后续办；未重新编码');
        const result=await call('encoding-review',{namespace,cacheKey:row.cacheKey,expected,delivery:plan});await check();return result;
      });
    },
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
export function createVibeReviewController({actions,onAdd,onClose,confirm=async()=>false,onNotice=()=>{},icons=()=>{},isCurrent=()=>true}){
  let host,disposed=false,revision=0,rows=[],visible=40,busy=false,message='',loaded=false,archive=null,reviewHistory=null,historical=false,historyAfter='',historyNext='',historyCount=0;const historyCursors=[],recovered=new Map(),urls=new Map();
  const live=()=>!disposed&&isCurrent()&&host?.isConnected;
  function download(blob,name='qianmu-recovered.naiv4vibe'){const url=URL.createObjectURL(blob),link=host.ownerDocument.createElement('a');link.href=url;link.download=name;host.ownerDocument.body.append(link);link.click();link.remove();urls.set(url,setTimeout(()=>{URL.revokeObjectURL(url);urls.delete(url);},30000));}
  function downloadRecords(blob){download(blob,`qianmu-vibe-records-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);message='已发起记录下载，请确认文件已保存。可用“校验记录文件”检查；本机原记录未清除。';}
  async function refresh(){const token=++revision;busy=true;render();try{const next=historical?await actions.archivePage(historyAfter):{rows:await actions.list()};if(!live()||token!==revision)return;rows=next.rows;historyNext=next.next||'';historyCount=next.count||0;loaded=true;message='';}catch(error){if(live()&&token===revision)message=error.message;}finally{if(live()&&token===revision){busy=false;render();}}}
  const run=callback=>async event=>{event.preventDefault();if(busy||!live())return;const token=revision,active=()=>live()&&token===revision;busy=true;render();try{await callback(active);}catch(error){if(active())message=error.message;}finally{if(active()){busy=false;render();}}};
  function renderHistory(){
    const current=reviewHistory,{reviews,offset}=current;
    host.innerHTML=`<section class="sd-vibe-review"><header><h3>核查明细</h3><button class="sd-icon-btn sd-vibe-history-close" type="button" aria-label="返回编码记录"><i class="fa-solid fa-xmark"></i></button></header>
      <p class="sd-vibe-review-status" role="status">${escape(message||'原结果及费用未知 · 完整明细保留，只读查阅。')}</p><small class="sd-vibe-review-file-info">${reviews.length} 次 · 每页 40 次 · ${current.file?'来自校验文件，不读取或覆盖本机':'来自本机历史档案'}</small>
      ${current.file?'':`<button type="button" class="sd-btn sd-vibe-history-export" ${busy?'disabled':''}>导出记录及完整明细</button>`}
      <div class="sd-vibe-review-rows">${reviews.slice(offset,offset+40).map(row=>`<article><b>${row.feeReview.method==='local-user'?'本机人工确认 · 上游未验证':'原服务核查'}</b><time>${escape(new Date(row.feeReview.at).toLocaleString())}</time><span>原结果及费用未知</span><span>尝试 ${escape(row.attemptId)}</span><small>${row.delivery?.transport==='service'?'增强服务':row.delivery?.transport==='direct'?'浏览器直连':'旧记录 · 来源未绑定'}</small></article>`).join('')}</div>
      <div class="sd-vibe-review-tools"><button type="button" class="sd-btn sd-vibe-history-prev" ${busy||!offset?'disabled':''}>上一页</button><button type="button" class="sd-btn sd-vibe-history-next" ${busy||offset+40>=reviews.length?'disabled':''}>下一页</button></div></section>`;
    host.querySelector('.sd-vibe-history-close').onclick=()=>{revision++;busy=false;reviewHistory=null;message='';render();};
    host.querySelector('.sd-vibe-history-prev').onclick=()=>{current.offset=Math.max(0,offset-40);render();};
    host.querySelector('.sd-vibe-history-next').onclick=()=>{current.offset=offset+40;render();};
    host.querySelector('.sd-vibe-history-export')?.addEventListener('click',run(async active=>{const blob=await actions.exportRecords(current.receipt);if(active())downloadRecords(blob);}));icons(host);
  }
  function render(){
    if(!live())return;
    if(reviewHistory){renderHistory();return;}
    const displayed=archive?.receipts||rows,limit=archive?.visible||visible;
    const readyBatch=rows.slice(0,visible).filter(row=>row.status==='ready').slice(0,40);
    host.innerHTML=`<section class="sd-vibe-review"><header><h3>${archive?'记录文件预览':historical?'历史编码':'编码记录'}</h3>${archive?'':`<button type="button" class="sd-icon-btn sd-vibe-review-refresh" aria-label="刷新记录" ${busy?'disabled':''}><i class="fa-solid fa-rotate"></i></button>`}<button type="button" class="sd-icon-btn sd-vibe-review-close" aria-label="${archive?'返回本机记录':'返回 Vibe 库'}"><i class="fa-solid fa-xmark"></i></button></header><p class="sd-vibe-review-status" role="status">${escape(message||(busy?'正在读取…':'领取只读取原结果，不会重新编码。未确认的费用记录不会自动清除。'))}</p>${archive?`<p class="sd-vibe-review-file-info">${escape(new Date(archive.exportedAt).toLocaleString())} · ${archive.receipts.length} 条 · ${(archive.bytes/1024).toFixed(1)} KB<br>摘要 ${escape(archive.fingerprint)}<br>仅核查记录，不含图片或编码。摘要只校验内容，不证明上游任务或费用；没有恢复或覆盖本机数据。</p>`:`<div class="sd-vibe-review-tools">
      <button type="button" class="sd-btn sd-vibe-review-history" ${busy?'disabled':''}>${historical?'当前记录':'历史档案'}</button>
      <button type="button" class="sd-btn sd-vibe-review-export-all" ${busy||!rows.length?'disabled':''}>${historical?'导出本页记录':'导出当前记录'}</button><button type="button" class="sd-btn sd-vibe-review-inspect" ${busy?'disabled':''}>校验记录文件</button>
      ${!historical?`<button type="button" class="sd-btn sd-vibe-review-archive-batch" ${busy||!readyBatch.length?'disabled':''}>归档已完成 · ${readyBatch.length}</button>`:''}<input class="sd-vibe-review-file" type="file" accept=".json,application/json" hidden></div>
      <small class="sd-vibe-review-file-info">${historical?`历史 ${historyCount} / 16384 条 · 每页最多 40 条，按请求编号分页。`: `当前 ${rows.length} / 2048 条 · 批量归档仅处理已显示的前 40 条已完成记录。`}归档保留完整历史，不释放磁盘。导出不含图片、编码或 Key；含账户与渠道地址，请勿公开分享。文件校验仅作只读预览。</small>`}<div class="sd-vibe-review-rows">${displayed.slice(0,limit).map((row,index)=>{
      const ref=row.status==='ready'?row.assetRef:recovered.get(rowKey(row)),transport=row.delivery?.transport==='service'?'增强服务':row.delivery?.transport==='direct'?'浏览器直连':'旧记录 · 来源未绑定';
      return `<article data-vibe-review-row="${index}" data-state="${escape(row.status)}"><b>${escape(statuses[row.status]||'待核查')}</b><time>${escape(new Date(row.updatedAt).toLocaleString())}</time><span>${escape(row.identity.remoteModelId)}</span><span>信息提取 ${escape(row.identity.parameters.information_extracted)} · ${escape(transport)}</span>${archive?`<details class="sd-vibe-fee-history"><summary>原提交标识</summary><p>${escape(row.identity.endpoint)}<br>请求 ${escape(row.cacheKey)}<br>尝试 ${escape(row.attemptId)}</p></details>`:`<div>${['reserved','submitting','unknown'].includes(row.status)?`<button type="button" class="sd-btn sd-vibe-review-check" ${busy?'disabled':''}>${row.delivery?.transport==='service'?'核查后继续':'人工核查'}</button>`:''}${row.status!=='ready'?`<button type="button" class="sd-btn sd-vibe-review-receive" ${busy?'disabled':''}>${row.delivery?.transport==='service'?'领取原结果':'查服务缓存'}</button>`:''}${ref?`<button type="button" class="sd-btn sd-vibe-review-add" ${busy?'disabled':''}>加入 Vibe 库</button><button type="button" class="sd-icon-btn sd-vibe-review-export" aria-label="导出编码文件" ${busy?'disabled':''}><i class="fa-solid fa-download"></i></button>`:''}<button type="button" class="sd-btn sd-vibe-review-export-record" ${busy?'disabled':''}>导出记录</button>${!historical&&row.status==='ready'?`<button type="button" class="sd-btn sd-vibe-review-archive" ${busy?'disabled':''}>归档</button>`:''}</div>`}${['reserved','submitting','unknown'].includes(row.status)?'<small>请先在渠道核查原任务和账单；仍在运行的请求不能解除占用。</small>':''}${row.feeReview||row.pastReviews?.length?`<details class="sd-vibe-fee-history"><summary>保留核查记录 ${(row.pastReviews?.length||0)+(row.feeReview?1:0)} 次</summary>${[...(row.pastReviews||[]),...(row.feeReview?[row]:[])].map(item=>`<p>${escape(new Date(item.feeReview.at).toLocaleString())} · ${item.feeReview.method==='local-user'?'本机人工确认 · 上游未验证':'原服务核查'} · 原结果及费用未知</p>`).join('')}</details>`:''}</article>`;
    }).join('')}</div>${displayed.length>limit?'<button type="button" class="sd-btn sd-vibe-review-more">加载更多</button>':''}${historical&&!archive?`<div class="sd-vibe-review-tools"><button type="button" class="sd-btn sd-vibe-review-history-prev" ${busy||!historyCursors.length?'disabled':''}>上一页</button><button type="button" class="sd-btn sd-vibe-review-history-next" ${busy||!historyNext?'disabled':''}>下一页</button></div>`:''}</section>`;
    for(const article of host.querySelectorAll('[data-vibe-review-row]')){
      const row=displayed[Number(article.dataset.vibeReviewRow)];
      if(row.reviewArchive){const button=host.ownerDocument.createElement('button');button.type='button';button.className='sd-btn sd-vibe-review-details';button.disabled=busy;button.textContent=`查看较早明细 · ${row.reviewArchive.count}`;article.append(button);
        button.addEventListener('click',run(async active=>{const result=archive?{receipt:row,reviews:archive.reviewHistories[row.cacheKey],file:true}:await actions.reviewHistory(row);
          if(active()){reviewHistory={...result,offset:0};message='';}}));}
      if(!archive&&!historical&&(row.pastReviews?.length||0)>=16){const button=host.ownerDocument.createElement('button');button.type='button';button.className='sd-btn sd-vibe-review-compact';button.disabled=busy;button.textContent='整理旧核查明细';article.append(button);
        button.addEventListener('click',run(async active=>{const result=await actions.compactReviews(row,async(...args)=>{if(!active())return false;const yes=await confirm(...args);return active()&&yes===true;});if(!active())return;
          if(result.cancelled){message='已取消整理，原明细保留';return;}rows=rows.map(item=>item.cacheKey===row.cacheKey?result.receipt:item);message=`已整理 ${result.moved} 次明细，当前请求与费用状态不变；可查看或导出完整历史。`;
        }));}
    }
    host.querySelector('.sd-vibe-review-close').onclick=()=>{revision++;busy=false;if(archive){archive=null;message='';render();}else onClose();};
    host.querySelector('.sd-vibe-review-more')?.addEventListener('click',()=>{if(archive)archive.visible+=40;else visible+=40;render();});
    if(archive){icons(host);return;}
    host.querySelector('.sd-vibe-review-refresh').onclick=()=>void refresh();
    host.querySelector('.sd-vibe-review-history').onclick=()=>{historical=!historical;rows=[];visible=40;historyAfter='';historyCursors.length=0;void refresh();};
    host.querySelector('.sd-vibe-review-history-next')?.addEventListener('click',()=>{historyCursors.push(historyAfter);historyAfter=historyNext;rows=[];void refresh();});
    host.querySelector('.sd-vibe-review-history-prev')?.addEventListener('click',()=>{historyAfter=historyCursors.pop()||'';rows=[];void refresh();});
    host.querySelector('.sd-vibe-review-export-all').addEventListener('click',run(async active=>{const blob=historical?await actions.exportPage(rows):await actions.exportRecords();if(active())downloadRecords(blob);}));
    const archiveRows=selected=>run(async active=>{
      const result=await actions.archiveCompleted(selected,async(...args)=>{if(!active())return false;const yes=await confirm(...args);return active()&&yes===true;});if(!active())return;
      if(result.cancelled){message='已取消归档，原记录保留';return;}
      const moved=new Set(selected.map(row=>row.cacheKey));rows=rows.filter(row=>!moved.has(row.cacheKey));message=`已归档 ${result.archived} 条；完整历史和原结果引用保留，未重新编码。`;
      try{const next=await actions.list();if(active())rows=next;}catch(error){if(active())message+=` 列表刷新未完成：${error.message}`;}
    });
    host.querySelector('.sd-vibe-review-archive-batch')?.addEventListener('click',archiveRows(readyBatch));
    const fileInput=host.querySelector('.sd-vibe-review-file');
    host.querySelector('.sd-vibe-review-inspect').onclick=()=>fileInput.click();
    fileInput.onchange=event=>{const file=event.target.files?.[0];if(!file)return;void run(async active=>{
      const result=await actions.inspectFile(file);if(!active())return;archive={...result,visible:40};message='文件结构与摘要校验通过 · 只读预览';
    })(event);};
    for(const article of host.querySelectorAll('[data-vibe-review-row]')){
      const row=rows[Number(article.dataset.vibeReviewRow)],ref=row.status==='ready'?row.assetRef:recovered.get(rowKey(row)),selection={model:row.identity.capabilityModelId,information:row.identity.parameters.information_extracted,expectedSourceId:row.identity.sourceId};
      article.querySelector('.sd-vibe-review-receive')?.addEventListener('click',run(async active=>{
        const result=await actions.receive(row);if(!active())return;
        if(result.blob){download(result.blob);message=result.warning;onNotice(message);return;}
        recovered.set(rowKey(row),result.assetRef);const next=await actions.list();if(!active())return;rows=next;
        message=result.reconciled?'原编码已领取并关联，无需再次编码':'已领取为独立素材；原记录的发送来源无法核实，费用状态仍保留';
      }));
      article.querySelector('.sd-vibe-review-check')?.addEventListener('click',run(async active=>{
        const result=await actions.review(row,confirm);if(!active())return;
        if(result.cancelled){message='已取消核查，原状态保留';return;}
        const next=await actions.list();if(!active())return;rows=next;message='原未知费用事实已保留；新生成仍需正常授权，本次没有编码或生图';
      }));
      article.querySelector('.sd-vibe-review-add')?.addEventListener('click',run(async active=>{await onAdd(ref,selection);if(active())message='已加入 Vibe 库，未改变当前生成配置';}));
      article.querySelector('.sd-vibe-review-export')?.addEventListener('click',run(async active=>{const blob=await actions.export(ref,selection);if(active())download(blob);}));
      article.querySelector('.sd-vibe-review-export-record')?.addEventListener('click',run(async active=>{const blob=await actions.exportRecords(row);if(active())downloadRecords(blob);}));
      article.querySelector('.sd-vibe-review-archive')?.addEventListener('click',archiveRows([row]));
    }icons(host);
  }
  return {mount(node){this.detach();host=node;render();if(!loaded)void refresh();},detach(){revision++;host=null;busy=false;},dispose(){this.detach();disposed=true;archive=null;reviewHistory=null;rows=[];recovered.clear();for(const [url,timer] of urls){clearTimeout(timer);URL.revokeObjectURL(url);}urls.clear();}};
}
