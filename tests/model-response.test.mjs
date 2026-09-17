import test from 'node:test';
import assert from 'node:assert/strict';
import { readModelResponse } from '../qianmu-model-response.js';
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const chunk = (content, more = {}) => ({ choices: [{ index: 0, delta: { content }, ...more }] });
function response(text, { split = 1, mime = 'text/event-stream' } = {}) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += split) controller.enqueue(bytes.slice(i, i + split)); controller.close(); } }), { headers: { 'Content-Type': mime } });
}

test('SSE byte splits preserve exact Unicode, whitespace, reasoning, usage and final unterminated event', async () => {
  const text = frame(chunk('  中文😀\n')) + frame({ choices: [{ delta: { reasoning_content: ' 思考\n' } }] })
    + frame(chunk('正文\n', { finish_reason: 'stop' })) + 'data: {"usage":{"total_tokens":8}}';
  const seen=[], thoughts=[];
  const result = await readModelResponse(response(text), { stream: true, onDelta: full => seen.push(full), onReasoning: full => thoughts.push(full) });
  assert.equal(result.text, '  中文😀\n正文\n'); assert.equal(result.reasoning, ' 思考\n');
  assert.equal(result.finishReason, 'stop'); assert.equal(result.complete, true); assert.equal(result.usage.total_tokens, 8);
  assert.deepEqual(seen, ['  中文😀\n', '  中文😀\n正文\n']); assert.deepEqual(thoughts, [' 思考\n']);
});

for (const newline of ['\n', '\r', '\r\n']) test(`SSE event boundaries and multiline data tolerate ${JSON.stringify(newline)} split between bytes`, async () => {
  const source=': comment\nevent: message\ndata: {"choices":\ndata: [{"delta":{"content":"body"}}]}\n\ndata: [DONE]';
  const result=await readModelResponse(response(source.replaceAll('\n',newline)),{stream:true});assert.equal(result.text,'body');assert.equal(result.complete,true);
});

test('end marker returns without waiting for a server that keeps the connection open and cancels its reader', async()=>{
  let cancelled=false;
  const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(frame(chunk('body'))+'data: [DONE]\n\n'));},cancel(){cancelled=true;}});
  assert.equal((await readModelResponse(new Response(body),{stream:true})).text,'body');assert.equal(cancelled,true);assert.equal(body.locked,false);
});

for (const reason of ['length','MAX_TOKENS','content_filter','SAFETY','tool_calls']) test(`non-normal finish ${reason} retains raw body without successful adoption`,async()=>{
  let latest;
  await assert.rejects(readModelResponse(response(frame(chunk('{"quests":[]}',{finish_reason:reason}))+'data: [DONE]\n\n'),{stream:true,onResponse:value=>latest=value}),error=>{
    assert.equal(error.code,'MODEL_OUTPUT_INCOMPLETE');assert.equal(error.modelResponse.text,'{"quests":[]}');assert.equal(error.modelResponse.finishReason,reason);return true;
  });assert.equal(latest.complete,false);assert.equal(latest.interrupted,true);
});

test('EOF without a terminal marker and malformed or explicit error frames are never silently treated as success',async()=>{
  for(const end of ['', 'data: {broken}\n\n', frame({error:{message:'upstream failure'}})]) {
    await assert.rejects(readModelResponse(response(frame(chunk('kept prefix'))+end),{stream:true}),error=>error.modelResponse.text==='kept prefix'&&error.modelResponse.interrupted);
  }
});

test('Gemini joins every text part, excludes thought parts, skips other candidates, and retains native finish and usage',async()=>{
  const text=frame({candidates:[{index:1,content:{parts:[{text:'ignored'}]}},{index:0,content:{parts:[{text:'A'},{thought:true,text:'T'},{text:'B'}]},finishReason:'STOP'}],usageMetadata:{totalTokenCount:4}});
  const result=await readModelResponse(response(text),{stream:true});assert.equal(result.text,'AB');assert.equal(result.reasoning,'T');assert.equal(result.usage.totalTokenCount,4);
});

