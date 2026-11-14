const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8080;
// Bind address. Defaults to loopback so a default install is not exposed to the
// network. Set HOST=0.0.0.0 (or your LAN IP) deliberately for remote access.
const HOST = process.env.HOST || '127.0.0.1';

// Prevent a single request error from crashing the whole server
// (moved to error logging section below)
// Mutable so backend auto-detection can override when BACKEND_TYPE is unset.
let BACKEND_TYPE = (process.env.BACKEND_TYPE || '').toLowerCase();
let BACKEND_URL = process.env.BACKEND_URL || process.env.OLLAMA_URL || '';
let OLLAMA = BACKEND_URL || 'http://127.0.0.1:11434';
const PUBLIC = path.join(__dirname, 'public');

// Auto-detect backend if not explicitly configured. Probes common backend ports.
async function detectBackend() {
  if (BACKEND_EXPLICIT) {
    if (!BACKEND_TYPE) BACKEND_TYPE = 'ollama';
    if (!BACKEND_URL) BACKEND_URL = 'http://127.0.0.1:11434';
    OLLAMA = BACKEND_URL;
    try { OLLAMA_URL = new URL(OLLAMA); } catch (e) {}
    IS_OPENAI_COMPAT = (BACKEND_TYPE === 'llamacpp' || BACKEND_TYPE === 'lmstudio' || BACKEND_TYPE === 'openai');
    console.log('Backend (explicit):', BACKEND_TYPE, 'at', BACKEND_URL);
    return;
  }
  const probes = [
    { type: 'ollama', url: 'http://127.0.0.1:11434', path: '/api/version' },
    { type: 'lmstudio', url: 'http://127.0.0.1:1234', path: '/v1/models' },
    { type: 'llamacpp', url: 'http://127.0.0.1:8080', path: '/v1/models' },
    { type: 'llamacpp', url: 'http://127.0.0.1:8081', path: '/v1/models' },
    { type: 'openai', url: 'http://127.0.0.1:8000', path: '/v1/models' },
  ];
  for (const p of probes) {
    try {
      const r = await fetch(p.url + p.path, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        BACKEND_TYPE = p.type;
        BACKEND_URL = p.url;
        OLLAMA = p.url;
        try { OLLAMA_URL = new URL(OLLAMA); } catch (e) {}
        IS_OPENAI_COMPAT = (BACKEND_TYPE === 'llamacpp' || BACKEND_TYPE === 'lmstudio' || BACKEND_TYPE === 'openai');
        console.log('Auto-detected backend:', p.type, 'at', p.url);
        return;
      }
    } catch (e) {}
  }
  // Default to Ollama if nothing detected
  if (!BACKEND_TYPE) {
    BACKEND_TYPE = 'ollama';
    BACKEND_URL = BACKEND_URL || 'http://127.0.0.1:11434';
    OLLAMA = BACKEND_URL;
    try { OLLAMA_URL = new URL(OLLAMA); } catch (e) {}
    IS_OPENAI_COMPAT = (BACKEND_TYPE === 'llamacpp' || BACKEND_TYPE === 'lmstudio' || BACKEND_TYPE === 'openai');
    console.log('No backend detected; defaulting to Ollama at', BACKEND_URL);
  }
}

// Track whether the backend was explicitly configured.
const BACKEND_EXPLICIT = !!process.env.BACKEND_TYPE || !!process.env.BACKEND_URL || !!process.env.OLLAMA_URL;

// Defaults for module-level use (overridden by detectBackend at startup).
if (!BACKEND_URL) BACKEND_URL = 'http://127.0.0.1:11434';
if (!BACKEND_TYPE) BACKEND_TYPE = '';   // empty => auto-detect
OLLAMA = BACKEND_URL;
let OLLAMA_URL = new URL(OLLAMA);
let IS_OPENAI_COMPAT = (BACKEND_TYPE === 'llamacpp' || BACKEND_TYPE === 'lmstudio' || BACKEND_TYPE === 'openai');

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
    const lines = buf.split('\n');
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
        if (delta.reasoning_content) {
          if (onChunk) onChunk({ type: 'thinking', content: delta.reasoning_content });
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


// Maximum accepted HTTP request body (bytes). Guards against memory-exhaustion
// attacks on the JSON upload endpoints.
let _scanCache = null;
const MAX_BODY_BYTES = parseInt(process.env.AEGISAI_MAX_BODY || (100 * 1024 * 1024), 10);
// Optional allow-list for the agent project root (AEGISAI_PROJECT_ROOT_ALLOWLIST).
// Entries are separated by the platform path-list separator (or ';').
const PROJECT_ROOT_ALLOWLIST = (process.env.AEGISAI_PROJECT_ROOT_ALLOWLIST || '')
  .split(/[;]|:(?!\\|\/)/).map((s) => s.trim()).filter(Boolean)
  .map((s) => path.resolve(s));
// Total tool budget for the agent (coding tools are always included).
const TOOL_BUDGET = Math.max(1, parseInt(process.env.AEGISAI_TOOL_BUDGET || '64', 10));

// Resolve the ollama binary (may not be on PATH on Windows)
function resolveOllamaBin() {
  if (process.env.OLLAMA_BIN && fs.existsSync(process.env.OLLAMA_BIN)) return process.env.OLLAMA_BIN;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
    'C:\\Program Files\\Ollama\\ollama.exe',
    'C:\\Program Files (x86)\\Ollama\\ollama.exe',
  ];
  for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
  // try where
  try {
    const { execSync } = require('child_process');
    const out = execSync('where ollama', { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
    const first = (out || '').trim().split(/\r?\n/)[0];
    if (first && fs.existsSync(first)) return first;
  } catch (_) {}
  return 'ollama';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------- Process helpers ----------
// Always spawn without a shell so user-supplied values can never be interpreted
// by cmd.exe / sh. This is the single most important process-safety primitive.
function runProcess(file, args, opts) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    try {
      execFile(file, Array.isArray(args) ? args : [], Object.assign({
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }, opts || {}), (err, stdout, stderr) => {
        resolve({
          ok: !err,
          out: (stdout || '') + (stderr || ''),
          err: err ? (err.message || String(err)) : null,
          code: err ? (err.code || 1) : 0,
        });
      });
    } catch (e) {
      resolve({ ok: false, out: '', err: e.message || String(e), code: 1 });
    }
  });
}

// Ollama model references: name[:tag] or namespace/name[:tag]. Rejects whitespace,
// quotes, and option-like leading dashes.
function isValidModelName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,199}$/.test(name);
}

// SSRF guard: only http(s) URLs whose host is not a loopback/private/link-local
// or otherwise reserved address. Best-effort on the hostname string (no DNS).
function isSafeUrl(u) {
  if (typeof u !== 'string' || !u) return false;
  let parsed;
  try { parsed = new URL(u); } catch (e) { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = (parsed.hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host === '::1' || host === '0.0.0.0') return false;
  // IPv4 private/reserved ranges
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 0) return false;
    if (a === 169 && b === 254) return false;   // link-local
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  }
  // IPv6 private/link-local/loopback (bracketed hostname already stripped by URL)
  if (host.startsWith('[')) return false;
  if (/^(fc|fd|fe80|::1)/i.test(host)) return false;
  return true;
}

// ---------- Anonymous Error Logging ----------
const ERROR_LOG_FILE = path.join(process.env.AEGISAI_DATA_DIR || __dirname, 'error.log');
const MAX_ERROR_LOG_SIZE = 100 * 1024; // 100KB max

function sanitizeForLog(text) {
  if (!text) return '';
  let s = String(text);
  // Remove potential API keys / tokens (long alphanumeric strings)
  s = s.replace(/[A-Za-z0-9_-]{32,}/g, '[REDACTED]');
  // Sanitize file paths: replace username in paths
  s = s.replace(/C:\\Users\\[^\\]+/gi, 'C:\\Users\\[USER]');
  s = s.replace(/\/home\/[^\/]+/g, '/home/[USER]');
  s = s.replace(/\/Users\/[^\/]+/g, '/Users/[USER]');
  return s;
}

function logError(context, error) {
  try {
    const fs = require('fs');
    const entry = {
      ts: new Date().toISOString(),
      v: (function() { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; } catch (e) { return 'unknown'; } })(),
      ctx: sanitizeForLog(context),
      msg: sanitizeForLog(error && error.message ? error.message : String(error)),
      stack: sanitizeForLog(error && error.stack ? error.stack : ''),
    };
    let line = JSON.stringify(entry) + '\n';
    // Rotate if too large
    if (fs.existsSync(ERROR_LOG_FILE)) {
      const stat = fs.statSync(ERROR_LOG_FILE);
      if (stat.size > MAX_ERROR_LOG_SIZE) {
        // Keep last half
        const content = fs.readFileSync(ERROR_LOG_FILE, 'utf8');
        const lines = content.split('\n');
        const half = lines.slice(Math.floor(lines.length / 2));
        fs.writeFileSync(ERROR_LOG_FILE, half.join('\n'), 'utf8');
      }
    }
    fs.appendFileSync(ERROR_LOG_FILE, line, 'utf8');
  } catch (e) {
    // Silently fail - don't let logging crash the server
  }
}

// Global error handlers
process.on('uncaughtException', (err) => {
  logError('uncaughtException', err);
  console.error('Uncaught exception:', err && err.message);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', reason);
});

// ---------- MCP client (REA) ----------
let mcpClient = null;
let mcpTools = []; // MCP tool descriptors (REA)
let mcpReady = false;
let mcpError = null;

// Awesome-reverse-engineered MCP (optional, requires uv)
let areClient = null;
let areTools = [];
let areReady = false;
let areError = null;

// GhidrAssistMCP (optional, requires Ghidra + GhidrAssistMCP extension)
let ghidraClient = null;
let ghidraTools = [];
let ghidraReady = false;
let ghidraError = null;

// Craft Anything MCP (optional, requires craft-anything-cli binary)
let craftClient = null;
let craftTools = [];
let craftReady = false;
let craftError = null;

