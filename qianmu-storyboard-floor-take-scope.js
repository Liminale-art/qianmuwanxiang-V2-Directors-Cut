const text=value=>typeof value==='string'&&value.length>0&&value.length<=160&&!/[\u0000-\u001f\u007f]/.test(value);

// v2 is only needed when explicit, verified host continuations changed a key.
// v1 cannot silently carry a field that an older normalizer would discard.
export function storyboardFloorTakeMessageKeys(value){
  if(!value||!text(value.messageKey))return null;
  if(value.version===1)return Object.hasOwn(value,'messageKeys')?null:[value.messageKey];
  if(value.version!==2||!Array.isArray(value.messageKeys)||value.messageKeys.length<2||value.messageKeys.length>33
    ||value.messageKeys[0]!==value.messageKey||value.messageKeys.some(key=>!text(key))||new Set(value.messageKeys).size!==value.messageKeys.length)return null;
  return [...value.messageKeys];
}

export function storyboardFloorTakeScopesOverlap(a,b){
  if(!a||!b||a.chatKey!==b.chatKey||a.swipeId!==b.swipeId)return false;
  const left=storyboardFloorTakeMessageKeys(a),right=storyboardFloorTakeMessageKeys(b);
  return Boolean(left&&right&&left.some(key=>right.includes(key)));
}
