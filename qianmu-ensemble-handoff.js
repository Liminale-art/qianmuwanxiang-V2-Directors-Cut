import {storyboardPromptRenderingSource} from './qianmu-prompt-formats.js';
import {ensembleStyleOrigins} from './qianmu-ensemble-origin.js';
import {ensembleSelectionStages} from './qianmu-ensemble-diagnostics.js';
const records=new WeakMap();
const fail=message=>{throw Object.assign(Error(message),{code:'ensemble_handoff',submissionState:'not_submitted'});};
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const snapshot=shot=>JSON.stringify({id:shot.id,prompt:shot.prompt,negative:shot.negative,paragraphIndex:shot.paragraphIndex,shotType:shot.shotType,sensitive:shot.sensitive,
  narrativeMoment:shot.shotSpec?.narrativeMoment||null,visual:storyboardPromptRenderingSource(shot.shotSpec)});
function shots(result){
  if(result?.shouldGenerate!==true||!Array.isArray(result.shots)||!result.shots.length||result.shots.length>20)fail('镜组结果缺少有效镜头');
  const seen=new Set();for(const shot of result.shots){if(typeof shot?.id!=='string'||!shot.id||seen.has(shot.id))fail('镜组镜头编号缺失或重复');seen.add(shot.id);}return result.shots;
}
function recordFor(result){
  const record=records.get(result);
  if(!record&&!result?.ensembleRequired)return null;
  if(!record||result.ensembleRequired!==true)fail('风格交接已丢失，请重新提取，未改用当前线路');
  const current=shots(result);
  if(current.length!==record.shots.length||current.some((shot,index)=>shot!==record.shots[index]||shot.id!==record.ids[index]))fail('镜组镜头在交接前已替换或重排');
  record.session.assertCurrent();return record;
}

// The compiler adapter supplies its own newly minted draft IDs, not model IDs.
// Capture before casting, then seal only after character remapping/renderings.
// Neither the marker nor a JSON copy of this object carries execution authority.
export function attachEnsembleCompilerResult(result,{session,receipt}={}){
  if(!session||typeof session.resolveAssignment!=='function'||typeof session.assertCurrent!=='function')fail('风格方案没有本次执行绑定');
  if(records.has(result)||Object.hasOwn(result,'ensembleRequired'))fail('风格结果不能重复绑定');
  const values=shots(result);
  if(receipt?.executionAuthorized!==false||!Array.isArray(receipt.assignments)||receipt.assignments.length!==values.length
    ||receipt.assignments.some((row,index)=>row.shotId!==`S${index+1}`))fail('风格选择与实际镜头数量或顺序不一致');
  session.assertCurrent();result.ensembleRequired=true;
  records.set(result,{session,receipt,shots:[...values],ids:values.map(shot=>shot.id),sealed:false,sealing:false,snapshots:null,guard:null});return result;
}

export async function sealEnsembleCompilerResult(result,guard){
  const record=recordFor(result);if(!record)return false;
  if(typeof guard!=='function'||record.sealed||record.sealing)fail('风格交接已封存或正在核对');
  record.sealing=true;
  try{
    if(await guard()===false)fail('风格来源已变化');recordFor(result);
    const snapshots=record.shots.map(snapshot);
    for(let index=0;index<record.shots.length;index++){
      await record.session.resolveAssignment(record.receipt,`S${index+1}`);
      if(await guard()===false)fail('风格来源已变化');recordFor(result);
      if(record.shots.some((shot,i)=>snapshot(shot)!==snapshots[i]))fail('封存期间镜头内容已变化');
    }
    record.snapshots=snapshots;record.guard=guard;record.sealed=true;return true;
  }finally{record.sealing=false;}
}

// A live batch may drop redundant shots, but cannot swap, invent or repeat one.
// The caller retains image-count limits, safety adaptation and admission checks.
export async function resolveEnsembleCompiledRoutes(result,planned,{guard}={}){
  const record=recordFor(result);if(!record)return null;
  if(!record.sealed||typeof guard!=='function'||!Array.isArray(planned))fail('风格交接尚未完整封存');
  const check=async()=>{
    if(await guard()===false||await record.guard()===false)fail('镜组来源已失效');recordFor(result);
    if(record.shots.some((shot,index)=>snapshot(shot)!==record.snapshots[index]))fail('镜头已编辑，旧风格交接失效');
  };
  const selected=()=>{
    let previous=-1;return planned.map(shot=>{const index=record.ids.indexOf(shot?.id);
      if(index<=previous||index<0||snapshot(shot)!==record.snapshots[index])fail('待画镜头与原叙事交接不一致');previous=index;return index;});
  };
  await check();const indices=selected(),assignments=[];
  for(const index of indices){assignments.push(await record.session.resolveAssignment(record.receipt,`S${index+1}`));await check();
    if(JSON.stringify(selected())!==JSON.stringify(indices))fail('风格核对期间镜头列表已变化');}
  return Object.freeze({routes:freeze(assignments.map(row=>row.route)),artistPresetIds:freeze(assignments.map(row=>row.artistPresetId)),
    origins:ensembleStyleOrigins(record.receipt,indices.map(index=>`S${index+1}`)),
    stages:ensembleSelectionStages(record.receipt,record.session.catalogue,indices.map(index=>`S${index+1}`)),
    schemes:freeze(assignments.map(row=>({shotId:row.shotId,schemeId:row.schemeId,bindingKey:row.bindingKey}))),executionAuthorized:false,
    async assertCurrent(){await check();if(JSON.stringify(selected())!==JSON.stringify(indices))fail('镜组待画列表已变化');},
  });
}

// Readable recovery data is not a transferable execution permit. Only a live,
// sealed compiler result can produce it; a new host must recheck stored origin,
// shot content and fresh technical bindings before using a restored selection.
export async function readEnsembleCompilerProof(result,{guard}={}){
  const record=recordFor(result);if(!record)fail('此结果没有镜组交接');
  const resolved=await resolveEnsembleCompiledRoutes(result,record.shots,{guard});await resolved.assertCurrent();
  return freeze({receipt:JSON.parse(JSON.stringify(record.receipt)),shotIds:[...record.ids],snapshots:[...record.snapshots]});
}
export const ensembleShotContent=shot=>snapshot(shot);
