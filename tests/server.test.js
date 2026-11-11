// AegisAI test suite. Run with: npm test
// Starts a fake Ollama HTTP backend so the agent loop can be exercised end to end.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOKEN = 'test-token-123';
process.env.LOCALAI_TOKEN = TOKEN;
process.env.AEGISAI_MAX_BODY = String(1024 * 1024);
const ALLOWED_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-allowed-'));
process.env.AEGISAI_PROJECT_ROOT_ALLOWLIST = ALLOWED_ROOT;
process.env.AEGISAI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-test-data-'));

// Fake Ollama: scripted replies driven by the request body.
let fakeOllama;
let fakeLog = [];
function startFakeOllama() {
  return new Promise((resolve) => {
    fakeOllama = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const data = body ? JSON.parse(body) : {};
        fakeLog.push({ url: req.url, data });
        if (req.url === '/api/embeddings') {
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }));
        }
        if (req.url === '/api/show') {
          res.statusCode = 404;
          return res.end('{}');
        }
        if (req.url === '/api/chat') {
          const toolMsgs = (data.messages || []).filter((m) => m.role === 'tool');
          // Scripted model name: "scripted:<base64 json {name,args}>" asks the fake to call that tool once.
          let wantTool = null;
          if (typeof data.model === 'string' && data.model.startsWith('scripted:')) {
            wantTool = JSON.parse(Buffer.from(data.model.slice('scripted:'.length), 'base64').toString('utf8'));
          }
          res.setHeader('Content-Type', 'application/x-ndjson');
          const lines = [];
          if (toolMsgs.length === 0 && wantTool) {
            lines.push({ model: data.model, message: { role: 'assistant', content: '', tool_calls: [{ function: { name: wantTool.name, arguments: wantTool.args } }] }, done: false });
            lines.push({ model: data.model, message: { role: 'assistant', content: '' }, done: true, eval_count: 5, prompt_eval_count: 10 });
          } else {
            lines.push({ model: data.model, message: { role: 'assistant', content: 'final answer' }, done: false });
            lines.push({ model: data.model, message: { role: 'assistant', content: '' }, done: true, eval_count: 7, prompt_eval_count: 20 });
          }
          return res.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    fakeOllama.listen(0, '127.0.0.1', () => resolve(fakeOllama.address().port));
  });
}

let app;
let base;
let serverInstance;

before(async () => {
  const port = await startFakeOllama();
  process.env.OLLAMA_URL = 'http://127.0.0.1:' + port;
  app = require('../server.js');
  serverInstance = app.server;
  await new Promise((resolve) => serverInstance.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + serverInstance.address().port;
});

after(async () => {
  await new Promise((resolve) => serverInstance.close(resolve));
  await new Promise((resolve) => fakeOllama.close(resolve));
});

function req(method, url, { body, auth = true, headers = {} } = {}) {
  const h = Object.assign({}, headers);
  if (auth) h['X-Auth-Token'] = TOKEN;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  return fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}

// ---------- process + input safety ----------

test('runProcess never interprets shell metacharacters', async () => {
  const payload = 'x" & echo INJECTED & "';
  const r = await app.runProcess(process.execPath, ['-e', 'console.log(process.argv[1])', payload]);
  assert.equal(r.ok, true);
  assert.ok(r.out.includes(payload), 'argument must arrive verbatim: ' + r.out);
  assert.ok(!/^INJECTED$/m.test(r.out));
});

test('isValidModelName accepts normal refs and rejects injection', () => {
  assert.equal(app.isValidModelName('llama3.2:3b'), true);
  assert.equal(app.isValidModelName('huihui_ai/qwen2.5-coder-abliterate:7b'), true);
  assert.equal(app.isValidModelName('x" & calc & "'), false);
  assert.equal(app.isValidModelName('-f /etc/passwd'), false);
  assert.equal(app.isValidModelName(''), false);
  assert.equal(app.isValidModelName('a'.repeat(300)), false);
});

test('/api/pull-model rejects injected model names before running anything', async () => {
  const r = await req('POST', '/api/pull-model', { body: { name: 'x" & echo PWNED & "' } });
  assert.equal(r.status, 400);
  const d = await r.json();
  assert.equal(d.ok, false);
});

test('/api/project rejects roots that do not exist', async () => {
  const r = await req('POST', '/api/project', { body: { root: path.join(os.tmpdir(), 'definitely-missing-' + Date.now()) } });
  assert.equal(r.status, 400);
});

test('/api/project accepts an existing directory', async () => {
  const dir = fs.mkdtempSync(path.join(ALLOWED_ROOT, 'proj-'));
  const r = await req('POST', '/api/project', { body: { root: dir } });
  assert.equal(r.status, 200);
  assert.equal(app.getProjectRoot(), path.resolve(dir));
});

test('validateProjectRoot enforces AEGISAI_PROJECT_ROOT_ALLOWLIST', () => {
  const inside = path.join(ALLOWED_ROOT, 'sub');
  fs.mkdirSync(inside, { recursive: true });
  assert.equal(app.validateProjectRoot(inside), path.resolve(inside));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-outside-'));
  assert.throws(() => app.validateProjectRoot(outside), (e) => e.status === 403);
});

test('/api/project returns 403 for a root outside the allow-list', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-outside2-'));
  const r = await req('POST', '/api/project', { body: { root: outside } });
  assert.equal(r.status, 403);
});

