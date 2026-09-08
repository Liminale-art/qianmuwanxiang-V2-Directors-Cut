import { parseStrictStoryboardJson } from './qianmu-storyboard-package-input.js';
import { collectStoryboardVibeDependencies } from './qianmu-storyboard-package-assets.js';
import { assertPortableConnection, assertPortableConnectionUrl } from './qianmu-storyboard-connection-identity.js';
import { vibeDigest } from './qianmu-vibe-file.js';

export const STORYBOARD_ORIGINS_SCHEMA = 'qianmu.storyboard.resource-origins.v1';
export const STORYBOARD_ORIGINS_LIMITS = Object.freeze({ rows: 100000, bytes: 32 * 1048576, page: 24 });
const kinds = ['image','vibe','workflow','connection','llm-profile','comfy-file','comfy-slot','workflow-review'];
const states = ['included','external','dynamic','unresolved','review'];
const families = new Set(['novel','banana','openai','seedream','comfy']);
const fileInputs = new Set(['ckpt_name','lora_name','vae_name','unet_name','clip_name','clip_name1','clip_name2','clip_name3','control_net_name','style_model_name','upscale_model','model_name','image','image_path','filename']);
// Unknown nodes can use the same names for outputs or service IDs. Do not label those as proven input files.
const nativeFiles = Object.freeze({CheckpointLoaderSimple:['ckpt_name'],CheckpointLoader:['ckpt_name','config_name'],LoraLoader:['lora_name'],LoraLoaderModelOnly:['lora_name'],
  VAELoader:['vae_name'],UNETLoader:['unet_name'],CLIPLoader:['clip_name'],DualCLIPLoader:['clip_name1','clip_name2'],TripleCLIPLoader:['clip_name1','clip_name2','clip_name3'],
  ControlNetLoader:['control_net_name'],DiffControlNetLoader:['control_net_name'],StyleModelLoader:['style_model_name'],UpscaleModelLoader:['model_name'],LoadImage:['image'],LoadImageMask:['image']});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value,max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const fail = message => { throw Object.assign(new Error(message), { code:'storyboard_resource_origins',submissionState:'not_submitted' }); };
const pointer = path => '$' + path.map(key => `[${JSON.stringify(key)}]`).join('');
const workflowKey = value => `${value.id}@${value.revision}/v${value.version}`;
const canonical = value => JSON.stringify(value,(_,row)=>object(row)?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);

// Drop large image/Vibe bodies after package validation; no clone of the full binary-bearing package survives this projection.
export async function projectStoryboardOriginPayload(payload, { guard = async()=>{} } = {}) {
  const media=[];
  for(const row of payload.media || []) {
    await guard(); const bytes=Uint8Array.from(atob(row.b64),c=>c.charCodeAt(0));
    media.push({id:row.id,sha256:await vibeDigest(bytes),bytes:bytes.length,mime:row.mime}); await guard();
  }
  return {type:payload.type,settings:payload.settings,chat:payload.chat,media,
    vibeAssets:(payload.vibeAssets||[]).map(row=>({id:row.id,sha256:row.id,bytes:row.bytes}))};
}

function validRow(row) {
  return object(row) && Object.keys(row).every(key=>['kind','state','at','label','target','owner','sha256','bytes'].includes(key))
    && kinds.includes(row.kind) && states.includes(row.state) && text(row.at,8192) && Boolean(row.at) && text(row.label,512) && text(row.target,4096)
    && (!Object.hasOwn(row,'owner')||text(row.owner,512)) && (!Object.hasOwn(row,'sha256')||hash(row.sha256))
    && (!Object.hasOwn(row,'bytes')||Number.isSafeInteger(row.bytes)&&row.bytes>=0);
}

