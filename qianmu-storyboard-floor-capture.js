import {createStoryboardFloorTake,createStoryboardCaptureReservation} from './qianmu-storyboard-floor-take.js?v=1.59.352';
import {readStoryboardFloorTakeSourceKeys} from './qianmu-storyboard-floor-take-source.js?v=1.59.352';
import {storyboardStreamGeneration} from './qianmu-storyboard-stream-reference.js?v=1.59.352';
const running=new WeakSet();
export async function captureStoryboardFloor(floor,message,api) {
  const state=api.state(),chatKey=api.chatKey(),epoch=api.epoch(),text=message?.mes,swipe=message?.swipe_id;
  const generation=message?JSON.stringify(storyboardStreamGeneration(message)):'';
  const current=()=>api.state()===state&&api.chatKey()===chatKey&&api.epoch()===epoch&&api.chat()?.[floor]===message&&message.mes===text&&message.swipe_id===swipe
    &&JSON.stringify(storyboardStreamGeneration(message))===generation&&state.enabled;
  if(!message||message.is_system||!current())return false;
  if(running.has(state)||api.busy()){api.toast('取景正在准备，请稍候','info');return false;}
  running.add(state);
  let reservation,plan;
  try {
    const existing=api.planFor(state,floor,message);
    if(['screening','compiling','queued','generating'].includes(existing?.status)){api.toast('这一层的分镜任务正在进行','info');return false;}
    const identity=Promise.resolve().then(api.namespace).then(value=>({value}),error=>({error}));
    const choice=await api.choose(floor,message,{reextract:Boolean(existing)});
    if(!choice||!current())return false;
    const resolved=await identity;if(resolved.error)throw resolved.error;const namespace=resolved.value;
    if(!choice||!current()||namespace!==await api.namespace()||!current()||api.busy())return false;
    const supplement=choice.mode==='manual_supplement';
    const messageKeys=supplement?null:await readStoryboardFloorTakeSourceKeys(floor,message,api,namespace,current);
    if(!current()||api.busy())return false;
    reservation=createStoryboardCaptureReservation(state);
    plan=api.ensurePlan(state,floor,message,{origin:supplement?'manual_supplement':'manual',autoGenerate:false,forceNew:true,paragraphSelection:choice.selection});
    if(!supplement)plan.floorTake=createStoryboardFloorTake(plan,api.records(),api.visible,api.pending?.()||state.taskStates||[],api.receipts?api.receipts():[],messageKeys);
    Object.assign(state,{target:'floor',floor:String(floor),inlineByDefault:true,paragraphMode:supplement?'manual':'auto',manualParagraphIndex:choice.paragraphIndex,
      pendingParagraphSelection:choice.selection,promptMode:'auto'});
    state.promptCompiler.enabled=true;reservation.seal();
    Object.assign(plan,{status:'screening',updatedAt:Date.now()});api.save();api.render(floor);
    const compiled=await api.compile(plan);
    if(!compiled){
      if(plan.status==='screening'){plan.status='failed';plan.error='取景未启动，请核对配置后重试';}
      if(current()&&reservation.restore())api.save();
      return false;
    }
    if(!current()||namespace!==await api.namespace()||!current()||state.promptDraft.planId!==plan.id)return false;
    return await api.generate(plan);
  } catch(error) {
    if(current()) {
      if(plan&&['idle','screening','compiling'].includes(plan.status)){plan.status='failed';plan.error=String(error?.message||error);}
      reservation?.restore();
      api.toast(`正文取景未完成：${error?.message||error}`,'warning');
    }
    return false;
  } finally {running.delete(state);}
}
