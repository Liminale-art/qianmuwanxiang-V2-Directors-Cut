// Decode exactly once. Case, Unicode normalization and literal percent signs are part of the avatar filename.
export function canonicalUserSubjectKey(value){
  if(typeof value!=='string'||value.length>1024)return null;
  const match=/^user:\/User(?:%20| )Avatars\/([^/\\]+)$/.exec(value);if(!match)return null;
  let name;try{name=decodeURIComponent(match[1]);}catch(_){return null;}
  if(!name||name==='.'||name==='..'||/[\/\\\u0000-\u001f\u007f]/.test(name))return null;
  try{const key='user:/User Avatars/'+encodeURIComponent(name);return key.length<=1024?key:null;}catch(_){return null;}
}
export const sameCharacterSubject=(a,b)=>a.category===b.category&&(a.subjectKey===b.subjectKey||a.category==='user'&&Boolean(canonicalUserSubjectKey(a.subjectKey))&&canonicalUserSubjectKey(a.subjectKey)===canonicalUserSubjectKey(b.subjectKey));
export function inspectUserAliasTargets(targets,personas){
  if(!Array.isArray(targets)||targets.length>2048||new Set(targets).size!==targets.length||targets.some(key=>canonicalUserSubjectKey(key)!==key))throw Error('USER地址目标清单无效');
  if(!targets.length)return [];
  if(!personas||typeof personas!=='object'||Array.isArray(personas))throw Error('ST人设目录尚未载入，请先打开人设管理页');
  return targets.map(subjectKey=>({subjectKey,present:Object.hasOwn(personas,decodeURIComponent(subjectKey.slice('user:/User Avatars/'.length)))}));
}