// Derive declarations, not installation readiness. Never fetch a model, resolve arbitrary files, execute nodes or rewrite graphs.
// Inputs must already have passed the owning package/library validators.
export async function buildStoryboardResourceOrigins({ payload, workflows, pools, characters, originals = [], legacy = null }, { guard = async()=>{} } = {}) {
  const rows=[],seen=new Set(),originalMap=new Map(originals.map(row=>[row.url,row])),workflowIds=new Set(),presets=new Set();
  let nodes=0, rowBytes=0;
  const add = row => {
    if(!validRow(row))fail('文件用途清单包含过长或无法明确描述的来源，请保留原资料');
    const id=JSON.stringify([row.kind,row.at]);if(seen.has(id))fail('文件用途位置重复');seen.add(id);
    rowBytes+=new TextEncoder().encode(JSON.stringify(row)).byteLength+1;
    if(rows.length>=STORYBOARD_ORIGINS_LIMITS.rows||rowBytes>STORYBOARD_ORIGINS_LIMITS.bytes-2048)fail('文件用途清单超过支持容量，未裁剪来源');rows.push(row);
  };
  for(const row of workflows.workflows)for(const version of row.versions)workflowIds.add(workflowKey(version.meta));
  for(const [family,group] of Object.entries(payload.settings.connections||{}))for(const row of group.presets||[])presets.add(`${family}/${row.id}`);
  function original(row,at,label) {
    const receipt=originalMap.get(row.url),included=receipt&&receipt.sha256===row.sha256&&receipt.bytes===row.bytes&&receipt.mime===row.mime;
    add({kind:'image',state:included?'included':'external',at,label,target:included?receipt.url:'参考原件未随包收录',...(hash(row.sha256)?{sha256:row.sha256}:{}),...(Number.isSafeInteger(row.bytes)?{bytes:row.bytes}:{})});
  }
  function graph(value,at,owner='') {
    let parsed=value;
    if(typeof value==='string') {
      if(!value.trim())return;
      try { parsed=parseStrictStoryboardJson(value,{maxBytes:3*1048576}); } catch (_) { fail('已声明工作流原文无法完整读取，未生成不完整用途清单'); }
    }
    if(!object(parsed)||!Object.keys(parsed).length||!Object.values(parsed).every(row=>object(row)&&text(row.class_type,240)&&object(row.inputs))) {
      add({kind:'workflow-review',state:'review',at,label:'工作流结构需人工核对',target:'未把未知结构当作已检查的节点',...(owner?{owner}:{})});return;
    }
    add({kind:'workflow-review',state:'review',at,label:'工作流运行环境',target:'核对所需节点插件及间接文件；文件名清单不验证 Comfy 实际就绪',...(owner?{owner}:{})});
    for(const [id,node] of Object.entries(parsed)) {
      assertPortableConnection(node.inputs);
      for(const [input,value] of Object.entries(node.inputs)) {
        const native=Object.hasOwn(nativeFiles,node.class_type)&&nativeFiles[node.class_type].includes(input);
        if(!(native||fileInputs.has(input))||typeof value!=='string'||!value)continue;
        if(/^https?:\/\//i.test(value))assertPortableConnectionUrl(value);
        const slot=/%qianmu_[^%]+%/.test(value),dynamic=node.class_type==='LoadImage'&&input==='image'&&/^%qianmu_reference_(?:[1-9]|1[0-6])%$/.test(value),url=/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
        add({kind:slot?'comfy-slot':'comfy-file',state:dynamic?'dynamic':native&&!slot?'external':'review',at:`${at}::${pointer([id,'inputs',input])}`,
          label:`${node.class_type} · ${input}`,target:url?'外部地址，见工作流原文':value,...(owner?{owner}:{})});
      }
    }
  }
  function visit(value,section,path=[],family='',owner='') {
    if(++nodes>500000||path.length>40)fail('文件用途扫描范围过大，未裁剪来源');
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){value.forEach((row,i)=>visit(row,section,[...path,i],family,owner));return;}
    // A selected top-level provider is not evidence of the provider used by every historical record.
    const current=path.length===0||section==='storyboard'&&path.length===1?family:families.has(value.providerId)?value.providerId:families.has(value.source)?value.source:family;
    const at=key=>`${section}${pointer([...path,key])}`;
    for(const [key,item] of Object.entries(value)) {
      if(item==null)continue;
      if(key==='workflow'&&(typeof item==='string'||object(item)&&!item.id)) { graph(item,at(key),owner);continue; }
      if(key==='comfyWorkflowBinding'&&object(item))add({kind:'workflow',state:workflowIds.has(workflowKey(item))?'included':'unresolved',at:at(key),label:'固定工作流引用',target:workflowKey(item)});
      if(key==='connection'&&object(item)&&(item.id||item.baseUrl))add({kind:'connection',state:'included',at:at(key),label:'连接快照（仅配置，不含授权）',target:item.id?`${current||'未声明渠道'}/${item.id}`:'独立连接快照'});
      if(key==='connectionPresetId'&&typeof item==='string'&&item) {
        const llm=path.includes('promptCompiler'),target=current?`${current}/${item}`:item;
        add({kind:llm?'llm-profile':'connection',state:llm?'external':current&&presets.has(target)?'included':'unresolved',at:at(key),label:llm?'取词连接引用（不含 ST 档案/授权）':'生图预设引用（不含授权）',target});
      }
      if(key==='apiProfileId'&&typeof item==='string'&&item)add({kind:'llm-profile',state:'external',at:at(key),label:'ST 取词 API 档案（需单独保全）',target:item});
      if(key==='comfyReferences'&&object(item))for(const [i,row] of (item.items||[]).entries())original(row,`${section}${pointer([...path,key,'items',i])}`,'Comfy 参考原件');
      if(key==='loraName'&&typeof item==='string'&&item&&value.nodeId&&value.classType)add({kind:'comfy-file',state:'external',at:at(key),label:'角色实现 LoRA',target:item,...(owner?{owner}:{})});
      if(['reference','preview'].includes(key)&&object(item)&&item.url&&item.sha256)original(item,at(key),'角色参考／封面原件');
      if(['referenceUrl','previewUrl'].includes(key)&&typeof item==='string'&&item) {
        const receipt=originalMap.get(item);add({kind:'image',state:receipt?'included':'external',at:at(key),label:'图片地址引用',target:receipt?receipt.url:'地址原件未随包收录',...(receipt?{sha256:receipt.sha256,bytes:receipt.bytes}:{})});
      }
      if(key==='profiles'||key==='modelProfiles') {for(const [source,row] of Object.entries(item))visit(row,section,[...path,key,source],families.has(source)?source:'',owner);continue;}
      visit(item,section,[...path,key],current,owner);
    }
  }
  visit(payload.settings,'storyboard',['settings']);visit(payload.chat,'storyboard',['chat']);
  // Every immutable pool/workflow revision is inventoried, including archived or currently unused versions.
  for(const [i,row] of pools.pools.entries())for(const [j,version] of row.versions.entries()) {visit(version.pool,'pools',['pools',i,'versions',j,'pool'],'',workflowKey(version.meta));await guard();}
  for(const [i,row] of characters.archives.entries()) {
    const base=['archives',i,'document'];visit(row.document,'characters',base,'',workflowKey(row.head));
    for(const [j,impl] of (row.document.comfy?.implementations||[]).entries())add({kind:'workflow',state:workflowIds.has(workflowKey(impl.workflow))?'included':'unresolved',at:`characters${pointer([...base,'comfy','implementations',j,'workflow'])}`,label:'角色实现固定工作流',target:workflowKey(impl.workflow)});
    await guard();
  }
  for(const [i,row] of workflows.workflows.entries())for(const [j,version] of row.versions.entries()) {graph(version.document.workflow,`workflows${pointer(['workflows',i,'versions',j,'document','workflow'])}`,workflowKey(version.meta));await guard();}
  const media=new Map(payload.media.map(row=>[row.id,row]));
  for(const [i,row] of (payload.chat.images||[]).entries()) {const receipt=media.get(row.id);if(!receipt)fail('成片原件摘要缺失');add({kind:'image',state:'included',at:`storyboard${pointer(['chat','images',i,'url'])}`,label:'阅片室成片原件',target:row.id,sha256:receipt.sha256,bytes:receipt.bytes});}
  const census=collectStoryboardVibeDependencies(payload),assets=new Map(payload.vibeAssets.map(row=>[row.id,row])),legacyRows=new Map((legacy?.items||[]).map(row=>[row.url,row.receipt]));
  for(const ref of census.refs) {const asset=assets.get(ref.id);if(!asset)fail('Vibe 原文件摘要缺失');for(const at of ref.uses)add({kind:'vibe',state:'included',at:`storyboard${at}`,label:'NAI Vibe 原文件',target:ref.id,sha256:asset.sha256,bytes:asset.bytes});}
  for(const ref of census.legacyUrls)for(const at of ref.uses) {const receipt=legacyRows.get(ref.url);add({kind:'vibe',state:receipt?'included':'external',at:`storyboard${at}`,label:'旧 Vibe 地址原图',target:receipt?receipt.url:'原图未随包收录',...(receipt?{sha256:receipt.sha256,bytes:receipt.bytes}:{})});}
  rows.sort((a,b)=>a.at<b.at?-1:a.at>b.at?1:a.kind<b.kind?-1:a.kind>b.kind?1:0);
  const body={schema:STORYBOARD_ORIGINS_SCHEMA,scope:'declared-package-uses',rows};
  await guard();return {...body,digest:await vibeDigest(canonical(body))};
}

