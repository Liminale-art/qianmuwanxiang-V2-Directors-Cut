import {retainVibeAssetRef} from './qianmu-vibe-asset-ref.js';
import {captureStoryboardVibeRecipe} from './qianmu-vibe-recipe.js';

// Small supplied thumbnails only; no originals, paid encoding or generation while browsing the workbench.
export function mountVibeWorkbenchPreviews(root,{items,preview,isCurrent=()=>true}){
  let disposed=false,running=0,observer;const queue=[],urls=new Set(),nodes=[...root.querySelectorAll('[data-sd-vibe-asset]')].slice(0,16);
  const live=node=>!disposed&&isCurrent()&&root.isConnected&&node.isConnected;
  const pump=()=>{while(running<2&&queue.length&&!disposed){const node=queue.shift(),item=items.find(row=>row.id===node.dataset.sdVibeAsset);if(!live(node)||!item?.assetRef)continue;running++;
    void preview(item.assetRef).then(blob=>{if(!blob||!live(node))return;const url=URL.createObjectURL(blob);urls.add(url);const img=root.ownerDocument.createElement('img');
      img.src=url;img.alt='';img.decoding='async';img.addEventListener('error',()=>{img.remove();URL.revokeObjectURL(url);urls.delete(url);},{once:true});node.prepend(img);
    }).catch(error=>{if(live(node))node.title=error.message;}).finally(()=>{running--;pump();});
  }};
  if(typeof IntersectionObserver==='function'){observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);queue.push(entry.target);}pump();},{rootMargin:'120px'});nodes.forEach(node=>observer.observe(node));}
  else{queue.push(...nodes);pump();}
  return ()=>{disposed=true;observer?.disconnect();queue.length=0;for(const url of urls)URL.revokeObjectURL(url);urls.clear();};
}

// The caller owns the live account/page guards and publishes settings only after the entire operation succeeds.
export function createVibeLibraryAssets({state,namespace,call,guard,isCurrent,publish,uid,notify=()=>{}}){
  const ref=value=>{const result=retainVibeAssetRef(value);if(result.invalid||result.namespace!==namespace)throw Error('Vibe 资产不属于当前账户，请重新导入');return result;};
  const current=()=>{if(!isCurrent())throw Error('Vibe 页面已变化，未应用素材');};
  return Object.freeze({
    async import(file,active=()=>true){
      current();await guard();const original=JSON.stringify(state.vibeLibrary);
      const heads=await call('import',{namespace,file});await guard();current();
      if(!active()||JSON.stringify(state.vibeLibrary)!==original)throw Error('导入时页面或素材库已变化；文件已留存，未改变当前列表');
      const next=[...state.vibeLibrary],used=new Set(next.map(row=>row.id));let added=0;
      for(const head of heads){
        const assetRef=ref({version:1,namespace,id:head.assetId}),strength=head.defaults.strength,informationExtracted=head.defaults.information;
        if(next.some(row=>row.assetRef?.namespace===namespace&&row.assetRef.id===assetRef.id&&row.strength===strength&&row.informationExtracted===informationExtracted))continue;
        if(next.length>=500)throw Error('Vibe 库已满；文件已留存，未改变当前列表');
        const id=uid('shotvibe');if(typeof id!=='string'||!id||used.has(id))throw Error('无法创建独立 Vibe 编号');used.add(id);const at=Date.now();
        const item={id,name:head.summary.name,previewUrl:'',assetId:'',assetRef,strength,informationExtracted,providerIds:['novel'],modelIds:[],tags:[],notes:'',createdAt:at,updatedAt:at};
        captureStoryboardVibeRecipe([id],[item]);next.push(item);added++;
      }
      if(added){state.vibeLibrary=next;publish();}notify(added?`已导入 ${added} 项 Vibe`:'这些 Vibe 已在库中');return true;
    },
    async head(value){const asset=ref(value);await guard();const head=await call('head',{namespace,id:asset.id});await guard();return head;},
    async preview(value,{original=false}={}){const asset=ref(value);await guard();let blob=await call('preview',{namespace,id:asset.id});await guard();if(!blob&&original){blob=await call('original-preview',{namespace,id:asset.id});await guard();}return blob;},
    async validate(rows,model){
      await guard();for(const row of rows){if(!row.assetRef)continue;const asset=ref(row.assetRef);await call('check',{namespace,id:asset.id,model,information:row.informationExtracted});await guard();}return true;
    },
    async export(rows,{bundle=rows.length!==1}={}){
      if(!rows.length||rows.length>16||rows.some(row=>!row?.assetRef))throw Error('请选择 1～16 项已导入的 Vibe 文件导出');
      const original=JSON.stringify(rows),ids=rows.map(row=>ref(row.assetRef).id),settings=rows.map(row=>({name:row.name,strength:row.strength,information:row.informationExtracted}));
      await guard();const blob=await call('export',{namespace,ids,settings,bundle});await guard();current();
      if(rows.some(row=>JSON.stringify(state.vibeLibrary.find(item=>item.id===row.id))!==JSON.stringify(row))||JSON.stringify(rows)!==original)throw Error('Vibe 条目已变化，请重新导出');
      return blob;
    },
  });
}
