const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const button = (action, text, disabled = false) => `<button type="button" class="sd-btn" data-bundle-action="${action}" ${disabled ? 'disabled' : ''}>${text}</button>`;
const resourceStates={included:'包内资料',external:'外部另备',dynamic:'动态槽位',unresolved:'引用待定位',review:'运行环境待核对'};
function renderCarrierHistory(view){
  const plan=view.preview?.carrierRestore,page=view.carrierPage;if(!plan)return '';
  return `<section data-bundle-carriers><h3>来源记录 · ${plan.count}</h3><p>含本次备份；新增 ${plan.added} · 完全相同 ${plan.existing}。原成员 ${plan.originalCount} 份，新增 ${plan.addedOriginals} 份。合计占用 ${Math.ceil(plan.totalBytes/1024)} KiB，已含本次载体及原文空间。</p><p>保存原始来源与成员，不执行旧选择，不认证身份，也不替代当前人物或环境确认。</p>
    ${page&&page.descriptorDigest===plan.descriptorDigest?`${page.rows.map(row=>`<p><b>${row.current?'本次备份':'历史来源'}</b> · ${escape(new Date(row.createdAt).toLocaleString())}<br>${row.indexState==='absent'?'原包未记录历史目录':row.indexState==='empty'?'原包历史目录明确为空':`原目录 ${row.receiptCount} 份凭据`} · ${Math.ceil(row.bytes/1024)} KiB<br><small>${escape(row.carrierDigest)}</small></p>`).join('')}<nav>${button('carriers-previous','上一页',!page.offset)}<span>${page.offset+1}–${Math.min(page.offset+24,page.total)} / ${page.total}</span>${button('carriers-next','下一页',page.offset+24>=page.total)}</nav>`:button('carriers','查看来源清单')}</section>`;
}
function renderMappingHistory(view){
  const source=view.preview?.summary?.mappingReceipts,plan=view.preview?.mappingRestore,page=view.receiptPage;if(!source)return '';
  return `<section data-bundle-history><h3>历史迁移凭据 · ${source.count}</h3><p>环境 ${source.environment} · 人物／人设 ${source.subjects}。原来源、首次保存时间和全部关系保留；历史选择不会用于本次绑定，也不替代本次确认。</p>
    ${plan?`<p>新增 ${plan.added} · 完全相同 ${plan.existing}。空间已计入本次新映射预留；同摘要但原记录不同会停止，不自动覆盖。</p>`:''}
    ${source.count?page?`${page.rows.map(row=>`<p><b>${row.kind==='environment'?'环境映射':row.version===3?'原包USER整理与映射':row.version===2?'USER地址整理':'角色目标映射'}</b> · ${escape(new Date(row.createdAt).toLocaleString())}<br>${row.bindings} 条原关系 · ${Math.ceil(row.bytes/1024)} KiB<br><small>原来源 ${escape(row.sourceDigest)}<br>凭据 ${escape(row.digest)}</small></p>`).join('')}
      <nav>${button('receipts-previous','上一页',!page.offset)}<span>${page.offset+1}–${Math.min(page.offset+24,page.total)} / ${page.total}</span>${button('receipts-next','下一页',page.offset+24>=page.total)}</nav>`:button('receipts','查看原凭据清单'):'<p>此包明确记录空凭据库。</p>'}</section>`;
}
function renderSourceAliases(view){
  const summary=view.preview?.sourceAliases,page=view.sourceAliasPage;if(!summary?.changed)return '';
  return `<section data-bundle-source-aliases><h3>先核对原包 USER 地址</h3><p>${summary.total} 条原绑定 · ${summary.groups} 组 · 待选择 ${summary.unresolved} 组。只统一同一头像文件的地址写法，不按同名合并不同人设。</p>
    <p>默认与每个聊天分别选择；同组只采用所选档案，未采用的原关系仍完整保留在凭据中。选好后再选目标头像、核对本机覆盖；改来源选择会清掉后两项草稿。原包和档案原文不改写。</p>
    ${summary.unverified?`<p>${summary.unverified} 组原人设资料摘要不一致，不会按第一条或选中档案冒称内容匹配；请结合原环境核对。</p>`:''}
    ${summary.targetsReady===false?'<p>整理后的待绑定人设尚未完整载入，请在下方选择对应目标，或先在ST打开原人设。</p>':''}
    ${page?`${page.rows.map((row,index)=>`<label class="sd-bundle-source-alias-row"><input type="radio" name="source-${row.groupId}" data-bundle-source-choice="${index}" ${row.selected?'checked':''}><span><b>${escape(row.archiveName||'不使用档案（显式解除）')}</b><small>${escape(row.scope==='default'?'默认绑定':row.chatKey)}</small><small>${escape(row.sourceKey)}</small><small>→ ${escape(row.targetKey)}</small><small>${row.conflict?'不同档案，须明确选择':'同组档案一致；保留全部原关系'}</small></span></label>`).join('')}
      <nav>${button('aliases-previous','上一页',!page.offset)}<span>${page.total?`${page.offset+1}–${Math.min(page.offset+24,page.total)} / ${page.total}`:'没有待调整的绑定，仅核对来源证据地址'}</span>${button('aliases-next','下一页',page.offset+24>=page.total)}${button('aliases-close','收起')}</nav>`:button('aliases','核对原关系与选择')}
    <p>来源地址 ${summary.evidenceChanges} 项；该步骤不证明目标身份，不代表恢复已完成。凭据可查看导出，暂无一键撤销。</p></section>`;
}
function renderSubjectPicker(view) {
  const picker=view.targetPicker;if(!picker)return '';
  return `<section data-bundle-target-picker><h3>选择${picker.category==='char'?'CHAR':'USER'}目标</h3><input class="text_pole" data-bundle-target-query maxlength="160" aria-label="搜索目标名称或文件" value="${escape(picker.query)}">
    <nav>${button('targets-search','搜索')}${button('targets-close','关闭选择')}</nav>
    ${picker.rows.map((row,index)=>`<p><button type="button" class="sd-btn" data-bundle-target-select="${index}"><span>${escape(row.name)}</span><small>${escape(row.subjectKey)}</small></button></p>`).join('')}
    <nav>${button('targets-previous','上一页',picker.offset===0)}<span>${picker.total?Math.floor(picker.offset/24)+1:0} / ${Math.ceil(picker.total/24)}</span>${button('targets-next','下一页',picker.offset+24>=picker.total)}</nav></section>`;
}
function renderSubjects(view,subjects,offset) {
  if(!subjects.length)return '';
  return `<section><h3>角色卡与人设内容 · ${subjects.length}</h3><p>核对声明的人物正文、开场与提示字段；不含头像图像、自定义扩展或外部世界书，不是完整角色卡备份。目标选择只改变待恢复绑定，旧画面、档案编号及原配方不改写；OTHER没有ST绑定。</p>
    ${subjects.slice(offset,offset+24).map((row,index)=>`<p>${escape(row.category.toUpperCase())} · ${escape(row.subjectKey)}${row.targetKey?`<br>→ ${escape(row.targetKey)}`:''}<br>${({matched:'内容一致',changed:'内容有变化，请确认仍为原角色',missing:'目标未找到',unverified:'来源或目标资料未载入，须人工核对'})[row.state]}${row.required?' · 将恢复绑定':''}
      ${['char','user'].includes(row.category)?`<br><button type="button" class="sd-btn" data-bundle-target-for="${offset+index}">选择目标</button>${row.targetKey?`<button type="button" class="sd-btn" data-bundle-target-clear="${offset+index}">保留原标识</button>`:''}`:''}</p>`).join('')}
    ${subjects.some(row=>row.required&&row.state==='missing')?'<p>待绑定目标缺失，请恢复原ST角色／人设，或明确选择对应目标；不猜同名对象。</p>':''}
    ${view.preview.subjectMappings?.length?'<p>新选目标必须已载入资料。映射凭据保留原绑定与派生绑定；冲突选择保留本机时，并不覆盖该处绑定。重新核对不会自动沿用批准。</p>':''}
    ${view.preview.subjectMappingConflict?'<p>未完成恢复的目标或内容摘要与原映射不同，尚不能续接；请先核对原选择与目标资料。</p>':''}</section>${renderSubjectPicker(view)}`;
}
function renderEnvironment(review) {
  if (review?.state !== 'mapping-required') return '';
  const label = (title, identity) => `<p><b>${title}</b><br>ST 安装：${escape(identity.instanceId)}<br>账户标签：${escape(identity.accountId)}</p>`;
  return `<section data-bundle-environment-map><h3>更换 ST 环境 · 请单独确认</h3>${label('备份来源',review.source)}${label('当前目标',review.target)}
    <p>仅映射安装／账户标签，账户名与聊天标识仍须相同；角色／人设目标变更须另行逐项选择。不会改写原包、工作流历史或历史角色身份，也不会替换ST来源标签。</p>
    <p>标签不是身份认证。同名不是同一个人；请同时核对角色内容和正文落点。凭据仅保存于当前浏览器，仍须保留原备份。</p>
    <p><small>原包 SHA-256：${escape(review.sourceDigest)}<br>本次映射：${escape(review.digest)}</small></p></section>`;
}
function renderResources(view) {
  const summary=view.preview?.summary?.resourceOrigins,page=view.resourcePage;if(!summary)return '';
  return `<section data-bundle-resource-section><h3>文件与引用用途 · ${summary.total}</h3><p>${summary.recorded?'来源清单已与原包逐项核对。':'旧包未记录此清单；以下从现有原文重建，不冒充当时的来源证明。'} 原包全部用途按位置列出，不是唯一文件数；保留本机条目时不代表全部应用。</p>
    <p>${Object.entries(resourceStates).map(([key,label])=>`${label} ${summary[key]}`).join(' · ')}</p><p>“包内资料”可能是图片/Vibe原件或配置引用，不代表模型、节点插件、ST API档案及授权已安装。动态槽需生成时提供；未识别节点和间接文件仍须在 Comfy 核对。</p>
    ${page?`<select class="text_pole" data-bundle-resource-filter aria-label="文件用途分类"><option value="all" ${page.filter==='all'?'selected':''}>全部用途</option>${Object.entries(resourceStates).map(([key,label])=>`<option value="${key}" ${page.filter===key?'selected':''}>${label}</option>`).join('')}</select>
    ${page.rows.map(row=>`<p><b>${escape(row.label)}</b> · ${resourceStates[row.state]}<br>${escape(row.target)}${row.owner?`<br>原版本：${escape(row.owner)}`:''}${row.sha256?`<br>SHA-256：${escape(row.sha256)} · ${row.bytes??'—'} 字节`:''}<br><small>${escape(row.at)}</small></p>`).join('')}
    <nav>${button('resources-previous','上一页',page.offset===0)}<span>${page.total?Math.floor(page.offset/24)+1:0} / ${Math.ceil(page.total/24)}</span>${button('resources-next','下一页',page.offset+24>=page.total)}</nav>`:button('resources','查看用途清单')}</section>`;
}
export function renderStoryboardBundleReview(view) {
  const p = view.preview, offset = view.page * 24, conflicts = p?.conflicts || [], bindings = p?.bindingReview || [], subjects = p?.subjectReview || [], connections = p?.configuration?.connections || [];
  const pages = Math.max(1, Math.ceil(Math.max(conflicts.length, bindings.length, subjects.length, connections.length) / 24));
  const ready = p?.ready && !p.needsRecheck && view.environmentReviewed && (p.environmentReview?.state !== 'mapping-required' || view.environmentMapped) && (!p.subjectMappings?.length || view.subjectsMapped) && (!p.sourceAliases?.changed || view.sourceAliasesReviewed) && (!bindings.length || view.bindingsReviewed) && (!subjects.length || view.subjectsReviewed) && (!connections.length || view.connectionsReviewed) && (!p.summary?.resourceOrigins?.total || view.resourcesReviewed) && (!p.summary?.mappingReceipts?.count || view.historyReviewed)&&(!p.carrierRestore||view.carriersReviewed);
  return `<header><b id="qm-bundle-title">恢复分镜资源联包</b><button type="button" class="sd-icon-btn" data-bundle-action="close" title="关闭恢复页面" aria-label="关闭恢复页面"><i data-qm-icon="qm-regular-x"></i></button></header>
    <main data-bundle-scroll><fieldset ${view.busy || view.result ? 'disabled' : ''}>
    <section><p class="sd-bundle-file">${escape(view.fileName)}</p><p>恢复当前聊天成片、配置、Vibe 原文件、完整工作流／候选历史及角色库。只补缺件，不覆盖原图；不含模型文件或 API 授权。参数记忆与默认词按模型合并，同项以来包为准。取景 API 沿用本机选择，不按原包编号切换。Comfy当前方案选择保留，自动择流需在镜头台重新开启。更换ST安装和CHAR／USER目标可分别确认；不同账户名或聊天的迁移尚未开放，请保留旧环境。</p>
    ${p ? `<p>成片 ${p.summary.images} · Vibe ${p.summary.vibeFiles} · 工作流 ${p.summary.workflows.count}（${p.summary.workflows.versions} 版） · 候选 ${p.summary.pools.count} · 角色 ${p.summary.characters.count}</p>
    <p>${p.sourceLabelsMatched ? 'ST 来源标识一致；完整服务器副本也会相同，角色与聊天仍须人工核对。' : p.environmentReview ? 'ST 来源标签不同，请逐项核对来源与当前目标后确认映射。' : '此包无 ST 来源标识，仅凭同名账户与聊天不能确认身份，请人工核对原环境。'}</p>
    ${p.summary.legacyVibeOriginals ? `<p>已包含 ${p.summary.legacyVibeOriginals} 个旧 Vibe 地址的本地原图；原配方及强度不变。</p>` : ''}
    ${p.summary.legacyVibeUrls > (p.summary.legacyVibeOriginals || 0) ? `<p>另有 ${p.summary.legacyVibeUrls - (p.summary.legacyVibeOriginals || 0)} 个旧 Vibe 地址未包含原图，请另行保全。</p>` : ''}
    <p>档案／绑定：新增 ${p.characterSummary.added} · 替换 ${p.characterSummary.replaced} · 保留 ${p.characterSummary.kept}</p>
    ${p.configuration?.orphaned ? `<p>${p.configuration.orphaned} 张成片无法确认正文位置，将保留在阅片室，不自动挂入楼层。</p>` : ''}
    ${!p.needsRecheck && p.planDigest ? `<p>原图 ${p.images.length} 处 · 缺件 ${p.images.filter(row => row.state === 'missing').length} · 冲突 ${p.images.filter(row => row.state === 'conflict').length}</p>` : '<p>选项只是草稿，选好后请核对原件。</p>'}
    ${p.record ? `<p>上次资源核对：${escape(({prepared:'已确认',originals:'原图',workflows:'工作流',pools:'候选',metadata:'角色',vibes:'Vibe',verified:'原件已核对，配置另行确认'})[p.record.phase] || p.record.phase)}。续接仍会逐项核对。</p>` : ''}` : ''}</section>
    ${conflicts.length ? `<section><h3>逐项选择 · ${conflicts.length}</h3>${conflicts.slice(offset, offset + 24).map((row, index) => `<label class="sd-bundle-choice"><span>${escape(row.kind === 'archive' ? `${row.localName} v${row.localVersion} → ${row.incomingName} v${row.incomingVersion}` : `${row.category.toUpperCase()} · ${row.subjectKey} · ${row.chatKey || '默认绑定'} · ${row.localArchiveId || '不绑定'} → ${row.incomingArchiveId || '不绑定'}`)}</span><select class="text_pole" data-bundle-choice="${offset + index}"><option value="" ${!row.choice?'selected':''}>请选择</option><option value="local" ${row.choice==='local'?'selected':''}>保留本机</option><option value="incoming" ${row.choice==='incoming'?'selected':''}>使用备份</option></select></label>`).join('')}</section>` : ''}
    ${bindings.length ? `<section><h3>原身份与聊天绑定 · ${bindings.length}</h3>${bindings.slice(offset, offset + 24).map(row => `<p>${escape(row.category.toUpperCase())} · ${escape(row.subjectKey)}<br>${escape(row.scope === 'chat' ? row.chatKey : '角色默认')} → ${escape(row.archiveId || '明确不绑定')}</p>`).join('')}</section>` : ''}
    ${renderSourceAliases(view)}
    ${renderMappingHistory(view)}
    ${renderCarrierHistory(view)}
    ${renderSubjects(view,subjects,offset)}
    ${connections.length ? `<section><h3>连接预设 · ${connections.length}</h3><p>仅核对生图连接配置，不测试连通、不复制 Key。当前编辑中的连接和选择标识保持本机状态；重选预设后才加载备份配置。取词 LLM 的 ST API 档案仍需另行核对。</p>${connections.slice(offset, offset + 24).map(row => `<p>${escape(row.providerId)} · ${escape(row.name)}<br>${({added:'新增预设',same:'连接配置一致',changed:'连接配置有变化'})[row.state]}${row.active ? ' · 当前选择的同编号预设' : ''}<br>${row.credential === 'retained' ? '保留本机该预设的授权引用；是否仍有效需自行验证' : '未沿用本机该预设的授权引用；使用前请重新核对 Key'}${row.differences.length ? `<br>变化项：${row.differences.map(key => ({baseUrl:'地址',protocol:'接口协议',imageProtocolVersion:'协议版本',modelFamily:'模型系列',headers:'自定义请求头',options:'传输选项',compatibility:'兼容规则',unverified:'原配置无法完整核对'})[key]).join('、')}` : ''}</p>`).join('')}</section>` : ''}
    ${pages > 1 ? `<nav>${button('previous','上一页',view.page === 0)}<span>${view.page + 1} / ${pages}</span>${button('next','下一页',view.page >= pages - 1)}</nav>` : ''}
    ${renderEnvironment(p?.environmentReview)}
    ${renderResources(view)}
    ${p?.images?.some(row => row.state === 'conflict') ? `<section><h3>原图冲突，未覆盖</h3>${p.images.filter(row => row.state === 'conflict').slice(0,24).map(row => `<p>${escape(row.url)}</p>`).join('')}<p>请先在旧环境保全并处理冲突后重新核对。</p></section>` : ''}
    <label class="sd-bundle-review"><input type="checkbox" data-bundle-environment ${view.environmentReviewed?'checked':''}>我已核对备份来源与当前聊天；同名不代表同一身份，不确定时取消。</label>
    ${p?.environmentReview?.state === 'mapping-required' ? `<label class="sd-bundle-review"><input type="checkbox" data-bundle-mapping ${view.environmentMapped?'checked':''}>我明确确认从以上备份来源恢复至当前 ST，并保存本次环境映射凭据。</label>` : ''}
    ${bindings.length ? `<label class="sd-bundle-review"><input type="checkbox" data-bundle-bindings ${view.bindingsReviewed?'checked':''}>我已核对全部 ${bindings.length} 处原身份与聊天标识。</label>` : ''}
    ${subjects.length ? `<label class="sd-bundle-review"><input type="checkbox" data-bundle-subjects ${view.subjectsReviewed?'checked':''}>我已核对全部角色／人设差异，确认仍为原对象；无法确定时取消。</label>` : ''}
    ${p?.subjectMappings?.length ? `<label class="sd-bundle-review"><input type="checkbox" data-bundle-subject-mapping ${view.subjectsMapped?'checked':''}>我明确确认以上角色／人设目标映射，理解它只用于恢复绑定，不改写历史画面身份。</label>` : ''}
    ${p?.sourceAliases?.changed ? `<label class="sd-bundle-review"><input type="checkbox" data-bundle-source-reviewed ${view.sourceAliasesReviewed?'checked':''} ${p.sourceAliases.ready?'':'disabled'}>我确认已核对原包USER的全部来源选择及资料差异，理解未采用关系保留在凭据中，目标映射和覆盖另行确认。</label>` : ''}
    ${connections.length ? `<label class="sd-bundle-review"><input type="checkbox" data-bundle-connections ${view.connectionsReviewed?'checked':''}>我已核对全部连接差异及授权提示，恢复后会先检查连接再使用。</label>` : ''}
    ${p?.summary?.resourceOrigins?.total ? `<label class="sd-bundle-review"><input type="checkbox" data-bundle-resources ${view.resourcesReviewed?'checked':''}>我已核对包内资料和外部依赖，理解仅恢复资料、不保证工作流可直接运行。</label>` : ''}
    ${p?.summary?.mappingReceipts?.count?`<label class="sd-bundle-review"><input type="checkbox" data-bundle-history-reviewed ${view.historyReviewed?'checked':''}>我确认保全全部历史迁移凭据，理解它们不会自动授权或执行本次身份映射。</label>`:''}
    ${p?.carrierRestore?`<label class="sd-bundle-review"><input type="checkbox" data-bundle-carriers-reviewed ${view.carriersReviewed?'checked':''}>我确认保全全部来源记录及成员原文，包含本次备份；旧来源不授权自动恢复。</label>`:''}
    </fieldset></main><footer><p role="status">${escape(view.notice || (view.busy ? '正在后台核对；关闭会中止后续步骤，已保存部分仍保留。' : '不会启动生成任务。'))}</p><div>${view.result ? button('close','关闭并稍后核对导入') : `${button('preview',p?.needsRecheck?'核对选择与原件':'重新核对',view.busy)}${button('restore','确认恢复',view.busy || !ready)}`}</div></footer>`;
}