function resolveReaBin() {
  if (process.env.REA_BIN && fs.existsSync(process.env.REA_BIN)) return process.env.REA_BIN;
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'rea.cmd'),
    path.join(process.env.APPDATA || '', 'npm', 'rea'),
    'C:\\Program Files\\rea\\rea.exe',
  ];
  for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
  try {
    const { execSync } = require('child_process');
    const out = execSync('where rea', { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
    const first = (out || '').trim().split(/\r?\n/)[0];
    if (first && fs.existsSync(first)) return first;
  } catch (_) {}
  return 'rea';
}

async function initMcp() {
  try {
    let Client, StdioClientTransport;
    try {
      const sdk = require('@modelcontextprotocol/sdk/client');
      Client = sdk.Client;
      const stdio = require('@modelcontextprotocol/sdk/client/stdio.js');
      StdioClientTransport = stdio.StdioClientTransport;
    } catch (e) {
      // Try alternate require paths
      try {
        const sdk = require('@modelcontextprotocol/sdk');
        Client = sdk.Client;
        StdioClientTransport = sdk.StdioClientTransport;
      } catch (e2) {
        throw new Error('MCP SDK missing. In the AegisAI folder run: npm install  (then restart the server). If npm is not on PATH, install Node.js from https://nodejs.org first. Underlying error: ' + (e.message || e));
      }
    }
    const reaBin = resolveReaBin();
    console.log('Using rea binary:', reaBin);
    const transport = new StdioClientTransport({
      command: reaBin,
      args: ['--mcp'],
      env: Object.assign({}, process.env, { PATH: (process.env.PATH || '') + path.delimiter + path.dirname(reaBin) }),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'local-ai', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const res = await client.listTools();
    mcpTools = res.tools || [];
    mcpClient = client;
    mcpReady = true;
    console.log('REA MCP ready. Tools:', mcpTools.length);
  } catch (e) {
    mcpError = e && e.message ? e.message : String(e);
    mcpReady = false;
    console.error('REA MCP init failed:', mcpError);
    // Provide helpful hint
    if (/not recognized|ENOENT|not found/i.test(mcpError)) {
      mcpError += ' - REA (rea-agents) may not be installed. Run: npm install -g rea-agents';
    }
  }
}

async function initAwesomeReMcp() {
  // Check if uv is available
  try {
    const { execSync } = require('child_process');
    execSync('uv --version', { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
  } catch (_) {
    areError = 'uv not found. Install from https://docs.astral.sh/uv/ to enable reverse-engineered project search.';
    areReady = false;
    console.log('Awesome-RE MCP skipped:', areError);
    return;
  }
  try {
    let Client, StdioClientTransport;
    try {
      const sdk = require('@modelcontextprotocol/sdk/client');
      Client = sdk.Client;
      const stdio = require('@modelcontextprotocol/sdk/client/stdio.js');
      StdioClientTransport = stdio.StdioClientTransport;
    } catch (e) {
      try {
        const sdk = require('@modelcontextprotocol/sdk');
        Client = sdk.Client;
        StdioClientTransport = sdk.StdioClientTransport;
      } catch (e2) {
        throw new Error('MCP SDK not installed. Run: npm install in the AegisAI folder.');
      }
    }
    const transport = new StdioClientTransport({
      command: 'uvx',
      args: ['--from', 'git+https://github.com/alexgaoth/awesome-reverse-engineered#subdirectory=mcp', 'reverse-engineered-mcp'],
      env: Object.assign({}, process.env),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'aegisai-are', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const res = await client.listTools();
    areTools = res.tools || [];
    areClient = client;
    areReady = true;
    console.log('Awesome-RE MCP ready. Tools:', areTools.length);
  } catch (e) {
    areError = e && e.message ? e.message : String(e);
    areReady = false;
    console.error('Awesome-RE MCP init failed:', areError);
  }
}

async function initGhidrAssistMcp() {
  const url = process.env.GHIDRASSIST_MCP_URL || 'http://localhost:8081/mcp';
  try {
    let Client, StreamableHTTPClientTransport;
    try {
      const sdk = require('@modelcontextprotocol/sdk/client');
      Client = sdk.Client;
      const http = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
      StreamableHTTPClientTransport = http.StreamableHTTPClientTransport;
    } catch (e) {
      try {
        const sdk = require('@modelcontextprotocol/sdk');
        Client = sdk.Client;
        StreamableHTTPClientTransport = sdk.StreamableHTTPClientTransport;
      } catch (e2) {
        throw new Error('MCP SDK not installed. Run: npm install in the AegisAI folder.');
      }
    }
    const transport = new StreamableHTTPClientTransport(new URL(url), {});
    const client = new Client({ name: 'aegisai-ghidra', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const res = await client.listTools();
    ghidraTools = res.tools || [];
    ghidraClient = client;
    ghidraReady = true;
    console.log('GhidrAssistMCP ready. Tools:', ghidraTools.length, 'from', url);
  } catch (e) {
    ghidraError = e && e.message ? e.message : String(e);
    ghidraReady = false;
    // Only log if it's not a connection refused (expected when Ghidra isn't running)
    if (!/ECONNREFUSED|fetch failed|not found/i.test(ghidraError)) {
      console.error('GhidrAssistMCP init failed:', ghidraError);
    } else {
      console.log('GhidrAssistMCP not available (Ghidra not running or extension not installed).');
    }
  }
}

function resolveCraftBin() {
  if (process.env.CRAFT_ANYTHING_BIN && fs.existsSync(process.env.CRAFT_ANYTHING_BIN)) return process.env.CRAFT_ANYTHING_BIN;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'craft-anything', 'craft-anything-cli.exe'),
    path.join(process.env.PROGRAMFILES || '', 'craft-anything', 'craft-anything-cli.exe'),
    path.join(process.env.HOME || '', '.cargo', 'bin', 'craft-anything-cli'),
    '/usr/local/bin/craft-anything-cli',
    '/usr/bin/craft-anything-cli',
  ];
  for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
  try {
    const { execSync } = require('child_process');
    const cmd = process.platform === 'win32' ? 'where craft-anything-cli' : 'which craft-anything-cli';
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
    const first = (out || '').trim().split(/\r?\n/)[0];
    if (first && fs.existsSync(first)) return first;
  } catch (_) {}
  return null;
}

async function initCraftMcp() {
  const bin = resolveCraftBin();
  if (!bin) {
    craftError = 'craft-anything-cli not found. Install from https://github.com/storytold/craft-anything';
    craftReady = false;
    console.log('Craft Anything MCP skipped:', craftError);
    return;
  }
  try {
    let Client, StdioClientTransport;
    try {
      const sdk = require('@modelcontextprotocol/sdk/client');
      Client = sdk.Client;
      const stdio = require('@modelcontextprotocol/sdk/client/stdio.js');
      StdioClientTransport = stdio.StdioClientTransport;
    } catch (e) {
      try {
        const sdk = require('@modelcontextprotocol/sdk');
        Client = sdk.Client;
        StdioClientTransport = sdk.StdioClientTransport;
      } catch (e2) {
        throw new Error('MCP SDK not installed. Run: npm install in the AegisAI folder.');
      }
    }
    const transport = new StdioClientTransport({
      command: bin,
      args: ['mcp'],
      env: Object.assign({}, process.env),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'aegisai-craft', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    const res = await client.listTools();
    craftTools = res.tools || [];
    craftClient = client;
    craftReady = true;
    console.log('Craft Anything MCP ready. Tools:', craftTools.length);
  } catch (e) {
    craftError = e && e.message ? e.message : String(e);
    craftReady = false;
    if (!/ENOENT|not found|not recognized/i.test(craftError)) {
      console.error('Craft Anything MCP init failed:', craftError);
    } else {
      console.log('Craft Anything MCP not available.');
    }
  }
}

function mcpToolsAsOllama() {
  const tools = mcpTools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: (t.description || '').slice(0, 120),
      parameters: t.inputSchema || { type: 'object', properties: {} },
    },
  }));
  // Add awesome-re tools (prefixed to avoid collisions)
  if (areReady) {
    for (const t of areTools) {
      tools.push({
        type: 'function',
        function: {
          name: 'are_' + t.name,
          description: ((t.description || '') + ' [from awesome-reverse-engineered index]').slice(0, 120),
          parameters: t.inputSchema || { type: 'object', properties: {} },
        },
      });
    }
  }
  // Add GhidrAssistMCP tools (prefixed to avoid collisions)
  if (ghidraReady) {
    for (const t of ghidraTools) {
      tools.push({
        type: 'function',
        function: {
          name: 'ghidra_' + t.name,
          description: ((t.description || '') + ' [from GhidrAssistMCP]').slice(0, 120),
          parameters: t.inputSchema || { type: 'object', properties: {} },
        },
      });
    }
  }
  // Add Craft Anything tools (prefixed to avoid collisions)
  if (craftReady) {
    for (const t of craftTools) {
      tools.push({
        type: 'function',
        function: {
          name: 'craft_' + t.name,
          description: ((t.description || '') + ' [from Craft Anything]').slice(0, 120),
          parameters: t.inputSchema || { type: 'object', properties: {} },
        },
      });
    }
  }
  return tools;
}

function mcpToolAsOllama(t, prefix, suffix) {
  return {
    type: 'function',
    function: {
      name: prefix + t.name,
      description: ((t.description || '') + suffix).slice(0, 120),
      parameters: t.inputSchema || { type: 'object', properties: {} },
    },
  };
}

// Clean-room mode must never reach tools that read original code, files, binaries,
// or arbitrary code. Matched by exact name or by substring for RE tool families.
const CLEAN_ROOM_EXACT = new Set([
  'read_file', 'write_file', 'replace_in_file', 'list_files', 'run_command', 'run_python',
  'skill_run', 'skill_save', 'skill_get', 'git_status', 'git_diff', 'read_pdf', 'analyze_image',
  'speech_to_text', 'fetch_url', 'web_search',
]);
const CLEAN_ROOM_PATTERNS = ['inspect_', 'decompile', 'disassemble', 'get_pseudocode', 'get_disassembly', 'get_hexdump', 'list_strings', 'list_imports', 'list_exports', 'get_function', 'get_control_flow_graph', 'get_callers', 'get_callees', 'get_xrefs', 'get_comment', 'list_function_variables', 'rename_local_variable', 'set_local_variable', 'set_function_prototype', 'list_data_types', 'get_data_type', 'set_data_type', 'create_structure', 'set_structure_field', 'infer_structure', 'get_structure_field_xrefs', 'list_classes', 'get_class_info', 'analyze_program', 'get_analysis_status', 'list_tasks', 'get_task_status', 'cancel_task', 'open_program', 'close_program', 'import_file', 'export_program', 'read_', 'write_', 'file', 'binary', 'source'];
function isCleanRoomBlocked(name) {
  const n = String(name || '');
  if (CLEAN_ROOM_EXACT.has(n)) return true;
  return CLEAN_ROOM_PATTERNS.some((p) => n.includes(p));
}

// Tool result cache (5-minute TTL)
const _toolCache = new Map();

// Pending tool-confirmations: id -> { resolve, timer }
const _pendingConfirms = new Map();
function requestConfirmation(id, name, args, signal, onEvent) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      _pendingConfirms.delete(id);
      resolve(false);
    }, 60000);
    _pendingConfirms.set(id, { resolve: (approved) => { clearTimeout(timer); _pendingConfirms.delete(id); resolve(approved); }, timer });
    if (onEvent) onEvent({ type: 'confirm', id, name, args });
    if (signal) {
      const onAbort = () => { clearTimeout(timer); _pendingConfirms.delete(id); resolve(false); };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
const TOOL_CACHE_MAX = 500;
function toolCacheKey(name, args) { return name + ':' + JSON.stringify(args || {}); }
function toolCacheSet(key, value) {
  _toolCache.delete(key);
  _toolCache.set(key, value);
  while (_toolCache.size > TOOL_CACHE_MAX) _toolCache.delete(_toolCache.keys().next().value);
}

// Tools that should never be cached (mutating, polling, status checks)
const NO_CACHE_PATTERNS = /status|poll|open|close|delete|write|create|update|set_|move|copy|remove|rename|exec|run_|call_|start|stop|restart|launch|add_|modify_|patch_|append_|insert_|comment|label|tag_/i;
function isCacheableTool(name) {
  return !NO_CACHE_PATTERNS.test(name);
}

async function callMcpTool(name, args) {
  // Check cache first (only for read-only tools)
  const cacheKey = toolCacheKey(name, args);
  const cached = _toolCache.get(cacheKey);
  if (isCacheableTool(name) && cached && (Date.now() - cached.ts) < 2 * 60 * 1000) {
    return cached.result + '\n[cached]';
  }
  // Route to awesome-re client if prefixed
  if (name.startsWith('are_')) {
    if (!areClient) throw new Error('Awesome-RE MCP not ready: ' + (areError || 'unknown'));
    const origName = name.slice(4);
    const r = await areClient.callTool({ name: origName, arguments: args || {} });
    let text = '';
    if (r && r.content) {
      for (const c of r.content) {
        if (c.type === 'text') text += c.text;
        else text += JSON.stringify(c);
      }
    }
    if (r && r.isError) text = 'ERROR: ' + text;
    if (isCacheableTool(name)) toolCacheSet(cacheKey, { result: text, ts: Date.now() });
    return text;
  }
  // Route to GhidrAssistMCP client if prefixed
  if (name.startsWith('ghidra_')) {
    if (!ghidraClient) throw new Error('GhidrAssistMCP not ready: ' + (ghidraError || 'unknown'));
    const origName = name.slice(7);
    const r = await ghidraClient.callTool({ name: origName, arguments: args || {} });
    let text = '';
    if (r && r.content) {
      for (const c of r.content) {
        if (c.type === 'text') text += c.text;
        else text += JSON.stringify(c);
      }
    }
    if (r && r.isError) text = 'ERROR: ' + text;
    if (isCacheableTool(name)) toolCacheSet(cacheKey, { result: text, ts: Date.now() });
    return text;
  }
  // Route to Craft Anything client if prefixed
  if (name.startsWith('craft_')) {
    if (!craftClient) throw new Error('Craft Anything MCP not ready: ' + (craftError || 'unknown'));
    const origName = name.slice(6);
    const r = await craftClient.callTool({ name: origName, arguments: args || {} });
    let text = '';
    if (r && r.content) {
      for (const c of r.content) {
        if (c.type === 'text') text += c.text;
        else text += JSON.stringify(c);
      }
    }
    if (r && r.isError) text = 'ERROR: ' + text;
    if (isCacheableTool(name)) toolCacheSet(cacheKey, { result: text, ts: Date.now() });
    return text;
  }
  if (!mcpClient) throw new Error('MCP not ready: ' + (mcpError || 'unknown'));
  const r = await mcpClient.callTool({ name, arguments: args || {} });
  // Normalize content to text
  let text = '';
  if (r && r.content) {
    for (const c of r.content) {
      if (c.type === 'text') text += c.text;
      else text += JSON.stringify(c);
    }
  }
  if (r && r.isError) text = 'ERROR: ' + text;
  toolCacheSet(cacheKey, { result: text, ts: Date.now() });
  return text;
}

// ---------- Coding tools (hands-on file/shell) ----------
let projectRoot = path.join(__dirname, 'workspace');

function safePath(rel) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const resolved = path.resolve(root, rel || '.');
  // Resolve symlinks in any existing portion to prevent escape via links.
  let realResolved = resolved;
  try { realResolved = fs.realpathSync(resolved); }
  catch (e) {
    try { realResolved = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved)); }
    catch (e2) { realResolved = resolved; }
  }
  if (realResolved !== root && !realResolved.startsWith(root + path.sep)) {
    throw new Error('Path escapes project root: ' + rel);
  }
  return realResolved;
}

// Validate a user-supplied project root. When AEGISAI_PROJECT_ROOT_ALLOWLIST is
// set the root must live inside one of the allow-listed directories; otherwise
// any existing directory is accepted (with a warning when it leaves the app dir).
function validateProjectRoot(root) {
  if (!root || typeof root !== 'string') throw Object.assign(new Error('Project root must be a non-empty string'), { status: 400 });
  const resolved = path.resolve(root.trim());
  let realResolved = resolved;
  try { realResolved = fs.realpathSync(resolved); } catch (e) { /* handled below */ }
  let stat = null;
  try { stat = fs.statSync(resolved); } catch (e) { /* handled below */ }
  if (!stat || !stat.isDirectory()) throw Object.assign(new Error('Project root does not exist or is not a directory: ' + root), { status: 400 });
  if (PROJECT_ROOT_ALLOWLIST.length) {
    const allowed = PROJECT_ROOT_ALLOWLIST.some((base) => realResolved === base || realResolved.startsWith(base + path.sep));
    if (!allowed) throw Object.assign(new Error('Project root is outside the allowed directories (AEGISAI_PROJECT_ROOT_ALLOWLIST)'), { status: 403 });
  } else if (!realResolved.startsWith(path.resolve(__dirname) + path.sep) && realResolved !== path.resolve(__dirname)) {
    console.warn('WARNING: project root is outside the app directory:', realResolved);
  }
  return realResolved;
}

const codingToolsDef = [
  { name: 'list_files', description: 'List files and folders in a directory relative to the project root.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative directory path (default ".")' } } } },
  { name: 'read_file', description: 'Read the contents of a file relative to the project root.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative file path' }, max_bytes: { type: 'integer', description: 'Max bytes to read (default 200000)' } }, required: ['path'] } },
  { name: 'write_file', description: 'Write (overwrite) a file relative to the project root. Creates parent dirs.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'replace_in_file', description: 'Replace an exact text snippet in a file (first occurrence). Safer than full rewrite.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'run_command', description: 'Run a shell command in the project root. Returns stdout/stderr/exit code. Timeout 60s.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'git_status', description: 'Run git status in the project root.', parameters: { type: 'object', properties: {} } },
  { name: 'git_diff', description: 'Run git diff in the project root.', parameters: { type: 'object', properties: {} } },
  { name: 'fetch_url', description: 'Fetch a URL and return its text content (truncated).', parameters: { type: 'object', properties: { url: { type: 'string' }, max_bytes: { type: 'integer' } }, required: ['url'] } },
  { name: 'web_search', description: 'Search the web (DuckDuckGo) and return titles, snippets, and URLs.', parameters: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer' } }, required: ['query'] } },
  { name: 'read_pdf', description: 'Extract text from a PDF file (relative to project root).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'screenshot', description: 'Capture the primary screen to a PNG in the project root; returns the file path.', parameters: { type: 'object', properties: { filename: { type: 'string' } } } },
  { name: 'memory_recall', description: 'Recall a saved memory by key, or list all keys if no key given.', parameters: { type: 'object', properties: { key: { type: 'string' } } } },
  { name: 'run_python', description: 'Run a Python snippet and return stdout/stderr.', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
];

function codingToolsAsOllama() {
  return codingToolsDef.map((t) => ({
    type: 'function',
    function: { name: t.name, description: (t.description || '').slice(0, 120), parameters: t.parameters },
  }));
}

function isDangerousCmd(cmd) {
  const lc = cmd.toLowerCase();
  const blocked = ['format ', 'del /f /s', 'rd /s', 'rmdir /s', 'rm -rf /', 'remove-item -recurse -force c:\\', ':\\windows', 'shutdown', 'reg delete', 'cipher /w'];
  return blocked.some((b) => lc.includes(b));
}

async function httpGet(url, headers) {
  const https = require('https');
  const http = require('http');
  const lib = url.startsWith('https') ? https : http;
  const MAX = 2 * 1024 * 1024;
  return new Promise((resolve) => {
    const req = lib.get(url, { headers: headers || { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let chunks = [];
      let size = 0;
      let tooBig = false;
      res.on('data', (c) => {
        if (tooBig) return;
        size += c.length;
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString('utf8') + (tooBig ? '\n... (truncated)' : '') }));
    });
    req.on('error', (e) => resolve({ status: 0, data: 'ERROR: ' + e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, data: 'TIMEOUT' }); });
  });
}

async function execCodingTool(name, args) {
  const fs = require('fs');
  if (name === 'list_files') {
    const dir = safePath(args.path || '.');
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.map((e) => (e.isDirectory() ? '[dir] ' : '[file] ') + e.name).join('\n') || '(empty)';
  }
  if (name === 'read_file') {
    const fp = safePath(args.path);
    const max = Math.max(1, Math.min(parseInt(args.max_bytes, 10) || 200000, 5 * 1024 * 1024));
    const total = fs.statSync(fp).size;
    const fd = fs.openSync(fp, 'r');
    let slice;
    try {
      slice = Buffer.alloc(Math.min(max, total));
      fs.readSync(fd, slice, 0, slice.length, 0);
    } finally { fs.closeSync(fd); }
    let text = slice.toString('utf8');
    if (total > max) text += '\n... (truncated, ' + total + ' bytes total)';
    return text;
  }
  if (name === 'write_file') {
    const fp = safePath(args.path);
    const dir = path.dirname(fp);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, args.content, 'utf8');
    return 'Wrote ' + fs.statSync(fp).size + ' bytes to ' + args.path;
  }
  if (name === 'run_command') {
    if (isDangerousCmd(args.command)) return 'BLOCKED: command matched safety filter.';
    if ((process.env.AEGISAI_SANDBOX || '').toLowerCase() === 'docker') {
      const r = await runProcess('docker', ['run', '--rm', '--network', 'none', '--memory', '256m', '--cpus', '1', '-v', projectRoot + ':/work', '-w', '/work', 'alpine:3.20', 'sh', '-c', args.command], { timeout: 60000, maxBuffer: 1024 * 1024 });
      if (!r.ok && r.err) return 'EXIT ' + r.code + '\n' + (r.out || r.err);
      return r.out || '(no output)';
    }
    const { execSync } = require('child_process');
    try {
      const out = execSync(args.command, { cwd: projectRoot, timeout: 60000, maxBuffer: 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return out || '(no output)';
    } catch (e) {
      return 'EXIT ' + (e.status || '?') + '\nSTDOUT:\n' + (e.stdout || '') + '\nSTDERR:\n' + (e.stderr || '') + '\n' + (e.message || '');
    }
  }
  if (name === 'git_status' || name === 'git_diff') {
    const r = await runProcess('git', [name === 'git_status' ? 'status' : 'diff'], { cwd: projectRoot, timeout: 30000 });
    return r.ok ? r.out : (r.out || r.err || 'git failed');
  }
  if (name === 'replace_in_file') {
    const fp = safePath(args.path);
    const fs = require('fs');
    const text = fs.readFileSync(fp, 'utf8');
    if (!text.includes(args.old_text)) return 'old_text not found in file.';
    const updated = text.replace(args.old_text, args.new_text);
    fs.writeFileSync(fp, updated, 'utf8');
    return 'Replaced one occurrence in ' + args.path;
  }
  if (name === 'fetch_url') {
    if (!isSafeUrl(args.url)) return 'BLOCKED: URL is not allowed (only public http(s) URLs).';
    const http = require('http');
    const https = require('https');
    const max = args.max_bytes || 100000;
    return new Promise((resolve) => {
      const lib = args.url.startsWith('https') ? https : http;
      const req = lib.get(args.url, (res) => {
        let data = '';
        res.on('data', (c) => { if (data.length < max) data += c; });
        res.on('end', () => resolve(data.slice(0, max) || '(empty)'));
      });
      req.on('error', (e) => resolve('ERROR: ' + e.message));
      req.setTimeout(20000, () => { req.destroy(); resolve('TIMEOUT'); });
    });
  }
  if (name === 'web_search') {
    const cfg = loadSearchConfig();
    const engine = (cfg && cfg.engine) || 'duckduckgo';
    const max = args.max_results || 8;
    let result = '';
    if (engine === 'duckduckgo') {
      const r = await httpGet('https://api.duckduckgo.com/?q=' + encodeURIComponent(args.query) + '&format=json&no_html=1&skip_disambig=0', {});
      try {
        const j = JSON.parse(r.data);
        const out = [];
        if (j.AbstractText) out.push('Abstract: ' + j.AbstractText + (j.AbstractURL ? '\n' + j.AbstractURL : ''));
        if (j.Answer) out.push('Answer: ' + j.Answer);
        if (Array.isArray(j.RelatedTopics)) {
          for (const t of j.RelatedTopics.slice(0, max)) {
            if (t.Text) out.push('- ' + t.Text + (t.FirstURL ? ' (' + t.FirstURL + ')' : ''));
            if (t.Topics) for (const st of t.Topics.slice(0, 3)) if (st.Text) out.push('  - ' + st.Text);
          }
        }
        result = out.length ? out.join('\n') : 'No instant results. Try fetch_url with a specific URL.';
      } catch (e) { result = 'ERROR parsing: ' + e.message; }
    } else if (engine === 'wikipedia') {
      const r = await httpGet('https://en.wikipedia.org/w/api.php?action=opensearch&search=' + encodeURIComponent(args.query) + '&limit=' + max + '&namespace=0&format=json', { 'User-Agent': 'LocalAI' });
      try {
        const j = JSON.parse(r.data);
        const titles = j[1] || [];
        const descs = j[2] || [];
        const urls = j[3] || [];
        const out = [];
        for (let i = 0; i < titles.length && i < max; i++) {
          out.push('- ' + titles[i] + ' (' + urls[i] + ')' + (descs[i] ? '\n  ' + descs[i] : ''));
        }
        result = out.length ? out.join('\n') : 'No results.';
      } catch (e) { result = 'ERROR parsing: ' + e.message; }
    } else if (engine === 'searxng') {
      const instance = (cfg && cfg.searxngInstance) || 'https://searx.be';
      const r = await httpGet(instance.replace(/\/$/, '') + '/search?q=' + encodeURIComponent(args.query) + '&format=json', { 'User-Agent': 'LocalAI', 'Accept': 'application/json' });
      try {
        const j = JSON.parse(r.data);
        const out = [];
        const results = (j.results || []).slice(0, max);
        for (const it of results) out.push('- ' + (it.title || '') + ' (' + (it.url || '') + ')' + (it.content ? '\n  ' + it.content : ''));
        result = out.length ? out.join('\n') : 'No results.';
      } catch (e) { result = 'ERROR parsing: ' + e.message + ' ' + (r.data || '').slice(0, 200); }
    } else if (engine === 'searxng-fws') {
      const instance = (cfg && cfg.searxngFwsInstance) || 'https://search.sapti.me';
      const r = await httpGet(instance.replace(/\/$/, '') + '/search?q=' + encodeURIComponent(args.query) + '&format=json', { 'User-Agent': 'LocalAI', 'Accept': 'application/json' });
      try {
        const j = JSON.parse(r.data);
        const out = [];
        const results = (j.results || []).slice(0, max);
        for (const it of results) out.push('- ' + (it.title || '') + ' (' + (it.url || '') + ')' + (it.content ? '\n  ' + it.content : ''));
        result = out.length ? out.join('\n') : 'No results.';
      } catch (e) { result = 'ERROR parsing: ' + e.message + ' ' + (r.data || '').slice(0, 200); }
    } else if (engine === 'google-html') {
      const r = await httpGet('https://www.google.com/search?q=' + encodeURIComponent(args.query) + '&hl=en&num=' + max, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' });
      const out = [];
      const re = /<a[^>]*href="\/url\?q=([^"&]+)[^"]*"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
      let m;
      while ((m = re.exec(r.data)) && out.length < max) {
        try {
          const url = decodeURIComponent(m[1]);
          const title = m[2].replace(/<[^>]+>/g, '').trim();
          if (title && url.startsWith('http')) out.push('- ' + title + ' (' + url + ')');
        } catch (e) {}
      }
      if (!out.length) {
        const re2 = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
        let m2;
        while ((m2 = re2.exec(r.data)) && out.length < max) {
          const title = m2[1].replace(/<[^>]+>/g, '').trim();
          if (title) out.push('- ' + title);
        }
      }
      result = out.length ? out.join('\n') : 'No results (Google may have blocked the request).';
    } else if (engine === 'firecrawl') {
      const instance = ((cfg && cfg.firecrawlInstance) || 'http://localhost:3002').replace(/\/$/, '');
      const body = JSON.stringify({ query: args.query, limit: max });
      const r = await new Promise((resolve) => {
        const lib = instance.startsWith('https') ? require('https') : require('http');
        const req = lib.request(instance + '/v1/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, data }));
        });
        req.on('error', (e) => resolve({ status: 0, data: 'ERROR: ' + e.message }));
        req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, data: 'TIMEOUT' }); });
        req.write(body);
        req.end();
      });
      try {
        const j = JSON.parse(r.data);
        const out = [];
        const results = (j.data || j.results || []).slice(0, max);
        for (const it of results) {
          const title = it.title || (it.metadata && it.metadata.title) || '';
          const url = it.url || (it.metadata && it.metadata.sourceURL) || '';
          const desc = it.description || it.markdown || (it.content || '').slice(0, 200);
          out.push('- ' + title + (url ? ' (' + url + ')' : '') + (desc ? '\n  ' + String(desc).slice(0, 200) : ''));
        }
        if (r.status !== 200) result = 'ERROR (HTTP ' + r.status + '): ' + r.data.slice(0, 300);
        else result = out.length ? out.join('\n') : 'No results. (Is Firecrawl running at ' + instance + '?)';
      } catch (e) { result = 'ERROR parsing: ' + e.message + ' ' + (r.data || '').slice(0, 200); }
    } else if (engine === 'dokobot') {
      const seen = new Set();
      const out = [];
      async function collect(url, parseFn) {
        const r = await httpGet(url, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' });
        parseFn(r.data);
      }
      // Google
      try {
        await collect('https://www.google.com/search?q=' + encodeURIComponent(args.query) + '&hl=en&num=' + max, (html) => {
          const re = /<a[^>]*href="\/url\?q=([^"&]+)[^"]*"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
          let m;
          while ((m = re.exec(html)) && out.length < max * 2) {
            try {
              const url = decodeURIComponent(m[1]);
              const title = m[2].replace(/<[^>]+>/g, '').trim();
              if (title && url.startsWith('http') && !seen.has(url)) { seen.add(url); out.push('- ' + title + ' (' + url + ')'); }
            } catch (e) {}
          }
        });
      } catch (e) {}
      // Bing
      try {
        await collect('https://www.bing.com/search?q=' + encodeURIComponent(args.query) + '&count=' + max, (html) => {
          const re = /<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/gi;
          let m;
          while ((m = re.exec(html)) && out.length < max * 2) {
            const url = m[1];
            const title = m[2].replace(/<[^>]+>/g, '').trim();
            if (title && url.startsWith('http') && !seen.has(url)) { seen.add(url); out.push('- ' + title + ' (' + url + ')'); }
          }
        });
      } catch (e) {}
      // Baidu
      try {
        await collect('https://www.baidu.com/s?wd=' + encodeURIComponent(args.query) + '&rn=' + max, (html) => {
          const re = /<h3[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h3>/gi;
          let m;
          while ((m = re.exec(html)) && out.length < max * 2) {
            const url = m[1];
            const title = m[2].replace(/<[^>]+>/g, '').trim();
            if (title && !seen.has(url)) { seen.add(url); out.push('- ' + title + ' (' + url + ')'); }
          }
        });
      } catch (e) {}
      result = out.length ? out.slice(0, max).join('\n') : 'No results (search engines may have blocked the request).';
    } else if (engine === 'internet-archive') {
      const rows = Math.min(max, 10);
      const r = await httpGet('https://archive.org/advancedsearch.php?q=' + encodeURIComponent(args.query) + '&fl[]=title&fl[]=identifier&fl[]=description&rows=' + rows + '&output=json', { 'User-Agent': 'LocalAI' });
      try {
        const j = JSON.parse(r.data);
        const docs = (j.response && j.response.docs) || [];
        const out = [];
        for (const d of docs.slice(0, max)) {
          const title = d.title || d.identifier || '';
          const id = d.identifier || '';
          const desc = (d.description || '').toString().slice(0, 200);
          out.push('- ' + title + ' (https://archive.org/details/' + id + ')' + (desc ? '\n  ' + desc : ''));
        }
        result = out.length ? out.join('\n') : 'No results.';
      } catch (e) { result = 'ERROR parsing: ' + e.message + ' ' + (r.data || '').slice(0, 200); }
    } else if (engine === 'tinyfish') {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: args.query } } });
      const r = await new Promise((resolve) => {
        const https = require('https');
        const req = https.request('https://agent.tinyfish.ai/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'X-TinyFish-Access-Mode': 'keyless', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
        });
        req.on('error', (e) => resolve({ status: 0, data: 'ERROR: ' + e.message }));
        req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, data: 'TIMEOUT' }); });
        req.write(body);
        req.end();
      });
      // Parse SSE or JSON
      let payload = r.data;
      // If SSE, extract last data: line
      if (payload.indexOf('data:') !== -1) {
        const lines = payload.split('\n');
        let last = '';
        for (const ln of lines) {
          if (ln.startsWith('data:')) last = ln.slice(5).trim();
        }
        if (last) payload = last;
      }
      try {
        const j = JSON.parse(payload);
        if (j.error) { result = 'ERROR: ' + (j.error.message || JSON.stringify(j.error)); }
        else {
          const content = (j.result && j.result.content) || [];
          let text = '';
          for (const c of content) { if (c.type === 'text') text += c.text; }
          // try parse text as JSON with results
          let parsed = null;
          try { parsed = JSON.parse(text); } catch (e) {}
          const out = [];
          const results = (parsed && (parsed.results || parsed.data || parsed.items)) || null;
          if (Array.isArray(results)) {
            for (const it of results.slice(0, max)) {
              out.push('- ' + (it.title || it.name || '') + ' (' + (it.url || it.link || '') + ')' + (it.snippet || it.description || it.content ? '\n  ' + (it.snippet || it.description || it.content).slice(0, 200) : ''));
            }
          } else if (text) {
            out.push(text.slice(0, 1500));
          }
          result = out.length ? out.join('\n') : 'No results.';
        }
      } catch (e) { result = 'ERROR parsing: ' + e.message + ' ' + r.data.slice(0, 300); }
    } else if (engine === 'langsearch') {
      const key = cfg.keys && cfg.keys.langsearch;
      if (!key) return 'LangSearch requires an API key. Set it via the Instances dialog.';
      const body = JSON.stringify({ query: args.query, count: max });
      const r = await new Promise((resolve) => {
        const https = require('https');
        const req = https.request('https://api.langsearch.com/v1/web-search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, data }));
        });
        req.on('error', (e) => resolve({ status: 0, data: 'ERROR: ' + e.message }));
        req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, data: 'TIMEOUT' }); });
        req.write(body);
        req.end();
      });
      try {
        const j = JSON.parse(r.data);
        const out = [];
        const pages = (j.data && j.data.webPages && j.data.webPages.value) || [];
        for (const it of pages.slice(0, max)) {
          out.push('- ' + (it.name || '') + ' (' + (it.url || '') + ')' + (it.snippet ? '\n  ' + it.snippet : (it.text ? '\n  ' + String(it.text).slice(0, 200) : '')));
        }
        if (r.status !== 200) result = 'ERROR (HTTP ' + r.status + '): ' + r.data.slice(0, 300);
        else result = out.length ? out.join('\n') : 'No results.';
      } catch (e) { result = 'ERROR parsing: ' + e.message + ' ' + (r.data || '').slice(0, 200); }
    } else {
      result = 'Unknown search engine: ' + engine;
    }
    if (result && result.length && !result.startsWith('ERROR') && !result.startsWith('TIMEOUT') && process.env.AEGISAI_AUTO_SAVE_SEARCH === '1') {
      await addMemory('Web search (' + engine + '): ' + args.query + '\n' + result.slice(0, 1500), 'web_search', ['search']).catch(() => {});
    }
    return result;
  }
  if (name === 'read_pdf') {
    const fp = safePath(args.path);
    try {
      const pdfParse = require('pdf-parse');
      const buf = fs.readFileSync(fp);
      const data = await pdfParse(buf);
      return (data.text || '').slice(0, 200000) || '(no text extracted)';
    } catch (e) { return 'ERROR: ' + (e.message || String(e)); }
  }
  if (name === 'screenshot') {
    const { execFileSync } = require('child_process');
    const fn = args.filename || ('screenshot_' + Date.now() + '.png');
    const fp = safePath(fn);
    const ps = "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('" + fp.replace(/'/g, "''") + "'); $g.Dispose(); $bmp.Dispose(); Write-Output $b.Width x $b.Height";
    try {
      const out = execFileSync('powershell', ['-Command', ps], { encoding: 'utf8', timeout: 30000 });
      return 'Saved screenshot: ' + fp + ' (' + out.trim() + ')';
    } catch (e) { return 'ERROR: ' + (e.stderr || e.message); }
  }
  if (name === 'memory_recall') {
    const mems = loadJsonFile(MEMORY_FILE);
    if (args.key) {
      const m = mems.find((x) => x.id === args.key);
      return m ? m.text : '(not found)';
    }
    return mems.length ? mems.map((m) => m.id + ' | ' + m.text.slice(0, 120)).join('\n') : '(no memories)';
  }
  if (name === 'run_python') {
    const os = require('os');
    if ((process.env.AEGISAI_SANDBOX || '').toLowerCase() === 'docker') {
      const f = path.join(os.tmpdir(), 'localai-py-' + Date.now() + '.py');
      fs.writeFileSync(f, args.code || '');
      const r = await runProcess('docker', ['run', '--rm', '--network', 'none', '--memory', '256m', '--cpus', '1', '-v', path.dirname(f) + ':/work', '-w', '/work', 'python:3.12-alpine', 'python', '/work/' + path.basename(f)], { timeout: 120000, maxBuffer: 1024 * 1024 });
      try { fs.unlinkSync(f); } catch (e) {}
      if (!r.ok) return 'EXIT ' + r.code + '\n' + (r.out || r.err);
      return r.out || '(no output)';
    }
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync('python', ['-c', args.code], { cwd: projectRoot, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 120000 });
      return out || '(no output)';
    } catch (e) { return 'EXIT ' + (e.status || '?') + '\nSTDOUT:\n' + (e.stdout || '') + '\nSTDERR:\n' + (e.stderr || '') + '\n' + (e.message || ''); }
  }
  if (name === 'memory_search') {
    const topK = args.top_k || 6;
    const res = await searchMemory(args.query, topK);
    if (!res.length) return '(no relevant memories)';
    return res.map((m) => '[' + m.id + '] ' + m.text + (m.tags && m.tags.length ? '  (tags: ' + m.tags.join(',') + ')' : '')).join('\n');
  }
  if (name === 'memory_save') {
    const tags = args.tags ? args.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
    const id = await addMemory(args.text, 'manual', tags);
    return id ? 'Saved memory ' + id : 'Duplicate or too short; not saved.';
  }
  if (name === 'memory_list') {
    const mems = loadJsonFile(MEMORY_FILE);
    const limit = args.limit || 30;
    const recent = mems.slice(-limit).reverse();
    return recent.length ? recent.map((m) => m.id + ' | ' + m.text.slice(0, 120)).join('\n') : '(no memories)';
  }
  if (name === 'memory_forget') {
    const mems = loadJsonFile(MEMORY_FILE);
    const idx = mems.findIndex((m) => m.id === args.id);
    if (idx === -1) return 'Not found.';
    mems.splice(idx, 1);
    saveJsonFile(MEMORY_FILE, mems);
    return 'Forgot ' + args.id;
  }
  if (name === 'skill_save') {
    const skills = loadSkills();
    const idx = skills.findIndex((s) => s.name === args.name);
    const entry = { name: args.name, description: args.description, code: args.code, created: new Date().toISOString() };
    if (idx >= 0) skills[idx] = entry; else skills.push(entry);
    saveSkills(skills);
    return 'Saved skill: ' + args.name;
  }
  if (name === 'skill_list') {
    const skills = loadSkills();
return skills.length ? skills.map((s) => s.name + ' � ' + s.description).join('\n') : '(no skills)';
  }
  if (name === 'skill_get') {
    const skills = loadSkills();
    const s = skills.find((x) => x.name === args.name);
    if (!s) return 'Not found.';
    return 'DESCRIPTION: ' + s.description + '\nCODE:\n' + s.code;
  }
  if (name === 'skill_run') {
    const skills = loadSkills();
    const s = skills.find((x) => x.name === args.name);
    if (!s) return 'Skill not found.';
    const os = require('os');
    if ((process.env.AEGISAI_SANDBOX || '').toLowerCase() === 'docker') {
      const f = path.join(os.tmpdir(), 'localai-skill-' + Date.now() + '.py');
      fs.writeFileSync(f, s.code || '');
      const r = await runProcess('docker', ['run', '--rm', '--network', 'none', '--memory', '256m', '--cpus', '1', '-v', path.dirname(f) + ':/work', '-w', '/work', 'python:3.12-alpine', 'python', '/work/' + path.basename(f)], { timeout: 120000, maxBuffer: 1024 * 1024 });
      try { fs.unlinkSync(f); } catch (e) {}
      if (!r.ok) return 'EXIT ' + r.code + '\n' + (r.out || r.err);
      return r.out || '(no output)';
    }
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync('python', ['-c', s.code], { cwd: projectRoot, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 120000 });
      return out || '(no output)';
    } catch (e) { return 'EXIT ' + (e.status || '?') + '\nSTDOUT:\n' + (e.stdout || '') + '\nSTDERR:\n' + (e.stderr || '') + '\n' + (e.message || ''); }
  }
  if (name === 'text_to_speech') {
    const { execFileSync } = require('child_process');
    const fn = args.filename || ('speech_' + Date.now() + '.wav');
    const fp = safePath(fn);
    const voice = args.voice || '';
    const speak = (args.speak === true || args.speak === 'true') ? '$synth.Speak($text);' : '';
    let voiceCmd = '';
    if (voice) voiceCmd = "$synth.SelectVoice('" + voice.replace(/'/g, "''") + "');";
    const ps = "Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; " + voiceCmd + " $text = @'\n" + args.text.replace(/'/g, "''") + "\n'@; $synth.SetOutputToWaveFile('" + fp.replace(/'/g, "''") + "'); $synth.Speak($text); $synth.Dispose(); Write-Output 'ok'";
    try {
      execFileSync('powershell', ['-Command', ps], { encoding: 'utf8', timeout: 120000 });
      return 'Saved TTS audio: ' + fp;
    } catch (e) { return 'ERROR: ' + (e.stderr || e.message); }
  }
  if (name === 'speech_to_text') {
    const { execFileSync } = require('child_process');
    const fp = safePath(args.path);
    const lang = args.language || 'en-US';
    const ps = "Add-Type -AssemblyName System.Speech; $culture = New-Object System.Globalization.CultureInfo('" + lang.replace(/'/g, "''") + "'); $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture); $rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar)); $rec.SetInputToWaveFile('" + fp.replace(/'/g, "''") + "'); $r = $rec.Recognize(); if ($r) { $r.Text } else { '(no speech recognized)' }";
    try {
      const out = execFileSync('powershell', ['-Command', ps], { encoding: 'utf8', timeout: 120000 });
      return out.trim() || '(no text)';
    } catch (e) { return 'ERROR: ' + (e.stderr || e.message); }
  }
  if (name === 'analyze_image') {
    const fs = require('fs');
    const fp = safePath(args.path);
    const st = fs.statSync(fp);
    if (st.size > 20 * 1024 * 1024) return 'ERROR: image too large (' + st.size + ' bytes; max 20 MB).';
    const buf = fs.readFileSync(fp);
    const b64 = buf.toString('base64');
    const visionModel = args.model || 'moondream';
    const r = await ollamaRequest('/api/chat', {
      model: visionModel,
      messages: [{ role: 'user', content: args.question || 'Describe this image in detail.', images: [b64] }],
      stream: false,
    });
    if (r.status !== 200) return 'ERROR: ' + (r.data && r.data.error ? r.data.error : JSON.stringify(r.data));
    return (r.data && r.data.message && r.data.message.content) || '(no description)';
  }
  throw new Error('Unknown coding tool: ' + name);
}