test('safePath blocks traversal outside the project root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-safe-'));
  app.setProjectRoot(dir);
  assert.throws(() => app.safePath('../../etc/passwd'), /escapes project root/);
  assert.ok(app.safePath('sub/file.txt').startsWith(path.resolve(dir) + path.sep));
});

// ---------- HTTP hardening ----------

test('requests without the token are rejected (401)', async () => {
  const r = await fetch(base + '/api/version', { headers: { 'Host': '127.0.0.1:' + serverInstance.address().port } });
  assert.equal(r.status, 401);
});

test('wrong token is rejected (401)', async () => {
  const r = await fetch(base + '/api/version', { headers: { 'Host': '127.0.0.1:' + serverInstance.address().port, 'X-Auth-Token': 'nope' } });
  assert.equal(r.status, 401);
});

test('Authorization: Bearer token is accepted', async () => {
  const r = await fetch(base + '/api/version', { headers: { 'Host': '127.0.0.1:' + serverInstance.address().port, Authorization: 'Bearer ' + TOKEN } });
  assert.equal(r.status, 200);
});

test('static responses carry security headers', async () => {
  const r = await fetch(base + '/index.html', { headers: { 'Host': '127.0.0.1:' + serverInstance.address().port } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.ok(r.headers.get('content-security-policy').includes("default-src 'self'"));
});

test('the web UI itself loads without a token so the browser can prompt for one', async () => {
  const r = await fetch(base + '/index.html');
  assert.equal(r.status, 200);
  const api = await fetch(base + '/api/version');
  assert.equal(api.status, 401);
});

test('static path traversal is blocked', async () => {
  const r = await fetch(base + '/..%2F..%2Fpackage.json', { headers: { 'Host': '127.0.0.1:' + serverInstance.address().port, 'X-Auth-Token': TOKEN } });
  assert.notEqual(r.status, 200);
  const r2 = await fetch(base + '/%2e%2e/%2e%2e/server.js', { headers: { 'Host': '127.0.0.1:' + serverInstance.address().port, 'X-Auth-Token': TOKEN } });
  assert.notEqual(r2.status, 200);
});

test('oversized request bodies are rejected with 413', async () => {
  const big = 'a'.repeat(app.MAX_BODY_BYTES + 1024);
  const r = await req('POST', '/api/memory/save', { body: { text: big } });
  assert.equal(r.status, 413);
});

// ---------- memory / embeddings ----------

test('memory save persists with a real embedding (duplicate embedText fixed)', async () => {
  const r = await req('POST', '/api/memory/save', { body: { text: 'The user prefers dark theme for all screens' } });
  assert.equal(r.status, 200);
  const mem = JSON.parse(fs.readFileSync(path.join(process.env.AEGISAI_DATA_DIR, 'memory.json'), 'utf8'));
  const saved = mem.find((m) => m.text.includes('dark theme'));
  assert.ok(saved, 'memory saved');
  assert.ok(Array.isArray(saved.embedding) && saved.embedding.length === 3, 'embedding stored');
});

// ---------- stats ----------

test('/api/stats counts only user and assistant messages', async () => {
  const chats = [{ id: 'c1', title: 't', updated: '', messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'yo', tokenStats: { prompt: 3, generated: 4 } },
    { role: 'tool', content: 'x' },
    { role: 'system', content: 'sys' },
  ] }];
  fs.writeFileSync(path.join(process.env.AEGISAI_DATA_DIR, 'chats.json'), JSON.stringify(chats));
  const r = await req('GET', '/api/stats');
  const d = await r.json();
  assert.equal(d.messages.total, 2);
  assert.equal(d.messages.user, 1);
  assert.equal(d.messages.assistant, 1);
  assert.equal(d.tokenUsage.prompt, 3);
  assert.equal(d.tokenUsage.generated, 4);
});

