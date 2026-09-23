// Compact exceptional review only; no ordinary migration/sync settings.
export function renderCharacterImportReview(review,{escape,icon,busy=false,error=''}={}){
  const page=review.page||0,rows=review.conflicts.slice(page*24,page*24+24),choices=review.choices||{},ready=review.conflicts.every(row=>choices[row.key]);
  const target=value=>value===null?'没有此绑定':value||'明确不绑定';
  const blocked=row=>row.deleted||row.categoryConflict||row.alias||row.missing&&choices[`archive:${row.sourceArchiveId}`]!=='source';
  const document=(label,value)=>`<details class="sd-card"><summary><b>${label}</b></summary><pre class="sd-character-import-original">${escape(value?JSON.stringify(value,null,2):'当前已无此档案')}</pre></details>`;
  return `<div class="sd-character-library sd-character-restore" aria-busy="${busy}"><fieldset ${busy?'disabled':''}>
    <div class="sd-character-tools">${icon('legacy-close','返回角色库','x')}<b>旧资料核对</b></div>
    <p>已完整保留旧端原件。只按你的选择替换档案或绑定；保留当前不会删除旧端原件。</p>
    <section class="sd-card"><div class="sd-storyboard-card-body sd-character-restore-items">${rows.map((row,i)=>`<label>
      <span>${escape(row.kind==='archive'?`${row.localName} v${row.localVersion} / 旧端 ${row.sourceName} v${row.sourceVersion}`:`${row.category.toUpperCase()} · ${row.subjectKey} · ${row.chatKey||'默认绑定'}`)}</span>
      ${row.kind==='binding'?`<small>${escape(target(row.localArchiveId))} → ${escape(target(row.sourceArchiveId))}</small>`:icon('legacy-details','对比完整档案','book-open',`data-archive-id="${escape(row.id)}"`)}
      ${row.deleted||row.categoryConflict||row.alias||row.missing?'<small>涉及已删除、分类或身份差异；请保留当前后另行核对，不自动复活或猜测身份。</small>':''}
      <select class="text_pole" data-archive-legacy-choice="${page*24+i}"><option value="" ${!choices[row.key]?'selected':''}>请选择</option><option value="current" ${choices[row.key]==='current'?'selected':''}>保留当前</option><option value="source" ${choices[row.key]==='source'?'selected':''} ${blocked(row)?'disabled':''}>采用旧端</option></select>
    </label>`).join('')}</div></section>
    ${review.conflicts.length>24?`<div class="sd-character-tools">${icon('legacy-previous','上一页','arrow-left',page?'':'disabled')}<span>${page+1} / ${Math.ceil(review.conflicts.length/24)}</span>${icon('legacy-next','下一页','arrow-right',(page+1)*24<review.conflicts.length?'':'disabled')}</div>`:''}
    ${review.details?document('当前档案',review.details.current)+document('旧端完整原件',review.details.source):''}
    <div class="sd-character-tools">${icon('legacy-reload','重新核对当前版本','arrows-clockwise')}<button type="button" class="sd-btn" data-archive-action="legacy-apply" ${ready?'':'disabled'}>确认应用选择</button></div>
    ${error?`<p role="alert">${escape(error)}</p>`:''}
    </fieldset></div>`;
}
