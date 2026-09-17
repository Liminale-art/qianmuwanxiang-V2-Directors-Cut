// Request-local response decoding. Never subscribes to host generation events.
const LIMIT = 16 * 1024 * 1024;
const plain = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter(part => part && ['text', 'output_text'].includes(part.type)).map(part => part.text || '').join('') : '';
const thoughtText = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(thoughtText).join('')
  : value && typeof value === 'object' ? thoughtText(value.text ?? value.content ?? value.summary ?? value.reasoning ?? '') : '';
const reasoning = value => thoughtText(value?.reasoning_content ?? value?.reasoning ?? value?.reasoning_details ?? value?.thinking_content ?? value?.thinking ?? value?.analysis ?? value?.thoughts ?? '');
const first = rows => Array.isArray(rows) ? rows.find(row => row && (row.index === undefined || row.index === 0)) : null;
const failure = (code, message) => Object.assign(new Error(message), { code });

export function createModelResponseAccumulator({ onDelta, onReasoning, onResponse } = {}) {
  const state = { text: '', reasoning: '', finishReason: '', complete: false, interrupted: false, receivedBytes: 0, usage: null };
  let terminal = false;
  const snapshot = () => structuredClone(state);
  const publish = () => { onResponse?.(snapshot()); };
  function append(text, thought = '', mode = 'delta') {
    const priorText = state.text, priorReasoning = state.reasoning;
    if (mode === 'snapshot') {
      if (text && !text.startsWith(priorText)) throw failure('MODEL_PROTOCOL_ERROR', '模型返回了不连续的正文快照，已保留此前内容');
      if (thought && !thought.startsWith(priorReasoning)) throw failure('MODEL_PROTOCOL_ERROR', '模型返回了不连续的推理快照，已保留此前内容');
      if (text) state.text = text;
      if (thought) state.reasoning = thought;
    } else { state.text += text; state.reasoning += thought; }
    if (state.text !== priorText) onDelta?.(state.text);
    if (state.reasoning !== priorReasoning) onReasoning?.(state.reasoning);
    publish();
  }
  function consume(data, { streaming = true } = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('MODEL_PROTOCOL_ERROR', '模型返回的事件不是有效对象');
    if (data.error || data.type === 'error') throw failure('MODEL_REMOTE_ERROR', `模型服务返回错误：${String(data.error?.message || data.message || data.error || '未知错误').slice(0, 600)}`);
    if (terminal) return;
    if (data.usage || data.usageMetadata) state.usage = structuredClone(data.usage || data.usageMetadata);
    const choice = first(data.choices), candidate = first(data.candidates);
    if (candidate) {
      const parts = candidate.content?.parts || [];
      append(parts.filter(part => !part.thought).map(part => plain(part.text)).join(''), parts.filter(part => part.thought).map(part => plain(part.text)).join(''));
      if (candidate.finishReason) state.finishReason = candidate.finishReason;
    } else if (choice) {
      const message = choice.delta || choice.message || {};
      append(plain(message.content ?? choice.text), reasoning(message), choice.message && streaming ? 'snapshot' : 'delta');
      if (choice.finish_reason) state.finishReason = choice.finish_reason;
    } else if (data.type === 'content_block_delta') {
      append(plain(data.delta?.text), plain(data.delta?.thinking));
    } else if (data.type === 'content_block_start') {
      append(plain(data.content_block?.text), plain(data.content_block?.thinking));
    } else if (data.type === 'message_delta') {
      if (data.delta?.stop_reason) state.finishReason = data.delta.stop_reason;
    } else if (data.type === 'message_stop') terminal = true;
    else if (data.type === 'message' || !streaming && Array.isArray(data.content)) {
      append(plain(data.content), data.content.filter(part => part.type === 'thinking').map(part => plain(part.thinking)).join(''));
      if (data.stop_reason) state.finishReason = data.stop_reason;
    } else if (data.type === 'content-delta') append(plain(data.delta?.message?.content?.text));
    else if (data.type === 'message-end') { state.finishReason = data.delta?.finish_reason || data.finish_reason || ''; terminal = true; }
    else if (data.message?.content && !streaming) { append(plain(data.message.content)); state.finishReason = data.finish_reason || ''; }
    if (data.promptFeedback?.blockReason) state.finishReason = data.promptFeedback.blockReason;
    publish();
  }
  function finish({ streaming = true } = {}) {
    const reason = state.finishReason.toLowerCase();
    const normal = ['stop', 'end_turn', 'stop_sequence', 'complete', 'completed', 'eos_token'].includes(reason);
    const truncated = ['length', 'max_tokens', 'max_output_tokens', 'model_length'].includes(reason);
    state.complete = !truncated && (!reason || normal) && (!streaming || terminal || normal);
    if (!state.complete) {
      state.interrupted = true; publish();
      throw failure('MODEL_OUTPUT_INCOMPLETE', truncated ? '模型达到输出长度上限，回复被截断；已保留收到的原文，未自动补写或重试'
        : reason ? `模型未正常完成（${state.finishReason}）；已保留原文，未自动采用部分结果` : '连接结束但未收到模型完成标记；已保留收到的原文');
    }
    publish(); return snapshot();
  }
  return { consume, finish, snapshot, done() { terminal = true; }, get terminal() { return terminal; },
    bytes(value) { state.receivedBytes = value; }, interrupt() { state.complete = false; state.interrupted = true; publish(); } };
}

