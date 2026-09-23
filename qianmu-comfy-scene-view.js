import {sameComfySceneSnapshot as same} from './qianmu-comfy-scene-backup.js';

const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const button=(action,label,glyph,extra='')=>`<button type="button" class="sd-icon-btn" data-scene-action="${action}" aria-label="${label}" title="${label}" ${extra}><i class="fa-solid fa-${glyph}"></i></button>`;
const status=record=>record===null?'已移出当前续场':record.holders.length?`${record.holders.length} 个原任务待核查`:record.lock?'风格已保存':'风格已解除';
const description=record=>record?.label?.workflowName||record?.label?.sceneTitle||'续场来源';
const time=record=>record?new Date(record.updatedAt).toLocaleString():'';
const layer=value=>({present:'现实',memory:'回忆',fantasy:'幻想',dream:'梦境',imagined:'想象'}[value]||value);

export function renderComfySceneReview(snapshot,{shown=40,busy=false,error='',taskLinks=false}={}){
  const rows=snapshot?.rows||[],local=snapshot?.local,tools=`${button('refresh','刷新续场记录','rotate')}${snapshot?.native?button('journal','导出本账户本机事务记录','download'):''}`;
  const pending=local&&(local.pending||local.outcomes)?`<div class="sd-comfy-pool-tools"><span>本机有待保存记录${local.outcomes?` · ${local.outcomes} 条结果`:''}</span><button type="button" class="sd-btn" data-scene-action="sync">重试保存</button></div><small>仅同步原记录，不提交生图。</small>`:'';
  return `<div class="sd-comfy-library sd-comfy-scene-review" aria-busy="${busy}">${error?`<p role="alert">${escape(error)}</p>`:''}<fieldset ${busy?'disabled':''}><div class="sd-comfy-pool-tools">${tools}${rows.length?'<button type="button" class="sd-btn" data-scene-action="clear">清理本聊天记录</button>':''}</div>${pending}${local?.conflicts?`<small>${local.conflicts} 项旧保存冲突已保全，可导出本机事务记录。</small>`:''}
    ${snapshot?.native?'<small>ST 账户保存 · 原件保留；清理不等于释放全部磁盘。</small>':''}
    ${rows.slice(0,shown).map((row,i)=>{
      const records=row.branches.map(branch=>branch.record),conflict=row.blocked||records.some(record=>!same(record,records[0])),primary=records.find(Boolean),view=row.view;
      const hasTickets=records.some(record=>record?.holders?.length),title=view?.label.workflowName||description(primary),floor=view?.label.floor??primary?.label?.floor;
      return `<section class="sd-card" data-scene-row="${i}"><div class="sd-storyboard-card-body"><div class="sd-comfy-pool-tools"><b>${escape(title)}</b>${snapshot.native?button('export','导出本场景完整操作原件','download'):''}</div>
        <small>${Number.isInteger(floor)?`第 ${floor} 层 · `:''}${escape(layer(row.scope.narrativeLayer))} · ${escape(time(primary)|| (view?new Date(view.updatedAt).toLocaleString():''))}</small>
        ${row.error?`<p role="alert">${escape(row.error)}</p><small>此场景原件未读全，不以空记录替代；可重试读取。其他场景仍可查看。</small>`:conflict?`<p>${row.blocked?'清理后发现旧来源':'发现不同续场来源'} · 请核对，不按时间自动选版</p>${hasTickets?'<small>来源仍含原任务票据，请先在原设备或渠道核查。这里不会把远端任务判为结束。</small>':''}
          ${row.branches.map((branch,j)=>`<details class="sd-card"><summary>${escape(description(branch.record))} · ${branch.digest.slice(0,8)}</summary><div class="sd-storyboard-card-body"><small>${escape(status(branch.record))} · ${escape(time(branch.record))}</small>${renderTasks(branch.record,j,taskLinks)}<button type="button" class="sd-btn" data-scene-action="choose" data-scene-branch="${j}" ${hasTickets?'disabled':''}>保留此来源</button></div></details>`).join('')}`
          :`<small>${view?view.pending?`${view.pending} 个待处理任务`:view.uncertain?`${view.uncertain} 个结果未明任务`:view.lock?'风格已保存':'风格已解除':escape(status(primary))}</small>${renderTasks(primary,records.indexOf(primary),taskLinks)}${view?.lock||primary?.lock?'<button type="button" class="sd-btn" data-scene-action="unlock">核查并解锁</button>':''}`}</div></section>`;
    }).join('')}${shown<rows.length?'<button type="button" class="sd-btn" data-scene-action="more">更多记录</button>':''}${snapshot&&!rows.length?'<small>本聊天暂无续场记录。</small>':''}</fieldset></div>`;
}
function renderTasks(record,branch,links){
  return record?.holders?.length?`<details><summary>查看原任务</summary>${record.holders.map((task,i)=>`<div class="sd-comfy-pool-tools sd-comfy-scene-task"><code>${escape(task.attemptId)}</code><small>${({reserved:'已预留（不以过期推定远端结束）',submitting:'已进入提交阶段',uncertain:'结果未明'})[task.status]}</small>${links?button('task','查看原任务日志','arrow-right',`data-scene-branch="${branch}" data-scene-task="${i}"`):''}</div>`).join('')}</details>`:'';
}
const download=(name,value)=>{
  const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'});if(blob.size>40*1024*1024)throw Error('原件超过40MiB，未截断或导出不完整文件');
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
export async function mountComfySceneReview({host,manager,namespace,chatKey,current,guard,confirm,notify=()=>{},icons=()=>{},save=download,openTask}){
  let snapshot=null,shown=40,busy=false,error='';
  const draw=()=>{if(!current())return;host.innerHTML=renderComfySceneReview(snapshot,{shown,busy,error,taskLinks:typeof openTask==='function'});icons(host);};
  const refresh=async()=>{await guard();snapshot=await manager.review(namespace,chatKey,{valid:current});await guard();};
  const run=async work=>{if(busy||!current())return;busy=true;error='';draw();try{await guard();await work();await guard();}catch(cause){if(current()){error=cause.message||'续场操作未完成';notify(error,'warning');}}finally{busy=false;draw();}};
  host.onclick=event=>{const control=event.target.closest?.('[data-scene-action]');if(!control||!host.contains(control)||control.disabled||busy||!current())return;
    event.preventDefault();event.stopPropagation();const action=control.dataset.sceneAction,row=snapshot?.rows[Number(control.closest('[data-scene-row]')?.dataset.sceneRow)];
    return run(async()=>{
      if(action==='refresh')return refresh();
      if(action==='more'){shown+=40;return;}
      if(action==='sync'){const result=await manager.synchronize(namespace,{valid:current});await refresh();
        if(result?.errors?.length){error=`${result.errors.length} 个场景仍待核查：${result.errors[0].error}`;notify(error,'warning');}
        else notify('续场记录已核对保存，未提交生图','success');return;}
      if(action==='journal'){const value=await manager.exportJournal(namespace,{valid:current});await guard();save('qianmu-comfy-local-journal.json',value);return;}
      if(action==='export'&&row){const value=await manager.exportScene(row.scope,{valid:current});await guard();save(`qianmu-comfy-scene-${row.scope.continuityId.slice(0,16)}.json`,value);return;}
      if(action==='task'&&row){const branch=row.branches[Number(control.dataset.sceneBranch)],task=branch?.record?.holders?.[Number(control.dataset.sceneTask)];
        if(!task||typeof openTask!=='function')throw Error('原任务入口已变化，请刷新续场记录');
        await openTask(structuredClone({scope:row.scope,lock:branch.record.lock,attemptId:task.attemptId}));return;}
      if(action==='choose'&&row){const branch=row.branches[Number(control.dataset.sceneBranch)];if(!branch)throw Error('所选来源已变化');
        if(!await confirm('核对续场来源','将使用这份来源的风格。其他来源与操作原件继续保留，不复制人物状态、不启动或重投生成。确认保留？'))return;
        await guard();await manager.resolveSource(row.scope,{heads:row.heads,generation:row.generation,selected:branch.digest,acknowledged:true},{valid:current});await refresh();notify('续场来源已核对，其他原件保留','success');return;}
      if(action==='unlock'&&row){let view=await manager.inspect(row.scope);await guard();if(view.pending)view=await manager.reconcile(row.scope,{valid:current});await guard();
        if(view.pending)throw Error('原任务仍待处理；另一设备或旧来源的任务不会按本机页面状态自动结束，请先核查原任务');
        if(!await confirm('解锁续场风格',view.uncertain?'原任务结果仍未确认，云端可能继续运行。解锁不取消或重投请求，仅影响之后镜头。确认已核查渠道记录并解锁？':'只解除之后镜头的续场风格，不删除图片或重新生成。确认解锁？'))return;
        await guard();await manager.unlock(row.scope,view,{acknowledgeUncertain:view.uncertain>0,valid:current});await refresh();return;}
      if(action==='clear'){if(!await confirm('清理续场记录','清理本聊天的续场选择，不删除图片、不取消或重投请求；在途、结果未明或分叉时停止。原件继续保留，不代表释放全部磁盘。'))return;
        await guard();const result=await manager.clearChat(namespace,chatKey,{valid:current});await refresh();notify(`已清理 ${result.removed} 条续场记录`,'success');}
    });
  };
  await run(refresh);return {refresh:()=>run(refresh),close(){host.onclick=null;}};
}
