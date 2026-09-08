import {newCharacterArchive,normalizeCharacterArchive} from '../../qianmu-character-archive.js';
import {CHARACTER_LIBRARY_BACKUP_SCHEMA} from '../../qianmu-character-library-backup.js';
export const namespace='st-user:user-alias',chatKey='chat-one',chatHash='e'.repeat(64),targetKey='user:/User Avatars/A%20B.png';
export function aliasFixture({extra=0}={}){
  const archives=['alice','bob'].map(id=>{const document=normalizeCharacterArchive({...newCharacterArchive('user'),name:id,imagegen:{appearance:'private appearance',negative:'private negative'}});
    return {head:{id,revision:id+'-1',version:1,category:'user',name:id,aliases:[],cover:'',bytes:new TextEncoder().encode(JSON.stringify(document)).length,createdAt:1,updatedAt:1},document};});
  const binding=(subjectKey,scope,chatKey,archiveId,revision)=>({category:'user',subjectKey,scope,chatKey,archiveId,revision,updatedAt:1});
  const bindings=[binding(targetKey,'default','','alice','canonical'),binding('user:/User%20Avatars/A B.png','default','','bob','old'),
    binding('user:/User Avatars/A B.png','chat',chatKey,'','null-override'),binding(targetKey,'chat','other-chat','alice','unchanged'),
    ...Array.from({length:extra},(_,i)=>binding('user:/User%20Avatars/A%20B%2epng','chat','extra-'+i,'alice','extra-'+i))];
  return {schema:CHARACTER_LIBRARY_BACKUP_SCHEMA,namespace,credentialsIncluded:false,archives,bindings,usage:{count:2,bytes:archives.reduce((sum,row)=>sum+row.head.bytes,0),bindings:bindings.length}};
}
