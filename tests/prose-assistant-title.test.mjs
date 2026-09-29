import test from 'node:test';
import assert from 'node:assert/strict';
import {createProseAssistantTitleProtocol as create} from '../qianmu-prose-assistant-title.js';

const id='01234567-89ab-4cde-8f01-23456789abcd';
const open=`[[qianmu-title:${id}]]`,close=`[[/qianmu-title:${id}]]`;
const marker=title=>`${open}${title}${close}`;
function stream(text){
  const protocol=create({id});let shown='';
  for(let i=1;i<=text.length;i++){
    const next=protocol.push(text.slice(0,i));
    assert.ok(next.startsWith(shown),'display text must only grow');
    assert.ok(text.slice(0,i).startsWith(next),'display text stays an exact source prefix');
    assert.ok(i-next.length<=256,'held suffix stays bounded');shown=next;
  }
  return {protocol,shown,result:protocol.finish(text)};
}

test('the request instruction uses a per-response nonce and already supplied context only',()=>{
  const protocol=create({id:id.toUpperCase()});
  assert.ok(protocol.instruction.includes(open));assert.ok(protocol.instruction.includes(close));
  assert.match(protocol.instruction,/已提供的近期对话和当前问题/);
  assert.deepEqual(Object.keys(protocol),['instruction','push','finish']);
  assert.notEqual(create().instruction,create().instruction);
  for(const value of ['',null,'x]\nInjected','a'.repeat(36)])assert.throws(()=>create({id:value}),{code:'prose_assistant_title_stream'});
});

test('character-by-character streaming never exposes a valid title marker',()=>{
  const body='这是正常回答。\n第二段有 emoji 🐈。',text=`${body}\n${marker('岩彩与传统绘画')}`;
  const {shown,result,protocol}=stream(text);
  assert.equal(shown,body);assert.deepEqual(result,{text:body,title:'岩彩与传统绘画'});
  assert.equal(protocol.finish(text),result);assert.equal(protocol.push(text),body);
  assert.throws(()=>protocol.push(text+'later'),{code:'prose_assistant_title_stream'});
});

test('non-streamed replies and both LF and CRLF terminal newlines are supported',()=>{
  for(const separator of ['\n','\r\n'])for(const ending of ['',separator]){
    const text=`回答${separator}${marker(' 一段标题 ')}${ending}`;
    assert.deepEqual(create({id}).finish(text),{text:'回答',title:'一段标题'});
    assert.deepEqual(stream(text).result,{text:'回答',title:'一段标题'});
  }
});

test('valid title suffixes tolerate bounded final ASCII whitespace without flashing markers',()=>{
  for(const tail of ['  ','\t','\n\n',' \t\r\n\n\t  ','\r','\r\n\r\n  \t']){
    const text=`正常回答\n${marker('有效标题')}${tail}`,{shown,result}=stream(text);
    assert.equal(shown,'正常回答');assert.deepEqual(result,{text:'正常回答',title:'有效标题'});
    assert.deepEqual(create({id}).finish(text),result);
  }
});

test('trailing whitespace does not discard invalid titles or ordinary text',()=>{
  for(const body of ['普通正文',`回答\n${marker('<b>不能用</b>')}`,`回答\n${open}未完成`]){
    for(const tail of [' \t\n\n','\r\n\r\n  ','\t']){
      const text=body+tail;assert.deepEqual(stream(text).result,{text,title:null});
    }
  }
  const text=`回答\n${marker('标题')}${' '.repeat(256)}`;
  assert.deepEqual(stream(text).result,{text,title:null});
});

test('missing markers, partial markers and similar strings remain exact ordinary text',()=>{
  const samples=['普通正文','普通正文\n','普通正文\r\n','普通正文\r',
    `回答\n${open.slice(0,-1)}`,`回答\n${open}不完整标题`,
    `回答\n${marker('不同 nonce').replace(id,'11234567-89ab-4cde-8f01-23456789abcd')}`,
    `在正文里引用 ${marker('标记不是正文尾缀')}`,`回答\n ${marker('前有空格')}`,
    `回答\n> ${marker('引用')}`,`回答\n    ${marker('缩进代码')}`,marker('没有正文')];
  for(const text of samples)assert.deepEqual(stream(text).result,{text,title:null});
});

test('markers inside fenced or inline code are not metadata',()=>{
  for(const fence of ['```','~~~~','  ````']){
    for(const ending of ['',`\n${fence.trim()}`]){
      const text=`代码示例\n${fence}\n${marker('示例标题')}${ending}`;
      const {shown,result}=stream(text);
      assert.ok(shown.includes(open));assert.deepEqual(result,{text,title:null});
    }
  }
  const inline=`回答\n\`${marker('行内代码')}\``;
  assert.deepEqual(stream(inline).result,{text:inline,title:null});
  const valid=`代码\n~~~js\nconst answer=42;\n~~~\n${marker('代码解释')}`;
  assert.deepEqual(stream(valid).result,{text:'代码\n~~~js\nconst answer=42;\n~~~',title:'代码解释'});
});

test('blank, long, multiline, HTML, control and malformed Unicode titles do not discard text',()=>{
  const titles=['','   ','x'.repeat(41),'🐈'.repeat(41),'两\n行','两\r行','两\u2028行','<b>标题</b>','a\0b','a\tb','a\u200bb','a\ud800b'];
  for(const title of titles){const text=`回答\n${marker(title)}`;assert.deepEqual(stream(text).result,{text,title:null});}
  const text=`回答\n${marker('🐈'.repeat(40))}`;
  assert.deepEqual(stream(text).result,{text:'回答',title:'🐈'.repeat(40)});
});

test('ordinary content after an apparent suffix releases it and prevents naming',()=>{
  for(const tail of [' 再补一句','\n再补一句','\n```','\n\n\t再补一句']){
    const text=`回答\n${marker('暂时的标题')}${tail}`;
    assert.deepEqual(stream(text).result,{text,title:null});
  }
});

test('bounded withholding never swallows a large malformed suffix or later paragraphs',()=>{
  const text=`回答\n${open}${'正文'.repeat(1000)}\n后续正文。`;
  const {shown,result}=stream(text);
  assert.equal(shown,text);assert.deepEqual(result,{text,title:null});
});

test('noncumulative streams are rejected rather than silently repaired',()=>{
  const protocol=create({id});assert.equal(protocol.push('原回答'),'原回答');
  assert.throws(()=>protocol.push('改回答'),{code:'prose_assistant_title_stream'});
  assert.throws(()=>protocol.finish('原回'),{code:'prose_assistant_title_stream'});
  assert.deepEqual(protocol.finish('原回答'),{text:'原回答',title:null});
});
