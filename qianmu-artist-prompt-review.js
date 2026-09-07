const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function renderArtistPromptReview({prompt,negative,message=''}){
  return `<div class="sd-world-shot-dialog sd-artist-prompt-review"><h3>核对原画面提示</h3><small>旧图没有可确认的画师层，或提示词已改写。请去除旧画师与附加风格词，保留画面描述；仅用于新图，不修改原图。</small>
    <div class="sd-world-shot-fields"><label><span>画面正文</span><textarea class="text_pole" data-artist-base="prompt" rows="5" maxlength="24000">${escape(prompt)}</textarea></label>
    <label><span>画面排除项</span><textarea class="text_pole" data-artist-base="negative" rows="4" maxlength="12000">${escape(negative)}</textarea></label></div><p role="status">${escape(message)}</p></div>`;
}
export async function openArtistPromptReview({prompt,negative,context,guard=async()=>{}}){
  if(!context?.Popup||!context.POPUP_TYPE)throw new Error('当前 ST 不支持提示核对，请载入镜头台编辑后重绘');
  let message='';
  for(;;){
    await guard();const wrap=document.createElement('div');wrap.innerHTML=renderArtistPromptReview({prompt,negative,message});
    const confirmed=await new context.Popup(wrap,context.POPUP_TYPE.CONFIRM,'',{okButton:'确认换画师',cancelButton:'取消'}).show();
    await guard();if(!confirmed)return null;
    prompt=wrap.querySelector('[data-artist-base=prompt]').value.trim();negative=wrap.querySelector('[data-artist-base=negative]').value.trim();
    if(prompt.length>24000||negative.length>12000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt+negative)){message='提示词过长或包含无效字符，请调整后确认';continue;}
    return {prompt,negative,needsReview:false};
  }
}
