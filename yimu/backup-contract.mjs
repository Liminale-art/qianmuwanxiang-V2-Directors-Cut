// Data-only portable format. A package is not authority to adopt an existing
// local file, activate a companion link, or replay another device's operations.
import {SCHEMA, createDocument, validateDocument, validateSettings, normalizeBinding, bindingKey, validateDiscardedSources} from './contract.mjs';
import {validateOrigin, validateLineage} from './story-contract.mjs';
import {validateStageSource} from './stage-contract.mjs';
import {validateExcerpt} from './recall-contract.mjs';
import {validateCompanion} from './companion-contract.mjs';
import {validatePlacement, normalizeEntryOrder, validateMemoryTitle} from './timeline.mjs';
import {validateScenes} from './scene-contract.mjs';

export const BACKUP_FORMAT = 'yimu-backup';
export const BACKUP_VERSION = 1;
export const BACKUP_MAX_SOURCES = 256;
const fail = message => {throw Object.assign(new Error(message), {code:'yimu_backup_validation',status:400,statusCode:400});};
const own = (value,key) => Object.hasOwn(value,key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const requireObject = value => {if(!object(value))fail('忆幕备份资料格式无效');return value;};
const integer = value => Number.isSafeInteger(value) && value >= 0;
const id = value => {if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(value))fail('忆幕备份标识无效');return value;};
const hash = value => {if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('忆幕备份来源指纹无效');return value;};
const prose = (value,max=100000) => {if(typeof value!=='string'||!value.trim()||value.length>max)fail('忆幕备份记忆正文无效或过长');return value;};
const kinds=new Set(['summary','manual','stage','excerpt']),statuses=new Set(['active','invalid','excluded','deleted']);
const safeSettings=new Set(['recent','trigger','batch','budget','preference','stageAuto','stageBasis','stageThreshold','stageRecent','sliceChars','stageChars','recall','prompts']);

