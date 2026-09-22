import {EventEmitter} from 'node:events';
import {createStoryboardMessageReference,createStoryboardParagraphAnchor} from '../../qianmu-storyboard.js';
import {hashText} from '../../qianmu-storyboard-utils.js';
import {createGalleryLocation} from '../../qianmu-gallery-location.js';
export const locationGate=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve};};
export function galleryLocationFixture(t){
  const context={chatId:'chat',characterId:0,characters:[{chat:'chat',avatar:'Alice.png'}],eventSource:new EventEmitter(),chatMetadata:{story_director_liminale:{}},
    chat:[{mes:'Kitchen light.\n\nAlice reaches for the bowl.',name:'Alice',send_date:'day-1',gen_started:'generation-1',swipe_id:0}]};
  const scope={namespace:'st-user:alice',ownerKey:'char:Alice.png',chatKey:'chat'},paragraphs=text=>text.split(/\n\n/).filter(Boolean);
  const message=context.chat[0],record={id:'archived',chatKey:'chat',floor:0,swipeId:0,messageHash:hashText(message.mes),
    messageRef:createStoryboardMessageReference({message,chatKey:'chat',floor:0,now:1}),
    paragraphAnchor:createStoryboardParagraphAnchor({messageText:message.mes,paragraphText:paragraphs(message.mes)[1],previousText:paragraphs(message.mes)[0],paragraphIndex:1,chatKey:'chat',swipeId:0})};
  let epoch=0,account=scope.namespace,current=true;
  const input={record,scope,getContext:()=>context,epoch:()=>epoch,account:async()=>account,isCurrent:()=>current,paragraphs};
  return {context,record,scope,input,paragraphs,get message(){return context.chat[0];},set epoch(value){epoch=value;},set account(value){account=value;},set current(value){current=value;},
    async open(extra={}){const lease=await createGalleryLocation({...input,...extra});t.after(()=>lease.close());return lease;}};
}
