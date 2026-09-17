import {createCurrentChatGalleryReceiptClient} from './qianmu-chat-character-receipt-client.js';
import {chatGalleryReceiptText} from './qianmu-chat-gallery-receipt.js';

const active=new WeakSet();
// Explicit read-only check of the current host file. No save, directory write,
// automatic indexing, source relocation, media fetch or cleanup authorization.
export async function checkStorageGallerySource(button,{getContext,epoch,createClient=createCurrentChatGalleryReceiptClient,timeoutMs=15000}={}){
  if(!button?.isConnected||active.has(button))return;
  const section=button.closest('.sd-storage-backup-section'),status=section?.querySelector('.sd-storage-gallery-check-status');
  const modal=button.closest('#story-director-modal');
  if(!status||!modal?.classList.contains('open'))return;
  active.add(button);button.disabled=true;status.hidden=false;status.textContent='正在核对当前聊天已保存的静帧记录…';
  let closed=false,client,reason='本次来源核对已取消，请重新核对。',rejectCancellation;
  const cancellation=new Promise((_,reject)=>{rejectCancellation=reject;});
  void cancellation.catch(()=>{});
  const current=()=>!closed&&button.isConnected&&status.isConnected&&modal.classList.contains('open')&&modal.contains(button);
  const stop=()=>{closed=true;client?.close();rejectCancellation(Error(reason));};
  const observer=new button.ownerDocument.defaultView.MutationObserver(records=>{
    if(!current()||records.some(row=>row.type==='attributes'&&row.target===modal&&!row.oldValue?.split(/\s+/).includes('open')))stop();
  });
  observer.observe(modal,{attributes:true,attributeOldValue:true,attributeFilter:['class'],childList:true,subtree:true});
  observer.observe(button.ownerDocument.body,{childList:true,subtree:true});
  const view=button.ownerDocument.defaultView;view.addEventListener('pagehide',stop,{once:true});
  const timer=setTimeout(()=>{reason='来源核对超时，未修改资料；请稍后重试。';stop();},Math.max(100,Math.min(30000,Number(timeoutMs)||15000)));
  const guard=()=>{if(!current())throw Error('资料页面已变化，本次来源核对作废');};
  const records=()=>getContext()?.chatMetadata?.story_director_liminale?.storyboardImages;
  try{
    const opening=Promise.resolve(createClient({getContext,epoch,guard}));
    void opening.then(late=>{if(closed)late.close();},()=>{}).catch(()=>{});
    client=await Promise.race([opening,cancellation]);guard();
    const before=chatGalleryReceiptText(records()),snapshot=before?JSON.parse(before.text):undefined;
    const receipt=await Promise.race([client.verify(snapshot),cancellation]);guard();client.assertCurrent();
    if(before?.text!==chatGalleryReceiptText(records())?.text)throw Error('核对期间静帧记录已变化，请重新核对');
    const label=client.target.kind==='character'?`${client.target.avatar} / ${client.target.chatId}`:`群聊 / ${client.target.chatId}`;
    const detail=receipt.matches
      ? receipt.state==='present'?`服务器已保存的 ${receipt.gallery.count} 条静帧记录与当前页面一致。`:'当前页面与服务器均无静帧记录。'
      :'当前页面与服务器的静帧记录不一致，可能尚未保存或已在另一端变化；未覆盖任一端。';
    status.textContent=`本次核对 · ${label}：${detail} 仅核对该聊天的静帧记录，不核验图片原件、影片或整个账户；本次结果不是删除或迁移授权。`;
  }catch(error){
    if(current())status.textContent=`来源尚未确认：${error?.message||'请稍后重试'}。此功能需要配套千幕后端；旧后端请更新后正常重启 ST。本次未修改或删除任何资料。`;
  }finally{
    clearTimeout(timer);client?.close();observer.disconnect();view.removeEventListener('pagehide',stop);active.delete(button);button.disabled=false;
    if(closed&&status.isConnected)status.textContent=reason;
  }
}
