import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {isQianmuOwnedDockDescriptor,QIANMU_DETACHED_OWNED_SELECTOR} from '../qianmu-hive-ownership.js';
import {storyboardFunctionSource} from './helpers/storyboard-form-fixture.mjs';
test('only proven Qianmu floating aliases are removed; external plugins keep their records',()=>{
 for(const selector of ['div.qm-prose-hive-layer','button[aria-label="打开正文助手"]','button[title="场外特助（拖回千幕归巢）"]','button.sd-detached-notes-entry.is-glass-dark'])assert.equal(isQianmuOwnedDockDescriptor({selector}),true);
 for(const item of [{selector:'#plugin-123',label:'场外特助'},{selector:'button[title="助手"]'},null])assert.equal(isQianmuOwnedDockDescriptor(item),false);
 assert.equal(isQianmuOwnedDockDescriptor({shadowPath:['.qm-prose-hive-layer','button']}),true);
});
test('document capture rejects own floating entry before looking for an external dock target',()=>{
 class Element{closest(selector){assert.equal(selector,QIANMU_DETACHED_OWNED_SELECTOR);return this;}}
 const node=new Element(),context=vm.createContext({Element,QIANMU_DETACHED_OWNED_SELECTOR,isQianmuOwnedDockDescriptor});
 vm.runInContext(storyboardFunctionSource('quickDockCandidate')+'\n'+storyboardFunctionSource('quickDockAttach'),context);
 assert.equal(context.quickDockCandidate({composedPath:()=>[node]}),null);
 node.isConnected=true;assert.equal(context.quickDockAttach(node,node),false);
});
