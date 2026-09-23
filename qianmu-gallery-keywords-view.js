import {selectedGalleryKeywords,galleryKeywordList,DEFAULT_GALLERY_KEYWORDS} from './qianmu-gallery-keywords.js';
import {renderGalleryChoicePicker} from './qianmu-gallery-choice-picker.js';
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function renderGalleryKeywordEntry(state){
  let words;try{words=selectedGalleryKeywords(state);}catch{words=[];}
  return `<details class="sd-storyboard-preset-entry sd-gallery-keyword-entry"><summary><span>阅片关键词</span></summary><div class="sd-gallery-keyword-fields"><label><span>词库</span><textarea class="text_pole" data-gallery-keyword-editor rows="4" aria-label="阅片关键词词库">${words.map(escape).join('\n')}</textarea></label><small>每行一个词，也可用逗号分隔。取景时择取3–5个，宁少不乱贴；不写入生图提示词。清空即停用。</small><div><button type="button" class="sd-btn" data-gallery-keyword-defaults>恢复默认词库</button><span data-gallery-keyword-status role="status"></span></div></div></details>`;
}
export function bindGalleryKeywordEntry(root,state,{current,save,changed=()=>{}}){
  const input=root.querySelector('[data-gallery-keyword-editor]');if(!input)return;
  const presetId=state.promptCompiler?.instructionPresetId||'',preset=state.promptPresets?.find(row=>row.id===presetId),target=preset||state;
  const status=root.querySelector('[data-gallery-keyword-status]');
  const valid=()=>current()&&(state.promptCompiler?.instructionPresetId||'')===presetId&&(!preset||state.promptPresets.includes(preset));
  const commit=()=>{
    if(!valid())return;
    try{
      const words=galleryKeywordList(input.value.split(/[\r\n,，]+/));
      const old=target.galleryKeywords,had=Object.hasOwn(target,'galleryKeywords'),updatedAt=target.updatedAt;
      target.galleryKeywords=words;if(preset)preset.updatedAt=Date.now();
      try{save();}catch(error){if(had)target.galleryKeywords=old;else delete target.galleryKeywords;if(preset)preset.updatedAt=updatedAt;throw error;}
      changed();status.textContent=words.length?'已应用':'已停用';
    }catch(error){status.textContent=error?.message||'未能保存，输入已保留';}
  };
  input.addEventListener('change',commit);
  root.querySelector('[data-gallery-keyword-defaults]')?.addEventListener('click',()=>{if(valid()){input.value=DEFAULT_GALLERY_KEYWORDS.join('\n');commit();}});
}
export function renderGalleryKeywordFilters(records,selected=[],keywordWords){
  const words=keywordWords??[...new Set(records.flatMap(row=>row.tags||[]))].filter(word=>typeof word==='string'&&word).sort((a,b)=>a.localeCompare(b));
  return words.length?`<nav class="sd-gallery-keyword-filters" aria-label="关键词筛选，可多选取交集">${renderGalleryChoicePicker({id:'keywords',title:'关键词',items:words.map(word=>({id:word,label:word})),selected})}</nav>`:'';
}