export function openStoryboardBundleReview({ parent, fileName, connect, paintIcons = () => {} }) {
  const dialog = document.createElement('dialog'); dialog.className = 'sd-bundle-dialog'; dialog.setAttribute('aria-labelledby','qm-bundle-title');
  const view = { fileName, page: 0, preview: null, busy: true, notice: '', result: null, historyReviewed:false,receiptPage:null,carriersReviewed:false,carrierPage:null,environmentReviewed: false, environmentMapped: false, bindingsReviewed: false, subjectsReviewed: false, subjectsMapped:false,subjectMappings:undefined,targetPicker:null,targetIndex:null, sourceAliasChoices:undefined,sourceAliasPage:null,sourceAliasesReviewed:false,connectionsReviewed: false, resourcesReviewed: false, resourcePage: null };
  let session = null, closed = false, choices = {}, focusChoice = null, resolve; const finished = new Promise(done => resolve = done);
  function close() { if (closed) return; closed = true; session?.close(); if (dialog.open) dialog.close(); dialog.remove(); resolve(view.result); }
  function draw() {
    if (closed) return;
    const scroll = dialog.querySelector('[data-bundle-scroll]')?.scrollTop || 0;
    const focused = dialog.contains(document.activeElement) ? document.activeElement.dataset.bundleChoice : undefined;
    if (focused !== undefined) focusChoice = focused;
    dialog.innerHTML = renderStoryboardBundleReview(view); paintIcons(dialog);
    const main = dialog.querySelector('[data-bundle-scroll]'); main.scrollTop = scroll;
    if (!view.busy && focusChoice !== null) dialog.querySelector(`[data-bundle-choice="${Number(focusChoice)}"]`)?.focus({ preventScroll: true });
  }
  async function run(action, resourceOptions) {
    if (view.busy || !session || closed) return;
    view.busy = true; view.notice = ''; draw();
    try {
      if (action === 'preview' || action==='mapping' || action==='alias-choice') {
        view.historyReviewed=false;view.carriersReviewed=false;
        view.sourceAliasesReviewed=false;view.subjectsMapped=false;view.environmentMapped=false;view.environmentReviewed=false;view.bindingsReviewed=false;view.subjectsReviewed=false;view.connectionsReviewed=false;view.resourcesReviewed=false;
        view.preview=await session.preview(choices,view.subjectMappings,view.sourceAliasChoices);view.subjectMappings=view.preview.subjectMappings;view.sourceAliasChoices=view.preview.sourceAliasChoices;
        if(view.sourceAliasPage){const offset=view.sourceAliasPage.offset<view.preview.sourceAliases?.total?view.sourceAliasPage.offset:0;view.sourceAliasPage=await session.aliases({choices:view.sourceAliasChoices||{},offset});if(view.sourceAliasPage.digest!==view.preview.sourceAliases?.digest)throw Error('来源USER地址选择已变化，请重新核对');}
      }
      if (action === 'choose') view.preview = await session.choose(choices);
      if(action==='receipts'){view.historyReviewed=false;const page=await session.receipts(resourceOptions);if(page.indexDigest!==view.preview.summary.mappingReceipts.digest)throw Error('历史凭据清单与原包不符');view.receiptPage=page;}
      if(action==='carriers'){view.carriersReviewed=false;const page=await session.carriers(resourceOptions);if(page.descriptorDigest!==view.preview.carrierRestore?.descriptorDigest)throw Error('来源清单与原包不符');view.carrierPage=page;}
      if(action==='targets')view.targetPicker=await session.targets(resourceOptions);
      if(action==='aliases'){view.sourceAliasesReviewed=false;const page=await session.aliases({choices:view.sourceAliasChoices||{},offset:resourceOptions?.offset||0});if(page.digest!==view.preview.sourceAliases?.digest)throw Error('来源USER地址选择已变化，请重新核对');view.sourceAliasPage=page;}
      if (action === 'resources') { const page=await session.resources(resourceOptions);if(page.digest!==view.preview.summary.resourceOrigins.digest)throw Error('文件用途清单与当前预览不符');view.resourcePage=page; }
      if (action === 'restore') {
        view.result = await session.restore(view.preview, { confirmed: true, environmentReviewed: view.environmentReviewed, environmentMapped: view.environmentMapped, bindingsReviewed: view.bindingsReviewed, subjectsReviewed: view.subjectsReviewed, subjectsMapped:view.subjectsMapped, sourceAliasesReviewed:view.sourceAliasesReviewed,connectionsReviewed: view.connectionsReviewed, resourcesReviewed: view.resourcesReviewed,historyReviewed:view.historyReviewed,carriersReviewed:view.carriersReviewed });
        session.close(); // Release the source Blob, decoded documents and worker DB connections while the result stays readable.
        view.notice = '原件已核对，配置已应用。请刷新后点击“核对导入”确认保存；历史生成任务不会续跑。';
      }
    } catch (error) {
      view.notice = error?.message || '恢复未确认，请核对原包';
      view.historyReviewed=false;view.carriersReviewed=false;
      if (view.preview) view.preview = { ...view.preview, ready: false, needsRecheck: true, planDigest: '' };
      view.sourceAliasesReviewed=false;view.subjectsMapped=false;view.environmentMapped = false; view.environmentReviewed = false; view.bindingsReviewed = false; view.subjectsReviewed = false; view.connectionsReviewed = false; view.resourcesReviewed = false;
      if (/过期/.test(view.notice)) { choices = {}; view.preview = null; view.page = 0;view.sourceAliasChoices=undefined;view.subjectMappings=undefined;view.sourceAliasPage=null;view.targetPicker=null;view.notice += '，已清空过期选择，请重新核对。'; }
    } finally { view.busy = false; draw(); }
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', close);
  dialog.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&event.target.matches('[data-bundle-target-query]')&&view.targetPicker){event.preventDefault();void run('targets',{category:view.targetPicker.category,query:event.target.value,offset:0});}});
  dialog.addEventListener('click', event => {
    const action = event.target.closest('[data-bundle-action]')?.dataset.bundleAction;
    if (action === 'close') { close(); return; } if (view.busy) return;
    if(action==='receipts'){void run('receipts',{offset:0});return;}
    if(action==='carriers'){void run('carriers',{offset:0});return;}
    if(['carriers-previous','carriers-next'].includes(action)&&view.carrierPage){void run('carriers',{offset:view.carrierPage.offset+(action==='carriers-next'?24:-24)});return;}
    if(['receipts-previous','receipts-next'].includes(action)&&view.receiptPage){void run('receipts',{offset:view.receiptPage.offset+(action==='receipts-next'?24:-24)});return;}
    if(action==='aliases-close'){view.sourceAliasPage=null;draw();return;}
    if(action==='aliases'){void run('aliases',{offset:0});return;}
    if(['aliases-previous','aliases-next'].includes(action)&&view.sourceAliasPage){void run('aliases',{offset:view.sourceAliasPage.offset+(action==='aliases-next'?24:-24)});return;}
    const pick=event.target.closest('[data-bundle-target-for]'),select=event.target.closest('[data-bundle-target-select]'),clear=event.target.closest('[data-bundle-target-clear]');
    if(pick){view.targetIndex=Number(pick.dataset.bundleTargetFor);const row=view.preview?.subjectReview[view.targetIndex];if(row){focusChoice=null;void run('targets',{category:row.category,query:'',offset:0});}return;}
    if(select||clear){const index=clear?Number(clear.dataset.bundleTargetClear):view.targetIndex,source=view.preview?.subjectReview[index],target=select?view.targetPicker?.rows[Number(select.dataset.bundleTargetSelect)]:null;if(!source||select&&!target)return;
      view.subjectMappings=(view.preview.subjectMappings||[]).filter(row=>row.category!==source.category||row.sourceKey!==source.subjectKey);
      if(target&&target.subjectKey!==source.subjectKey)view.subjectMappings.push({category:source.category,sourceKey:source.subjectKey,targetKey:target.subjectKey});
      choices={};focusChoice=null;view.targetPicker=null;view.page=0;void run('mapping');return;}
    if(action==='targets-close'){view.targetPicker=null;draw();return;}
    if(['targets-search','targets-next','targets-previous'].includes(action)&&view.targetPicker){const page=view.targetPicker;void run('targets',{category:page.category,query:action==='targets-search'?dialog.querySelector('[data-bundle-target-query]').value:page.query,offset:action==='targets-search'?0:page.offset+(action==='targets-next'?24:-24)});return;}
    if (action === 'next' || action === 'previous') { focusChoice = null; view.page = Math.max(0, view.page + (action === 'next' ? 1 : -1)); draw(); dialog.querySelector('[data-bundle-scroll]').scrollTop = 0; }
    else if (action === 'resources') void run('resources',{offset:0,filter:'all'});
    else if (['resources-previous','resources-next'].includes(action)&&view.resourcePage) void run('resources',{offset:view.resourcePage.offset+(action==='resources-next'?24:-24),filter:view.resourcePage.filter});
    else if (['preview','restore'].includes(action)) void run(action);
  });
  dialog.addEventListener('change', event => {
    if (view.busy || closed) return; const field = event.target;
    if(field.matches('[data-bundle-history-reviewed]')){focusChoice=null;view.historyReviewed=field.checked;draw();return;}
    if(field.matches('[data-bundle-carriers-reviewed]')){focusChoice=null;view.carriersReviewed=field.checked;draw();return;}
    if(field.matches('[data-bundle-source-reviewed]')){focusChoice=null;view.sourceAliasesReviewed=field.checked;draw();return;}
    if(field.matches('[data-bundle-source-choice]')){
      const row=view.sourceAliasPage?.rows[Number(field.dataset.bundleSourceChoice)];if(!row)return;
      view.sourceAliasChoices={...view.sourceAliasChoices,[row.groupId]:row.candidateId};choices={};view.subjectMappings=[];view.targetPicker=null;view.sourceAliasesReviewed=false;focusChoice=null;
      void run('alias-choice');return;
    }
    if (field.matches('[data-bundle-environment]')) { focusChoice = null; view.environmentReviewed = field.checked; draw(); }
    else if (field.matches('[data-bundle-mapping]')) { focusChoice = null; view.environmentMapped = field.checked; draw(); }
    else if (field.matches('[data-bundle-bindings]')) { focusChoice = null; view.bindingsReviewed = field.checked; draw(); }
    else if (field.matches('[data-bundle-subjects]')) { focusChoice = null; view.subjectsReviewed = field.checked; draw(); }
    else if(field.matches('[data-bundle-subject-mapping]')){focusChoice=null;view.subjectsMapped=field.checked;draw();}
    else if (field.matches('[data-bundle-connections]')) { focusChoice = null; view.connectionsReviewed = field.checked; draw(); }
    else if (field.matches('[data-bundle-resources]')) { focusChoice = null; view.resourcesReviewed = field.checked; draw(); }
    else if (field.matches('[data-bundle-resource-filter]')) { focusChoice = null;void run('resources',{offset:0,filter:field.value}); }
    else if (field.matches('[data-bundle-choice]')) {
      view.historyReviewed=false;view.carriersReviewed=false;
      const row = view.preview?.conflicts[Number(field.dataset.bundleChoice)]; if (!row) return;
      focusChoice = field.dataset.bundleChoice;
      if (field.value) choices[row.key] = field.value; else delete choices[row.key];
      view.sourceAliasesReviewed=false;view.subjectsMapped=false;view.environmentMapped = false; view.environmentReviewed = false; view.bindingsReviewed = false; view.subjectsReviewed = false; view.connectionsReviewed = false; view.resourcesReviewed = false; view.preview = { ...view.preview, ready: false, needsRecheck: true, planDigest: '' }; void run('choose');
    }
  });
  parent.appendChild(dialog); draw();
  try { dialog.showModal(); } catch (error) { close(); throw error; }
  void (async () => {
    try { session = await connect(); if (closed) { session.close(); return; } view.preview = await session.preview();view.subjectMappings=view.preview.subjectMappings;view.sourceAliasChoices=view.preview.sourceAliasChoices; }
    catch (error) { view.notice = error?.message || '原包核对失败，请关闭后重选文件'; }
    finally { view.busy = false; draw(); }
  })();
  return Object.freeze({ finished, close, get isOpen() { return !closed && dialog.isConnected; } });
}
