import test from 'node:test';
import assert from 'node:assert/strict';
import {renderProseAssistantMarkdown} from '../qianmu-prose-assistant-markdown.js';
import {textCollectionDom} from './helpers/text-collection-dom.mjs';

function fixture({hrefs=[]}={}){
 const {doc,parent}=textCollectionDom(),fragment=doc.createElement('fragment'),calls=[];
 fragment.nodeType=11;
 const links=hrefs.map(href=>{const link=doc.createElement('a');link.textContent='link';if(href!==null)link.setAttribute('href',href);fragment.append(link);return link;});
 const libs={showdown:{Converter:class{
  constructor(options){calls.push({type:'converter',options});}
  makeHtml(raw){calls.push({type:'convert',raw});return '<p>converted fixture</p>';}
 }},DOMPurify:{sanitize(html,options){calls.push({type:'sanitize',html,options});return fragment;}}};
 return {doc,parent,fragment,links,calls,libs};
}

test('assistant Markdown converts then sanitizes before inserting only the returned fragment',()=>{
 const f=fixture(),insert=f.parent.replaceChildren.bind(f.parent);
 f.parent.replaceChildren=(...nodes)=>{assert.deepEqual(f.calls.map(call=>call.type),['converter','convert','sanitize']);assert.deepEqual(nodes,[f.fragment]);insert(...nodes);};
 assert.equal(renderProseAssistantMarkdown(f.parent,'**bold**\n\n- item',{libs:f.libs}),true);
 assert.deepEqual(f.calls.map(call=>call.type),['converter','convert','sanitize']);
 assert.equal(f.calls[1].raw,'**bold**\n\n- item');assert.equal(f.calls[2].html,'<p>converted fixture</p>');
 assert.equal(f.parent.firstChild,f.fragment);
});

test('assistant Markdown sanitizer allows basic prose but no interactive HTML, images, styles or event attributes',()=>{
 const f=fixture();renderProseAssistantMarkdown(f.parent,'markdown',{libs:f.libs});
 const options=f.calls[2].options;
 for(const tag of ['p','h2','strong','em','del','ul','ol','li','blockquote','pre','code','table','thead','tbody','tr','th','td','a'])assert.ok(options.ALLOWED_TAGS.includes(tag),tag);
 for(const tag of ['script','style','form','input','button','select','textarea','svg','math','iframe','object','embed','img','audio','video','link','base'])assert.ok(!options.ALLOWED_TAGS.includes(tag),tag);
 assert.deepEqual(options.ALLOWED_ATTR,['href','title','start']);
 assert.equal(options.ALLOW_DATA_ATTR,false);assert.equal(options.ALLOW_ARIA_ATTR,false);assert.equal(options.RETURN_DOM_FRAGMENT,true);
 for(const href of ['https://example.test','http://example.test','mailto:a@example.test'])assert.ok(options.ALLOWED_URI_REGEXP.test(href));
 for(const href of ['javascript:alert(1)','data:text/html,hello','//example.test','/relative'])assert.ok(!options.ALLOWED_URI_REGEXP.test(href));
});

test('assistant Markdown adds safe external-link attributes and removes non-allowed destinations',()=>{
 const f=fixture({hrefs:['https://example.test/path','http://example.test','mailto:a@example.test','javascript:alert(1)','data:text/html,x','/relative',null]});
 renderProseAssistantMarkdown(f.parent,'links',{libs:f.libs});
 for(const link of f.links.slice(0,2)){assert.equal(link.getAttribute('target'),'_blank');assert.equal(link.getAttribute('rel'),'noopener noreferrer');}
 assert.equal(f.links[2].getAttribute('href'),'mailto:a@example.test');assert.equal(f.links[2].getAttribute('target'),null);assert.equal(f.links[2].getAttribute('rel'),'noopener noreferrer');
 for(const link of f.links.slice(3)){assert.equal(link.getAttribute('href'),null);assert.equal(link.getAttribute('target'),null);assert.equal(link.getAttribute('rel'),null);}
});

test('assistant Markdown preserves literal original text when either host library is missing',()=>{
 const raw='<img src="https://example.test/private" onerror="alert(1)">\n**not parsed**';
 for(const libs of [undefined,{}, {showdown:{}},{DOMPurify:{sanitize(){throw Error('must not be used');}}}]){
  const {parent}=fixture();assert.equal(renderProseAssistantMarkdown(parent,raw,{libs}),false);assert.equal(parent.textContent,raw);assert.equal(parent.children.length,0);
 }
});

test('assistant Markdown never inserts converter output when conversion, sanitation or fragment creation fails',()=>{
 const raw='**original** <script>alert(1)</script>';
 for(const failure of ['convert','sanitize','string','null']){
  const f=fixture();
  if(failure==='convert')f.libs.showdown.Converter=class{makeHtml(){throw Error('converter failed');}};
  else if(failure==='sanitize')f.libs.DOMPurify.sanitize=()=>{throw Error('sanitizer failed');};
  else f.libs.DOMPurify.sanitize=()=>failure==='string'?'<img onerror="alert(1)">':null;
  assert.equal(renderProseAssistantMarkdown(f.parent,raw,{libs:f.libs}),false,failure);assert.equal(f.parent.textContent,raw);assert.equal(f.parent.children.length,0);
 }
});

test('each streaming prefix still passes through sanitation and replaces the previous display',()=>{
 const f=fixture();
 for(const raw of ['**','**a','**answer**\n[link](javascript:','**answer**\n[link](javascript:alert(1))\n<script>']){
  const before=f.calls.length;assert.equal(renderProseAssistantMarkdown(f.parent,raw,{libs:f.libs}),true);
  assert.equal(f.calls[before+1].raw,raw);assert.equal(f.calls[before+2].type,'sanitize');assert.equal(f.parent.children.length,1);
 }
});