// ---------- agent loop: tool assembly, clean room, tool execution ----------

test('clean room blocks dangerous tool names and keeps safe ones', () => {
  assert.equal(app.isCleanRoomBlocked('read_file'), true);
  assert.equal(app.isCleanRoomBlocked('run_python'), true);
  assert.equal(app.isCleanRoomBlocked('skill_run'), true);
  assert.equal(app.isCleanRoomBlocked('git_diff'), true);
  assert.equal(app.isCleanRoomBlocked('decompile_function'), true);
  assert.equal(app.isCleanRoomBlocked('web_search'), false);
  assert.equal(app.isCleanRoomBlocked('memory_search'), false);
});

test('agent executes a coding tool and returns the final answer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-agent-'));
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello world');
  app.setProjectRoot(dir);
  const r = await agentRun('list_files', { path: '.' }, { cleanRoom: false });
  assert.equal(r.final.type, 'done');
  assert.equal(r.final.final, 'final answer');
  assert.equal(r.toolLog.length, 1);
  assert.equal(r.toolLog[0].name, 'list_files');
  assert.ok(r.toolLog[0].resultPreview.includes('hello.txt'));
});

test('external Ghidra/Craft/ARE tools reach the model and respect the budget', async () => {
  app.__setExternalTools('ghidra', [{ name: 'list_functions', description: 'g', inputSchema: { type: 'object', properties: {} } }]);
  app.__setExternalTools('craft', [{ name: 'scan_binary', description: 'c', inputSchema: { type: 'object', properties: {} } }]);
  app.__setExternalTools('are', [{ name: 'search_reverse_engineered', description: 'a', inputSchema: { type: 'object', properties: {} } }]);
  fakeLog = [];
  await agentRun('list_files', { path: '.' }, { cleanRoom: false, includeRe: true });
  const chat = fakeLog.find((c) => c.url === '/api/chat' && Array.isArray(c.data.tools));
  assert.ok(chat, 'chat request with tools was sent');
  const names = chat.data.tools.map((t) => t.function.name);
  assert.ok(names.includes('ghidra_list_functions'), 'ghidra tool present: ' + names);
  assert.ok(names.includes('craft_scan_binary'), 'craft tool present');
  assert.ok(names.includes('are_search_reverse_engineered'), 'ARE tool present');
  assert.ok(names.includes('list_files'), 'coding tools kept');
  assert.ok(names.length <= app.TOOL_BUDGET, 'within budget');
  app.__setExternalTools('ghidra', []);
  app.__setExternalTools('craft', []);
  app.__setExternalTools('are', []);
});

test('clean room mode refuses run_python even when the model asks for it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-cr-'));
  app.setProjectRoot(dir);
  const r = await agentRun('run_python', { code: 'print(1)' }, { cleanRoom: true });
  assert.equal(r.toolLog.length, 1);
  assert.ok(r.toolLog[0].resultPreview.startsWith('BLOCKED'), 'got: ' + r.toolLog[0].resultPreview);
});

// Drives /api/agent through the real HTTP route. The fake Ollama returns one tool call
// (named by the test) and then a final answer. The tool name is passed via the model name.
async function agentRun(toolName, toolArgs, opts) {
  fakeScript = { name: toolName, args: toolArgs };
  const r = await req('POST', '/api/agent', { body: {
    model: 'scripted:' + Buffer.from(JSON.stringify(fakeScript)).toString('base64'),
    messages: [{ role: 'user', content: 'go' }],
    includeRe: !!opts.includeRe,
    includeCoding: true,
    cleanRoom: !!opts.cleanRoom,
  } });
  const text = await r.text();
  const events = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  const final = events.find((e) => e.type === 'done') || events.find((e) => e.type === 'final');
  return { final, toolLog: final.toolLog || [] };
}
let fakeScript = null;
