import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWorldSourceIndex} from '../qianmu-world-source.js';
import {WORLD_AUTOMATIC_APPROVAL_SCHEMA as schema,normalizeWorldAutomaticApproval as normalize,worldAutomaticApprovalMatches as matches} from '../qianmu-world-automatic-approval.js';
import {normalizeQianmuProductionPacket} from '../qianmu-production-packet.js';
import {adaptProductionPacketToNarrativeLedgerEntry} from '../qianmu-narrative-ledger.js';
import {scoreNarrativeDirectorCandidate} from '../qianmu-director-candidate.js';
import {createAutomaticWorldDirectorDecision as automatic,createDirectorDecision as manual,canConsumeDirectorDecision as consume,
  normalizeDirectorDecision,revokeDirectorDecision,validateDirectorDecision} from '../qianmu-director-decision.js';
import {createDirectorWorkOrder,canConsumeDirectorWorkOrder,normalizeDirectorWorkOrder,directorWorkOrderToStoryboardShot} from '../qianmu-director-work-order.js';
import {normalizeStoryboardShotSpec,storyboardDirectorDecisionSnapshot,storyboardProductionDeliveryPolicy} from '../qianmu-storyboard.js';

async function fixture() {
  const plan={npc_updates:[{name:'Alice',action:'reads a letter'}]},chatKey='chat-a';
  const index=await buildWorldSourceIndex(plan,{chatKey,revisionId:'plan-1'}),source=index.entries[0].source;
  const packet=normalizeQianmuProductionPacket({packetId:'packet-a',eventId:'event-a',timelineAnchor:{chatKey,floor:7},
    sourceRef:{field:'npc_updates',index:0,worldSource:source},characterState:[{id:'alice',name:'Alice'}],
    visualIntent:{subject:'the letter',description:'Alice reads a letter',evidenceRefs:['world-plan-1']},
    audioIntent:{dialogue:['Alice: keep out'],ambience:['rain']},perceivedConsequence:{summary:'private caption'}});
  const ledgerEntry=adaptProductionPacketToNarrativeLedgerEntry(packet),candidate=scoreNarrativeDirectorCandidate(ledgerEntry,{chatKey,viewerId:'user'});
  const approval={schema,namespace:'st-user:test',requestId:'wa-'+'a'.repeat(32),source};
  return {packet,ledgerEntry,candidate,approval,options:{chatKey,namespace:approval.namespace,ledgerEntry,ledgerEntryId:ledgerEntry.entryId,
    worldAutoEnabled:true,worldAutomation:approval,approvedAt:100,outputs:{storyboard:true}}};
}

test('world setting approval is distinct from a per-picture confirmation and preserves director-only provenance',async()=>{
  const f=await fixture(),before=structuredClone(f),result=automatic(f.candidate,f.packet,f.options);assert.equal(result.ok,true,result.issues.join(','));
  assert.equal(f.candidate.recommendation,'manual_review');assert.equal(f.candidate.gates.spoilerSafe,false);
  assert.equal(result.decision.approval.mode,'world_setting');assert.equal(result.decision.decisionId,'decision-'+f.approval.requestId);
  assert.equal(result.decision.truthMode,'speculative');assert.equal(consume(result.decision,'storyboard','chat-a'),true);
  assert.deepEqual(result.decision.lanes.dialogue,[]);assert.deepEqual(result.decision.lanes.ambience,[]);assert.equal(result.decision.lanes.caption,'');
  assert.deepEqual(f,before);assert.equal(manual(f.candidate,f.packet,f.options).ok,false,'manual entry must not silently reinterpret settings as a click');
});

test('all non-boolean opt-ins fail without creating an approved decision or coercing legacy values',async()=>{
  const f=await fixture();for(const worldAutoEnabled of [undefined,null,false,0,1,'true','false',{},[]]){
    const result=automatic(f.candidate,f.packet,{...f.options,worldAutoEnabled});assert.equal(result.ok,false);assert.equal(result.decision,null);
  }
  assert.equal(automatic(f.candidate,f.packet,{...f.options,explicitApproval:true}).ok,false);
});

test('world automation cannot widen its consumer scope to voice, subtitle or film',async()=>{
  const f=await fixture();for(const output of ['voice','subtitle','film']){
    const invalid=automatic(f.candidate,f.packet,{...f.options,outputs:{storyboard:true,[output]:true}});assert.equal(invalid.ok,false);assert.equal(invalid.decision,null);
    const {decision}=automatic(f.candidate,f.packet,f.options);assert.equal(consume(decision,output,'chat-a'),false);
    assert.equal(createDirectorWorkOrder(decision,output,'chat-a').ok,false);
    decision.outputs[output]=true;assert.equal(validateDirectorDecision(decision).ok,false);assert.equal(consume(decision,'storyboard','chat-a'),false);
  }
});

test('approval requires exact account and world source identity, not a floor number or matching character name',async()=>{
  const f=await fixture();for(const patch of [{namespace:'st-user:other'},{namespace:undefined},{chatKey:'chat-b'},
    {worldAutomation:{...f.approval,source:{...f.approval.source,chatKey:'chat-b'}}},
    {worldAutomation:{...f.approval,source:{...f.approval.source,revisionId:'wrev-'+'b'.repeat(64)}}},
    {worldAutomation:{...f.approval,source:{...f.approval.source,itemId:'witem-'+'b'.repeat(64)}}},
    {worldAutomation:{...f.approval,source:{...f.approval.source,field:'world_updates'}}}]){
    const result=automatic(f.candidate,f.packet,{...f.options,...patch});assert.equal(result.ok,false);assert.equal(result.decision,null);
  }
});