function range(value) {
    requireObject(value);
    if(!integer(value.start)||value.start<1||!integer(value.end)||value.end<value.start||!Array.isArray(value.hashes)
        ||value.hashes.length!==value.end-value.start+1)fail('忆幕备份来源楼层无效');
    return {start:value.start,end:value.end,hashes:value.hashes.map(hash)};
}
function source(value) {
    if(value===null)return null;
    requireObject(value);
    return own(value,'ranges') ? validateStageSource(value) : range(value);
}
function origin(value) {return value===null?null:validateOrigin(requireObject(value));}
function initialRange(value) {
    if(value===null)return null;requireObject(value);
    if(!integer(value.start)||value.start<1||!integer(value.end)||!integer(value.total)||value.end>value.total
        ||value.end<value.start&&!(value.start===1&&value.end===0))fail('忆幕备份初始整理范围无效');
    return {start:value.start,end:value.end,total:value.total};
}
function fields(value) {
    requireObject(value);const result={};
    for(const key of ['id','revision','kind','title','text','source','status','edited','origin','parent','quote','placement','scenes','replacedBy','textUndoRevision','discarded','deletedRevision','discardedSources']) {
        if(!own(value,key))continue;const item=value[key];
        if(key==='id')result.id=id(item);
        else if(key==='revision'){if(!integer(item)||item<1)fail('忆幕备份版本无效');result.revision=item;}
        else if(key==='kind'){if(!kinds.has(item))fail('忆幕备份记忆类型无效');result.kind=item;}
        else if(key==='status'){if(!statuses.has(item))fail('忆幕备份状态无效');result.status=item;}
        else if(key==='edited'){if(typeof item!=='boolean')fail('忆幕备份修订状态无效');result.edited=item;}
        else if(key==='text')result.text=prose(item);
        else if(key==='title')result.title=validateMemoryTitle(item);
        else if(key==='discardedSources')result.discardedSources=validateDiscardedSources(item);
        else if(key==='discarded'){if(item!==true)fail('忆幕删除标记无效');result.discarded=true;}
        else if(key==='deletedRevision'){if(!integer(item)||item<1)fail('忆幕删除顺序无效');result.deletedRevision=item;}
        else if(key==='source')result.source=source(item);
        else if(key==='origin')result.origin=origin(item);
        else if(key==='placement')result.placement=validatePlacement(item);
        else if(key==='scenes')result.scenes=validateScenes(item);
        else if(key==='replacedBy')result.replacedBy=id(item);
        else if(key==='textUndoRevision'){if(!integer(item)||item<1)fail('忆幕文字撤回位置无效');result.textUndoRevision=item;}
        else if(key==='parent'){
            if(item===null){result.parent=null;continue;}requireObject(item);
            if(!integer(item.revision)||item.revision<1)fail('忆幕备份引证父版本无效');
            result.parent={id:id(item.id),revision:item.revision};
        } else if(key==='quote'){
            if(item===null){result.quote=null;continue;}requireObject(item);
            if(!integer(item.start)||!integer(item.end)||item.end<=item.start||item.end-item.start>1200)fail('忆幕备份引证位置无效');
            result.quote={start:item.start,end:item.end};
        }
    }
    return result;
}
function fullVersion(value) {
    const result=fields(value);
    if(!result.id||!result.revision||!kinds.has(result.kind)||!statuses.has(result.status)||typeof result.edited!=='boolean'||!result.text||!own(result,'source'))fail('忆幕备份历史或记忆条目不完整');
    if(result.kind==='manual'){if(result.source!==null)fail('自定义切片不能伪造原文来源');}
    else if(result.kind==='summary'){if(!result.source||own(result.source,'ranges'))fail('细摘要来源格式无效');}
    else if(result.kind==='stage')result.source=validateStageSource(result.source);
    else Object.assign(result,validateExcerpt(result));
    return result;
}
function candidate(value,current,conflict=false) {
    const result=fields(value);
    if(!result.id||!result.text)fail('忆幕备份待确认版本不完整');
    if(conflict&&own(value,'reason'))result.reason=prose(value.reason,12000);
    fullVersion({...current,...result});
    return result;
}
function entry(value) {
    const result=fullVersion(value);
    if(!Array.isArray(value.history)||!Array.isArray(value.conflicts))fail('忆幕备份修订记录不完整');
    result.history=value.history.map(fullVersion);
    if(result.history.some(version=>version.id!==result.id||version.revision>=result.revision))fail('忆幕备份历史版本归属不一致');
    result.conflicts=value.conflicts.map(item=>candidate(item,result,true));
    result.candidate=value.candidate==null?null:candidate(value.candidate,result);
    return result;
}
function companionArchive(value) {
    const values=[];
    if(value.archivedCompanion!=null){
        if(!Array.isArray(value.archivedCompanion))fail('忆幕备份伴读归档格式无效');
        values.push(...value.archivedCompanion);
    }
    if(value.companion!=null)values.push(value.companion);
    const result=[],seen=new Set();
    for(const item of values){const clean=validateCompanion(item),key=JSON.stringify(clean);if(!seen.has(key)){seen.add(key);result.push(clean);}}
    return result;
}

/** Whitelist all nested versions; never export arbitrary settings or receipts. */
export function portableDocument(value) {
    requireObject(value);
    if(!integer(value.schema)||value.schema<1||value.schema>SCHEMA)fail('不支持此忆幕资料版本，请先更新忆幕');
    if(typeof value.enabled!=='boolean'||!integer(value.revision)||!integer(value.epoch)||!integer(value.configRevision)||!Array.isArray(value.entries))fail('忆幕备份资料格式无效');
    requireObject(value.settings);
    const settings=validateSettings(Object.fromEntries(Object.entries(value.settings).filter(([key])=>safeSettings.has(key))));
    const result={schema:SCHEMA,revision:value.revision,epoch:value.epoch,configRevision:value.configRevision,
        binding:normalizeBinding(value.binding),enabled:value.enabled,autoSummary:value.schema<6?value.enabled:value.autoSummary,
        settings,initialRange:initialRange(value.initialRange),entries:value.entries.map(entry)};
    result.entryOrder=normalizeEntryOrder({...result,...(value.entryOrder!==undefined?{entryOrder:value.entryOrder}:{})});
    if(value.lineage!=null)result.lineage=validateLineage(value.lineage);
    const archived=companionArchive(value);if(archived.length)result.archivedCompanion=archived;
    // Validate cross-entry identity without retaining compatibility/runtime extras.
    validateDocument({...result,operations:[],receipts:{}});
    return result;
}