export async function readModelResponse(response, { stream = false, signal, guard = () => true, maxBytes = LIMIT, ...callbacks } = {}) {
  const accumulator = createModelResponseAccumulator(callbacks);
  let reader, cancelled = false, bytes = 0, buffer = '', event = [], json = '', sse = stream, failedPayload = '';
  const check = async () => {
    if (cancelled || signal?.aborted) throw Object.assign(new Error('已取消生成'), { name: 'AbortError' });
    if (await guard() === false) throw failure('MODEL_SCOPE_CHANGED', '生成所属的聊天或账户已变化，原始回复保留但未写入');
    if (cancelled || signal?.aborted) throw Object.assign(new Error('已取消生成'), { name: 'AbortError' });
  };
  const abort = () => { cancelled = true; void reader?.cancel().catch(() => {}); };
  function dispatch() {
    if (!event.length) return;
    const payload = event.join('\n'); event = [];
    if (payload.trim() === '[DONE]') { accumulator.done(); return; }
    let data;
    try { data = JSON.parse(payload); } catch (_) { failedPayload = payload; throw failure('MODEL_PROTOCOL_ERROR', '模型返回了损坏或截断的流式事件，已保留此前原文'); }
    accumulator.consume(data);
  }
  function line(value) {
    if (!value) { dispatch(); return; }
    if (value.startsWith('data:')) event.push(value.slice(5).replace(/^ /, ''));
    else if (value === 'data') event.push('');
  }
  function drain(final = false) {
    while (buffer.length) {
      const match = /[\r\n]/.exec(buffer);
      if (!match) { if (final) { line(buffer); buffer = ''; } break; }
      const at = match.index;
      if (!final && buffer[at] === '\r' && at === buffer.length - 1) break;
      line(buffer.slice(0, at));
      buffer = buffer.slice(at + (buffer[at] === '\r' && buffer[at + 1] === '\n' ? 2 : 1));
    }
    if (final) dispatch();
  }
  try {
    await check();
    reader = response.body?.getReader();
    if (!reader) throw failure(response.ok ? 'MODEL_PROTOCOL_ERROR' : 'MODEL_HTTP_ERROR', response.ok ? '模型没有返回可读取的内容' : `模型请求失败：HTTP ${response.status}`);
    signal?.addEventListener('abort', abort, { once: true });
    await check();
    // Some compatible gateways return JSON despite a requested stream; read it once, never resend.
    const mime = response.headers?.get?.('content-type') || '';
    sse = response.ok && stream && !/^application\/json\b/i.test(mime);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (true) {
      await check(); const part = await reader.read(); await check();
      if (part.done) break;
      bytes += part.value.byteLength; accumulator.bytes(bytes);
      if (bytes > maxBytes) throw failure('MODEL_RESPONSE_LIMIT', '模型回复超过读取上限；已保留此前内容，未自动采用或重试');
      const text = decoder.decode(part.value, { stream: true });
      if (sse) { buffer += text; drain(); if (accumulator.terminal) break; }
      else json += text;
    }
    await check();
    const end = decoder.decode();
    if (!response.ok) { json += end; throw failure('MODEL_HTTP_ERROR', `模型请求失败：HTTP ${response.status}${json ? ` · ${json.slice(0, 600)}` : ''}`); }
    if (sse) { buffer += end; drain(true); }
    else { json += end; let data; try { data = JSON.parse(json); } catch (_) { throw failure('MODEL_PROTOCOL_ERROR', '模型返回的 JSON 响应损坏或未完整接收'); } accumulator.consume(data, { streaming: false }); }
    return accumulator.finish({ streaming: sse });
  } catch (error) {
    accumulator.interrupt(); error.modelResponse = accumulator.snapshot();
    if (['MODEL_PROTOCOL_ERROR', 'MODEL_HTTP_ERROR'].includes(error.code) || error instanceof TypeError) {
      error.modelResponse.rawTransport = sse ? failedPayload || [event.join('\n'), buffer].filter(Boolean).join('\n') : json;
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    try { await reader?.cancel(); } catch (_) {}
    try { reader?.releaseLock(); } catch (_) {}
  }
}