// ---------- Learning / Memory system ----------
// Data dir is overridable (e.g. AEGISAI_DATA_DIR=/app/data in Docker) so all
// JSON state files can live under one mounted volume instead of per-file paths.
const DATA_DIR = process.env.AEGISAI_DATA_DIR || __dirname;
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const SKILLS_FILE = path.join(DATA_DIR, 'skills.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DB_FILE = path.join(DATA_DIR, 'aegisai.db');
const USE_SQLITE = (process.env.AEGISAI_DB || 'json').toLowerCase() === 'sqlite';
let dbModule = null;
if (USE_SQLITE) {
  try {
    dbModule = require('./lib/db');
    dbModule.open(DB_FILE);
    dbModule.migrateFromJson(DATA_DIR);
    console.log('SQLite backend enabled:', DB_FILE);
  } catch (e) {
    console.error('SQLite init failed, falling back to JSON:', e.message);
    dbModule = null;
  }
}
// Modularized data-access layer (lib/). Inline helpers below delegate to these.
// lib/memory and lib/settings are unused dead code; removed to avoid startup failure in Docker
function loadSkills() { return loadJsonFile(SKILLS_FILE); }
function saveSkills(s) { saveJsonFile(SKILLS_FILE, s); }
function loadSettings() {
  try { const j = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); return (j && typeof j === 'object') ? j : {}; } catch (e) { return {}; }
}
function saveSettings(s) { try { const _t = SETTINGS_FILE + '.tmp'; fs.writeFileSync(_t, JSON.stringify(s || {}, null, 2), 'utf8'); fs.renameSync(_t, SETTINGS_FILE); } catch (e) {} }

function loadJsonFile(fp) { try { return JSON.parse(require('fs').readFileSync(fp, 'utf8')); } catch (e) { return []; } }
function saveJsonFile(fp, data) { const fs = require('fs'); const tmp = fp + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8'); fs.renameSync(tmp, fp); }

async function embedText(text) {
  try {
    const r = await ollamaRequest('/api/embeddings', { model: 'nomic-embed-text', prompt: (text || '').slice(0, 4000) });
    if (r.data && Array.isArray(r.data.embedding)) return r.data.embedding;
  } catch (e) {}
  return null;
}

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function addMemory(text, source, tags) {
  text = (text || '').trim();
  if (!text || text.length < 8) return null;
  // Compute embedding FIRST (before loading), to avoid stale reads
  const emb = await embedText(text);
  // Then load -> check dedup -> push -> save with no await in between
  const memories = loadJsonFile(MEMORY_FILE);
  // dedup by exact text
  if (memories.some((m) => m.text === text)) return null;
  const entry = { id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), text, source: source || 'manual', tags: tags || [], created: new Date().toISOString(), embedding: emb };
  memories.push(entry);
  // cap at 5000
  if (memories.length > 5000) memories.splice(0, memories.length - 5000);
  saveJsonFile(MEMORY_FILE, memories);
  return entry.id;
}