/** Deterministic IDs belong to this one package, never to a filesystem path. */
export function collectBackupSources(value) {
    const document=portableDocument(value),sources=[],seen=new Map();
    const add=(binding,resolved=false)=>{
        const normalized=normalizeBinding(binding),key=bindingKey(normalized);
        if(seen.has(key)){if(resolved)delete seen.get(key).unresolved;return;}
        if(sources.length>=BACKUP_MAX_SOURCES)fail('忆幕备份关联来源过多');
        const item={id:`source_${sources.length}`,binding:normalized,...(!resolved?{unresolved:true}:{})};sources.push(item);seen.set(key,item);
    };
    add(document.binding,true);if(document.lineage)add(document.lineage.sourceBinding,document.lineage.unresolved!==true);
    for(const item of document.entries.filter(item=>!item.discarded))for(const version of [item,...item.history,...item.conflicts,...(item.candidate?[item.candidate]:[])]) {
        if(version.origin)add(version.origin.binding,version.origin.unresolved!==true);
        if(version.placement)add(version.placement.binding,version.origin?.unresolved!==true);
    }
    return sources;
}

export function validateBackupHeader(value) {
    requireObject(value);
    if(value.format!==BACKUP_FORMAT||value.version!==BACKUP_VERSION)fail('不是支持的忆幕备份包');
    if(typeof value.createdAt!=='string'||value.createdAt.length>40||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.createdAt)||!Number.isFinite(Date.parse(value.createdAt))
        ||new Date(value.createdAt).toISOString()!==value.createdAt.replace(/Z$/,value.createdAt.includes('.')?'Z':'.000Z'))fail('忆幕备份时间无效');
    const document=portableDocument(value.document),expected=collectBackupSources(document);
    if(!Array.isArray(value.sources)||value.sources.length!==expected.length)fail('忆幕备份来源清单不完整');
    const seen=new Set();
    const sources=value.sources.map(item=>{
        requireObject(item);
        if(typeof item.id!=='string'||!/^source_\d+$/.test(item.id)||seen.has(item.id))fail('忆幕备份来源标识重复或无效');seen.add(item.id);
        const declared=expected.find(source=>source.id===item.id),binding=normalizeBinding(item.binding);
        if(!declared||bindingKey(binding)!==bindingKey(declared.binding))fail('忆幕备份来源归属与记忆不一致');
        if(typeof item.available!=='boolean'||typeof item.attached!=='boolean'||!integer(item.bytes)||!integer(item.floorCount)
            ||item.attached&&!item.available||item.available&&item.bytes<1||!item.available&&(item.bytes!==0||item.floorCount!==0))fail('忆幕备份来源大小或附带状态无效');
        const result={id:item.id,binding,available:item.available,attached:item.attached,bytes:item.bytes,floorCount:item.floorCount};
        for(const field of ['sha256','fingerprint'])if(item[field]!=null){if(!item.available)fail('不可用来源不能冒称已核验');result[field]=hash(item[field]);}
        if(item.available&&(!result.sha256||!result.fingerprint))fail('可用来源缺少完整字节和内容指纹');
        return result;
    });
    return {format:BACKUP_FORMAT,version:BACKUP_VERSION,packageId:id(value.packageId),createdAt:value.createdAt,document,
        sources:expected.map(source=>sources.find(item=>item.id===source.id))};
}

/** Only the store supplies mappings, after byte/fingerprint verification and
 * create-only writes or an explicitly confirmed existing-file match. */
