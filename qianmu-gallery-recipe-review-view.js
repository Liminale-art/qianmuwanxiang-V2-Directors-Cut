import {htmlEscape as escape} from './qianmu-storyboard-utils.js';
import {createCurrentGalleryArchiveSession} from './qianmu-gallery-archive-source.js?v=1.59.324';

export function galleryRecipeReviewSummary(snapshot){
  const fields=[['渠道',({novel:'NovelAI',openai:'兼容图像模型',comfy:'ComfyUI'})[snapshot.source]||snapshot.source],['模型',snapshot.profile?.model],
    ['画面提示词',snapshot.prompt],['负面提示词',snapshot.negative],['画师串',snapshot.artistString]];
  return '<dl>'+fields.map(([label,value])=>`<dt>${label}</dt><dd style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(value==null?'未记录':value===''?'（空）':String(value))}</dd>`).join('')+'</dl>';
}

// An explicit exceptional repair path for pre-digest device caches. Opening
// this view neither reads the cache nor associates it with the active account.
export function openGalleryRecipeReview({parent,recordId,isCurrent=()=>true,connect=createCurrentGalleryArchiveSession,...options}={}){
  const document=parent.ownerDocument,view=document.defaultView,focus=document.activeElement;
  const dialog=document.createElement('dialog');dialog.className='sd-bundle-dialog sd-gallery-directory sd-gallery-recipe-review';dialog.setAttribute('aria-label','核对旧配方');
  let closed=false,busy=false,session,review=null,notice='',saved=false,resolve;
  const finished=new Promise(done=>resolve=done);
  function close(){if(closed)return;closed=true;session?.close();observer.disconnect();view.removeEventListener('pagehide',close);if(dialog.open)dialog.close();dialog.remove();if(focus?.isConnected)focus.focus({preventScroll:true});resolve({saved});}
  function alive(){if(closed)return false;try{if(!parent.isConnected||!dialog.isConnected||isCurrent()!==true)throw Error();return true;}catch{close();return false;}}
  const observer=new view.MutationObserver(alive);
  function draw(){
    if(!alive())return;
    dialog.innerHTML=`<header><b>核对旧配方</b><button type="button" class="sd-btn" data-review-action="close">关闭</button></header><main>
      <p>早期本机索引没有账户归属凭据。请在原设备核对下方内容确实属于这张画面；不确定时关闭即可，旧资料不会删除。</p>
      <p>确认后只将此配方关联到当前 ST 账户的原画面，不改正文或绘图设置，不提交生成。</p>
      ${review?galleryRecipeReviewSummary(review.snapshot)+'<details><summary>完整原始配方（只读）</summary><textarea class="text_pole" rows="12" readonly aria-label="待核对旧配方"></textarea></details>':'<button type="button" class="sd-btn" data-review-action="read" '+(busy?'disabled':'')+'>读取此画面的本机旧项</button>'}
      </main><footer><p role="status">${escape(notice)}</p>${review?`<button type="button" class="sd-btn" data-review-action="confirm" ${busy||saved?'disabled':''}>确认是此画面的配方并保存</button>`:''}</footer>`;
    const field=dialog.querySelector('textarea');if(field)field.value=JSON.stringify(review.snapshot,null,2);
  }
  async function work(action){
    if(!alive()||busy||saved)return;busy=true;notice=action==='read'?'正在核对原聊天并读取这一项…':'正在保存已核对的副本…';draw();
    try{
      if(action==='read'){
        session?.close();session=null;review=null;
        const opened=await connect({...options,guard:alive,preserveOriginals:false,preserveSupplements:false,preserveEvidence:false});
        if(!alive()){opened.close();return;}session=opened;
        const candidate=await session.reviewLegacyRecipe(recordId);if(!alive())return;review=candidate;notice='尚未关联或保存。请完整核对后再确认。';
      }else{
        if(!review||!session)throw Error('请先读取并核对旧配方');
        const result=await session.confirmLegacyRecipe({confirmed:true,expectedDigest:review.digest});if(!alive())return;
        if(result?.state!=='available'||result.origin!=='reviewed-local-copy')throw Error('旧配方保存读回尚未确认');
        saved=true;notice='旧配方已保存到当前 ST 账户。原记录与本机缓存均保留，之后可直接使用。';
      }
    }catch(error){if(alive())notice=(error?.message||'旧配方核对未完成')+(error?.writeState==='unconfirmed'?'。保存状态待核对；不要删除原资料，可再次核对同一份内容。':'');}
    finally{busy=false;draw();}
  }
  dialog.addEventListener('click',event=>{const action=event.target.closest('[data-review-action]')?.dataset.reviewAction;if(action==='close')close();else if(['read','confirm'].includes(action))void work(action);});
  for(const type of ['keydown','keypress','keyup'])dialog.addEventListener(type,event=>event.stopPropagation());
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.addEventListener('close',close);
  parent.append(dialog);view.addEventListener('pagehide',close);observer.observe(document.body,{childList:true,subtree:true});
  draw();dialog.showModal();return {finished,close};
}