async function searchMemory(query, topK) {
  topK = topK || 6;
  const memories = loadJsonFile(MEMORY_FILE);
  if (!memories.length) return [];
  const qEmb = await embedText(query);
  const scored = memories.map((m) => ({
    m,
    score: qEmb && m.embedding ? cosineSim(qEmb, m.embedding) : (m.text.toLowerCase().includes((query||'').toLowerCase()) ? 0.5 : 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0.05).slice(0, topK).map((s) => s.m);
}

async function autoExtractMemories(messages) {
  try {
    const convo = messages.map((m) => (m.role + ': ' + (m.content || '').slice(0, 1500))).join('\n').slice(0, 8000);
    const r = await ollamaRequest('/api/chat', {
      model: process.env.LOCALAI_MEMORY_MODEL || 'llama3.2:1b',
      messages: [
        { role: 'system', content: 'Extract durable facts, user preferences, decisions, and useful findings from this conversation. Return ONLY a JSON array of short, self-contained factual strings (each a complete sentence). If nothing durable, return []. No prose, no markdown.' },
        { role: 'user', content: convo },
      ],
      stream: false,
    });
    const content = (r.data && r.data.message && r.data.message.content) || '';
    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return;
    let facts;
    try { facts = JSON.parse(match[0]); } catch (e) { return; }
    if (!Array.isArray(facts)) return;
    for (const f of facts) {
      if (typeof f === 'string' && f.trim().length > 8) await addMemory(f.trim(), 'auto', ['auto-extracted']);
    }
  } catch (e) {}
}

// Search engine config
const SEARCH_CONFIG_FILE = path.join(DATA_DIR, 'search-config.json');
function loadSearchConfig() {
  try { return JSON.parse(require('fs').readFileSync(SEARCH_CONFIG_FILE, 'utf8')); }
  catch (e) { return { engine: 'duckduckgo', keys: {} }; }
}
function saveSearchConfig(c) { const _fs = require('fs'); const _t = SEARCH_CONFIG_FILE + '.tmp'; _fs.writeFileSync(_t, JSON.stringify(c, null, 2), 'utf8'); _fs.renameSync(_t, SEARCH_CONFIG_FILE); }

const SEARCH_ENGINES = [
  { id: 'duckduckgo', name: 'DuckDuckGo (instant)', needsKey: false },
  { id: 'wikipedia', name: 'Wikipedia', needsKey: false },
  { id: 'internet-archive', name: 'Internet Archive', needsKey: false },
  { id: 'tinyfish', name: 'TinyFish (keyless)', needsKey: false },
  { id: 'langsearch', name: 'LangSearch', needsKey: true, keyName: 'langsearch' },
  { id: 'searxng', name: 'SearXNG (public)', needsKey: false },
  { id: 'searxng-fws', name: 'SearXNG (Free-Web-Search)', needsKey: false },
  { id: 'google-html', name: 'Web Search MCP (Google SERP)', needsKey: false },
  { id: 'firecrawl', name: 'Firecrawl (keyless)', needsKey: false },
  { id: 'dokobot', name: 'Dokobot (Google/Bing/Baidu)', needsKey: false },
];

function searchEngineConfigured(e, cfg) {
  if (!e.needsKey) return true;
  return !!(cfg.keys && cfg.keys[e.keyName]);
}

// extend coding tools def with memory + skill + search tools
// (appended below by editing codingToolsDef? We'll push at runtime instead)
const extraToolsDef = [
  { name: 'memory_search', description: 'Semantic search over saved memories/learnings.', parameters: { type: 'object', properties: { query: { type: 'string' }, top_k: { type: 'integer' } }, required: ['query'] } },
  { name: 'memory_save', description: 'Save a durable fact/note to memory.', parameters: { type: 'object', properties: { text: { type: 'string' }, tags: { type: 'string' } }, required: ['text'] } },
  { name: 'memory_list', description: 'List recent memories (text + id).', parameters: { type: 'object', properties: { limit: { type: 'integer' } } } },
  { name: 'memory_forget', description: 'Delete a memory by id.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'skill_save', description: 'Save a reusable procedure/skill (name, description, code).', parameters: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, code: { type: 'string' } }, required: ['name', 'description', 'code'] } },
  { name: 'skill_list', description: 'List saved skills.', parameters: { type: 'object', properties: {} } },
  { name: 'skill_get', description: 'Get a saved skill by name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'skill_run', description: 'Run a saved skill (executes its code as Python).', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'text_to_speech', description: 'Convert text to speech and save as WAV in project root (Windows SAPI). Optional voice param for voice selection. Optionally speak on server speakers.', parameters: { type: 'object', properties: { text: { type: 'string' }, filename: { type: 'string' }, speak: { type: 'boolean' }, voice: { type: 'string', description: 'Voice name (e.g. Microsoft Zira Desktop)' } }, required: ['text'] } },
  { name: 'speech_to_text', description: 'Transcribe a WAV audio file to text (Windows Speech Recognition). Optional language param (e.g. en-US, fr-FR).', parameters: { type: 'object', properties: { path: { type: 'string' }, language: { type: 'string', description: 'Language code (default: en-US)' } }, required: ['path'] } },
  { name: 'analyze_image', description: 'Analyze an image file (screenshot etc.) using a vision model and answer a question about it.', parameters: { type: 'object', properties: { path: { type: 'string' }, question: { type: 'string' }, model: { type: 'string' } }, required: ['path'] } },
];

// merge into codingToolsDef
for (const t of extraToolsDef) codingToolsDef.push(t);

const codingToolNames = new Set(codingToolsDef.map((t) => t.name));

// ---------- Streaming helper for Ollama ----------
function ollamaStream(path, bodyObj, onChunk, signal) {
  if (IS_OPENAI_COMPAT) {
    return backendChat(bodyObj, onChunk, signal);
  }
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    const req = http.request(
      {
        hostname: OLLAMA_URL.hostname,
        port: OLLAMA_URL.port || 80,
        path: path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = '';
        let fullContent = '';
        let fullThinking = '';
        let toolCalls = [];
        let done = false;
        let evalCount = 0;
        let promptEvalCount = 0;
        const _ollamaDec = new TextDecoder('utf-8', { fatal: false });
        res.on('data', (c) => {
          buf += _ollamaDec.decode(c, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.message) {
                if (obj.message.content) {
                  fullContent += obj.message.content;
                  if (onChunk) onChunk({ type: 'token', content: obj.message.content });
                }
                if (obj.message.thinking) {
                  fullThinking += obj.message.thinking;
                  if (onChunk) onChunk({ type: 'thinking', content: obj.message.thinking });
                }
                if (obj.message.tool_calls) toolCalls = toolCalls.concat(obj.message.tool_calls);
              }
              if (obj.done) {
                done = true;
                if (obj.eval_count) evalCount = obj.eval_count;
                if (obj.prompt_eval_count) promptEvalCount = obj.prompt_eval_count;
              }
            } catch (e) {}
          }
        });
        res.on('end', () => {
          // flush remaining
          if (buf.trim()) {
            try {
              const obj = JSON.parse(buf);
              if (obj.message) {
                if (obj.message.content) { fullContent += obj.message.content; if (onChunk) onChunk({ type: 'token', content: obj.message.content }); }
                if (obj.message.thinking) { fullThinking += obj.message.thinking; if (onChunk) onChunk({ type: 'thinking', content: obj.message.thinking }); }
                if (obj.message.tool_calls) toolCalls = toolCalls.concat(obj.message.tool_calls);
              }
              if (obj.done) {
                if (obj.eval_count) evalCount = obj.eval_count;
                if (obj.prompt_eval_count) promptEvalCount = obj.prompt_eval_count;
              }
            } catch (e) {}
          }
          resolve({ status: res.statusCode, data: { message: { content: fullContent, thinking: fullThinking, tool_calls: toolCalls }, eval_count: evalCount, prompt_eval_count: promptEvalCount } });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    // 2-minute timeout for streaming
    req.setTimeout(120000, () => { req.destroy(new Error('Ollama stream timeout (120s)')); });
    if (signal) {
      if (signal.aborted) req.destroy(new Error('aborted by client'));
      else signal.addEventListener('abort', () => req.destroy(new Error('aborted by client')), { once: true });
    }
    req.write(data);
    req.end();
  });
}

// HTTP helpers marker
// ---------- HTTP helpers ----------
function readBody(req, maxBytes) {
  const limit = maxBytes || MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > limit) {
        tooLarge = true;
        reject(Object.assign(
          new Error('Request body too large (max ' + Math.round(limit / (1024 * 1024)) + ' MB)'),
          { status: 413 }
        ));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(obj));
}

function ollamaRequest(path, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(bodyObj);
    const req = http.request(
      {
        hostname: OLLAMA_URL.hostname,
        port: OLLAMA_URL.port || 80,
        path: path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
          catch (e) { resolve({ status: res.statusCode, data: buf }); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(new Error('Ollama request timeout (120s)')); });
    req.write(data);
    req.end();
  });
}

// ---------- Context compaction helpers ----------
const _ctxCache = new Map();
async function getModelContextLength(model) {
  const _cached = _ctxCache.get(model);
  if (_cached && _cached.val > 0 && (Date.now() - _cached.ts) < 10 * 60 * 1000) return _cached.val;
  try {
    const r = await ollamaRequest('/api/show', { name: model });
    if (r.status === 200 && r.data && r.data.model_info) {
      const info = r.data.model_info;
      for (const key of Object.keys(info)) {
        if (key.endsWith('.context_length')) {
          const val = info[key];
          if (val > 0) _ctxCache.set(model, { val: val, ts: Date.now() });
          return val || 0;
        }
      }
    }
  } catch (e) {}
  return 0;
}

function estimateTokens(text) {
  // Rough estimate: ~4 chars per token for English
  return Math.ceil((text || '').length / 4);
}

async function summarizeMessages(messages, model) {
  if (!messages || messages.length === 0) return null;
  try {
    const convo = messages.map((m) => (m.role + ': ' + (m.content || '').slice(0, 500))).join('\n').slice(0, 4000);
    const r = await ollamaRequest('/api/chat', {
      model: model,
      messages: [
        { role: 'system', content: 'Summarize the following conversation concisely (3-5 sentences). Focus on key facts, decisions, and context needed to continue. Return only the summary, no preamble.' },
        { role: 'user', content: convo },
      ],
      stream: false,
    });
    const content = (r.data && r.data.message && r.data.message.content) || '';
    return content.trim() || null;
  } catch (e) { return null; }
}

// Agent tool loop (non-streaming)
async function runAgent(model, messages, maxIter, opts) {
  opts = opts || {};
  const includeRe = opts.includeRe !== false;
  const includeCoding = opts.includeCoding !== false;
  const cleanRoom = opts.cleanRoom === true;
  const confirmTools = opts.confirmTools === true;
  const onEvent = opts.onEvent || null;
  maxIter = maxIter || 8;
  const tools = [];
  if (includeCoding) tools.push(...codingToolsAsOllama());
  const src = (opts && opts.sources) || {};
  if (includeRe) {
    if (mcpReady && src.re !== false) for (const t of mcpTools) tools.push(mcpToolAsOllama(t, '', ''));
    if (areReady && src.are !== false) for (const t of areTools) tools.push(mcpToolAsOllama(t, 'are_', ' [from awesome-reverse-engineered index]'));
    if (ghidraReady && src.ghidra !== false) for (const t of ghidraTools) tools.push(mcpToolAsOllama(t, 'ghidra_', ' [from GhidrAssistMCP]'));
    if (craftReady && src.craft !== false) for (const t of craftTools) tools.push(mcpToolAsOllama(t, 'craft_', ' [from Craft Anything]'));
  }
  const codingDefs = tools.filter((t) => codingToolNames.has(t.function.name));
  const externalDefs = tools.filter((t) => !codingToolNames.has(t.function.name));
  const budget = Math.max(1, parseInt((opts && opts.toolBudget), 10) || parseInt((loadSettings().toolBudget), 10) || TOOL_BUDGET);
  let kept = codingDefs.concat(externalDefs.slice(0, Math.max(0, budget - codingDefs.length)));
  // Enforce one overall budget. Coding tools are always kept; external tools fill the rest in order.
  if (cleanRoom) kept = kept.filter((t) => !isCleanRoomBlocked(t.function.name));

  tools.length = 0;
  tools.push(...kept);
  const log = [];
  const webCitations = [];
  const memBlock = '';
  const areHint = (areReady && includeRe) ? ' You also have REVERSE-ENGINEERING PROJECT SEARCH tools (are_search_reverse_engineered, are_get_reverse_engineered_project, are_list_reverse_engineered_categories) backed by 17,000+ indexed open-source RE projects.' : '';
  const craftHint = (craftReady && includeRe) ? ' You also have CRAFT ANYTHING tools (craft_* prefixed) for deep reverse engineering analysis (320 tools covering native, .NET, Java, Android, Apple, Electron/JS, websites, firmware, packet captures, databases, game files).' : '';
  const cleanRoomHint = cleanRoom ? ' CLEAN ROOM MODE: Do NOT read, view, or access any original source code, binaries, or files from the target. Work only from visible behavior: screenshots, UI layout, text content, and observable functionality. Refuse any tool that would read original code or files. If the user asks to read source, explain that clean room mode prevents this and suggest switching to Deep mode.' : '';
  const systemMsg = { role: 'system', content: 'You are a helpful local AI assistant.' + areHint + craftHint + cleanRoomHint };
  let finalThinking = '';
  let totalEvalCount = 0;
  let totalPromptEvalCount = 0;
  // Context compaction: summarize old messages if conversation is too long
  let compactedMessages = messages.slice();
  let compactedCount = 0;
  let ctxLen = 0;
  try {
    ctxLen = await getModelContextLength(model);
    if (ctxLen > 0 && messages.length > 8) {
      const estTokens = estimateTokens(systemMsg.content + messages.map((m) => m.content || '').join(' '));
      if (estTokens > ctxLen * 0.75) {
        // Summarize older messages, keep last 6
        const toSummarize = messages.slice(0, -6);
        const recent = messages.slice(-6);
        const summary = await summarizeMessages(toSummarize, model);
        if (summary) {
          compactedMessages = [{ role: 'system', content: 'Summary of earlier conversation:\n' + summary }].concat(recent);
          compactedCount = toSummarize.length;
        }
      }
    }
  } catch (e) { /* ignore compaction errors */ }
  let msgs = [systemMsg].concat(compactedMessages.slice());
  let toolsSupported = true;
  for (let iter = 0; iter < maxIter; iter++) {
    if (opts.signal && opts.signal.aborted) throw new Error('Client disconnected');
    let r;
    let streamedText = '';
    try {
      r = await ollamaStream('/api/chat', {
        model,
        messages: msgs,
        tools: (toolsSupported && tools.length) ? tools : undefined,
        stream: true,
        options: opts.options || undefined,
        keep_alive: opts.keep_alive,
      }, (chunk) => {
        if (chunk.type === 'token') {
          streamedText += chunk.content;
          if (onEvent) onEvent({ type: 'token', content: chunk.content });
        }
        if (chunk.type === 'thinking') {
          if (onEvent) onEvent({ type: 'thinking', content: chunk.content });
        }
      }, opts.signal);

      // Accumulate token counts
      if (r && r.data) {
        if (r.data.eval_count) totalEvalCount += r.data.eval_count;
        if (r.data.prompt_eval_count) totalPromptEvalCount += r.data.prompt_eval_count;
      }

    } catch (e) {
      throw new Error('Ollama error: ' + (e.message || String(e)));
    }
    if (r.status !== 200) {
      const errText = (r.data && r.data.error) ? String(r.data.error) : JSON.stringify(r.data);
      // Retry without tools on any 400 error (model may not support tools or tools payload too large)
      if (r.status === 400 || /does not support tools/i.test(errText) || /does not support tool/i.test(errText) || /tool calling/i.test(errText) || /function calling/i.test(errText) || /invalid/i.test(errText)) {
        toolsSupported = false;
        r = await ollamaRequest('/api/chat', { model, messages: msgs, stream: false, options: opts.options || undefined, keep_alive: opts.keep_alive });
        if (r.status !== 200) throw new Error('Ollama error ' + r.status + ': ' + JSON.stringify(r.data));
        const msg = r.data.message || {};
        msgs.push({ role: 'assistant', content: msg.content || '', thinking: msg.thinking || '' });
        const tokenStats = (totalEvalCount || totalPromptEvalCount) ? { prompt: totalPromptEvalCount, generated: totalEvalCount } : null;
        const contextUsed = ctxLen > 0 && tokenStats && tokenStats.prompt ? Math.round((tokenStats.prompt / ctxLen) * 100) : 0;
        if (onEvent) onEvent({ type: 'final', content: msg.content || '', thinking: msg.thinking || finalThinking, toolLog: log, webCitations, toolsDisabled: !toolsSupported, tokenStats, context: contextUsed });
        return { messages: msgs, final: msg.content || '', thinking: msg.thinking || finalThinking, toolLog: log, webCitations, toolsDisabled: !toolsSupported, tokenStats, compacted: compactedCount, context: contextUsed };
      } else {
        throw new Error('Ollama error ' + r.status + ': ' + JSON.stringify(r.data));
      }
    }
    const msg = r.data.message || {};
    let toolCalls = msg.tool_calls || [];
    if (!toolCalls.length && msg.content) {
      const m = msg.content.match(/\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"(?:parameters?|arguments)"\s*:\s*(\{[\s\S]*\})\s*\}/);
      if (m) {
        let raw = m[2].replace(/\bFalse\b/g, 'false').replace(/\bTrue\b/g, 'true').replace(/\bNone\b/g, 'null');
        let args = {};
        try { args = JSON.parse(raw); } catch (e) {
          let depth = 0, end2 = -1;
          for (let i = 0; i < raw.length; i++) {
            if (raw[i] === '{') depth++;
            else if (raw[i] === '}') { depth--; if (depth === 0) { end2 = i + 1; break; } }
          }
          if (end2 > 0) { try { args = JSON.parse(raw.slice(0, end2).replace(/\bFalse\b/g,'false').replace(/\bTrue\b/g,'true').replace(/\bNone\b/g,'null')); } catch (e2) {} }
        }
        toolCalls = [{ function: { name: m[1], arguments: args } }];
      }
    }
    if (!toolCalls.length) {
      const content = msg.content || '';
      const thinking = msg.thinking || finalThinking || '';
      msgs.push({ role: 'assistant', content: content, thinking: thinking });
      const tokenStats2 = (totalEvalCount || totalPromptEvalCount) ? { prompt: totalPromptEvalCount, generated: totalEvalCount } : null;
      const contextUsed2 = ctxLen > 0 && tokenStats2 && tokenStats2.prompt ? Math.round((tokenStats2.prompt / ctxLen) * 100) : 0;
      if (onEvent) onEvent({ type: 'final', content: content, thinking: thinking, toolLog: log, webCitations, toolsDisabled: !toolsSupported, tokenStats: tokenStats2, context: contextUsed2 });
      return { messages: msgs, final: content, thinking: thinking, toolLog: log, webCitations, toolsDisabled: !toolsSupported, tokenStats: tokenStats2, compacted: compactedCount, context: contextUsed2 };
    }
    if (msg.thinking) finalThinking += msg.thinking + '\n';
    msgs.push({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls, thinking: msg.thinking || '' });
    for (const tc of toolCalls) {
      const fn = tc.function || {};
      const name = fn.name;
      let args = fn.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = {}; } }
      log.push({ name, args });
      if (onEvent) onEvent({ type: 'tool', name, args });
      let result;
      // Tool confirmation gate
      if (confirmTools) {
        const confirmId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const approved = await requestConfirmation(confirmId, name, args, opts.signal, onEvent);
        if (!approved) {
          result = 'DENIED: user did not approve this tool call.';
          const resultStr = (typeof result === 'string' ? result : JSON.stringify(result));
          msgs.push({ role: 'tool', content: resultStr });
          const logEntry = log[log.length - 1];
          logEntry.resultPreview = resultStr.slice(0, 300);
          if (onEvent) onEvent({ type: 'tool_result', name, preview: resultStr.slice(0, 300) });
          continue;
        }
      }
      try {
        if (cleanRoom && isCleanRoomBlocked(name)) result = 'BLOCKED: this tool is disabled in clean room mode.';
        else if (codingToolNames.has(name)) result = await execCodingTool(name, args || {});
        else result = await callMcpTool(name, args);
      } catch (e) { result = 'ERROR: ' + (e.message || String(e)); }
      const resultStr = (typeof result === 'string' ? result : JSON.stringify(result));
      msgs.push({ role: 'tool', content: resultStr });
      const resultPreview = resultStr.slice(0, 300);
      // Store result preview in the log entry
      const logEntry = log[log.length - 1];
      logEntry.resultPreview = resultPreview;
      if (onEvent) onEvent({ type: 'tool_result', name, preview: resultPreview });
      // Extract web citations from web_search results
      if (name === 'web_search' && typeof result === 'string') {
        const urlRegex = /https?:\/\/[^\s)>\]]+/g;
        const urls = result.match(urlRegex) || [];
        for (const u of urls) {
          if (!webCitations.includes(u)) webCitations.push(u);
        }
      }
    }
    if (onEvent) onEvent({ type: 'tool_done' });
  }
  const fallback = 'Reached max iterations without final answer.';
  msgs.push({ role: 'assistant', content: fallback });
  if (onEvent) onEvent({ type: 'final', content: fallback, thinking: finalThinking, toolLog: log, webCitations, toolsDisabled: !toolsSupported });
  return { messages: msgs, final: fallback, thinking: finalThinking, toolLog: log, webCitations, toolsDisabled: !toolsSupported };
}


  // ---------- Components (About/Update) ----------
  // ---------- Version helpers ----------
function execSyncSafe(cmd, args, opts) {
  try {
    const { execFileSync } = require('child_process');
    return execFileSync(cmd, args, Object.assign({ encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }, opts || {})).trim();
  } catch (e) {
    return null;
  }
}

async function getOllamaVersion() {
  try {
    const r = await fetch(OLLAMA + '/api/version');
    if (!r.ok) return null;
    const d = await r.json();
    return (d && (d.version || d.ollama_version)) || null;
  } catch (e) { return null; }
}

async function getLatestOllamaVersion() {
  try {
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      const req = https.get('https://api.github.com/repos/ollama/ollama/releases/latest', { headers: { 'User-Agent': 'LocalAI' } }, (r) => {
        let buf = '';
        r.on('data', (c) => (buf += c));
        r.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    });
    return (data && data.tag_name) ? data.tag_name.replace(/^v/, '') : null;
  } catch (e) { return null; }
}