test('automatic source pairing never uses the legacy missing-ledger escape hatch',async()=>{
  const f=await fixture(),missing={...f.options};delete missing.ledgerEntry;
  for(const options of [missing,{...f.options,ledgerEntry:null},{...f.options,ledgerEntry:{}},
    {...f.options,ledgerEntry:{...f.ledgerEntry,continuity:{state:'invalidated',invalidatedBy:['edit']}}}]){
    assert.equal(automatic(f.candidate,f.packet,options).ok,false);
  }
});

test('rejected, inconsistent, non-world or mismatched material is still rejected despite the automatic setting',async()=>{
  const f=await fixture();for(const patch of [{recommendation:'reject'},{sourceKind:'prose'},{candidateId:'other'},
    {gates:{...f.candidate.gates,sourceValid:false}},{gates:{...f.candidate.gates,factConsistency:false}},{gates:{...f.candidate.gates,shotDistinct:false}}]){
    assert.equal(automatic({...f.candidate,...patch},f.packet,f.options).ok,false);
  }
  const altered=structuredClone(f.packet);altered.visualIntent.description='A different event';assert.equal(automatic(f.candidate,altered,f.options).ok,false);
  const missing=structuredClone(f.packet);delete missing.sourceRef.worldSource;assert.equal(automatic(f.candidate,missing,f.options).ok,false);
});

test('receipt normalization is bounded and rejects unknown formats, added data and unusable identities',async()=>{
  const f=await fixture();assert.deepEqual(normalize(f.approval),f.approval);assert.equal(matches(f.approval,f.approval.source,'chat-a'),true);
  for(const patch of [{schema:'future'},{apiKey:'secret'},{namespace:''},{namespace:'st-user: '},{namespace:'st-user:'+'x'.repeat(161)},
    {namespace:'st-user:x\ny'},{requestId:''},{requestId:'wa-nope'},{source:{}},{source:null}])assert.equal(normalize({...f.approval,...patch}),null);
  assert.equal(matches(f.approval,f.approval.source,'chat-b'),false);
});

test('normalization preserves invalid approval markers rather than silently downgrading them to a manual confirmation',async()=>{
  const f=await fixture(),{decision}=automatic(f.candidate,f.packet,f.options);
  for(const patch of [{worldAutomation:null},{worldAutomation:{...f.approval,schema:'future'}},{mode:'explicit'},{mode:'unknown'}]){
    const raw={...decision,approval:{...decision.approval,...patch}},normalized=normalizeDirectorDecision(raw);
    assert.equal(validateDirectorDecision(normalized).ok,false);
    const shot=normalizeStoryboardShotSpec({directorDecision:raw});assert.equal(consume(storyboardDirectorDecisionSnapshot(shot),'storyboard','chat-a'),false);
  }
});

test('revocation closes the setting-approved decision without losing its receipt',async()=>{
  const f=await fixture(),{decision}=automatic(f.candidate,f.packet,f.options),revoked=revokeDirectorDecision(decision,200);
  assert.equal(validateDirectorDecision(revoked).ok,true);assert.deepEqual(revoked.approval.worldAutomation,f.approval);
  assert.equal(consume(revoked,'storyboard','chat-a'),false);assert.equal(createDirectorWorkOrder(revoked,'storyboard','chat-a').ok,false);
});

test('the work order and normalized saved shot retain the same approval while delivery stays gallery-only',async()=>{
  const f=await fixture(),{decision}=automatic(f.candidate,f.packet,f.options),result=createDirectorWorkOrder(decision,'storyboard','chat-a',{createdAt:200});
  assert.equal(result.ok,true,result.issues.join(','));assert.deepEqual(result.workOrder.source.worldAutomation,f.approval);
  assert.equal(canConsumeDirectorWorkOrder(normalizeDirectorWorkOrder(result.workOrder),'storyboard','chat-a'),true);
  const shot=normalizeStoryboardShotSpec({...directorWorkOrderToStoryboardShot(result.workOrder,'chat-a'),directorDecision:decision});
  assert.deepEqual(storyboardDirectorDecisionSnapshot(shot).approval,decision.approval);assert.equal(shot.narrativeLayer,'imagined');
  assert.equal(storyboardProductionDeliveryPolicy(shot,{target:'latest',inlineByDefault:true}).target,'gallery');
  for(const patch of [{consumer:'film'},{truthMode:'canon'},{source:{...result.workOrder.source,worldAutomation:null}}]){
    assert.equal(canConsumeDirectorWorkOrder({...result.workOrder,...patch},'storyboard','chat-a'),false);
  }
});

test('unsupported future decision schema is not converted into an executable approval by saved-shot normalization',async()=>{
  const f=await fixture(),{decision}=automatic(f.candidate,f.packet,f.options);
  for(const value of [decision,{...decision,approval:{mode:'explicit',approvedAt:100,revision:1}}]){
    const shot=normalizeStoryboardShotSpec({directorDecision:{...value,schema:'qianmu.director-decision.v999'}});
    assert.equal(consume(storyboardDirectorDecisionSnapshot(shot),'storyboard','chat-a'),false);
  }
});