export function restoreBackupDocument(value,{binding,mappings={}}={}) {
    const portable=portableDocument(value),sources=collectBackupSources(portable),target=normalizeBinding(binding);
    requireObject(mappings);
    if(!own(mappings,'source_0'))fail('未核实主聊天原件，资料仅保留为导入档案，不能建立聊天副本');
    const mapped=new Map(),used=new Set();
    for(const [id,value]of Object.entries(mappings)){
        const source=sources.find(source=>source.id===id);if(!source)fail('备份恢复映射包含未知来源');
        const next=normalizeBinding(value),key=bindingKey(next);
        if(used.has(key))fail('不同备份来源不能归入同一聊天');used.add(key);mapped.set(bindingKey(source.binding),next);
    }
    if(bindingKey(mappings.source_0)!==bindingKey(target))fail('备份主来源未映射到新聊天');
    const warnings=[],missing=sources.filter(source=>!mapped.has(bindingKey(source.binding)));
    for(const source of missing)warnings.push({code:'source_unresolved',sourceId:source.id,binding:source.binding});
    const restoreVersion=(version,current=null)=>{
        const result=structuredClone(version),effective=current?{...current,...version}:version;
        if(effective.placement){
            const resolved=mapped.get(bindingKey(effective.placement.binding));
            result.placement={...structuredClone(effective.placement),binding:resolved||normalizeBinding(effective.placement.binding)};
            if(!resolved){
                result.origin={binding:normalizeBinding(effective.placement.binding),offset:effective.origin?.offset||0,unresolved:true};
                if(!['deleted','excluded'].includes(effective.status))result.status='invalid';
            }
            else if(effective.origin){
                const resolvedOrigin=mapped.get(bindingKey(effective.origin.binding));
                result.origin={binding:resolvedOrigin||normalizeBinding(effective.origin.binding),offset:effective.origin.offset,...(!resolvedOrigin?{unresolved:true}:{})};
            }
        }
        if(!effective.source){
            if(effective.origin){
                const resolved=mapped.get(bindingKey(effective.origin.binding));
                result.origin={binding:resolved||normalizeBinding(effective.origin.binding),offset:effective.origin.offset,...(!resolved?{unresolved:true}:{})};
                if(!resolved&&!['deleted','excluded'].includes(effective.status))result.status='invalid';
            }
            return result;
        }
        const oldOrigin=effective.origin||{binding:portable.binding,offset:portable.lineage?.offset||0};
        const resolved=mapped.get(bindingKey(oldOrigin.binding));
        if(resolved){
            if(!effective.origin&&bindingKey(resolved)===bindingKey(target))delete result.origin;
            else result.origin={binding:resolved,offset:oldOrigin.offset};
        }else{
            result.origin={binding:normalizeBinding(oldOrigin.binding),offset:oldOrigin.offset,unresolved:true};
            // Preserve a user's deletion/exclusion; the unresolved marker also
            // prevents restoring/undoing it into an unverified source.
            if(!['deleted','excluded'].includes(effective.status))result.status='invalid';
        }
        return result;
    };
    const document=createDocument(target);
    document.settings=structuredClone(portable.settings);document.initialRange=structuredClone(portable.initialRange);
    if(portable.lineage){
        document.lineage=structuredClone(portable.lineage);const mappedSource=mapped.get(bindingKey(document.lineage.sourceBinding));
        if(mappedSource){document.lineage.sourceBinding=mappedSource;delete document.lineage.unresolved;}
        else document.lineage.unresolved=true;
    }
    document.entries=portable.entries.map(item=>{
        const result=restoreVersion(item);
        result.history=item.history.map(version=>restoreVersion(version));
        result.conflicts=item.conflicts.map(version=>restoreVersion(version,item));
        result.candidate=item.candidate?restoreVersion(item.candidate,item):null;
        return result;
    });
    document.entryOrder=[...portable.entryOrder];
    if(portable.archivedCompanion)document.archivedCompanion=structuredClone(portable.archivedCompanion);
    return {document:validateDocument(document),warnings};
}