function getReaAgentVersion() {
  const env = Object.assign({}, process.env, { PATH: (process.env.PATH || '') });
  // try rea --version
  try {
    const { execFileSync } = require('child_process');
    const reaCmd = process.platform === 'win32' ? 'cmd' : resolveReaBin();
    const reaArgs = process.platform === 'win32' ? ['/c', 'rea', '--version'] : ['--version'];
    const v = execFileSync(reaCmd, reaArgs, { encoding: 'utf8', timeout: 15000, env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (v) return v.split(/\s+/).pop();
  } catch (e) {}
  // fallback npm list
  try {
    const { execFileSync } = require('child_process');
    const npmCmd = process.platform === 'win32' ? 'cmd' : 'npm';
    const npmArgs = process.platform === 'win32' ? ['/c', 'npm', 'list', '-g', 'rea-agents', '--depth=0', '--json'] : ['list', '-g', 'rea-agents', '--depth=0', '--json'];
    const v = execFileSync(npmCmd, npmArgs, { encoding: 'utf8', timeout: 20000, env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (v) { const j = JSON.parse(v); return (j.dependencies && j.dependencies['rea-agents'] && j.dependencies['rea-agents'].version) || null; }
  } catch (e) {}
  return null;
}

function getLatestReaAgentVersion() {
  const env = Object.assign({}, process.env, { PATH: (process.env.PATH || '') });
  try {
    const { execFileSync } = require('child_process');
    const npmCmd = process.platform === 'win32' ? 'cmd' : 'npm';
    const npmArgs = process.platform === 'win32' ? ['/c', 'npm', 'view', 'rea-agents', 'version'] : ['view', 'rea-agents', 'version'];
    const v = execFileSync(npmCmd, npmArgs, { encoding: 'utf8', timeout: 20000, env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return v || null;
  } catch (e) { return null; }
}

async function getReaRepoVersions() {
  const reaRepoPath = path.join(__dirname, 'repos', 'rea');
  let current = null, remote = null, behind = 0;
  // current: local clone HEAD (if present)
  if (fs.existsSync(reaRepoPath)) {
    try {
      const { execFileSync } = require('child_process');
      current = execFileSync('git', ['-C', reaRepoPath, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 15000 }).trim();
    } catch (e) {}
  }
  // remote: latest commit on GitHub (morluto/rea)
  try {
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      const req = https.get('https://api.github.com/repos/morluto/rea/commits?per_page=1', { headers: { 'User-Agent': 'LocalAI' } }, (r) => {
        let buf = '';
        r.on('data', (c) => (buf += c));
        r.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    });
    if (Array.isArray(data) && data.length) {
      remote = (data[0].sha || '').slice(0, 7);
    }
  } catch (e) {}
  // behind count: if we have both, compare (best effort via git if local clone exists)
  if (current && remote && fs.existsSync(reaRepoPath)) {
    try {
      const { execFileSync } = require('child_process');
      try { execFileSync('git', ['-C', reaRepoPath, 'fetch', '--quiet', '--depth=1'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore','ignore','ignore'] }); } catch (e) {}
      const count = execFileSync('git', ['-C', reaRepoPath, 'rev-list', '--count', 'HEAD..origin/main'], { encoding: 'utf8', timeout: 15000 }).trim();
      behind = parseInt(count, 10) || 0;
    } catch (e) { behind = (current !== remote) ? 1 : 0; }
  } else if (current && remote) {
    behind = (current !== remote) ? 1 : 0;
  }
  return { current, remote, behind };
}

// Version cache (avoid slow network calls on every /api/components request)
let _versionCache = null;
let _versionCacheTime = 0;
const VERSION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getCachedVersions() {
  const now = Date.now();
  if (_versionCache && (now - _versionCacheTime) < VERSION_CACHE_TTL) {
    return _versionCache;
  }
  const ollamaVer = await getOllamaVersion();
  const ollamaLatest = await getLatestOllamaVersion();
  const reaVer = getReaAgentVersion();
  const reaLatest = getLatestReaAgentVersion();
  const reaRepo = await getReaRepoVersions();
  _versionCache = { ollamaVer, ollamaLatest, reaVer, reaLatest, reaRepo };
  _versionCacheTime = now;
  return _versionCache;
}

function invalidateVersionCache() {
  _versionCache = null;
  _versionCacheTime = 0;
}

async function getComponents() {
    const comps = [];
    const _cv = await getCachedVersions();
    // Ollama backend
    let ollamaStatus = 'unknown';
    let models = [];
    try {
      const d = await backendListModels();
      if (d && d.models) {
        models = d.models || [];
        ollamaStatus = 'connected';
      } else {
        ollamaStatus = 'unreachable: ' + (d ? 'unexpected response (no models field)' : 'empty response');
      }
    } catch (e) {
      ollamaStatus = 'unreachable: ' + (e.message || e);
    }
    const ollamaVer = _cv.ollamaVer;
    const ollamaLatest = _cv.ollamaLatest;
    comps.push({
      id: 'ollama-backend',
      name: 'Ollama backend',
      kind: 'backend',
      status: ollamaStatus,
      detail: OLLAMA,
      version: ollamaVer || 'unknown',
      latest: ollamaLatest,
      updateAvailable: !!(ollamaVer && ollamaLatest && ollamaVer !== ollamaLatest),
      installed: ollamaStatus === 'connected',
      installUrl: 'https://ollama.com/download',
      homepage: 'https://ollama.com',
      about: 'AegisAI - local LLM server at ' + OLLAMA + '. Models: ' + models.length + '. Version: ' + (ollamaVer || 'unknown') + (ollamaLatest ? ' (latest: ' + ollamaLatest + ')' : '') + '.',
    });
    for (const m of models) {
      comps.push({
        id: 'model:' + m.name,
        name: m.name,
        kind: 'model',
        status: 'available',
        detail: (m.size ? (m.size / 1e9).toFixed(2) + ' GB' : '') + (m.digest ? ' � ' + m.digest.slice(0, 12) : ''),
        version: m.digest ? m.digest.slice(0, 12) : 'unknown',
        latest: null,
        updateAvailable: false,
        installed: true,
        installUrl: 'https://ollama.com/library/' + (m.name.split(':')[0]),
        homepage: 'https://ollama.com/library/' + m.name,
        about: 'Ollama model. Family: ' + (m.details && m.details.family || '?') + ', params: ' + (m.details && m.details.parameter_size || '?') + ', quant: ' + (m.details && m.details.quantization_level || '?') + '.',
      });
    }
    // RE tools (MCP/REA)
    comps.push({
      id: 're-tools',
      name: 'RE tools (REA)',
      kind: 'mcp',
      status: mcpReady ? 'ready (' + mcpTools.length + ' tools)' : 'error: ' + (mcpError || 'not ready'),
      detail: 'MCP server: re --mcp',
      version: _cv.reaVer || 'unknown',
      latest: _cv.reaLatest,
      updateAvailable: !!(_cv.reaVer && _cv.reaLatest && _cv.reaVer !== _cv.reaLatest),
      installed: mcpReady,
      installUrl: 'https://www.npmjs.com/package/rea-agents',
      homepage: 'https://github.com/morluto/rea',
      about: 'Reverse engineering toolset via REA MCP. Tools: ' + mcpTools.length + '. ' + (mcpError ? 'Error: ' + mcpError : '') + '\nCurrent: ' + (_cv.reaVer || 'unknown') + ', latest (npm): ' + (_cv.reaLatest || 'unknown'),
    });
    // REA source repo
    const reaRepoPath = path.join(__dirname, 'repos', 'rea');
    let reaRepoStatus = 'not cloned';
    let reaRepoAbout = 'Source repo not present at ' + reaRepoPath;
    if (!fs.existsSync(reaRepoPath)) {
      reaRepoStatus = 'not cloned';
      reaRepoAbout = 'REA source repo not cloned locally.\nLatest on GitHub: ' + ((_cv && _cv.reaRepo && _cv.reaRepo.remote) || 'unknown') + '\nClone from https://github.com/morluto/rea';
    } else {
      try {
        const { execFileSync } = require('child_process');
        const branch = execFileSync('git', ['-C', reaRepoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 15000 }).trim();
        const commit = execFileSync('git', ['-C', reaRepoPath, 'log', '-1', '--format=%h %s'], { encoding: 'utf8', timeout: 15000 }).trim();
        const dirty = execFileSync('git', ['-C', reaRepoPath, 'status', '--porcelain'], { encoding: 'utf8', timeout: 15000 }).trim();
        reaRepoStatus = branch + (dirty ? ' (dirty)' : ' (clean)');
        reaRepoAbout = 'Local clone of https://github.com/morluto/rea\nPath: ' + reaRepoPath + '\nLatest: ' + commit;
      } catch (e) {
        reaRepoStatus = 'error: ' + (e.message || e).slice(0, 120);
      }
    }
    const _rrv = _cv.reaRepo;
    comps.push({
      id: 'rea-repo',
      name: 'REA source repo',
      kind: 'repo',
      status: reaRepoStatus,
      detail: reaRepoPath,
      version: _rrv.current || (_rrv.remote ? 'remote: ' + _rrv.remote : 'unknown'),
      latest: _rrv.remote || null,
      updateAvailable: (_rrv.behind || 0) > 0,
      installed: fs.existsSync(reaRepoPath),
      installUrl: 'https://github.com/morluto/rea',
      homepage: 'https://github.com/morluto/rea',
      about: reaRepoAbout + '\nVersion: ' + (_rrv.current || 'unknown') + ' (remote: ' + (_rrv.remote || 'unknown') + ', behind by ' + (_rrv.behind || 0) + ' commit(s)).',
    });
    // Coding tools
    comps.push({
      id: 'coding-tools',
      name: 'Coding tools',
      kind: 'tools',
      status: 'registered (' + codingToolsDef.length + ')',
      detail: 'file, shell, git, web, pdf, memory, skills, ...',
      version: 'built-in',
      latest: null,
      updateAvailable: false,
      installed: true,
      homepage: null,
      about: 'Built-in coding/agent tools: ' + codingToolsDef.map((t) => t.name).join(', ') + '.',
    });
    // Memory system
    const mems = loadJsonFile(MEMORY_FILE);
    comps.push({
      id: 'memory',
      name: 'Memory system',
      kind: 'memory',
      status: mems.length + ' memories',
      detail: MEMORY_FILE,
      version: mems.length + ' entries',
      latest: null,
      updateAvailable: false,
      installed: true,
      homepage: null,
      about: 'Persistent semantic memory (embeddings via nomic-embed-text). Entries: ' + mems.length + '.',
    });
    // Web search
    comps.push({
      id: 'web-search',
      name: 'Web search',
      kind: 'web',
      status: 'available (DuckDuckGo)',
      detail: 'fetch_url + web_search tools',
      version: 'built-in',
      latest: null,
      updateAvailable: false,
      installed: true,
      homepage: null,
      about: 'Web search via DuckDuckGo instant answers + fetch_url for arbitrary pages.',
    });
    // Skills
    const skills = loadSkills();
    comps.push({
      id: 'skills',
      name: 'Skills',
      kind: 'skills',
      status: skills.length + ' saved',
      detail: SKILLS_FILE,
      version: skills.length + ' saved',
      latest: null,
      updateAvailable: false,
      installed: true,
      homepage: null,
      about: 'Reusable saved procedures. Count: ' + skills.length + '.',
    });
    return comps;
  }

// ---------- Server ----------
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; frame-src 'self' blob: data:");
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch (e) { res.statusCode = 400; res.end('Bad request'); return; }
  const filePath = path.resolve(PUBLIC, '.' + decoded);
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + path.sep)) { res.statusCode = 403; res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.statusCode = 404; res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    setSecurityHeaders(res);
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.end(data);
  });
}

function proxyToOllama(req, res) {
  // Buffer the request body first (needed for retries)
  let bodyChunks = [];
  req.on('data', (c) => bodyChunks.push(c));
  req.on('end', () => {
    const bodyBuf = Buffer.concat(bodyChunks);
    // Handle client disconnect (use res.on('close'), not req.on('close'),
    // because req 'close' fires after body consumption in Node 16+)
    res.on('close', () => {
      if (!res.writableFinished && proxyReq) { try { proxyReq.destroy(); } catch (_) {} }
    });
    const opts = {
      hostname: OLLAMA_URL.hostname,
      port: OLLAMA_URL.port || 80,
      path: req.url,
      method: req.method,
      headers: Object.assign({}, req.headers, { host: OLLAMA_URL.host, 'content-length': bodyBuf.length }),
    };
    delete opts.headers['transfer-encoding'];
    let retries = 0;
    let proxyReq = null;
    function attempt() {
      proxyReq = http.request(opts, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', (e) => {
        const isRetryable = req.method === 'GET' || req.method === 'HEAD';
        if (isRetryable && retries < 2 && (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT')) {
          retries++;
          setTimeout(attempt, 500 * retries);
          return;
        }
        if (!res.headersSent) { res.statusCode = 502; }
        try { res.end('Ollama proxy error: ' + e.message + '. Is Ollama running? Start with: ollama serve'); } catch (_) {}
      });
      if (bodyBuf.length > 0) proxyReq.write(bodyBuf);
      proxyReq.end();
    }
    attempt();
  });
  req.on('error', (e) => {
    if (!res.headersSent) { res.statusCode = 500; }
    try { res.end('Request error: ' + e.message); } catch (_) {}
  });
}

// ---------- Auth + rate limiting ----------
const AUTH_TOKEN = (process.env.LOCALAI_TOKEN || '').trim();
let _cachedToken = null;
let _cachedTokenTime = 0;
function getAuthToken() {
  if (AUTH_TOKEN) return AUTH_TOKEN;
  const now = Date.now();
  if (_cachedToken !== null && (now - _cachedTokenTime) < 30000) return _cachedToken;
  let tok = '';
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join(DATA_DIR, 'auth.json');
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      tok = (j && j.token) ? String(j.token).trim() : '';
    }
  } catch (e) {}
  _cachedToken = tok;
  _cachedTokenTime = now;
  return tok;
}
const _rateLimits = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const windowMs = 60000;
  const maxReq = 120;
  if (_rateLimits.size > 5000) {
    for (const [k, v] of _rateLimits) { if (now - v.start > windowMs) _rateLimits.delete(k); }
  }
  let entry = _rateLimits.get(ip);
  if (!entry || now - entry.start > windowMs) {
    entry = { start: now, count: 0 };
    _rateLimits.set(ip, entry);
  }
  entry.count++;
  return entry.count > maxReq;
}

const server = http.createServer(async (req, res) => { try {
  // Per-endpoint timeouts (runProcess/ollamaRequest) handle long work; the
  // blanket socket timeout here never delivered its 408 (callback never fires
  // on IncomingMessage in Node 26) and only cut off long requests.
  // Rate limit (applies to preflight too)
  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimit(ip)) {
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return;
  }
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin || '';
    const allowed = (origin === 'http://127.0.0.1:8080' || origin === 'http://localhost:8080' || !origin);
    res.writeHead(204, {
      'Access-Control-Allow-Origin': allowed ? (origin || '*') : 'http://127.0.0.1:8080',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token, Authorization',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }
  // Cross-site request and DNS-rebinding guard. A cross-site HTML form can only send
  // text/plain, and a rebinding page presents its own Host name; both are refused here.
  const hostHeader = String(req.headers.host || '').toLowerCase();
  const allowedHosts = (process.env.AEGISAI_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1') {
    // Accept any port on loopback, or any host in AEGISAI_ALLOWED_HOSTS.
    const isLoopback = /^127\.0\.0\.1:\d+$/.test(hostHeader) || /^localhost:\d+$/.test(hostHeader) || /^\[::1\]:\d+$/.test(hostHeader);
    const isAllowed = allowedHosts.some((h) => hostHeader === h || hostHeader.startsWith(h + ':'));
    if (!isLoopback && !isAllowed) {
      json(res, 421, { error: 'Misdirected request: unexpected Host header' });
      return;
    }
  }
  // When bound to 0.0.0.0 (LAN mode) we cannot validate the Host precisely, so we
  // rely on the auth token (and the JSON content-type check below) for protection.
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    const sameOrigin = origin.toLowerCase() === ('http://' + hostHeader) || origin.toLowerCase() === ('https://' + hostHeader);
    if (!sameOrigin) { json(res, 403, { error: 'Cross-origin request refused' }); return; }
  }
  const isApiRoute = req.url.startsWith('/api/') || req.url.startsWith('/v1/');
  if (isApiRoute && req.method !== 'GET' && req.method !== 'HEAD') {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) { json(res, 415, { error: 'Content-Type must be application/json' }); return; }
  }

  // Auth check
  const token = getAuthToken();
  // Static assets carry no secrets and must load so the browser can show the token prompt.
  // Only API and OpenAI-compatible routes require the token.
  const isApi = req.url.startsWith('/api/') || req.url.startsWith('/v1/');
  if (token && isApi) {
    // Allow health check and static assets without auth? No - require auth for everything except a login hint
    const provided = (req.headers['x-auth-token'] || req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    // Constant-time comparison so the token cannot be recovered via response timing.
    let providedValid = false;
    try {
      const a = Buffer.from(String(provided));
      const b = Buffer.from(String(token));
      providedValid = a.length === b.length && require('crypto').timingSafeEqual(a, b);
    } catch (e) { providedValid = false; }
    if (!providedValid) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Unauthorized', authRequired: true }));
      return;
    }
  }
  // Custom routes
  if (req.url === '/api/tools' && req.method === 'GET') {
    const allTools = mcpTools.map((t) => ({ name: t.name, description: t.description }));
    if (areReady) {
      for (const t of areTools) {
        allTools.push({ name: 'are_' + t.name, description: (t.description || '') + ' [awesome-reverse-engineered]' });
      }
    }
    if (ghidraReady) {
      for (const t of ghidraTools) {
        allTools.push({ name: 'ghidra_' + t.name, description: (t.description || '') + ' [GhidrAssistMCP]' });
      }
    }
    if (craftReady) {
      for (const t of craftTools) {
        allTools.push({ name: 'craft_' + t.name, description: (t.description || '') + ' [Craft Anything]' });
      }
    }
    json(res, 200, { ready: mcpReady, error: mcpError, projectRoot, tools: allTools, areReady, areTools: areTools.length, areError, ghidraReady, ghidraTools: ghidraTools.length, ghidraError, craftReady, craftTools: craftTools.length, craftError });
    return;
  }

  // ---------- Awesome-RE data search ----------
  if (req.url === '/api/are-search' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { query, category, language, minStars, limit } = JSON.parse(body || '{}');
      const data = await loadAreData();
      if (!data) { json(res, 503, { ok: false, message: 'ARE data not loaded yet. Try again in a moment.' }); return; }
      const results = searchAreData(query, { category, language, minStars, limit });
      json(res, 200, { ok: true, count: results.length, results: results.map((e) => ({
        name: e.name,
        description: e.desc || e.description || '',
        stars: e.stars,
        language: e.lang || e.language || '',
        category: e.category,
        url: e.url,
        health: e.health,
      })) });
    } catch (e) { json(res, (e && e.status) || 500, { ok: false, message: e.message || String(e) }); }
    return;
  }
  if (req.url === '/api/are-data-status' && req.method === 'GET') {
    json(res, 200, { loaded: !!areDataCache, loading: areDataLoading, count: Array.isArray(areDataCache) ? areDataCache.length : 0 });
    return;
  }
  if (req.url === '/api/are-data-refresh' && req.method === 'POST') {
    try {
      const fs = require('fs');
      // Delete cached file to force re-download
      if (fs.existsSync(ARE_DATA_FILE)) fs.unlinkSync(ARE_DATA_FILE);
      areDataCache = null;
      const data = await loadAreData();
      json(res, 200, { ok: true, count: Array.isArray(data) ? data.length : 0 });
    } catch (e) { json(res, (e && e.status) || 500, { ok: false, message: e.message || String(e) }); }
    return;
  }
  if (req.url === '/api/are-readme' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { url } = JSON.parse(body || '{}');
      if (!url) { json(res, 400, { ok: false, message: 'url required' }); return; }
      // Extract owner/repo from GitHub URL
      const m = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
      if (!m) { json(res, 400, { ok: false, message: 'Not a GitHub URL' }); return; }
      const owner = m[1], repo = m[2].replace(/\.git$/, '');
      const https = require('https');
      const fetchReadme = (branch) => new Promise((resolve, reject) => {
        const apiUrl = 'https://api.github.com/repos/' + owner + '/' + repo + '/readme' + (branch ? '?ref=' + branch : '');
        const headers = { 'User-Agent': 'AegisAI', 'Accept': 'application/vnd.github.v3.raw' };
        if (process.env.GITHUB_TOKEN) headers['Authorization'] = 'token ' + process.env.GITHUB_TOKEN;
        https.get(apiUrl, { headers }, (r) => {
          let buf = '';
          r.on('data', (c) => (buf += c));
          r.on('end', () => { if (r.statusCode === 200) resolve(buf); else reject(new Error('HTTP ' + r.statusCode)); });
        }).on('error', reject);
      });
      let content = '';
      try { content = await fetchReadme(''); }
      catch (e) { try { content = await fetchReadme('main'); } catch (e2) { try { content = await fetchReadme('master'); } catch (e3) { content = 'Could not fetch README: ' + e3.message; } } }
      // Truncate to 2000 chars
      if (content.length > 2000) content = content.slice(0, 2000) + '\n... (truncated)';
      json(res, 200, { ok: true, content });
    } catch (e) { json(res, (e && e.status) || 500, { ok: false, message: e.message || String(e) }); }
    return;
  }
  if (req.url === '/api/project' && req.method === 'GET') {
    json(res, 200, { projectRoot });
    return;
  }
  if (req.url === '/api/memory' && req.method === 'GET') {
    const mems = loadJsonFile(MEMORY_FILE);
    const u = new URL(req.url, 'http://localhost');
    const search = (u.searchParams.get('search') || '').toLowerCase();
    let filtered = mems;
    if (search) {
      filtered = mems.filter((m) => (m.text || '').toLowerCase().includes(search) || (m.tags || []).some((t) => t.toLowerCase().includes(search)));
    }
    json(res, 200, { count: filtered.length, memories: filtered.map((m) => ({ id: m.id, text: m.text, source: m.source, tags: m.tags, created: m.created })) });
    return;
  }
  if (req.url === '/api/memory/save' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { text, tags } = JSON.parse(body || '{}');
      if (!text) { json(res, 400, { ok: false, message: 'text required' }); return; }
      const id = await addMemory(text, 'manual', tags || []);
      json(res, 200, { ok: true, id: id || null, message: id ? 'Saved' : 'Duplicate or too short' });
    } catch (e) { json(res, (e && e.status) || 500, { ok: false, message: e.message || String(e) }); }
    return;
  }
  if (req.url === '/api/memory/forget' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { id } = JSON.parse(body || '{}');
      const mems = loadJsonFile(MEMORY_FILE);
      const idx = mems.findIndex((m) => m.id === id);
      if (idx === -1) { json(res, 404, { ok: false, message: 'Not found' }); return; }
      mems.splice(idx, 1);
      saveJsonFile(MEMORY_FILE, mems);
      json(res, 200, { ok: true, message: 'Deleted' });
    } catch (e) { json(res, (e && e.status) || 500, { ok: false, message: e.message || String(e) }); }
    return;
  }
  if (req.url === '/api/memory/edit' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { id, text, tags } = JSON.parse(body || '{}');
      const mems = loadJsonFile(MEMORY_FILE);
      const idx = mems.findIndex((m) => m.id === id);
      if (idx === -1) { json(res, 404, { ok: false, message: 'Not found' }); return; }
      if (text) { mems[idx].text = text; mems[idx].embedding = await embedText(text); }
      if (tags) mems[idx].tags = tags;
      mems[idx].updated = new Date().toISOString();
      saveJsonFile(MEMORY_FILE, mems);
      json(res, 200, { ok: true, message: 'Updated' });
    } catch (e) { json(res, (e && e.status) || 500, { ok: false, message: e.message || String(e) }); }
    return;
  }
  if (req.url === '/api/skills' && req.method === 'GET') {
    const skills = loadSkills();
    json(res, 200, { skills: skills.map((s) => ({ name: s.name, description: s.description, created: s.created })) });
    return;
  }
  if (req.url === '/api/skills/delete' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { name } = JSON.parse(body || '{}');
      const skills = loadSkills();
      const idx = skills.findIndex((s) => s.name === name);
      if (idx === -1) { json(res, 404, { ok: false, message: 'Not found' }); return; }
      skills.splice(idx, 1);
      saveSkills(skills);
      json(res, 200, { ok: true, message: 'Deleted' });
    } catch (e) { json(res, (e && e.status) || 500, { ok: false, message: e.message || String(e) }); }
    return;
  }
  if (req.url === '/api/project' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { root } = JSON.parse(body || '{}');
      if (root) { projectRoot = validateProjectRoot(root); }
      json(res, 200, { projectRoot });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message }); }
    return;
  }

  if (req.url.startsWith('/api/components') && req.method === 'GET') {
    try {
      const u = new URL(req.url, 'http://localhost');
      if (u.searchParams.get('refresh') === '1') invalidateVersionCache();
      const comps = await getComponents();
      json(res, 200, { components: comps });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  if (req.url.startsWith('/api/component/about') && req.method === 'GET') {
    try {
      const u = new URL(req.url, 'http://localhost');
      const id = u.searchParams.get('id');
      const comps = await getComponents();
      const c = comps.find((x) => x.id === id);
      if (!c) { json(res, 404, { error: 'not found' }); return; }
      json(res, 200, c);
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  // Background update job state
  if (!global._updateJob) global._updateJob = { running: false, status: '', result: null };

  if (req.url === '/api/component/update-status' && req.method === 'GET') {
    json(res, 200, global._updateJob);
    return;
  }

  if (req.url === '/api/reconnect-mcp' && req.method === 'POST') {
    mcpReady = false; mcpError = null; mcpClient = null; mcpTools = [];
    areReady = false; areError = null; areClient = null; areTools = [];
    ghidraReady = false; ghidraError = null; ghidraClient = null; ghidraTools = [];
    craftReady = false; craftError = null; craftClient = null; craftTools = [];
    const _t = (ms) => new Promise((r) => setTimeout(r, ms));
    await Promise.race([initMcp(), _t(20000)]);
    await Promise.race([initAwesomeReMcp(), _t(20000)]);
    await Promise.race([initGhidrAssistMcp(), _t(10000)]);
    await Promise.race([initCraftMcp(), _t(20000)]);
    json(res, 200, { ready: mcpReady, error: mcpError, tools: mcpTools.length + areTools.length + ghidraTools.length + craftTools.length, areReady, areTools: areTools.length, ghidraReady, ghidraTools: ghidraTools.length, craftReady, craftTools: craftTools.length });
    return;
  }

  if (req.url === '/api/component/update' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { id } = JSON.parse(body || '{}');
      let result = { ok: false, message: 'Unknown component' };
      if (id === 'ollama-backend') {
        const cv = await getCachedVersions();
        if (!(cv.ollamaVer && cv.ollamaLatest && cv.ollamaVer !== cv.ollamaLatest)) {
          const d = await backendListModels();
          result = d ? { ok: true, message: 'Backend reachable. ' + (d.models || []).length + ' model(s). Up to date.' } : { ok: false, message: 'Backend unreachable' };
          json(res, 200, result);
          return;
        }
        // Run update in background
        if (global._updateJob.running) {
          json(res, 200, { ok: true, message: 'Update already in progress: ' + global._updateJob.status, async: true });
          return;
        }
        global._updateJob = { running: true, status: 'Starting Ollama update...', result: null };
        (async () => {
          try {
            const { exec } = require('child_process');
            const https = require('https');
            const fs = require('fs');
            const path = require('path');
            const os = require('os');
            global._updateJob.status = 'Trying winget...';
            const wg = await new Promise((resolve) => {
              exec('winget upgrade Ollama.Ollama --accept-package-agreements --accept-source-agreements --silent', { timeout: 300000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
                resolve({ ok: !err, out: (stdout || '') + (stderr || ''), err: err ? err.message : null });
              });
            });
            if (wg.ok) {
              invalidateVersionCache();
              global._updateJob.result = { ok: true, message: 'Ollama updated via winget. Restart may be required.' };
            } else {
              global._updateJob.status = 'Downloading installer...';
              const installerPath = path.join(os.tmpdir(), 'OllamaSetup.exe');
              try {
                await new Promise((resolve, reject) => {
                  const file = fs.createWriteStream(installerPath);
                  function get(url) {
                    https.get(url, { headers: { 'User-Agent': 'LocalAI' } }, (r) => {
                      if (r.statusCode === 301 || r.statusCode === 302 || r.statusCode === 307 || r.statusCode === 308) { get(r.headers.location); return; }
                      if (r.statusCode !== 200) { reject(new Error('HTTP ' + r.statusCode)); return; }
                      r.pipe(file);
                      file.on('finish', () => { file.close(); resolve(); });
                    }).on('error', reject);
                  }
                  get('https://ollama.com/download/OllamaSetup.exe');
                });
                global._updateJob.status = 'Running installer...';
                const inst = await new Promise((resolve) => {
                  exec('"' + installerPath + '" /S', { timeout: 600000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
                    resolve({ ok: !err, out: (stdout || '') + (stderr || ''), err: err ? err.message : null });
                  });
                });
                try { fs.unlinkSync(installerPath); } catch (_) {}
                if (inst.ok) {
                  invalidateVersionCache();
                  global._updateJob.result = { ok: true, message: 'Ollama installer completed. Restart Ollama/server to apply.' };
                } else {
                  global._updateJob.result = { ok: false, message: 'Installer failed: ' + (inst.err || inst.out).slice(0, 300) };
                }
              } catch (e) {
                global._updateJob.result = { ok: false, message: 'Download failed: ' + (e.message || e) + '. Update manually: https://ollama.com/download' };
              }
            }
          } catch (e) {
            global._updateJob.result = { ok: false, message: String(e.message || e) };
          } finally {
            global._updateJob.running = false;
            global._updateJob.status = 'Done';
          }
        })();
        json(res, 200, { ok: true, message: 'Ollama update started in background. This may take several minutes. Check status below.', async: true });
        return;
      } else if (id.startsWith('model:')) {
        const modelName = id.slice('model:'.length);
        const r = isValidModelName(modelName)
          ? await runProcess(resolveOllamaBin(), ['pull', modelName], { timeout: 1800000, maxBuffer: 10 * 1024 * 1024 })
          : { ok: false, out: 'Invalid model name' };
        result = r.ok ? { ok: true, message: (r.out || 'done').trim().slice(0, 500) } : { ok: false, message: (r.out || '').slice(0, 500) };
      } else if (id === 're-tools') {
        // Disconnect MCP client BEFORE npm install so rea process releases file locks
        try { if (mcpClient) await mcpClient.close(); } catch (_) {}
        mcpReady = false; mcpError = null; mcpClient = null; mcpTools = [];
        // Kill lingering rea processes that might hold locks
        const { exec, execSync } = require('child_process');
        const isWin = process.platform === 'win32';
        try {
          if (isWin) execSync('taskkill /F /IM rea.exe 2>nul', { stdio: 'ignore' });
          else execSync('pkill -f rea 2>/dev/null || true', { stdio: 'ignore' });
        } catch (_) {}
        // Wait for processes to exit
        await new Promise((r) => setTimeout(r, 1000));
        // Run npm install
        let npmUpdate = await new Promise((resolve) => {
          exec('npm install -g rea-agents@latest', {
            timeout: 300000,
            maxBuffer: 1024 * 1024,
            env: Object.assign({}, process.env, { PATH: (process.env.PATH || '') }),
          }, (err, stdout, stderr) => {
            if (err) resolve({ ok: false, msg: (stderr || err.message || '').slice(0, 400) });
            else resolve({ ok: true, msg: (stdout || stderr || 'updated').trim().slice(0, 400) });
          });
        });
        // Retry with --force if failed with lock/permission error
        if (!npmUpdate.ok && /EPERM|EBUSY|locked|operation not permitted/i.test(npmUpdate.msg)) {
          await new Promise((r) => setTimeout(r, 3000));
          npmUpdate = await new Promise((resolve) => {
            exec('npm install -g rea-agents@latest --force', {
              timeout: 300000,
              maxBuffer: 1024 * 1024,
              env: Object.assign({}, process.env, { PATH: (process.env.PATH || '') }),
            }, (err, stdout, stderr) => {
              if (err) resolve({ ok: false, msg: (stderr || err.message || '').slice(0, 400) });
              else resolve({ ok: true, msg: (stdout || stderr || 'updated').trim().slice(0, 400) });
            });
          });
        }
        // Reconnect MCP after npm install
        await initMcp();
        const connMsg = mcpReady ? ('RE tools ready. ' + mcpTools.length + ' tools.') : (mcpError || 'reconnect failed');
        result = { ok: npmUpdate.ok && mcpReady, message: (npmUpdate.ok ? 'npm: ' + npmUpdate.msg + ' | ' : 'npm failed: ' + npmUpdate.msg + ' | ') + connMsg };
      } else if (id === 'rea-repo') {
        const reaRepoPath = path.join(__dirname, 'repos', 'rea');
        const { exec } = require('child_process');
        const fs = require('fs');
        if (!fs.existsSync(reaRepoPath)) {
          result = { ok: false, message: 'REA repo not cloned. Clone from https://github.com/morluto/rea into ' + reaRepoPath + ' or click Install.' };
        } else {
        // Stash local changes, fetch, reset to remote (handles diverging branches)
        result = await new Promise((resolve) => {
          const env = Object.assign({}, process.env, { PATH: (process.env.PATH || '') });
          const opts = { cwd: reaRepoPath, timeout: 300000, maxBuffer: 1024 * 1024, env };
          // detect default branch: try origin/main, then origin/master
          exec('git rev-parse --verify origin/main', opts, (errMain) => {
            const branch = errMain ? 'master' : 'main';
            const cmd = 'git fetch origin && git reset --hard origin/' + branch;
            exec(cmd, opts, (err2, stdout2, stderr2) => {
              if (err2) resolve({ ok: false, message: (stderr2 || err2.message || '').slice(0, 500) });
              else resolve({ ok: true, message: (stdout2 || stderr2 || 'Updated.').trim().slice(0, 500) });
            });
          });
        });
        }
      } else if (id === 'memory') {
        const mems = loadJsonFile(MEMORY_FILE);
        result = { ok: true, message: 'Memory OK. ' + mems.length + ' entries. (persistent; no update needed)' };
      } else if (id === 'coding-tools' || id === 'web-search' || id === 'skills') {
        result = { ok: true, message: 'Built-in component; no update action. Reload the page to refresh.' };
      } else {
        result = { ok: false, message: 'No update action for ' + id };
      }
      invalidateVersionCache();
      json(res, 200, result);
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/search-engines' && req.method === 'GET') {
    const cfg = loadSearchConfig();
    const engines = SEARCH_ENGINES.map((e) => ({ id: e.id, name: e.name, needsKey: e.needsKey, configured: searchEngineConfigured(e, cfg) }));
    json(res, 200, { engines, active: cfg.engine || 'duckduckgo' });
    return;
  }
  if (req.url === '/api/search-engine' && req.method === 'GET') {
    const cfg = loadSearchConfig();
    json(res, 200, { engine: cfg.engine || 'duckduckgo' });
    return;
  }
  if (req.url === '/api/search-engine' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { engine } = JSON.parse(body || '{}');
      const cfg = loadSearchConfig();
      cfg.engine = engine;
      saveSearchConfig(cfg);
      json(res, 200, { ok: true, engine });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message }); }
    return;
  }
  if (req.url === '/api/search-keys' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { keys } = JSON.parse(body || '{}');
      const cfg = loadSearchConfig();
      cfg.keys = Object.assign({}, cfg.keys || {}, keys || {});
      saveSearchConfig(cfg);
      json(res, 200, { ok: true });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message }); }
    return;
  }

  if (req.url === '/api/search-config' && req.method === 'GET') {
    json(res, 200, loadSearchConfig());
    return;
  }
  if (req.url === '/api/search-config' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const patch = JSON.parse(body || '{}');
      const cfg = loadSearchConfig();
      if (patch.engine) cfg.engine = patch.engine;
      if (patch.searxngInstance) cfg.searxngInstance = patch.searxngInstance;
      if (patch.searxngFwsInstance) cfg.searxngFwsInstance = patch.searxngFwsInstance;
      if (patch.firecrawlInstance) cfg.firecrawlInstance = patch.firecrawlInstance;
      if (patch.keys) cfg.keys = Object.assign({}, cfg.keys || {}, patch.keys);
      saveSearchConfig(cfg);
      json(res, 200, { ok: true, config: cfg });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message }); }
    return;
  }

  if (req.url === '/api/pull-model' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { name } = JSON.parse(body || '{}');
      if (BACKEND_TYPE !== 'ollama') {
        json(res, 400, { ok: false, message: 'Model pulling is only supported for the Ollama backend. Use your ' + BACKEND_TYPE + ' backend tools to load models.' });
        return;
      }
      if (!name || !name.trim()) { json(res, 400, { ok: false, message: 'Model name required' }); return; }

  // Load a model from a path (llama.cpp /models/load). Other backends manage models themselves.
  if (req.url === '/api/load-model' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { path: modelPath } = JSON.parse(body || '{}');
      if (!modelPath || !modelPath.trim()) { json(res, 400, { ok: false, message: 'model path required' }); return; }
      if (BACKEND_TYPE !== 'llamacpp') {
        json(res, 400, { ok: false, message: 'Loading a model from a path is only supported for the llama.cpp backend. Use your ' + BACKEND_TYPE + ' backend tools to load models.' });
        return;
      }
      try {
        const r = await fetch(BACKEND_URL.replace(/\/$/, '') + '/models/load', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelPath.trim() }),
        });
        const text = await r.text();
        let d = {};
        try { d = JSON.parse(text); } catch (e) { d = { message: text }; }
        if (!r.ok) { json(res, r.status, { ok: false, message: d.error || d.message || ('HTTP ' + r.status) }); return; }
        json(res, 200, { ok: true, message: d.message || ('Loaded ' + modelPath) });
      } catch (e) {
        json(res, 502, { ok: false, message: 'Backend unreachable: ' + (e.message || e) });
      }
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }
      const modelName = name.trim();
      if (!isValidModelName(modelName)) { json(res, 400, { ok: false, message: 'Invalid model name' }); return; }
      const r = await runProcess(resolveOllamaBin(), ['pull', modelName], { timeout: 1800000, maxBuffer: 10 * 1024 * 1024 });
      const result = r.ok
        ? { ok: true, message: (r.out || 'done').trim().slice(0, 500) }
        : { ok: false, message: (r.out || r.err || ('exit code ' + r.code)).slice(0, 500) };
      invalidateVersionCache();
      json(res, 200, result);
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/scan-models' && req.method === 'GET') {
    if (_scanCache && Date.now() - _scanCache.ts < 10 * 60 * 1000) { json(res, 200, { found: _scanCache.found, cached: true }); return; }
    try {
      const fsp = require('fs').promises;
      const path = require('path');
      const found = [];
      const home = process.env.USERPROFILE || process.env.HOME || '';
      // Ollama model store
      const ollamaModels = path.join(home, '.ollama', 'models');
      try {
        const st = await fsp.stat(ollamaModels);
        if (st.isDirectory()) {
          found.push({ type: 'ollama-store', path: ollamaModels, label: 'Ollama model store' });
          // Enumerate installed Ollama models via manifests
          const manifestsDir = path.join(ollamaModels, 'manifests');
          try {
            const walkManifests = async (dir, prefix) => {
              let entries;
              try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
              for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) { await walkManifests(full, prefix + e.name + '/'); }
                else {
                  // manifest file name is the tag; parent dirs form namespace/model
                  const parts = full.replace(manifestsDir + path.sep, '').split(path.sep);
                  const tag = parts.pop();
                  const model = parts.join('/');
                  if (model && tag) {
                    found.push({ type: 'ollama-model', path: full, label: model + ':' + tag, size: 0 });
                  }
                }
              }
            };
            await walkManifests(manifestsDir, '');
          } catch (e) {}
        }
      } catch (e) {}
      // LM Studio model store
      const lmStudioModels = path.join(home, '.cache', 'lm-studio', 'models');
      try {
        const st = await fsp.stat(lmStudioModels);
        if (st.isDirectory()) {
          found.push({ type: 'lmstudio-store', path: lmStudioModels, label: 'LM Studio model store' });
          // Walk for GGUF files (LM Studio stores them in subdirs)
          const walkLm = async (dir, depth) => {
            if (depth > 6) return;
            let entries;
            try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
            for (const e of entries) {
              if (e.name === 'node_modules' || e.name === '.git') continue;
              const full = path.join(dir, e.name);
              if (e.isDirectory()) { await walkLm(full, depth + 1); }
              else if (e.isFile() && e.name.toLowerCase().endsWith('.gguf')) {
                try { const st2 = await fsp.stat(full); found.push({ type: 'gguf', path: full, label: e.name, size: st2.size }); } catch (_) {}
              }
              await new Promise((r) => setImmediate(r));
            }
          };
          await walkLm(lmStudioModels, 0);
        }
      } catch (e) {}
      const skip = new Set(['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', '$Recycle.Bin', 'System Volume Information', 'node_modules', '.git']);
      // Async, yielding walk so the event loop stays responsive.
      async function walk(dir, depth) {
        if (depth > 4) return;
        let entries;
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of entries) {
          if (skip.has(e.name)) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { await walk(full, depth + 1); }
          else if (e.isFile() && e.name.toLowerCase().endsWith('.gguf')) {
            try { const st = await fsp.stat(full); found.push({ type: 'gguf', path: full, label: e.name, size: st.size }); } catch (_) {}
          }
          // yield to the event loop periodically
          await new Promise((r) => setImmediate(r));
        }
      }
      for (let c = 65; c <= 90; c++) {
        const root = String.fromCharCode(c) + ':\\';
        try { const st = await fsp.stat(root); if (st.isDirectory()) await walk(root, 0); } catch (_) {}
      }
      _scanCache = { ts: Date.now(), found };
      json(res, 200, { found });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/tags' && req.method === 'GET') {
    try {
      const d = await backendListModels();
      json(res, 200, d);
    } catch (e) { json(res, (e && e.status) || 502, { error: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/version' && req.method === 'GET') {
    try {
      const fs = require('fs');
      const path = require('path');
      let current = 'unknown';
      try { current = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown'; } catch (_) {}
      // check if git repo
      const isGit = fs.existsSync(path.join(__dirname, '.git'));
      json(res, 200, { version: current, isGit, backend: BACKEND_TYPE, backendUrl: BACKEND_URL, isOpenAICompat: IS_OPENAI_COMPAT });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  // ---------- Error log endpoints ----------
  if (req.url === '/api/error-log' && req.method === 'GET') {
    try {
      const fs = require('fs');
      if (!fs.existsSync(ERROR_LOG_FILE)) { json(res, 200, { entries: [], count: 0 }); return; }
      const content = fs.readFileSync(ERROR_LOG_FILE, 'utf8');
      const entries = content.trim().split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (e) { return { ts: '', msg: line }; } });
      json(res, 200, { entries, count: entries.length });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }
  if (req.url === '/api/error-log/clear' && req.method === 'POST') {
    try {
      const fs = require('fs');
      if (fs.existsSync(ERROR_LOG_FILE)) fs.unlinkSync(ERROR_LOG_FILE);
      json(res, 200, { ok: true, message: 'Error log cleared.' });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }
  if (req.url === '/api/error-log/copy' && req.method === 'GET') {
    try {
      const fs = require('fs');
      if (!fs.existsSync(ERROR_LOG_FILE)) { json(res, 200, { text: '(no errors logged)' }); return; }
      const content = fs.readFileSync(ERROR_LOG_FILE, 'utf8');
      // Format as readable text for copy/paste
      const entries = content.trim().split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (e) { return { ts: '', msg: line }; } });
      const text = entries.map((e) => '[' + (e.ts || '') + '] ' + (e.ctx || '') + ': ' + (e.msg || '') + (e.stack ? '\n  ' + e.stack : '')).join('\n\n');
      json(res, 200, { text });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/check-update' && req.method === 'GET') {
    try {
      const https = require('https');
      const fs = require('fs');
      const path = require('path');
      let current = 'unknown';
      try { current = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown'; } catch (_) {}
      const data = await new Promise((resolve, reject) => {
        https.get('https://api.github.com/repos/user6811992/LocalAI/releases/latest', { headers: { 'User-Agent': 'LocalAI' } }, (r) => {
          let buf = '';
          r.on('data', (c) => (buf += c));
          r.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
        }).on('error', reject);
      });
      json(res, 200, { current, latest: data.tag_name, url: data.html_url, hasUpdate: data.tag_name && data.tag_name.replace(/^v/, '') !== current });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/update' && req.method === 'POST') {
    try {
      const fs = require('fs');
      const path = require('path');
      const { exec } = require('child_process');
      const isGit = fs.existsSync(path.join(__dirname, '.git'));
      let output = '';
      // Files that contain user data/API keys (gitignored, but back up just in case)
      const userDataFiles = ['search-config.json', 'memory.json', 'skills.json', 'chats.json', 'rag-store.json', 'auth.json', 'settings.json', 'setup-done.flag', 'aegisai.db'];
      const backupDir = path.join(__dirname, '.update-backup');
      try { if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true }); } catch (_) {}
      // Back up user data before update
      const backedUp = [];
      for (const f of userDataFiles) {
        const src = path.join(DATA_DIR, f);
        if (fs.existsSync(src)) {
          try { fs.copyFileSync(src, path.join(backupDir, f)); backedUp.push(f); } catch (_) {}
        }
      }
      // Back up workspace (user's RE work)
      const wsSrc = path.join(__dirname, 'workspace');
      if (fs.existsSync(wsSrc)) {
        try {
          const wsBackup = path.join(backupDir, 'workspace');
          if (fs.existsSync(wsBackup)) fs.rmSync(wsBackup, { recursive: true, force: true });
          fs.cpSync(wsSrc, wsBackup, { recursive: true });
          backedUp.push('workspace/');
        } catch (_) {}
      }
      if (backedUp.length) output += 'Backed up user data: ' + backedUp.join(', ') + '\n';
      if (isGit) {
        output += 'Stashing local changes...\n';
        await new Promise((resolve) => {
          exec('git stash', { cwd: __dirname, timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            output += (stdout || '') + (stderr || '') + '\n';
            resolve();
          });
        });
        // Remember the current commit so a failed update can be rolled back.
        const prevHead = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: __dirname, timeout: 15000 })).out.trim();
        output += 'Cleaning untracked files (keeping the update backup)...\n';
        await runProcess('git', ['clean', '-fd', '-e', '.update-backup'], { cwd: __dirname, timeout: 60000 });
        output += 'Fetching latest...\n';
        const fetchRes = await runProcess('git', ['fetch', 'origin'], { cwd: __dirname, timeout: 120000 });
        let pullRes = { ok: fetchRes.ok, out: fetchRes.out, err: fetchRes.err };
        if (fetchRes.ok) {
          const r1 = await runProcess('git', ['reset', '--hard', 'origin/main'], { cwd: __dirname, timeout: 120000 });
          pullRes = r1.ok ? r1 : await runProcess('git', ['reset', '--hard', 'origin/master'], { cwd: __dirname, timeout: 120000 });
        }
        output += pullRes.out + '\n';
        if (!pullRes.ok) {
          if (prevHead) await runProcess('git', ['reset', '--hard', prevHead], { cwd: __dirname, timeout: 120000 });
          json(res, 500, { ok: false, message: 'Update failed (rolled back to previous commit): ' + (pullRes.err || pullRes.out), output });
          return;
        }
      } else {
        // Not a git repo (installed from release zip) - download latest release and extract
        output += 'Not a git repo. Downloading latest release...\n';
        try {
          const https = require('https');
          const os = require('os');
          // Get latest release info
          const releaseInfo = await new Promise((resolve, reject) => {
            https.get('https://api.github.com/repos/user6811992/LocalAI/releases/latest', { headers: { 'User-Agent': 'LocalAI' } }, (r) => {
              let buf = '';
              r.on('data', (c) => (buf += c));
              r.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
            }).on('error', reject);
          });
          const zipAsset = (releaseInfo.assets || []).find((a) => (a.name || '').endsWith('.zip')) || (releaseInfo.assets || [])[0];
          const zipUrl = (zipAsset && zipAsset.browser_download_url) || null;
          if (!zipUrl) { json(res, 400, { ok: false, message: 'No release zip found. Please re-install from https://github.com/user6811992/LocalAI/releases', output }); return; }
          output += 'Downloading ' + releaseInfo.tag_name + '...\n';
          const zipPath = path.join(os.tmpdir(), 'aegisai-update.zip');
          await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(zipPath);
            // Follow redirects (GitHub returns 302 for asset downloads)
            function download(url, redirects) {
              if (redirects > 5) { reject(new Error('Too many redirects')); return; }
              https.get(url, { headers: { 'User-Agent': 'AegisAI' } }, (r) => {
                if (r.statusCode === 301 || r.statusCode === 302 || r.statusCode === 303 || r.statusCode === 307) {
                  const loc = r.headers.location;
                  r.resume();
                  if (!loc) { reject(new Error('Redirect with no location')); return; }
                  download(loc, redirects + 1);
                  return;
                }
                if (r.statusCode !== 200) { reject(new Error('HTTP ' + r.statusCode)); return; }
                r.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
              }).on('error', (e) => { try { fs.unlinkSync(zipPath); } catch (_) {} reject(e); });
            }
            download(zipUrl, 0);
          });
          // Verify it's a valid zip
          const zipBuf = fs.readFileSync(zipPath);
          if (zipBuf.length < 4 || zipBuf[0] !== 0x50 || zipBuf[1] !== 0x4B) {
            throw new Error('Downloaded file is not a valid ZIP (may be a redirect page)');
          }
          output += 'Extracting...\n';
          const isWin = process.platform === 'win32';
          const extractDir = path.join(os.tmpdir(), 'aegisai-update-extract-' + Date.now());
          try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) {}
          fs.mkdirSync(extractDir, { recursive: true });
          const extractCmd = isWin
            ? 'powershell -NoProfile -Command "Expand-Archive -Path \\"' + zipPath + '\\" -DestinationPath \\"' + extractDir + '\\" -Force"'
            : 'unzip -o "' + zipPath + '" -d "' + extractDir + '"';
          const extractRes = await new Promise((resolve) => {
            exec(extractCmd, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
              resolve({ ok: !err, out: (stdout || '') + (stderr || ''), err: err ? err.message : null });
            });
          });
          output += extractRes.out + '\n';
          try { fs.unlinkSync(zipPath); } catch (e) {}
          if (!extractRes.ok) { try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) {} json(res, 500, { ok: false, message: 'Extraction failed: ' + (extractRes.err || extractRes.out), output }); return; }
          // Published zips ship a single top-level folder (AegisAI/); copy its
          // contents up so the app files land in __dirname, not __dirname/AegisAI.
          let srcDir = extractDir;
          const nested = path.join(extractDir, 'AegisAI');
          if (fs.existsSync(path.join(nested, 'server.js'))) srcDir = nested;
          try { fs.cpSync(srcDir, __dirname, { recursive: true, force: true }); } catch (e) { output += 'Copy failed: ' + (e.message || e) + '\n'; }
          try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) {}
          output += 'Update extracted successfully. Restart the server to apply.\n';
          // Clean up stale files: remove .tmp, .old, .bak files
          try {
            const staleFiles = fs.readdirSync(__dirname).filter((f) => f.endsWith('.tmp') || f.endsWith('.old') || f.endsWith('.bak') || f.endsWith('.orig'));
            for (const f of staleFiles) { try { fs.unlinkSync(path.join(__dirname, f)); } catch (_) {} }
            if (staleFiles.length) output += 'Cleaned ' + staleFiles.length + ' stale temp files.\n';
          } catch (_) {}
        } catch (e) {
          json(res, 500, { ok: false, message: 'Update failed: ' + (e.message || String(e)), output }); return;
        }
      }
      // npm install with retry
      let npmRes = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        output += 'Running npm install (attempt ' + attempt + '/3)...\n';
        npmRes = await new Promise((resolve) => {
          exec('npm install', { cwd: __dirname, timeout: 300000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ ok: !err, out: (stdout || '') + (stderr || ''), err: err ? err.message : null });
          });
        });
        output += npmRes.out + '\n';
        if (npmRes.ok) break;
        if (attempt < 3) { output += 'npm install failed, retrying...\n'; await new Promise((r) => setTimeout(r, 2000)); }
      }
      if (!npmRes.ok) { json(res, 500, { ok: false, message: 'npm install failed after 3 attempts: ' + (npmRes.err || npmRes.out), output }); return; }
      // Restore user data
      const restored = [];
      for (const f of userDataFiles) {
        const backup = path.join(backupDir, f);
        const target = path.join(DATA_DIR, f);
        if (fs.existsSync(backup)) {
          try { fs.copyFileSync(backup, target); restored.push(f); } catch (_) {}
        }
      }
      const wsBackup = path.join(backupDir, 'workspace');
      if (fs.existsSync(wsBackup)) {
        try {
          const wsTarget = path.join(__dirname, 'workspace');
          if (fs.existsSync(wsTarget)) fs.rmSync(wsTarget, { recursive: true, force: true });
          fs.cpSync(wsBackup, wsTarget, { recursive: true });
          restored.push('workspace/');
        } catch (_) {}
      }
      if (restored.length) output += 'Restored user data: ' + restored.join(', ') + '\n';
      // read new version
      let newVersion = 'unknown';
      try { newVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown'; } catch (_) {}
      // Post-update verification: check key files exist
      const keyFiles = ['server.js', 'package.json', 'public/index.html'];
      const missing = keyFiles.filter((f) => !fs.existsSync(path.join(__dirname, f)));
      if (missing.length) {
        output += 'WARNING: Missing files after update: ' + missing.join(', ') + '\n';
        output += 'Update may be incomplete.\n';
      } else {
        output += 'Verification passed: all key files present.\n';
      }
      // Clean stale files: remove .update-backup of old versions (keep only latest)
      try {
        const backupDir = path.join(__dirname, '.update-backup');
        if (fs.existsSync(backupDir)) {
          // Keep backup but remove any stale temp files
          const tmpFiles = fs.readdirSync(backupDir).filter((f) => f.endsWith('.tmp') || f.endsWith('.old'));
          for (const f of tmpFiles) { try { fs.unlinkSync(path.join(backupDir, f)); } catch (_) {} }
        }
      } catch (_) {}
      output += 'Updated to v' + newVersion + '.\n';
      output += 'IMPORTANT: The server will restart automatically in 3 seconds.\n';
      json(res, 200, { ok: true, message: 'Updated to v' + newVersion + '. Server restarting...', version: newVersion, output, restart: true });
      // Auto-restart: close server first, then spawn replacement from close callback
      server.close(() => {
        try {
          const { spawn } = require('child_process');
          const child = spawn(process.execPath, ['server.js'], {
            cwd: __dirname,
            detached: true,
            stdio: 'ignore',
            env: Object.assign({}, process.env),
          });
          child.unref();
          console.log('Update: spawned new server process (PID ' + child.pid + ')');
        } catch (e) {
          console.error('Update: failed to spawn new server:', e.message);
        }
        setTimeout(() => { process.exit(0); }, 500);
      });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  if (req.url.startsWith('/api/hf-search') && req.method === 'GET') {
    try {
      const u = new URL(req.url, 'http://localhost');
      const q = (u.searchParams.get('q') || '').trim();
      const https = require('https');
      const apiUrl = 'https://huggingface.co/api/models?search=' + encodeURIComponent(q) + '&filter=gguf&sort=downloads&direction=-1&limit=20';
      const data = await new Promise((resolve, reject) => {
        https.get(apiUrl, { headers: { 'User-Agent': 'LocalAI' } }, (r) => {
          let buf = '';
          r.on('data', (c) => (buf += c));
          r.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
        }).on('error', reject);
      });
      const items = (Array.isArray(data) ? data : []).map((m) => ({
        id: m.id || m.modelId,
        downloads: m.downloads || 0,
        likes: m.likes || 0,
        tags: m.tags || [],
      }));
      json(res, 200, { items });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  // ---------- RAG (document upload + retrieval) with collections ----------
  const RAG_FILE = path.join(DATA_DIR, 'rag-store.json');
  function loadRag() {
    try {
      const d = JSON.parse(fs.readFileSync(RAG_FILE, 'utf8'));
      if (!d.collections) d.collections = { default: { docs: d.docs || [], chunks: d.chunks || [] } };
      if (!d.activeCollection) d.activeCollection = 'default';
      return d;
    } catch (e) { return { collections: { default: { docs: [], chunks: [] } }, activeCollection: 'default' }; }
  }
  function saveRag(store) {
    try { const _tmp = RAG_FILE + '.tmp'; fs.writeFileSync(_tmp, JSON.stringify(store)); fs.renameSync(_tmp, RAG_FILE); } catch (e) {}
  }
  function getCollection(store, name) {
    name = name || store.activeCollection || 'default';
    if (!store.collections[name]) store.collections[name] = { docs: [], chunks: [] };
    return store.collections[name];
  }
  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
    return dot / (Math.sqrt(na)*Math.sqrt(nb) + 1e-9);
  }

  if (req.url === '/api/rag-collections' && req.method === 'GET') {
    const store = loadRag();
    const names = Object.keys(store.collections);
    json(res, 200, { collections: names, active: store.activeCollection });
    return;
  }

  if (req.url === '/api/rag-collections' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { name, action } = JSON.parse(body || '{}');
      const store = loadRag();
      if (action === 'create' && name) {
        if (!store.collections[name]) store.collections[name] = { docs: [], chunks: [] };
        store.activeCollection = name;
      } else if (action === 'switch' && name) {
        if (!store.collections[name]) store.collections[name] = { docs: [], chunks: [] };
        store.activeCollection = name;
      } else if (action === 'delete' && name && name !== 'default') {
        delete store.collections[name];
        if (store.activeCollection === name) store.activeCollection = 'default';
      }
      saveRag(store);
      json(res, 200, { ok: true, active: store.activeCollection, collections: Object.keys(store.collections) });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/rag-docs' && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const coll = u.searchParams.get('collection') || null;
    const store = loadRag();
    const col = getCollection(store, coll);
    json(res, 200, { collection: coll || store.activeCollection, docs: col.docs.map(d => ({ id: d.id, name: d.name, chunks: d.chunks })) });
    return;
  }

  if (req.url === '/api/rag-chunks' && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const coll = u.searchParams.get('collection') || null;
    const store = loadRag();
    const col = getCollection(store, coll);
    json(res, 200, { collection: coll || store.activeCollection, chunks: col.chunks.map((c, i) => ({ idx: i, docId: c.docId, text: c.text, hasEmbedding: !!c.embedding })) });
    return;
  }

  if (req.url === '/api/rag-upload' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { name, content, type, collection } = JSON.parse(body || '{}');
      if (!name || !content) { json(res, 400, { ok: false, message: 'name and content required' }); return; }
      let text = '';
      if (type === 'pdf') {
        try {
          const pdfParse = require('pdf-parse');
          const buf = Buffer.from(content, 'base64');
          const data = await pdfParse(buf);
          text = data.text || '';
        } catch (e) { text = ''; json(res, 500, { ok: false, message: 'PDF parse failed: ' + e.message }); return; }
      } else {
        text = Buffer.from(content, 'base64').toString('utf8');
      }
      if (!text.trim()) { json(res, 400, { ok: false, message: 'No text extracted' }); return; }
      const chunks = [];
      const size = 800;
      const overlap = 200;
      for (let i = 0; i < text.length; i += (size - overlap)) {
        chunks.push(text.slice(i, i + size));
        if (i + size >= text.length) break;
      }
      const store = loadRag();
      const coll = collection || store.activeCollection || 'default';
      const col = getCollection(store, coll);
      const docId = 'doc_' + Date.now();
      const doc = { id: docId, name, chunks: chunks.length };
      col.docs.push(doc);
      for (let i = 0; i < chunks.length; i++) {
        const emb = await embedText(chunks[i]);
        col.chunks.push({ docId, idx: i, text: chunks[i], embedding: emb });
      }
      saveRag(store);
      json(res, 200, { ok: true, message: 'Indexed ' + chunks.length + ' chunks from ' + name + ' into "' + coll + '"', docId, collection: coll });
    } catch (e) { json(res, (e && e.status) || 500, { ok: false, message: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/rag-query' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { query, topK, collection } = JSON.parse(body || '{}');
      const k = topK || 5;
      const store = loadRag();
      const coll = collection || store.activeCollection || 'default';
      const col = getCollection(store, coll);
      if (!col.chunks.length) { json(res, 200, { chunks: [], collection: coll }); return; }
      const qEmb = await embedText(query || '');
      let scored = col.chunks.map(c => ({ text: c.text, docId: c.docId, score: qEmb && c.embedding ? cosine(qEmb, c.embedding) : 0 }));
      scored.sort((a, b) => b.score - a.score);
      const topChunks = scored.slice(0, k);
      // include doc names for citations
      const citations = topChunks.map(c => {
        const doc = col.docs.find(d => d.id === c.docId);
        return { text: c.text, docName: doc ? doc.name : 'unknown', score: c.score };
      });
      json(res, 200, { chunks: topChunks.map(s => s.text), citations, collection: coll });
    } catch (e) { json(res, (e && e.status) || 500, { ok: false, message: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/rag-clear' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { collection } = JSON.parse(body || '{}');
      const store = loadRag();
      const coll = collection || store.activeCollection || 'default';
      if (store.collections[coll]) {
        store.collections[coll] = { docs: [], chunks: [] };
      }
      saveRag(store);
      json(res, 200, { ok: true, collection: coll });
    } catch (e) { json(res, (e && e.status) || 500, { ok: false, message: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/run-code' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { lang, code } = JSON.parse(body || '{}');
      const { exec } = require('child_process');
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const tmp = path.join(os.tmpdir(), 'localai-run-' + Date.now());
      let runner = '', f = '';
      if (lang === 'python') {
        f = tmp + '.py';
        fs.writeFileSync(f, code || '');
        runner = 'python';
      } else if (lang === 'javascript' || lang === 'js') {
        f = tmp + '.js';
        fs.writeFileSync(f, code || '');
        runner = process.execPath;
      } else {
        json(res, 400, { ok: false, message: 'Unsupported language. Use python or javascript.' }); return;
      }
      let r;
      if ((process.env.AEGISAI_SANDBOX || '').toLowerCase() === 'docker') {
        const image = lang === 'python' ? 'python:3.12-alpine' : 'node:20-alpine';
        const cmd = lang === 'python' ? 'python' : 'node';
        const baseName = path.basename(f);
        r = await runProcess('docker', ['run', '--rm', '--network', 'none', '--memory', '256m', '--cpus', '1', '-v', path.dirname(f) + ':/work', '-w', '/work', image, cmd, '/work/' + baseName], { timeout: 30000, maxBuffer: 1024 * 1024 });
      } else {
        r = await runProcess(runner, [f], { timeout: 15000, maxBuffer: 1024 * 1024 });
      }
      try { fs.unlinkSync(f); } catch (_) {}
      const result = { ok: r.ok, stdout: r.out.slice(0, 4000), stderr: (r.err || '').slice(0, 2000), code: r.code };
      json(res, 200, result);
    } catch (e) { json(res, (e && e.status) || 500, { ok: false, message: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/component/install' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { id } = JSON.parse(body || '{}');
      const { exec } = require('child_process');
      const fs = require('fs');
      const path = require('path');
      let result = { ok: false, message: 'Unknown component' };
      if (id === 're-tools') {
        const r = await new Promise((resolve) => {
          exec('npm install -g rea-agents@latest', { timeout: 300000, maxBuffer: 1024 * 1024, env: Object.assign({}, process.env, { PATH: (process.env.PATH || '') }) }, (err, stdout, stderr) => {
            resolve({ ok: !err, out: (stdout || '') + (stderr || ''), err: err ? err.message : null });
          });
        });
        result = r.ok ? { ok: true, message: 'REA tools installed. Restart server to connect. ' + r.out.slice(0, 200) } : { ok: false, message: 'Install failed: ' + (r.err || r.out).slice(0, 300) };
      } else if (id === 'rea-repo') {
        const reaRepoPath = path.join(__dirname, 'repos', 'rea');
        if (fs.existsSync(reaRepoPath)) {
          result = { ok: true, message: 'Already cloned at ' + reaRepoPath };
        } else {
          fs.mkdirSync(path.join(__dirname, 'repos'), { recursive: true });
          const r = await new Promise((resolve) => {
            exec('git clone https://github.com/morluto/rea "' + reaRepoPath + '"', { timeout: 300000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
              resolve({ ok: !err, out: (stdout || '') + (stderr || ''), err: err ? err.message : null });
            });
          });
          result = r.ok ? { ok: true, message: 'Cloned REA repo. ' + r.out.slice(0, 200) } : { ok: false, message: 'Clone failed: ' + (r.err || r.out).slice(0, 300) };
        }
      } else if (id === 'ollama-backend') {
        result = { ok: false, message: 'Install Ollama from https://ollama.com/download' };
      } else {
        result = { ok: false, message: 'No auto-installer for this component. See the About/Install URL.' };
      }
      invalidateVersionCache();
      json(res, 200, result);
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  // ---------- Ollama controls ----------
  if (req.url === '/api/ollama-info' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { name } = JSON.parse(body || '{}');
      if (!name) { json(res, 400, { error: 'model name required' }); return; }
      const d = await backendShowModel(name);
      json(res, 200, { info: d });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/ollama-ps' && req.method === 'GET') {
    try {
      const r = await fetch(OLLAMA + '/api/ps');
      if (!r.ok) { json(res, r.status, { error: 'HTTP ' + r.status }); return; }
      const d = await r.json();
      json(res, 200, d);
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/ollama-delete' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { name } = JSON.parse(body || '{}');
      if (!name) { json(res, 400, { error: 'model name required' }); return; }
      const r = await fetch(OLLAMA + '/api/delete', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      if (!r.ok) { const t = await r.text(); json(res, r.status, { error: t || ('HTTP ' + r.status) }); return; }
      json(res, 200, { ok: true, message: 'Deleted ' + name });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/ollama-unload' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { name } = JSON.parse(body || '{}');
      if (!name) { json(res, 400, { error: 'model name required' }); return; }
      // Unload by sending a chat with keep_alive=0
      const r = await fetch(OLLAMA + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name, messages: [], keep_alive: 0 }) });
      json(res, 200, { ok: r.ok, message: r.ok ? 'Unloaded ' + name : 'HTTP ' + r.status });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  // ---------- Multi-chat persistence ----------
  const CHATS_FILE = path.join(DATA_DIR, 'chats.json');
  function loadChats() {
    if (dbModule) {
      try { return dbModule.listChats().map((c) => dbModule.getChat(c.id)); } catch (e) { console.error('loadChats sqlite failed:', e.message); }
    }
    try { return JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8')); } catch (e) { return []; }
  }
  function saveChats(chats) {
    if (dbModule) {
      try {
        const existing = new Set(dbModule.listChats().map((c) => c.id));
        for (const c of (chats || [])) {
          dbModule.saveChat({ id: c.id, title: c.title, messages: c.messages, parent_id: c.parent_id, branch_from: c.branch_from });
          existing.delete(c.id);
        }
        for (const id of existing) dbModule.deleteChat(id);
        return;
      } catch (e) { console.error('saveChats sqlite failed:', e.message); }
    }
    try { const _tmp = CHATS_FILE + '.tmp'; fs.writeFileSync(_tmp, JSON.stringify(chats)); fs.renameSync(_tmp, CHATS_FILE); } catch (e) {}
  }
  function getChatById(id) {
    if (dbModule) { try { return dbModule.getChat(id); } catch (e) {} }
    return loadChats().find((c) => c.id === id) || null;
  }
  function saveOneChat(chat) {
    // Preserve existing messages/links when the caller (e.g. rename) omits them,
    // so a rename doesn't wipe the chat (covers the SQLite path too).
    if (!Array.isArray(chat.messages)) {
      let _existing = null;
      try { _existing = getChatById(chat.id); } catch (e) { _existing = null; }
      chat.messages = (_existing && Array.isArray(_existing.messages)) ? _existing.messages : [];
    }
    if (dbModule) { try { return dbModule.saveChat(chat); } catch (e) { console.error('saveOneChat sqlite failed:', e.message); } }
    // JSON fallback: upsert into chats.json
    const chats = loadChats();
    const idx = chats.findIndex((c) => c.id === chat.id);
    const existing = idx >= 0 ? chats[idx] : null;
    const entry = { id: chat.id || ('chat_' + Date.now()), title: chat.title || 'Untitled', messages: (Array.isArray(chat.messages) ? chat.messages : (existing ? existing.messages : [])), updated: new Date().toISOString(), parent_id: (chat.parent_id === undefined ? (existing ? existing.parent_id : null) : chat.parent_id), branch_from: (chat.branch_from === undefined ? (existing ? existing.branch_from : null) : chat.branch_from) };
    if (idx >= 0) chats[idx] = entry; else chats.unshift(entry);
    // No hard cap on chat history (was 50, which silently dropped older chats)
    saveChats(chats);
    return entry.id;
  }
  function deleteChatById(id) {
    if (dbModule) { try { dbModule.deleteChat(id); return; } catch (e) { console.error('deleteChatById sqlite failed:', e.message); } }
    const chats = loadChats().filter((c) => c.id !== id);
    saveChats(chats);
  }
  function listChatBranches(parentId) {
    if (dbModule) { try { return dbModule.listBranches(parentId); } catch (e) {} }
    return loadChats().filter((c) => c.parent_id === parentId);
  }

  if (req.url === '/api/chats' && req.method === 'GET') {
    const chats = loadChats();
    json(res, 200, { chats: chats.map(c => {
      let prompt = 0, generated = 0, msgs = 0;
      for (const m of (c.messages || [])) {
        msgs++;
        const ts = m.tokenStats;
        if (ts) { prompt += ts.prompt || 0; generated += ts.generated || 0; }
      }
      return { id: c.id, title: c.title, updated: c.updated, parent_id: c.parent_id, branch_from: c.branch_from, messages: msgs, tokenUsage: { prompt, generated } };
    }) });
    return;
  }
  if (req.url === '/api/chats' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { id, title, messages, parent_id, branch_from } = JSON.parse(body || '{}');
      const chatId = saveOneChat({ id, title, messages, parent_id, branch_from });
      json(res, 200, { ok: true, id: chatId });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/chats/delete' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { id } = JSON.parse(body || '{}');
      deleteChatById(id);
      json(res, 200, { ok: true });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }
  if (req.url === '/api/chats/branches' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { id } = JSON.parse(body || '{}');
      if (!id) { json(res, 400, { ok: false, message: 'id required' }); return; }
      const branches = listChatBranches(id);
      json(res, 200, { ok: true, branches });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }
  if (req.url === '/api/chats/branch' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { id, atIndex, title } = JSON.parse(body || '{}');
      const src = getChatById(id);
      if (!src) { json(res, 404, { ok: false, message: 'not found' }); return; }
      const idx = (typeof atIndex === 'number' && atIndex >= 0) ? atIndex : src.messages.length;
      const newId = 'chat_' + Date.now();
      saveOneChat({ id: newId, title: title || (src.title + ' (branch)'), messages: src.messages.slice(0, idx), parent_id: id, branch_from: idx });
      json(res, 200, { ok: true, id: newId, parent_id: id, branch_from: idx });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }
  if (req.url.startsWith('/api/chats/') && req.method === 'GET') {
    const id = req.url.split('/').pop();
    const chat = getChatById(id);
    if (!chat) { json(res, 404, { error: 'not found' }); return; }
    json(res, 200, chat);
    return;
  }
  if (req.url === '/api/settings' && req.method === 'GET') {
    const s = loadSettings();
    json(res, 200, { toolBudget: s.toolBudget || TOOL_BUDGET, sources: s.sources || { re: true, ghidra: true, craft: true, are: true } });
    return;
  }
  if (req.url === '/api/settings' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const patch = JSON.parse(body || '{}');
      const s = loadSettings();
      if (patch.toolBudget !== undefined) s.toolBudget = Math.max(1, Math.min(500, parseInt(patch.toolBudget, 10) || TOOL_BUDGET));
      if (patch.sources && typeof patch.sources === 'object') s.sources = Object.assign({}, s.sources || {}, patch.sources);
      saveSettings(s);
      json(res, 200, { ok: true, settings: s });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/backup' && req.method === 'GET') {
    try {
      const bundle = {
        version: 1,
        created: new Date().toISOString(),
        memory: loadJsonFile(MEMORY_FILE),
        skills: loadSkills(),
        chats: loadChats(),
        searchConfig: loadSearchConfig(),
        settings: loadSettings(),
      };
      json(res, 200, bundle);
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }
  if (req.url === '/api/restore' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const bundle = JSON.parse(body || '{}');
      if (!bundle || typeof bundle !== 'object') { json(res, 400, { ok: false, message: 'Invalid bundle' }); return; }
      if (Array.isArray(bundle.memory)) saveJsonFile(MEMORY_FILE, bundle.memory);
      if (Array.isArray(bundle.skills)) saveSkills(bundle.skills);
      if (Array.isArray(bundle.chats)) saveChats(bundle.chats);
      if (bundle.searchConfig && typeof bundle.searchConfig === 'object') saveSearchConfig(bundle.searchConfig);
      if (bundle.settings && typeof bundle.settings === 'object') saveSettings(bundle.settings);
      json(res, 200, { ok: true, message: 'Restored backup' });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  // RAG reindex: re-embed every chunk of a collection with the current model.
  if (req.url === '/api/rag-reindex' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { collection } = JSON.parse(body || '{}');
      const store = loadRag();
      const coll = collection || store.activeCollection || 'default';
      const col = getCollection(store, coll);
      let n = 0;
      for (const c of col.chunks) {
        c.embedding = await embedText(c.text);
        n++;
      }
      saveRag(store);
      json(res, 200, { ok: true, collection: coll, reindexed: n });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/setup/status' && req.method === 'GET') {
    let needsSetup = true;
    try {
      const fs2 = require('fs');
      const flagFile = path.join(DATA_DIR, 'setup-done.flag');
      if (fs2.existsSync(flagFile)) needsSetup = false;
    } catch (e) {}
    json(res, 200, { needsSetup, ollamaUrl: OLLAMA, backend: BACKEND_TYPE, backendUrl: BACKEND_URL, isOpenAICompat: IS_OPENAI_COMPAT });
    return;
  }
  if (req.url === '/api/setup/complete' && req.method === 'POST') {
    try {
      const fs2 = require('fs');
      fs2.writeFileSync(path.join(DATA_DIR, 'setup-done.flag'), new Date().toISOString(), 'utf8');
      json(res, 200, { ok: true });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/stats' && req.method === 'GET') {
    try {
      const chats = loadChats();
      let msgCount = 0, userCount = 0, assistantCount = 0, tokenPrompt = 0, tokenGenerated = 0;
      for (const c of chats) {
        const msgs = c.messages || [];
        for (const m of msgs) {
          if (!m || !m.role) continue;
          if (m.role !== 'user' && m.role !== 'assistant') continue;
          msgCount++;
          if (m.role === 'user') userCount++; else assistantCount++;
          const ts = m.tokenStats;
          if (ts) { tokenPrompt += ts.prompt || 0; tokenGenerated += ts.generated || 0; }
        }
      }
      json(res, 200, {
        ok: true,
        chats: chats.length,
        messages: { total: msgCount, user: userCount, assistant: assistantCount },
        tokenUsage: { prompt: tokenPrompt, generated: tokenGenerated },
        memories: loadJsonFile(MEMORY_FILE).length,
        skills: loadSkills().length,
      });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  // ---------- RE workspace: binary upload ----------
  if (req.url === '/api/re-upload' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { name, content } = JSON.parse(body || '{}');
      if (!name || !content) { json(res, 400, { ok: false, message: 'name and content required' }); return; }
      const fs = require('fs');
      const path = require('path');
      const wsDir = path.join(__dirname, 'workspace', 're');
      if (!fs.existsSync(wsDir)) fs.mkdirSync(wsDir, { recursive: true });
      const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(wsDir, safeName);
      fs.writeFileSync(filePath, Buffer.from(content, 'base64'));
      json(res, 200, { ok: true, path: filePath, message: 'Uploaded ' + safeName });
    } catch (e) { json(res, (e && e.status) || 500, { ok: false, message: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/re-files' && req.method === 'GET') {
    try {
      const fs = require('fs');
      const path = require('path');
      const wsDir = path.join(__dirname, 'workspace', 're');
      if (!fs.existsSync(wsDir)) { json(res, 200, { files: [] }); return; }
      const files = fs.readdirSync(wsDir).map(f => {
        try { const st = fs.statSync(path.join(wsDir, f)); return { name: f, size: st.size, path: path.join(wsDir, f) }; } catch (e) { return null; }
      }).filter(Boolean);
      json(res, 200, { files });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  // ---------- Import GGUF model into Ollama ----------
  if (req.url === '/api/import-model' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { path: modelPath, name } = JSON.parse(body || '{}');
      if (!modelPath || !name) { json(res, 400, { ok: false, message: 'path and name required' }); return; }
      // Model import (GGUF -> Ollama) only applies to the Ollama backend.
      if (BACKEND_TYPE !== 'ollama') {
        json(res, 400, { ok: false, message: 'Model import is only supported for the Ollama backend. Import models using your ' + BACKEND_TYPE + ' backend tools instead.' });
        return;
      }
      // Make sure Ollama is up before trying to import.
      try {
        const hr = await fetch(OLLAMA + '/api/version');
        if (!hr.ok) throw new Error('HTTP ' + hr.status);
      } catch (e) {
        json(res, 503, { ok: false, message: 'Ollama is not running. Start it with: ollama serve' });
        return;
      }
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      // Verify file exists
      if (!fs.existsSync(modelPath)) {
        json(res, 400, { ok: false, message: 'File not found: ' + modelPath });
        return;
      }
      // Confine the source path to the project root / allow-list, when configured.
      const resolvedModelPath = path.resolve(modelPath);
      if (PROJECT_ROOT_ALLOWLIST.length) {
        const allowed = PROJECT_ROOT_ALLOWLIST.some((base) => resolvedModelPath === base || resolvedModelPath.startsWith(base + path.sep));
        if (!allowed) { json(res, 403, { ok: false, message: 'Model path is outside the allowed directories' }); return; }
      } else if (!resolvedModelPath.startsWith(path.resolve(__dirname) + path.sep) && !resolvedModelPath.startsWith(path.resolve(projectRoot) + path.sep)) {
        console.warn('WARNING: importing model from outside the app/project directory:', resolvedModelPath);
      }
      const stat = fs.statSync(modelPath);
      if (stat.size < 1000) {
        json(res, 400, { ok: false, message: 'File too small (' + stat.size + ' bytes). Not a valid GGUF.' });
        return;
      }
      // Verify GGUF magic bytes
      const magicBuf = Buffer.alloc(4);
      const fd = fs.openSync(modelPath, 'r');
      fs.readSync(fd, magicBuf, 0, 4, 0);
      fs.closeSync(fd);
      if (magicBuf.toString('ascii') !== 'GGUF') {
        json(res, 400, { ok: false, message: 'Not a valid GGUF file (magic: ' + magicBuf.toString('hex') + '). File may be corrupted or not a GGUF model.' });
        return;
      }
      // Sanitize model name: lowercase, only a-z0-9._-
      let safeName = name.toLowerCase().trim().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
      // Ensure name starts with a letter (Ollama requirement)
      if (safeName && !/^[a-z]/.test(safeName)) safeName = 'm' + safeName;
      if (!safeName) safeName = 'imported-model';
      if (safeName && !safeName.includes(':')) safeName += ':latest';
      if (!safeName || !/^[a-z0-9]/.test(safeName)) {
        json(res, 400, { ok: false, message: 'Invalid model name. Use lowercase letters, numbers, dots, hyphens, underscores.' });
        return;
      }
      // Strategy: try multiple approaches to work around Ollama's path resolution
      // quirks on Windows. Each approach uses a different path format.
      const modelDir = path.dirname(resolvedModelPath);
      const modelBaseName = path.basename(resolvedModelPath);
      let r = null;
      const attempts = [];

      // Attempt 1: Ollama API /api/create with absolute forward-slash path
      try {
        const fromPath = resolvedModelPath.replace(/\\\\/g, '/');
        const apiRes = await fetch(OLLAMA + '/api/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: safeName, from: fromPath, stream: false }),
        });
        const apiText = await apiRes.text();
        console.log('Import attempt 1 (API fwd-slash):', apiRes.status, apiText.slice(0, 200));
        if (apiRes.ok) { r = { ok: true, out: apiText || 'done', err: null, code: 0 }; }
        else { attempts.push('API-fwd: ' + apiRes.status + ' ' + apiText.slice(0, 100)); }
      } catch (e) { attempts.push('API-fwd: ' + e.message); }

      // Attempt 2: Ollama API /api/create with absolute backslash path
      if (!r || !r.ok) {
        try {
          const fromPath = resolvedModelPath;
          const apiRes = await fetch(OLLAMA + '/api/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: safeName, from: fromPath, stream: false }),
          });
          const apiText = await apiRes.text();
          console.log('Import attempt 2 (API backslash):', apiRes.status, apiText.slice(0, 200));
          if (apiRes.ok) { r = { ok: true, out: apiText || 'done', err: null, code: 0 }; }
          else { attempts.push('API-back: ' + apiRes.status + ' ' + apiText.slice(0, 100)); }
        } catch (e) { attempts.push('API-back: ' + e.message); }
      }

      // Attempt 3: CLI with Modelfile in same dir as GGUF (relative FROM)
      if (!r || !r.ok) {
        console.log('Import: trying CLI with co-located Modelfile...');
        const tmpModelfile = path.join(modelDir, '.Modelfile_' + Date.now());
        fs.writeFileSync(tmpModelfile, 'FROM ./' + modelBaseName + '\\n', 'utf8');
        const cliR = await runProcess(resolveOllamaBin(), ['create', safeName, '-f', tmpModelfile], { timeout: 600000, maxBuffer: 10 * 1024 * 1024, cwd: modelDir });
        try { fs.unlinkSync(tmpModelfile); } catch (e) {}
        console.log('Import attempt 3 (CLI co-located):', cliR.ok, (cliR.out || cliR.err || '').slice(0, 200));
        if (cliR.ok) r = cliR;
        else attempts.push('CLI-colocated: ' + (cliR.err || cliR.out || '').slice(0, 100));
      }

      // Attempt 4: CLI with temp dir + hard link + relative FROM
      if (!r || !r.ok) {
        console.log('Import: trying CLI with temp dir + hard link...');
        const workDir = path.join(os.tmpdir(), 'aegis-import-' + Date.now());
        fs.mkdirSync(workDir, { recursive: true });
        const workGguf = path.join(workDir, 'model.gguf');
        try { fs.linkSync(resolvedModelPath, workGguf); }
        catch (e) { try { fs.copyFileSync(resolvedModelPath, workGguf); } catch (e2) {} }
        const tmpModelfile = path.join(workDir, 'Modelfile');
        fs.writeFileSync(tmpModelfile, 'FROM ./model.gguf\n', 'utf8');
        const cliR = await runProcess(resolveOllamaBin(), ['create', safeName, '-f', tmpModelfile], { timeout: 600000, maxBuffer: 10 * 1024 * 1024, cwd: workDir });
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
        console.log('Import attempt 4 (CLI tempdir):', cliR.ok, (cliR.out || cliR.err || '').slice(0, 200));
        if (cliR.ok) r = cliR;
        else attempts.push('CLI-tempdir: ' + (cliR.err || cliR.out || '').slice(0, 100));
      }

      if (!r) r = { ok: false, out: '', err: 'all attempts failed: ' + attempts.join(' | '), code: 1 };
      else if (!r.ok) r.err = (r.err || r.out || '') + ' (attempts: ' + attempts.join(' | ') + ')';
      // Strip ANSI escape codes and spinner glyphs from output
      const rawOut = (r.out || r.err) || 'done';
      const cleanOut = rawOut
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        .replace(/\x1b\[\?[0-9]*[hl]/g, '')
        .replace(/[\u280b\u2819\u2839\u2838\u283c\u2834\u2836\u2837\u2807\u280f]/g, '')
        .replace(/gathering model components\s*/gi, '')
        .trim();
      console.log('Import result:', cleanOut.slice(0, 500));
      json(res, 200, { ok: r.ok, message: cleanOut.slice(0, 500), name: safeName });
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); return; }
  }

  if (req.url === '/api/confirm' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { id, approved } = JSON.parse(body || '{}');
      const pending = _pendingConfirms.get(id);
      if (pending) { pending.resolve(!!approved); json(res, 200, { ok: true }); }
      else { json(res, 404, { ok: false, message: 'no pending confirmation with that id' }); }
    } catch (e) { json(res, (e && e.status) || 500, { error: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/agent' && req.method === 'POST') {
    // SSE streaming
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.flushHeaders();
    const sendEvent = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); if (typeof res.flush === 'function') res.flush(); } catch (e) { aborted = true; } };
    let aborted = false;
    // Client disconnect: res 'close' fires on disconnect and also after a normal end,
    // so only abort when the response was not finished. This stops the Ollama stream
    // and the tool loop instead of burning model time for nobody.
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) { aborted = true; ac.abort(); } });
    try {
      const body = await readBody(req);
      const { model, messages, includeRe, includeCoding, cleanRoom, confirmTools, options, keep_alive } = JSON.parse(body || '{}');
      const settings = loadSettings();
      const result = await runAgent(model, messages || [], undefined, {
        includeRe: includeRe !== false,
        includeCoding: includeCoding !== false,
        cleanRoom: cleanRoom === true,
        confirmTools: confirmTools === true,
        options: options || undefined,
        keep_alive: keep_alive,
        toolBudget: settings.toolBudget,
        sources: settings.sources,
        signal: ac.signal,
        onEvent: (ev) => { if (!aborted) sendEvent(ev); },
      });
      if (!aborted) {
        sendEvent({ type: 'final', content: result.final, thinking: result.thinking, toolLog: result.toolLog, webCitations: result.webCitations, toolsDisabled: result.toolsDisabled, tokenStats: result.tokenStats, context: result.context });
        sendEvent({ type: 'done', final: result.final, thinking: result.thinking, toolLog: result.toolLog, webCitations: result.webCitations, toolsDisabled: result.toolsDisabled, tokenStats: result.tokenStats, context: result.context });
        try { res.end(); } catch (_) {}
        setTimeout(() => { autoExtractMemories(result.messages || messages || []).catch(() => {}); }, 5000);
      }
    } catch (e) {
      if (!aborted) console.error('agent error:', e && e.stack || e);
      if (!aborted) logError('agent', e);
      if (!aborted) sendEvent({ type: 'error', message: e.message || String(e) });
    } finally {
      try { res.end(); } catch (_) {}
    }
    return;
  }
  if (req.url.startsWith('/api/') || req.url.startsWith('/v1/')) {
    proxyToOllama(req, res);
  } else {
    serveStatic(req, res);
  }
  } catch (e) { logError('request', e); if (!res.headersSent) json(res, 500, { error: e.message || String(e) }); }
});

if (require.main === module) {
  (async () => {
    await detectBackend();
    if (!getAuthToken() && HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
      if (process.env.AEGISAI_DOCKER === '1') {
        console.warn('WARNING: No auth token set (Docker mode). Container binds to all interfaces; restrict via the host port mapping or set LOCALAI_TOKEN for LAN exposure.');
      } else {
        console.error('FATAL: Refusing to start on non-loopback HOST (' + HOST + ') without an auth token. Set LOCALAI_TOKEN or create auth.json, or bind to 127.0.0.1.');
        process.exit(1);
      }
    }
    server.requestTimeout = 0;
    server.headersTimeout = 60000;
    server.listen(PORT, HOST, () => {
      console.log(`AegisAI web UI: http://${HOST}:${PORT}`);
      console.log(`Backend: ${BACKEND_TYPE} at ${BACKEND_URL}`);
      if (!getAuthToken() && HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1' && process.env.AEGISAI_DOCKER !== '1') {
        console.warn('WARNING: No auth token set and the server is reachable from the network. Set LOCALAI_TOKEN or auth.json.');
      }
    });

    // Init MCP after server start
    initMcp();
    initAwesomeReMcp();
    initGhidrAssistMcp();
    initCraftMcp();
  })().catch((e) => { console.error('Startup error:', e && e.message || e); process.exit(1); });
}

// ---------- Default skill: search before RE ----------
const DEFAULT_SKILL_NAME = 'search-before-re';
function ensureDefaultSkill() {
  try {
    const fs = require('fs');
    const skills = loadSkills();
    if (skills.find((s) => s.name === DEFAULT_SKILL_NAME)) return; // already exists
    const skill = {
      name: DEFAULT_SKILL_NAME,
      description: 'Search the awesome-reverse-engineered index (17,000+ projects) before starting any reverse engineering work. Avoids duplicating existing efforts.',
      code: "print('Use are_search_reverse_engineered to find existing RE projects before starting new work.')",
      created: new Date().toISOString(),
    };
    skills.push(skill);
    saveSkills(skills);
    console.log('Default skill saved:', DEFAULT_SKILL_NAME);
  } catch (e) {
    console.error('Failed to save default skill:', e.message);
  }
}
// Save default skill after a short delay (let MCP init finish)
if (require.main === module) setTimeout(ensureDefaultSkill, 5000);

// ---------- Nightly auto-refresh for ARE data ----------
// Check every hour if data is older than 24 hours and refresh
setInterval(async () => {
  try {
    const fs = require('fs');
    if (!fs.existsSync(ARE_DATA_FILE)) return;
    const stat = fs.statSync(ARE_DATA_FILE);
    const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
    if (ageHours >= 24) {
      console.log('ARE data is', ageHours.toFixed(1), 'hours old. Auto-refreshing...');
      fs.unlinkSync(ARE_DATA_FILE);
      areDataCache = null;
      const data = await loadAreData();
      if (data) console.log('ARE data auto-refreshed:', Array.isArray(data) ? data.length : 0, 'entries');
    }
  } catch (e) {
    console.error('ARE auto-refresh failed:', e.message);
  }
}, 60 * 60 * 1000).unref(); // every hour

// ---------- Awesome-RE data cache ----------
const ARE_DATA_FILE = path.join(DATA_DIR, 'data', 'are-entries.json');
const ARE_DATA_URL = 'https://raw.githubusercontent.com/alexgaoth/awesome-reverse-engineered/main/data/entries.json';
let areDataCache = null;
let areDataLoading = false;

async function loadAreData() {
  if (areDataCache) return areDataCache;
  const fs = require('fs');
  // Try local cache first (refresh if older than 24 hours)
  if (fs.existsSync(ARE_DATA_FILE)) {
    try {
      const stat = fs.statSync(ARE_DATA_FILE);
      const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
      if (ageHours < 24) {
        const raw = fs.readFileSync(ARE_DATA_FILE, 'utf8');
        areDataCache = JSON.parse(raw);
        console.log('Awesome-RE data loaded from cache:', Array.isArray(areDataCache) ? areDataCache.length : 'unknown', 'entries', '(age:', ageHours.toFixed(1), 'h)');
        return areDataCache;
      } else {
        console.log('Cached ARE data is', ageHours.toFixed(1), 'hours old. Will refresh.');
      }
    } catch (e) {
      console.error('Failed to read cached ARE data:', e.message);
    }
  }
  // Download if not cached
  if (areDataLoading) return null;
  areDataLoading = true;
  try {
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      const headers = { 'User-Agent': 'AegisAI' };
      if (process.env.GITHUB_TOKEN) headers['Authorization'] = 'token ' + process.env.GITHUB_TOKEN;
      https.get(ARE_DATA_URL, { headers }, (r) => {
        let buf = '';
        r.on('data', (c) => {
          if (buf.length > 50 * 1024 * 1024) { reject(new Error('ARE data too large')); r.destroy(); return; }
          buf += c;
        });
        r.on('end', () => resolve(buf));
      }).on('error', reject);
    });
    areDataCache = JSON.parse(data);
    // Cache to disk
    try {
      const dir = path.dirname(ARE_DATA_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(ARE_DATA_FILE, data, 'utf8');
      console.log('Awesome-RE data downloaded and cached:', Array.isArray(areDataCache) ? areDataCache.length : 'unknown', 'entries');
    } catch (e) {
      console.error('Failed to cache ARE data:', e.message);
    }
    areDataLoading = false;
    return areDataCache;
  } catch (e) {
    areDataLoading = false;
    console.error('Failed to download ARE data:', e.message);
    return null;
  }
}

// Search ARE data
function searchAreData(query, opts) {
  if (!areDataCache || !Array.isArray(areDataCache)) return [];
  opts = opts || {};
  const limit = (opts.limit === undefined || opts.limit === null) ? 20 : opts.limit;
  if (limit <= 0) return [];
  const q = (query || '').toLowerCase();
  const category = opts.category || '';
  const language = opts.language || '';
  const minStars = opts.minStars || 0;
  const results = [];
  for (const entry of areDataCache) {
    if (!entry) continue;
    // Filter by category
    if (category && (entry.category || '').toLowerCase() !== category.toLowerCase()) continue;
    const entryLang = entry.lang || entry.language || '';
    const entryDesc = entry.desc || entry.description || '';
    // Filter by language
    if (language && entryLang.toLowerCase() !== language.toLowerCase()) continue;
    // Filter by min stars
    if (minStars && (entry.stars || 0) < minStars) continue;
    // Search in name, description, topics
    const topics = Array.isArray(entry.topics) ? entry.topics : [];
    const searchable = ((entry.name || '') + ' ' + entryDesc + ' ' + topics.join(' ') + ' ' + (entry.category || '')).toLowerCase();
    if (q && !searchable.includes(q)) continue;
    results.push(entry);
    if (results.length >= limit) break;
  }
  return results;
}

module.exports = {
  runProcess,
  isValidModelName,
  validateProjectRoot,
  safePath,
  isCleanRoomBlocked,
  readBody,
  searchAreData,
  cosineSim,
  sanitizeForLog,
  setProjectRoot: (r) => { projectRoot = r; },
  // Test-only hook: inject external MCP tool lists without starting those servers.
  __setExternalTools: (name, tools) => {
    if (name === 'ghidra') { ghidraReady = true; ghidraTools = tools; }
    if (name === 'craft') { craftReady = true; craftTools = tools; }
    if (name === 'are') { areReady = true; areTools = tools; }
  },
  getProjectRoot: () => projectRoot,
  server,
  TOOL_BUDGET,
  MAX_BODY_BYTES,
};
