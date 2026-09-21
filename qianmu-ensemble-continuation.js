import {normalizeEnsembleStyleOrigin,retainEnsembleStyleOrigin} from './qianmu-ensemble-origin.js';
import {createStoryboardStreamMoment} from './qianmu-storyboard-stream-moment.js?v=1.59.224';
const copy=value=>JSON.parse(JSON.stringify(value));
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const fail=()=>{throw Object.assign(Error('已有画面的连续场景来源无法核对'),{code:'ensemble_scene_continuation',submissionState:'not_submitted'});};
const signal=value=>typeof value==='string'?value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu,' '):'';
const text=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

// The caller has already verified occupancy, account, source family and moment.
// Retain only bounded descriptive data. Invalid data is checked on opt-in use,
// so disabling style locking cannot break the ordinary image-budget reader.
export function captureEnsembleSceneAnchor(job,moment){
  if(!Object.hasOwn(job||{},'ensembleStyleOrigin'))return null;
  const location=job.shotSpec?.sceneFingerprint?.location,time=job.shotSpec?.continuityUpdates?.time;
  if(!moment||job.safetyAdapted||!text(location,1000)||!text(time,240))return {invalid:true};
  return freeze({origin:retainEnsembleStyleOrigin(job.ensembleStyleOrigin),moment:copy(moment),scene:{location,time}});
}

export const ENSEMBLE_SCENE_CONTINUATION_INSTRUCTION='prior_scene_anchors是已核对来源的本层已有画面，只用于判断连续场景，不是新画面或新增叙事。每镜scene_predecessor填同一连续场景的已有画面ID；无明确承接填空串。只有同一叙事分支/层、地点与时段连续才承接；转场、跳时、回忆/幻想分支不得混接，机位/主体/光线变化不算转场。承接时scene.location与scene.time沿用锚点表述。不能仅凭同名地点判断。只返回锚点ID，不决定画风；不改已提交画面。';

export function configureEnsembleSceneContinuation({history,session,schema,payload,window}={}){
  if(session?.enabled===false||session?.styleLock!==true)return null;
  session.assertCurrent();window.assertCurrent();
  if(!history)return null;
  if(!Array.isArray(history.rows)||history.rows.length>8)fail();if(!history.rows.length)return null;
  const anchors=[];
  for(const row of history.rows){
    if(!row||!text(row.id,160)||!row.anchor||row.anchor.invalid)fail();
    const anchor=row.anchor,origin=normalizeEnsembleStyleOrigin(anchor.origin);
    if(origin.namespace!==history.namespace||origin.chatKey!==window.current.messageRef.chatKey)fail();
    const previous=anchors.find(item=>item.logicalId===row.id);
    if(previous){if(JSON.stringify(previous.anchor)!==JSON.stringify(anchor))fail();continue;}
    anchors.push({id:`E${anchors.length+1}`,logicalId:row.id,anchor:copy(anchor)});
  }
  if(anchors.length>4)fail();
  const byId=new Map(anchors.map(row=>[row.id,row.anchor]));
  const shot=schema.properties.shots.items;shot.properties.scene_predecessor={type:'string',enum:['',...byId.keys()]};shot.required.push('scene_predecessor');
  payload.prior_scene_anchors=anchors.map(({id,anchor:{moment,scene}})=>({id,branch_id:moment.branchId,narrative_layer:moment.layer,
    paragraph_id:moment.paragraphId,quote:moment.quote,subject:moment.subject,location:scene.location,time:scene.time}));
  const current=()=>{window.assertCurrent();session.assertCurrent();};
  function selected(narrative){
    current();const rows=[],groups=new Map();
    for(const [index,shot] of narrative.shots.entries()){
      if(shot.scene_predecessor==='')continue;
      const anchor=byId.get(shot.scene_predecessor);if(!anchor)fail();
      const moment=createStoryboardStreamMoment(shot,window),old=anchor.moment,paragraphs=window.current.paragraphs;
      const before=paragraphs.findIndex(row=>row.id===old.paragraphId),after=paragraphs.findIndex(row=>row.id===moment.paragraphId);
      if(before<0||after<before||after===before&&moment.start<old.start||old.branchId!==moment.branchId||old.layer!==moment.layer
        ||signal(shot.scene?.location)!==signal(anchor.scene.location)||signal(shot.scene?.time)!==signal(anchor.scene.time))fail();
      const group=JSON.stringify([moment.branchId,moment.layer,signal(shot.composition?.continuity_key),signal(shot.scene.location),signal(shot.scene.time)]);
      const style=JSON.stringify([anchor.origin.schemeId,anchor.origin.revision,anchor.origin.bindingKey]),previous=groups.get(group);
      if(previous&&previous!==style)fail();groups.set(group,style);rows.push({shotId:`S${index+1}`,origin:anchor.origin});
    }
    current();return rows;
  }
  return Object.freeze({assertCurrent:current,validate(narrative){selected(narrative);return true;},resolve(narrative){
    if(typeof session.verifyOrigin!=='function')fail();
    return freeze(selected(narrative).map(({shotId,origin})=>({shotId,schemeId:session.verifyOrigin(origin)})));
  }});
}
