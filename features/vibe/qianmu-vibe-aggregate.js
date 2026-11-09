import {vibeDigest,vibeVariants,vibeFileError,exportNovelVibeFile,VIBE_FILE_LIMITS} from './qianmu-vibe-file.js';
const fail=message=>{throw vibeFileError('aggregate',message);};
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const same=(a,b)=>a===b||JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

// Inputs are complete assets validated by parseNovelVibeFile/store.load. Consume one at a time.
export function createVibeVariantAccumulator(base){
  if(base?.document?.type!=='image'||!hash(base.assetId))fail('全档汇总需要含原图文件；纯编码请原样备份');
  const original=base.document,document={...original,encodings:{}},files=new Set(),slots=new Map(),ordinary=new Map(),conflicts=[],differences=[];
  let duplicateCount=0,conflictCount=0,metadataDifferenceCount=0,variants=0,failed=null;
  const encoder=new TextEncoder();let contentBytes=encoder.encode(JSON.stringify(document)).byteLength+1024;
  const conflict=value=>{conflictCount++;if(conflicts.length<64)conflicts.push(value);};
  function consume(asset){
    const doc=asset?.document;if(!hash(asset?.assetId)||doc?.type!=='image'||doc.id!==original.id||doc.image!==original.image)fail('不能汇总不同原图或未验证的素材');
    if(files.has(asset.assetId))return;files.add(asset.assetId);
    const fields=['name','thumbnail','createdAt','importInfo'].filter(key=>!same(doc[key],original[key]));
    if(fields.length){metadataDifferenceCount++;if(differences.length<40)differences.push({assetId:asset.assetId,fields});}
    for(const item of vibeVariants(doc)){
      const {model,variant}=item,row=doc.encodings[model][variant],slot=JSON.stringify([model,variant]),old=slots.get(slot);
      if(old){if(old.row.encoding===row.encoding&&same(old.row.params,row.params))duplicateCount++;else conflict({kind:'slot',model,variant,information:item.information,first:old.assetId,second:asset.assetId});continue;}
      if(!document.encodings[model]){if(Object.keys(document.encodings).length>=VIBE_FILE_LIMITS.models)fail('汇总模型组超过 32 组，请保留原文件');document.encodings[model]={};}
      if(++variants>VIBE_FILE_LIMITS.variants)fail('汇总档位超过 256 项，请保留原文件');
      contentBytes+=encoder.encode(JSON.stringify(row)).byteLength+model.length+variant.length+16;
      if(contentBytes>VIBE_FILE_LIMITS.file)fail('汇总内容超过 64 MiB，请保留原文件并分批备份');
      slots.set(slot,{row,assetId:asset.assetId});document.encodings[model][variant]=row;
      if(!item.customParams&&item.information!==null){
        const semantic=JSON.stringify([model,item.information]),previous=ordinary.get(semantic);
        if(previous&&previous.row.encoding!==row.encoding)conflict({kind:'information',model,variant,information:item.information,first:previous.assetId,second:asset.assetId});
        else if(!previous)ordinary.set(semantic,{row,assetId:asset.assetId});
      }
    }
  }
  function add(asset){if(failed)throw failed;try{consume(asset);}catch(error){failed=error;throw error;}}
  add(base);
  return Object.freeze({add,report:()=>({baseId:base.assetId,sourceId:original.id,name:original.name||'Vibe',fileCount:files.size,variantCount:variants,
    variants:vibeVariants(document),duplicateCount,conflictCount,conflicts:structuredClone(conflicts),metadataDifferenceCount,metadataDifferences:structuredClone(differences)}),
    async file(){if(failed)throw failed;if(conflictCount)fail('存在不同编码或同档位冲突，未生成覆盖文件');return new Blob([await exportNovelVibeFile([document],{bundle:false})],{type:'application/json'});},
  });
}

export function createVibeAggregationOperations({store}){
  async function family(namespace,id){
    if(!account(namespace)||!hash(id))fail('同源汇总的账户或文件无效');const base=await store.head(namespace,id);
    if(!base||base.namespace!==namespace||base.summary.type!=='image')fail('请选一份当前账户含原图的文件；纯编码请原样备份');
    const heads=(await store.list(namespace)).filter(row=>row.summary.type==='image'&&row.summary.sourceId===base.summary.sourceId).sort((a,b)=>a.assetId.localeCompare(b.assetId));
    if(!heads.some(row=>row.assetId===id)||heads.some(row=>row.namespace!==namespace))fail('同源文件已变化或账户不符，请刷新');
    return {base,heads,fingerprint:await vibeDigest(JSON.stringify([namespace,id,heads]))};
  }
  async function verify(namespace,id,proof){if(!hash(proof))fail('缺少同源文件快照');const current=await family(namespace,id);if(current.fingerprint!==proof)fail('同源文件已变化，请重新汇总');return {verified:true};}
  return Object.freeze({verify,
    async prepare(namespace,id){
      const current=await family(namespace,id),base=await store.load(namespace,id);if(!base)fail('基准原文件已缺失，请先恢复原备份');
      const aggregate=createVibeVariantAccumulator(base);
      for(const head of current.heads){if(head.assetId===id)continue;const asset=await store.load(namespace,head.assetId);if(!asset)fail('同源原文件已缺失，未生成不完整汇总');aggregate.add(asset);}
      const report=aggregate.report(),file=report.conflictCount?null:await aggregate.file();await verify(namespace,id,current.fingerprint);
      return {namespace,id,fingerprint:current.fingerprint,report,file};
    },
  });
}