export async function inspectStoryboardResourceOrigins(value, expected) {
  if(!object(value)||Object.keys(value).some(key=>!['schema','scope','rows','digest'].includes(key))||value.schema!==STORYBOARD_ORIGINS_SCHEMA||value.scope!=='declared-package-uses'
    ||!Array.isArray(value.rows)||value.rows.length>STORYBOARD_ORIGINS_LIMITS.rows||!value.rows.every(validRow)||!hash(value.digest)
    ||new Blob([JSON.stringify(value)]).size>STORYBOARD_ORIGINS_LIMITS.bytes)fail('文件用途清单格式或容量无效');
  if(value.digest!==await vibeDigest(canonical({schema:value.schema,scope:value.scope,rows:value.rows}))||expected.digest!==value.digest)fail('文件用途清单与原包资料不符，未相信清单自报完整');
  return value;
}

export function storyboardResourceOriginsSummary(document, recorded) {
  const result={recorded:Boolean(recorded),digest:document.digest,total:document.rows.length,...Object.fromEntries(states.map(key=>[key,0]))};
  for(const row of document.rows)result[row.state]++;return result;
}
export function validStoryboardResourceOriginsSummary(value) {
  return object(value)&&Object.keys(value).every(key=>['recorded','digest','total',...states].includes(key))&&typeof value.recorded==='boolean'&&hash(value.digest)
    &&['total',...states].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0&&value[key]<=STORYBOARD_ORIGINS_LIMITS.rows)
    &&value.total===states.reduce((sum,key)=>sum+value[key],0);
}
export function storyboardResourceOriginsPage(document, options = {}) {
  if(!object(options)||Object.keys(options).some(key=>!['offset','filter'].includes(key)))fail('文件用途分页参数无效');
  const {offset=0,filter='all'}=options;
  if(!Number.isSafeInteger(offset)||offset<0||offset%24||!['all',...states].includes(filter))fail('文件用途页码或分类无效');
  const filtered=filter==='all'?document.rows:document.rows.filter(row=>row.state===filter);
  if(offset>0&&offset>=filtered.length)fail('文件用途页码超出范围');
  return {digest:document.digest,offset,filter,total:filtered.length,rows:filtered.slice(offset,offset+24)};
}
export function validStoryboardResourceOriginsPage(value) {
  return object(value)&&Object.keys(value).every(key=>['digest','offset','filter','total','rows','sourceDigest'].includes(key))&&hash(value.digest)
    &&Number.isSafeInteger(value.offset)&&value.offset>=0&&value.offset%24===0&&Number.isSafeInteger(value.total)&&value.total>=0&&value.total<=STORYBOARD_ORIGINS_LIMITS.rows
    &&['all',...states].includes(value.filter)&&Array.isArray(value.rows)&&value.rows.length===Math.min(24,Math.max(0,value.total-value.offset))&&value.rows.every(validRow)
    &&(value.offset===0||value.offset<value.total);
}
