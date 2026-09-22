import {prepareStoryboardEnsembleSession} from './qianmu-ensemble-preparation.js?v=1.59.304';
import {attachEnsembleCompilerResult,sealEnsembleCompilerResult,resolveEnsembleCompiledRoutes} from './qianmu-ensemble-handoff.js?v=1.59.304';
import {storyboardPromptRenderingSource} from './qianmu-prompt-formats.js';

const fail=message=>{throw Object.assign(Error(message),{code:'world_shot_preparation',submissionState:'not_submitted'});};
const visual=shot=>JSON.stringify(storyboardPromptRenderingSource(shot));

// One world picture, one existing expression request. No prose plan, history
// lookup, narrative re-planning, graph editing or image submission is owned here.
export async function prepareWorldStyleSelection(state,inputGuard,dependencies,{automatic=false}={}){
  const prepared=await prepareStoryboardEnsembleSession(state,inputGuard,dependencies,{automatic});
  if(!prepared?.session.enabled)return null;
  const session=prepared.session;let selected=null;
  const check=async()=>{inputGuard.assertCurrent();await prepared.assertCurrent();inputGuard.assertCurrent();return true;};
  function accept(rows,shot){
    selected=null;session.assertCurrent();
    try{selected={visual:visual(shot),receipt:session.resolve(rows,['S1'])};}
    catch(error){if(error?.code==='storyboard_style_selection')fail(error.message);throw error;}
  }
  function receipt(shot){session.assertCurrent();if(!selected||selected.visual!==visual(shot))fail('世界画面或风格选择已变化，请重新整理提示');return selected.receipt;}
  return Object.freeze({
    enabled:true,promptFormats:session.promptFormats,useReference:prepared.useReference===true,
    async assertCurrent(){return check();},
    request(){selected=null;session.assertCurrent();return {catalogue:session.catalogue,schema:session.responseSchema(['S1'])};},
    accept,
    manual(shot){accept([{shot_id:'S1',scheme_id:'current',reason:'用户手动填写，沿用当前方案'}],shot);},
    async resolve(shot){await check();const value=await session.resolveAssignment(receipt(shot),'S1');await check();return value;},
    async bind(shots,guard){
      if(!Array.isArray(shots)||shots.length!==1)fail('世界风格只能交接当前这一镜');
      const result={shouldGenerate:true,shots};
      const captured=receipt(shots[0].shotSpec);attachEnsembleCompilerResult(result,{session,receipt:captured});
      const verify=async()=>{await check();if(await guard()===false||receipt(shots[0].shotSpec)!==captured)fail('世界来源或风格已变化');await check();return true;};
      await sealEnsembleCompilerResult(result,verify);
      return Object.freeze({async resolve(planned,currentGuard){
        const resolved=await resolveEnsembleCompiledRoutes(result,planned,{guard:async()=>{await verify();return currentGuard();}});
        // The outer world preparation retains ownership until queue handoff
        // completes. The nested generator must not close its borrowed session.
        return Object.freeze({...resolved,preparedRoutes:inputGuard.comfyRoutes,close(){},
          comfyAuto:inputGuard.comfyAuto?Object.freeze({...inputGuard.comfyAuto,close(){}}):null});
      }});
    },
  });
}
