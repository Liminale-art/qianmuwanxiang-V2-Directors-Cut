import {captureStoryboardContinuation,saveStoryboardContinuation} from '../../qianmu-storyboard-continuation.js';
import {createStoryboardMessageReference,createStoryboardParagraphAnchor} from '../../qianmu-storyboard.js';
import {hashText} from '../../qianmu-storyboard-utils.js';

export async function attachGalleryContinuity({context,store=context.chatMetadata.story_director_liminale,namespace}){
  const message=context.chat[0];message.send_date='before';message.gen_started='generation-before';message.swipe_id=0;
  const source=message.mes,reference=createStoryboardMessageReference({message,chatKey:context.chatId,floor:0,now:1});
  const handle=captureStoryboardContinuation({type:'continue',getContext:()=>context,epoch:()=>0,createReference:createStoryboardMessageReference});
  message.mes+='\n\nA new moment.';message.send_date='after';message.gen_started='generation-after';
  try{await saveStoryboardContinuation(handle,async()=>namespace,store,async()=>{});}finally{handle.close();}
  store.storyboardContinuations[0].future={note:' keep exact ',zero:0};
  store.storyboardFloorTakeReceipts=[{version:1,id:'new-take',chatKey:context.chatId,messageKey:reference.messageKey,swipeId:0,startedAt:10,baselineTaskIds:['old-job'],future:{keep:false}}];
  return {reference,record:{messageRef:reference,messageHash:hashText(source),swipeId:0,chatKey:context.chatId,taskId:'old-job',planId:'old-plan',
    paragraphAnchor:createStoryboardParagraphAnchor({messageText:source,paragraphText:source,paragraphIndex:0,chatKey:context.chatId,swipeId:0})}};
}
