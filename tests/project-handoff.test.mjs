import test from 'node:test';
import assert from 'node:assert/strict';
import {checkProjectHandoff as check,HANDOFF_DOCUMENTS as names,HANDOFF_PRIVATE_FILES as privateFiles} from '../scripts/check-project-handoff.mjs';
const head='a'.repeat(40),version='1.2.3';
function fixture(){return {head,version,packageVersion:version,entryVersion:version,documents:Object.fromEntries(names.map((name,index)=>[name,
  `# Private fixture\n\n## ${index===0?'0. 当前有效快照':'当前状态'}\n\n- **${index===0?'分支与代码节点':index===1?'当前提交':'提交'}**：\`${head}\` / v${version}\n- **当前单元**：R2-04 Development\n- 当前状态：latest v${version}\n\n## ${index===0?'2. R2-XXX 统一单元表':'R2 单元表'}\n\n| R2-04 | Development ${head.slice(0,7)} / v${version} |\n\n## Historical\n\n- 提交：\`${'b'.repeat(40)}\` / v0.0.1\n- 当前单元：R2-01 Old\n\n| R2-04 | Historical |\n`]))};}

test('handoff compares only the current snapshot and does not misread historical commits or the visual baseline',()=>{
  const input=fixture();input.documents[privateFiles[3]]='Visual baseline v0.0.1';const result=check(input);
  assert.equal(result.status,'consistent');assert.equal(result.currentUnit,'R2-04');assert.equal(result.checkedDocuments,3);assert.equal(result.privateFilesExcluded,4);
});
test('a public checkout without private planning documents reports unavailable instead of inventing progress',()=>{
  const input=fixture();input.documents={};assert.equal(check(input).status,'private-documents-unavailable');assert.throws(()=>check({...input,requireDocuments:true}),{code:'private_documents_incomplete'});
});
test('partially missing private documents fail and never silently approve an incomplete handoff',()=>{
  const input=fixture();delete input.documents[names[1]];assert.throws(()=>check(input),{code:'private_documents_incomplete'});
});
test('runtime version drift, stale documentation commits and stale documentation versions are detected separately',()=>{
  assert.throws(()=>check({...fixture(),packageVersion:'1.2.4'}),{code:'runtime_version_mismatch'});
  const stale=fixture();stale.documents[names[0]]=stale.documents[names[0]].replace(head,'c'.repeat(40));assert.throws(()=>check(stale),{code:'document_commit_stale'});
  const versioned=fixture();versioned.documents[names[2]]=versioned.documents[names[2]].replace('v1.2.3','v1.2.2');assert.throws(()=>check(versioned),{code:'document_version_stale'});
});
test('current units must be one R2-00 to R2-12 unit, agree across documents and appear in the progress table',()=>{
  for(const value of ['R2-13','R2-99','R2-041','R2-04A','R2-04-1','R2-04_1','B3','R1-04']){const f=fixture();f.documents[names[0]]=f.documents[names[0]].replace('R2-04 Development',`${value} Development`);assert.throws(()=>check(f),{code:'current_unit_invalid'});}
  const mixed=fixture();mixed.documents[names[2]]=mixed.documents[names[2]].replace('R2-04 Development','R2-05 Development');assert.throws(()=>check(mixed),{code:'current_units_disagree'});
  const absent=fixture();absent.documents[names[1]]=absent.documents[names[1]].replace('| R2-04 |','| R2-05 |');assert.throws(()=>check(absent),{code:'current_unit_missing_from_table'});
});
test('duplicate current commit or current unit declarations are rejected instead of choosing an arbitrary match',()=>{
  const f=fixture();f.documents[names[1]]=f.documents[names[1]].replace('## R2 单元表',`- 当前提交：\`${head}\` / v${version}\n\n## R2 单元表`);assert.throws(()=>check(f),{code:'current_commit_ambiguous'});
  const g=fixture();g.documents[names[1]]=g.documents[names[1]].replace('## R2 单元表','- 当前单元：R2-04 second\n\n## R2 单元表');assert.throws(()=>check(g),{code:'current_unit_ambiguous'});
});
test('private planning or visual documents cannot become tracked or released, independent of snapshot availability',()=>{
  for(const file of privateFiles){assert.throws(()=>check({...fixture(),trackedPaths:[file]}),{code:'private_document_tracked'});assert.throws(()=>check({...fixture(),releasePaths:[file]}),{code:'private_document_released'});}
});
test('invalid heads and missing snapshot sections fail with codes without printing private contents',()=>{
  assert.throws(()=>check({...fixture(),head:'short'}),{code:'head_invalid'});const input=fixture();input.documents[names[2]]='PRIVATE_SECRET_BODY';
  assert.throws(()=>check(input),error=>error.code==='snapshot_missing'&&!error.message.includes('PRIVATE_SECRET_BODY'));
});

test('a stale current status is rejected even when the commit and release fields are current',()=>{
  const f=fixture();f.documents[names[1]]=f.documents[names[1]].replace('latest v1.2.3','latest v1.2.2');assert.throws(()=>check(f),{code:'current_status_stale'});
});
test('both current unit tables carry the current release and node; historical rows do not repair a stale current row',()=>{
  for(const name of names.slice(0,2))for(const previous of ['aaaaaaa / v1.2.2','bbbbbbb / v1.2.3']){
    const f=fixture();f.documents[name]=f.documents[name].replace('aaaaaaa / v1.2.3',previous);assert.throws(()=>check(f),{code:'current_unit_table_stale'});
  }
});
test('a missing or duplicated current row is not satisfied by the matching unit in historical logs',()=>{
  const f=fixture();f.documents[names[1]]=f.documents[names[1]].replace('| R2-04 | Development','| R2-05 | Development');assert.throws(()=>check(f),{code:'current_unit_missing_from_table'});
  const g=fixture();g.documents[names[0]]=g.documents[names[0]].replace('## Historical','| R2-04 | Duplicate |\n\n## Historical');assert.throws(()=>check(g),{code:'current_unit_table_ambiguous'});
});

test('the master introduction banner cannot retain an old version while its snapshot is current',()=>{
  const f=fixture();f.documents[names[0]]=f.documents[names[0]].replace('# Private fixture','# Private fixture\n\n> 状态：**latest v1.2.2**');
  assert.throws(()=>check(f),{code:'current_banner_stale'});f.documents[names[0]]=f.documents[names[0]].replace('v1.2.2','v1.2.3');assert.equal(check(f).status,'consistent');
});
test('ambiguous introduction status banners fail while historical block quotes remain historical',()=>{
  const f=fixture();f.documents[names[0]]=f.documents[names[0]].replace('# Private fixture','# Private fixture\n\n> 状态：v1.2.3\n> 状态：v1.2.3');
  assert.throws(()=>check(f),{code:'current_banner_ambiguous'});const g=fixture();g.documents[names[0]]+='\n> 状态：v1.1.1';assert.equal(check(g).status,'consistent');
});
test('unit table versions and commit identifiers match complete tokens, not longer prefix collisions',()=>{
  for(const patch of ['aaaaaaa / v1.2.30','aaaaaaa0 / v1.2.3']){const f=fixture();f.documents[names[0]]=f.documents[names[0]].replace('aaaaaaa / v1.2.3',patch);
    assert.throws(()=>check(f),{code:'current_unit_table_stale'});}
});
