import {changeComfySceneRecord,comfySceneScopeKey} from '../../qianmu-comfy-scene-lock.js';
import {COMFY_SCENE_SNAPSHOT_SCHEMA,comfySceneSnapshotBytes} from '../../qianmu-comfy-scene-backup.js';
import {COMFY_SELECTION_SCHEMA} from '../../qianmu-comfy-selection.js';

export function completedComfySceneSource(namespace,count){
  const rows=[];
  for(let i=0;i<count;i++){
    const scope={namespace,chatKey:'chat',continuityId:'scene-'+String(i).padStart(4,'0'),narrativeLayer:'present'},lock={schema:COMFY_SELECTION_SCHEMA,scope,poolKey:'a'.repeat(64),candidateId:'candidate',executionKey:'b'.repeat(64)};
    const reserved=changeComfySceneRecord(null,scope,{type:'reserve',lock,expectedRevision:0,attemptId:'old-'+i,ownerId:'old-page',token:'old-token-'+i},100);
    const begun=changeComfySceneRecord(reserved.row,scope,{type:'begin',receipt:reserved.receipt},100);
    const record=changeComfySceneRecord(begun.row,scope,{type:'settle',receipt:reserved.receipt,outcome:'succeeded'},100).row,bytes=comfySceneSnapshotBytes(record);
    rows.push({key:comfySceneScopeKey(scope),value:{namespace,chatKey:'chat',bytes,record}});
  }
  rows.sort((a,b)=>a.key<b.key?-1:1);
  return {schema:COMFY_SCENE_SNAPSHOT_SCHEMA,namespace,usage:{count,bytes:rows.reduce((n,row)=>n+row.value.bytes,0),generation:0},rows};
}
