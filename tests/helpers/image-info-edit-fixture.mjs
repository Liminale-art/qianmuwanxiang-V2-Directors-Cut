import vm from 'node:vm';
import * as storyboard from '../../qianmu-storyboard.js';
import * as membership from '../../qianmu-gallery-membership.js';
import {storyboardFunctionSource} from './storyboard-form-fixture.mjs';

// Exercise the actual editor without DOM, persistence, providers or paid work.
export async function exerciseImageInfo({snapshot,record={id:'old',floor:0},namespace='st-user:fixture',readNamespace=async()=>namespace,edit=()=>{},accept=true,
  collections=[],extraRecords=[],readRecords=()=>[record,...extraRecords],inspectOnly=false,onOpen=async()=>{},save=()=>{throw Error('old image must not be rewritten');}}={}) {
  const state=storyboard.createStoryboardDefaults(),metadata={},original=structuredClone(record),drafts=[],fields={
    '.sd-character-reference-picker':{value:snapshot.payload.shotSpec?.primarySubjectId||'__none__'},
    '.sd-comfy-character-inline':{checked:snapshot.profile.comfyCharacterEnabled===true},
  };
  const host={dataset:{},querySelector:selector=>fields[selector]};
  let sequence=0;
  const c=vm.createContext({...storyboard,...membership,clone:structuredClone,storyboardState:()=>state,getChatKey:()=> 'chat',ctx:()=>({chatMetadata:metadata}),storyboardAdmissionEpoch:1,uid:()=> 'new-'+(++sequence),
    storyboardGalleryRecords:readRecords,storyboardReadSnapshotForRecord:async()=>structuredClone(snapshot),storyboardImageInfoView:null,storyboardImageInfoOpening:0,
    htmlEscape:x=>String(x),storyboardRecordParameterLabel:()=>'',renderRunningHubTaskUsage:()=>'',STORYBOARD_SOURCES:{},storyboardSafeUrl:()=>'',
    storyboardMediaTagEditorMarkup:()=>'',summarizeGalleryRecords:()=>({knownTags:[]}),storyboardGalleryCollections:()=>collections,
    galleryRecordSourceCharacter:()=>'',storyboardUpdateGalleryNarrative:()=>({sourceFor:()=>null}),
    applyQianmuIcons:()=>{},coreadCopyText:()=>{},appearanceSession:{},storyboardBindMediaTagEditors:()=>{},
    saveMetadata:save,
    storyboardRedrawRecord:async(row,{snapshotOverride,verify})=>{await verify();drafts.push(structuredClone(snapshotOverride));return accept;},
    featureRuntime:{load:async key=>key==='imageAdmission'?{resolveImageAccountNamespace:readNamespace}:{renderCharacterShotEditor:()=>''}},
    openImageInfo:options=>({close(){},finished:Promise.resolve().then(async()=>{await onOpen(options);if(inspectOnly)return false;fields.positive={value:options.positive};fields.negative={value:options.negative};await edit({fields,record});return options.onGenerate({positive:fields.positive.value,negative:fields.negative.value,host,changed:true},options.guard);})}),
  });
  vm.runInContext(['storyboardParseWorkflow','storyboardCloseImageInfo','storyboardEditPrompt'].map(storyboardFunctionSource).join('\n'),c);
  let result,error;try{result=await c.storyboardEditPrompt({record});}catch(failure){error=failure;}
  return {result,error,record,original,drafts,state};
}
