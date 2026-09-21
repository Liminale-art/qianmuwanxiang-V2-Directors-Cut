// Local development check only. Reads no chat, settings, API keys or browser.
// Private planning documents are never bundled, uploaded or printed here.
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

export const HANDOFF_DOCUMENTS=Object.freeze(['千幕V2开发总纲.md','千幕V2进度清单.md','千幕V2实测流程.md']);
export const HANDOFF_PRIVATE_FILES=Object.freeze([...HANDOFF_DOCUMENTS,'千幕V2视觉规范.md']);
const fail=code=>{throw Object.assign(Error(`Project handoff check failed: ${code}`),{code});};
const portable=value=>String(value).replaceAll('\\','/').toLowerCase();
function snapshot(text){
  const lines=text.replaceAll('**','').split(/\r?\n/),at=lines.findIndex(line=>/^## (?:0\. )?当前/.test(line));
  if(at<0)fail('snapshot_missing');const end=lines.findIndex((line,index)=>index>at&&/^#{2,3} /.test(line));return lines.slice(at+1,end<0?undefined:end);
}
function currentTableRow(text,unit){
  const lines=text.replaceAll('**','').split(/\r?\n/),at=lines.findIndex(line=>/^## (?:2\. )?R2.*单元表$/.test(line));
  if(at<0)fail('current_unit_missing_from_table');
  const end=lines.findIndex((line,index)=>index>at&&/^## /.test(line));
  const rows=lines.slice(at+1,end<0?undefined:end).filter(line=>new RegExp(`^\\| ${unit} \\|`).test(line));
  if(rows.length!==1)fail(rows.length?'current_unit_table_ambiguous':'current_unit_missing_from_table');
  return rows[0];
}
export function checkProjectHandoff({head,version,packageVersion,entryVersion,documents={},trackedPaths=[],releasePaths=[],requireDocuments=false}={}){
  if(!/^[a-f0-9]{40}$/.test(head||''))fail('head_invalid');
  if(!/^\d+\.\d+\.\d+$/.test(version||'')||version!==packageVersion||version!==entryVersion)fail('runtime_version_mismatch');
  for(const file of HANDOFF_PRIVATE_FILES){
    if(trackedPaths.some(value=>portable(value)===portable(file)))fail('private_document_tracked');
    if(releasePaths.some(value=>portable(value)===portable(file)))fail('private_document_released');
  }
  const present=HANDOFF_DOCUMENTS.filter(file=>typeof documents[file]==='string');
  if(!present.length&&!requireDocuments)return {status:'private-documents-unavailable',head,version,checkedDocuments:0};
  if(present.length!==HANDOFF_DOCUMENTS.length)fail('private_documents_incomplete');
  const units=[];
  for(const file of HANDOFF_DOCUMENTS){
    const lines=snapshot(documents[file]);
    const commits=lines.filter(line=>/^-\s*(分支与代码节点|当前提交|提交)：/.test(line));
    if(commits.length!==1)fail('current_commit_ambiguous');
    const commit=commits[0].match(/`([a-f0-9]{40})`/),release=commits[0].match(/\bv(\d+\.\d+\.\d+)\b/);
    if(commit?.[1]!==head)fail('document_commit_stale');if(release?.[1]!==version)fail('document_version_stale');
    const statuses=lines.filter(line=>/^-\s*当前状态：/.test(line));
    if(statuses.length>1)fail('current_status_ambiguous');
    for(const match of (statuses[0]||'').matchAll(/\bv(\d+\.\d+\.\d+)\b/g))if(match[1]!==version)fail('current_status_stale');
    const current=lines.filter(line=>/^-\s*当前单元：/.test(line));if(current.length!==1)fail('current_unit_ambiguous');
    const unit=current[0].match(/当前单元：\s*(R2-\d{2})(?![A-Za-z0-9_-])/)?.[1];if(!/^R2-(0\d|1[0-2])$/.test(unit||''))fail('current_unit_invalid');units.push(unit);
  }
  if(new Set(units).size!==1)fail('current_units_disagree');
  for(const file of HANDOFF_DOCUMENTS.slice(0,2)){
    const row=currentTableRow(documents[file],units[0]);
    if(!row.includes(`v${version}`)||!row.includes(head.slice(0,7)))fail('current_unit_table_stale');
  }
  return {status:'consistent',head,version,currentUnit:units[0],checkedDocuments:3,privateFilesExcluded:4};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const root=fileURLToPath(new URL('..',import.meta.url)),git=args=>execFileSync('git',['-c',`safe.directory=${root.replaceAll('\\','/')}`,'-c','core.quotepath=false',...args],{cwd:root,encoding:'utf8'}).trim();
    const read=file=>readFile(path.join(root,file),'utf8'),manifest=JSON.parse(await read('manifest.json')),pkg=JSON.parse(await read('package.json'));
    const entry=await read('index.js'),release=JSON.parse(await read('release-files.json')),documents={};
    for(const file of HANDOFF_DOCUMENTS)try{documents[file]=await read(file);}catch(error){if(error.code!=='ENOENT')throw error;}
    console.log(JSON.stringify(checkProjectHandoff({head:git(['rev-parse','HEAD']),version:manifest.version,packageVersion:pkg.version,
      entryVersion:entry.match(/const VERSION = '(\d+\.\d+\.\d+)'/)?.[1],documents,trackedPaths:git(['ls-files']).split('\n'),releasePaths:release.files,
      requireDocuments:process.argv.includes('--require-docs')})));
  }catch(error){console.error(JSON.stringify({status:'failed',code:error.code||'handoff_read_failed'}));process.exitCode=1;}
}
