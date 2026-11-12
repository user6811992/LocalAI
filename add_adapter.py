# Insert adapter code after IS_OPENAI_COMPAT line
s = open('server.js', encoding='utf-8').read()
marker = "const IS_OPENAI_COMPAT = (BACKEND_TYPE === 'llamacpp' || BACKEND_TYPE === 'lmstudio' || BACKEND_TYPE === 'openai');"
adapter_code = '''

// ---------- Multi-backend adapter ----------
// Normalizes OpenAI-compatible backends (llama.cpp, LM Studio) to Ollama format

async function backendListModels() {
  if (!IS_OPENAI_COMPAT) {
    // Ollama native
    const r = await fetch(OLLAMA + '/api/tags');
    if (!r.ok) throw new Error('Failed to list models: ' + r.status);
    return r.json();
  }
  // OpenAI-compatible: GET /v1/models
  const r = await fetch(OLLAMA + '/v1/models');
  if (!r.ok) throw new Error('Failed to list models: ' + r.status);
  const data = await r.json();
  const models = (data.data || []).map((m) => ({
    name: m.id,
    model: m.id,
    modified_at: new Date().toISOString(),
    size: 0,
    digest: '',
    details: { format: 'gguf', family: 'unknown', parameter_size: '', quantization_level: '' },
  }));
  return { models };
}

async function backendShowModel(name) {
  if (!IS_OPENAI_COMPAT) {
    const r = await fetch(OLLAMA + '/api/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    if (!r.ok) throw new Error('Model not found: ' + r.status);
    return r.json();
  }
  // OpenAI-compatible: find in model list
  const models = await backendListModels();
  const found = (models.models || []).find((m) => m.name === name);
  if (!found) throw new Error('Model not found: ' + name);
  return { modelfile: '', parameters: '', template: '', details: found.details || {} };
}

async function backendChat(bodyObj, onChunk, signal) {
  if (!IS_OPENAI_COMPAT) {
    // Ollama native - use existing ollamaStream
    return ollamaStream('/api/chat', bodyObj, onChunk, signal);
  }
  // OpenAI-compatible: POST /v1/chat/completions
  const oaiBody = {
    model: bodyObj.model,
    messages: bodyObj.messages || [],
    stream: bodyObj.stream !== false,
    temperature: bodyObj.options && bodyObj.options.temperature,
  };
  if (bodyObj.tools && bodyObj.tools.length) {
    oaiBody.tools = bodyObj.tools;
    oaiBody.tool_choice = 'auto';
  }
  const r = await fetch(OLLAMA + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(oaiBody),
    signal,
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error('Chat failed: ' + r.status + ' ' + errText);
  }
  if (bodyObj.stream === false) {
    const data = await r.json();
    const choice = (data.choices && data.choices[0]) || {};
    const msg = choice.message || {};
    const result = { message: { role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls }, done: true };
    if (onChunk) onChunk({ type: 'token', content: msg.content || '' });
    return { status: 200, data: result };
  }
  // Streaming
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload);
        const delta = (obj.choices && obj.choices[0] && obj.choices[0].delta) || {};
        if (delta.content) {
          fullContent += delta.content;
          if (onChunk) onChunk({ type: 'token', content: delta.content });
        }
        if (delta.tool_calls) {
          // Forward tool calls
          if (onChunk) onChunk({ type: 'tool_calls', tool_calls: delta.tool_calls });
        }
      } catch (_) {}
    }
  }
  if (onChunk) onChunk({ type: 'done' });
  return { status: 200, data: { message: { role: 'assistant', content: fullContent }, done: true } };
}

// Model pull (Ollama only; OpenAI backends don't support pull)
async function backendPullModel(name, onProgress) {
  if (IS_OPENAI_COMPAT) {
    throw new Error('Model pulling is not supported for OpenAI-compatible backends. Download models manually.');
  }
  // Use existing Ollama pull logic
  return null; // handled by existing code
}
'''
s = s.replace(marker, marker + adapter_code)
open('server.js', 'w', encoding='utf-8').write(s)
print('done')
