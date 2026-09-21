import {createWorldAutomaticStorage} from './qianmu-world-automatic-storage.js?v=1.59.287';
import {normalizeWorldAutomaticApproval} from './qianmu-world-automatic-approval.js?v=1.59.287';
import {normalizeStoryboardPromptFormats,validateStoryboardPromptRenderings,bindStoryboardPromptRenderings} from './qianmu-prompt-formats.js';
import {characterReferenceChoice} from './qianmu-character-reference.js';
import {carryWorldGalleryKeywords} from './qianmu-world-gallery-keywords.js';
import {createWorldAutomaticRepairBudget} from './qianmu-world-automatic-host.js?v=1.59.287';

const fail=message=>{throw Object.assign(Error(message),{code:'world_automatic_preparation'});};
export async function beginWorldAutomaticAttempt({namespace,source,guard,createStorage}={}){
  if(typeof guard!=='function'||!globalThis.crypto?.randomUUID)fail('造物之眼自动准备环境未就绪');
  let storage;
  try{
    storage=await createWorldAutomaticStorage({scope:{namespace,source},guard,createStorage});
    const started={version:1,requestId:'wa-'+globalThis.crypto.randomUUID().replaceAll('-',''),status:'preparing',updatedAt:Date.now()};
    const saved=await storage.prepare(started);let finishing;
    return Object.freeze({approval:saved.approval,
      // One settlement attempt only. A lost acknowledgement remains blocking;
      // it must not trigger another save, another expression or another image.
      finish(status){return finishing||=(storage.settle(started,status));},
      close(){storage.close();},
    });
  }catch(error){storage?.close();throw error;}
}

export async function verifySavedWorldAutomaticApproval(value,{guard,createStorage}={}){
  const approval=normalizeWorldAutomaticApproval(value);if(!approval)fail('造物之眼自动授权记录无效');
  const storage=await createWorldAutomaticStorage({scope:{namespace:approval.namespace,source:approval.source},guard,createStorage});
  try{const record=await storage.read();return Boolean(record&&record.requestId===approval.requestId&&['preparing','queued'].includes(record.status));}
  finally{storage.close();}
}

// Only render the already scoped world facts. This is not another narrative
// planner, a workflow editor, or permission to recover a failed image request.
export async function prepareAutomaticWorldShot({shot,promptFormats,prepareRenderings,guard,useReference=false,repairBudget=createWorldAutomaticRepairBudget()}={}){
  if(typeof guard!=='function'||typeof prepareRenderings!=='function')fail('造物之眼提示整理尚未就绪');
  const formats=normalizeStoryboardPromptFormats(promptFormats);if(!formats.length)fail('当前工作流尚未声明提示格式，未自动创作');
  let prepared=structuredClone(shot);const warnings=[];
  if(useReference&&!characterReferenceChoice(prepared)){
    prepared={...prepared,characterReferenceDisabled:true};warnings.push('多人画面未指定主参考，本镜使用文字形象');
  }
  let previousError='';
  for(let repairAttempt=0;repairAttempt<=3;repairAttempt++){
    await guard();
    try{
      const values=await prepareRenderings(structuredClone(prepared),{repairAttempt,previousError});await guard();
      const checked=validateStoryboardPromptRenderings(values,{formats,characterIds:prepared.characters.map(row=>row.id)});
      if(!checked.ok)throw Object.assign(Error(checked.errors[0].message),{code:'storyboard_prompt_format'});
      const promptRenderingPack=await bindStoryboardPromptRenderings(prepared,checked.data,{formats,guard});await guard();
      return {shot:carryWorldGalleryKeywords({...prepared,promptRenderingPack},values),warnings,repairs:repairAttempt};
    }catch(error){
      await guard();
      if(!['world_shot_preparation','storyboard_prompt_format'].includes(error?.code))throw error;
      if(repairAttempt===3||repairBudget?.take?.()!==true)fail('画面提示格式仍不正确（本批已修复3次），本镜未生图');
      previousError=String(error?.message||'提示格式不符').slice(0,240);
    }
  }
}
