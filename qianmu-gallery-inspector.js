// Capture values, not a mutable array. Detached/closed/replaced views fail closed.
export function captureGalleryViewGuard(root, {scope,isActive}) {
  let captured;try {captured=[...scope()];} catch {return ()=>false;}
  return node=>{
    try {const live=scope();return Boolean(root.isConnected&&node?.isConnected&&root.contains(node)&&isActive()
      &&live.length===captured.length&&captured.every((value,index)=>Object.is(value,live[index])));} catch {return false;}
  };
}