test('Anthropic thinking and text blocks remain separated until its own completion event',async()=>{
  const text=frame({type:'content_block_start',content_block:{type:'text',text:'A'}})+frame({type:'content_block_delta',delta:{type:'thinking_delta',thinking:'T'}})
    +frame({type:'content_block_delta',delta:{type:'text_delta',text:'B'}})+frame({type:'message_delta',delta:{stop_reason:'end_turn'}})+frame({type:'message_stop'});
  const result=await readModelResponse(response(text),{stream:true});assert.equal(result.text,'AB');assert.equal(result.reasoning,'T');assert.equal(result.finishReason,'end_turn');
});

test('a JSON response to a streaming request is consumed once with raw content and no transport retry',async()=>{
  const data={choices:[{message:{content:'  untrimmed\n',reasoning_content:'Thought '},finish_reason:'stop'}]};
  const result=await readModelResponse(response(JSON.stringify(data),{mime:'application/json'}),{stream:true});assert.equal(result.text,'  untrimmed\n');assert.equal(result.reasoning,'Thought ');
  await assert.rejects(readModelResponse(response(JSON.stringify({...data,choices:[{...data.choices[0],finish_reason:'length'}]}),{mime:'application/json'})),/截断/);
});

test('repeated cumulative message snapshots are not appended twice; alternate choice cannot leak into content',async()=>{
  const text=frame(chunk('a'))+frame({choices:[{message:{content:'ab'}}]})+frame({choices:[{message:{content:'ab'}}]})+frame({choices:[{index:1,delta:{content:'ignored'}}]})+'data: [DONE]\n\n';
  assert.equal((await readModelResponse(response(text),{stream:true})).text,'ab');
});

test('cancel, changed owner, and byte limits release the reader and preserve already-received text',async()=>{
  for(const mode of ['abort','owner','limit']){
    const controller=new AbortController();let active=true;
    const body=response(frame(chunk('retained'))+frame(chunk('later'))).body;
    await assert.rejects(readModelResponse(new Response(body),{stream:true,signal:controller.signal,maxBytes:mode==='limit'?80:10000,guard:()=>active,
      onDelta(){if(mode==='abort')controller.abort();if(mode==='owner')active=false;}}),error=>error.modelResponse.text==='retained');
    assert.equal(body.locked,false);
  }
});

test('invalid UTF-8 and an HTTP failure cannot become an empty successful reply',async()=>{
  await assert.rejects(readModelResponse(new Response(new Uint8Array([255])),{stream:true}));
  await assert.rejects(readModelResponse(new Response('no',{status:503})),/HTTP 503/);
});

test('broken event and JSON fallback preserve unparsed transport independently from already-decoded prose',async()=>{
  await assert.rejects(readModelResponse(response(frame(chunk('kept'))+'data: {broken}\n\n'),{stream:true}),error=>{
    assert.equal(error.modelResponse.text,'kept');assert.equal(error.modelResponse.rawTransport,'{broken}');return true;
  });
  await assert.rejects(readModelResponse(response('{"choices":[',{mime:'application/json'}),{stream:true}),error=>{
    assert.equal(error.modelResponse.text,'');assert.equal(error.modelResponse.rawTransport,'{"choices":[');return true;
  });
});

test('HTTP error bodies and explicit reasoning detail fields retain diagnostic content without becoming story text',async()=>{
  await assert.rejects(readModelResponse(new Response('{"error":"quota exhausted"}',{status:429}),{stream:true}),error=>{
    assert.match(error.message,/429.*quota exhausted/);assert.equal(error.modelResponse.rawTransport,'{"error":"quota exhausted"}');assert.equal(error.modelResponse.text,'');return true;
  });
  const value={choices:[{message:{content:'reply',reasoning_details:[{type:'reasoning.text',text:'  thought\n'},{type:'reasoning.encrypted',data:'opaque'}]},finish_reason:'stop'}]};
  const result=await readModelResponse(response(JSON.stringify(value),{mime:'application/json'}));
  assert.equal(result.text,'reply');assert.equal(result.reasoning,'  thought\n');
});
