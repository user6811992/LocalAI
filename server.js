const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8080;

// Prevent a single request error from crashing the whole server
process.on('uncaughtException', (e) => { console.error('uncaughtException:', e && e.stack || e); });
process.on('unhandledRejection', (e) => { console.error('unhandledRejection:', e && e.stack || e); });
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const PUBLIC = path.join(__dirname, 'public');
const OLLAMA_URL = new URL(OLLAMA);

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

// ---------- MCP client (REA) ----------
let mcpClient = null;
let mcpTools = []; // MCP tool descriptors
let mcpReady = false;
let mcpError = null;

async function initMcp() {
  try {
    const { Client } = require('@modelcontextprotocol/sdk/client');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: 'rea',
      args: ['--mcp'],
      env: Object.assign({}, process.env, { PATH: process.env.PATH || '' }),
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
  }
}

function mcpToolsAsOllama() {
  return mcpTools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.inputSchema || { type: 'object', properties: {} },
    },
  }));
}

async function callMcpTool(name, args) {
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
  return text;
}

// ---------- Coding tools (hands-on file/shell) ----------
let projectRoot = path.join(__dirname, 'workspace');

function safePath(rel) {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, rel || '.');
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Path escapes project root: ' + rel);
  }
  return resolved;
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
  { name: 'memory_save', description: 'Save a note/fact to persistent memory (key/value).', parameters: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } },
  { name: 'memory_recall', description: 'Recall a saved memory by key, or list all keys if no key given.', parameters: { type: 'object', properties: { key: { type: 'string' } } } },
  { name: 'run_python', description: 'Run a Python snippet and return stdout/stderr.', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
];

function codingToolsAsOllama() {
  return codingToolsDef.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
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
  return new Promise((resolve) => {
    const req = lib.get(url, { headers: headers || { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
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
    const max = args.max_bytes || 200000;
    const buf = fs.readFileSync(fp);
    const slice = buf.slice(0, max);
    let text = slice.toString('utf8');
    if (buf.length > max) text += '\n... (truncated, ' + buf.length + ' bytes total)';
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
    const { execSync } = require('child_process');
    try {
      const out = execSync(args.command, { cwd: projectRoot, timeout: 60000, maxBuffer: 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return out || '(no output)';
    } catch (e) {
      return 'EXIT ' + (e.status || '?') + '\nSTDOUT:\n' + (e.stdout || '') + '\nSTDERR:\n' + (e.stderr || '') + '\n' + (e.message || '');
    }
  }
  if (name === 'git_status') {
    const { execSync } = require('child_process');
    try { return execSync('git status', { cwd: projectRoot, encoding: 'utf8', timeout: 30000 }); }
    catch (e) { return (e.stdout || '') + (e.stderr || '') + (e.message || ''); }
  }
  if (name === 'git_diff') {
    const { execSync } = require('child_process');
    try { return execSync('git diff', { cwd: projectRoot, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }); }
    catch (e) { return (e.stdout || '') + (e.stderr || '') + (e.message || ''); }
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
    if (result && result.length && !result.startsWith('ERROR') && !result.startsWith('TIMEOUT')) {
      addMemory('Web search (' + engine + '): ' + args.query + '\n' + result.slice(0, 1500), 'web_search', ['search']);
    }
    return result;
  }
  if (name === 'read_pdf') {
    const { execFileSync } = require('child_process');
    const fp = safePath(args.path);
    try {
      const out = execFileSync('python', ['-c', 'import sys,pypdf;r=pypdf.PdfReader(sys.argv[1]);print("\\n".join(p.extract_text() or "" for p in r.pages))', fp], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 120000 });
      return out.slice(0, 200000) || '(no text extracted)';
    } catch (e) { return 'ERROR: ' + (e.stderr || e.message); }
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
  if (name === 'memory_save') {
    const fs = require('fs');
    const memFile = path.join(projectRoot, '.memory.json');
    let mem = {};
    try { mem = JSON.parse(fs.readFileSync(memFile, 'utf8')); } catch (e) {}
    mem[args.key] = args.value;
    fs.writeFileSync(memFile, JSON.stringify(mem, null, 2), 'utf8');
    return 'Saved memory: ' + args.key;
  }
  if (name === 'memory_recall') {
    const fs = require('fs');
    const memFile = path.join(projectRoot, '.memory.json');
    let mem = {};
    try { mem = JSON.parse(fs.readFileSync(memFile, 'utf8')); } catch (e) {}
    if (args.key) {
      return Object.prototype.hasOwnProperty.call(mem, args.key) ? mem[args.key] : '(not found)';
    }
    const keys = Object.keys(mem);
    return keys.length ? keys.join('\n') : '(no memories)';
  }
  if (name === 'run_python') {
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
    return skills.length ? skills.map((s) => s.name + ' â€” ' + s.description).join('\n') : '(no skills)';
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
    const speak = (args.speak === true || args.speak === 'true') ? '$synth.Speak($text);' : '';
    const ps = "Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; $text = @'\n" + args.text.replace(/'/g, "''") + "\n'@; $synth.SetOutputToWaveFile('" + fp.replace(/'/g, "''") + "'); $synth.Speak($text); $synth.SetOutputToDefaultAudioDevice(); " + speak + " Write-Output 'ok'";
    try {
      execFileSync('powershell', ['-Command', ps], { encoding: 'utf8', timeout: 120000 });
      return 'Saved TTS audio: ' + fp;
    } catch (e) { return 'ERROR: ' + (e.stderr || e.message); }
  }
  if (name === 'speech_to_text') {
    const { execFileSync } = require('child_process');
    const fp = safePath(args.path);
    const ps = "Add-Type -AssemblyName System.Speech; $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine; $rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar)); $rec.SetInputToWaveFile('" + fp.replace(/'/g, "''") + "'); $r = $rec.Recognize(); if ($r) { $r.Text } else { '(no speech recognized)' }";
    try {
      const out = execFileSync('powershell', ['-Command', ps], { encoding: 'utf8', timeout: 120000 });
      return out.trim() || '(no text)';
    } catch (e) { return 'ERROR: ' + (e.stderr || e.message); }
  }
  if (name === 'analyze_image') {
    const fs = require('fs');
    const fp = safePath(args.path);
    const buf = fs.readFileSync(fp);
    const b64 = buf.toString('base64');
    const visionModel = 'moondream';
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
const MEMORY_FILE = path.join(__dirname, 'memory.json');
const SKILLS_FILE = path.join(__dirname, 'skills.json');
function loadSkills() { return loadJsonFile(SKILLS_FILE); }
function saveSkills(s) { saveJsonFile(SKILLS_FILE, s); }

function loadJsonFile(fp) { try { return JSON.parse(require('fs').readFileSync(fp, 'utf8')); } catch (e) { return []; } }
function saveJsonFile(fp, data) { require('fs').writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8'); }

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
  const memories = loadJsonFile(MEMORY_FILE);
  // dedup by exact text
  if (memories.some((m) => m.text === text)) return null;
  const emb = await embedText(text);
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
      model: 'llama3.1:8b',
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
const SEARCH_CONFIG_FILE = path.join(__dirname, 'search-config.json');
function loadSearchConfig() {
  try { return JSON.parse(require('fs').readFileSync(SEARCH_CONFIG_FILE, 'utf8')); }
  catch (e) { return { engine: 'duckduckgo', keys: {} }; }
}
function saveSearchConfig(c) { require('fs').writeFileSync(SEARCH_CONFIG_FILE, JSON.stringify(c, null, 2), 'utf8'); }

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
  { name: 'text_to_speech', description: 'Convert text to speech and save as WAV in project root (Windows SAPI). Optionally speak on server speakers.', parameters: { type: 'object', properties: { text: { type: 'string' }, filename: { type: 'string' }, speak: { type: 'boolean' } }, required: ['text'] } },
  { name: 'speech_to_text', description: 'Transcribe a WAV audio file to text (Windows Speech Recognition).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'analyze_image', description: 'Analyze an image file (screenshot etc.) using a vision model and answer a question about it.', parameters: { type: 'object', properties: { path: { type: 'string' }, question: { type: 'string' }, model: { type: 'string' } }, required: ['path'] } },
];

// merge into codingToolsDef
for (const t of extraToolsDef) codingToolsDef.push(t);

const codingToolNames = new Set(codingToolsDef.map((t) => t.name));

// ---------- Streaming helper for Ollama ----------
function ollamaStream(path, bodyObj, onChunk) {
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
        res.on('data', (c) => {
          buf += c.toString();
          const lines = buf.split('\\n');
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
              if (obj.done) done = true;
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
            } catch (e) {}
          }
          resolve({ status: res.statusCode, data: { message: { content: fullContent, thinking: fullThinking, tool_calls: toolCalls } } });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// HTTP helpers marker
// ---------- HTTP helpers ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
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
    req.write(data);
    req.end();
  });
}

// Agent tool loop (non-streaming)
async function runAgent(model, messages, maxIter, opts) {
  opts = opts || {};
  const includeRe = opts.includeRe !== false;
  const includeCoding = opts.includeCoding !== false;
  const onEvent = opts.onEvent || null;
  maxIter = maxIter || 8;
  const tools = [];
  if (includeRe && mcpReady) tools.push(...mcpToolsAsOllama());
  if (includeCoding) tools.push(...codingToolsAsOllama());
  const log = [];
  const relevant = await searchMemory((messages[messages.length-1] && messages[messages.length-1].content) || '', 5);
  const memBlock = relevant.length ? '\n\nRelevant memories from past interactions:\n' + relevant.map((m) => '- ' + m.text).join('\n') : '';
  const systemMsg = { role: 'system', content: 'You are a local AI assistant with hands-on capabilities and persistent memory. You have CODING tools (files, shell, git, web, pdf, screenshots, memory, skills) and REVERSE ENGINEERING tools (REA). Use them to act, not just talk. You learn from past interactions (memories below) and from web searches. Save durable facts with memory_save. Save reusable procedures with skill_save, and reuse them with skill_run. Always explain what you did.' + memBlock };
  let finalThinking = '';
  let msgs = [systemMsg].concat(messages.slice());
  let toolsSupported = true;
  for (let iter = 0; iter < maxIter; iter++) {
    let r;
    let streamedText = '';
    try {
      r = await ollamaStream('/api/chat', {
        model,
        messages: msgs,
        tools: (toolsSupported && tools.length) ? tools : undefined,
        stream: true,
      }, (chunk) => {
        if (chunk.type === 'token') {
          streamedText += chunk.content;
          if (onEvent) onEvent({ type: 'token', content: chunk.content });
        }
        if (chunk.type === 'thinking') {
          if (onEvent) onEvent({ type: 'thinking', content: chunk.content });
        }
      });
    } catch (e) {
      throw new Error('Ollama error: ' + (e.message || String(e)));
    }
    if (r.status !== 200) {
      const errText = (r.data && r.data.error) ? String(r.data.error) : JSON.stringify(r.data);
      if (/does not support tools/i.test(errText)) {
        toolsSupported = false;
        r = await ollamaRequest('/api/chat', { model, messages: msgs, stream: false });
        if (r.status !== 200) throw new Error('Ollama error ' + r.status + ': ' + JSON.stringify(r.data));
        const msg = r.data.message || {};
        msgs.push({ role: 'assistant', content: msg.content || '', thinking: msg.thinking || '' });
        if (onEvent) onEvent({ type: 'final', content: msg.content || '', thinking: msg.thinking || finalThinking, toolLog: log, toolsDisabled: !toolsSupported });
        return { messages: msgs, final: msg.content || '', thinking: msg.thinking || finalThinking, toolLog: log, toolsDisabled: !toolsSupported };
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
      msgs.push({ role: 'assistant', content: msg.content || '', thinking: msg.thinking || '' });
      if (onEvent) onEvent({ type: 'final', content: msg.content || '', thinking: msg.thinking || finalThinking, toolLog: log, toolsDisabled: !toolsSupported });
      return { messages: msgs, final: msg.content || '', thinking: msg.thinking || finalThinking, toolLog: log, toolsDisabled: !toolsSupported };
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
      try {
        if (codingToolNames.has(name)) result = await execCodingTool(name, args || {});
        else result = await callMcpTool(name, args);
      } catch (e) { result = 'ERROR: ' + (e.message || String(e)); }
      msgs.push({ role: 'tool', content: (typeof result === 'string' ? result : JSON.stringify(result)) });
      if (onEvent) onEvent({ type: 'tool_result', name, preview: String(result).slice(0, 200) });
    }
    if (onEvent) onEvent({ type: 'tool_done' });
    accumulatedContent = '';
  }
  const fallback = 'Reached max iterations without final answer.';
  msgs.push({ role: 'assistant', content: fallback });
  if (onEvent) onEvent({ type: 'final', content: fallback, thinking: finalThinking, toolLog: log, toolsDisabled: !toolsSupported });
  return { messages: msgs, final: fallback, thinking: finalThinking, toolLog: log, toolsDisabled: !toolsSupported };
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
      https.get('https://api.github.com/repos/ollama/ollama/releases/latest', { headers: { 'User-Agent': 'LocalAI' } }, (r) => {
        let buf = '';
        r.on('data', (c) => (buf += c));
        r.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    return (data && data.tag_name) ? data.tag_name.replace(/^v/, '') : null;
  } catch (e) { return null; }
}

function getReaAgentVersion() {
  const env = Object.assign({}, process.env, { PATH: (process.env.PATH || '') });
  // try rea --version
  try {
    const { execFileSync } = require('child_process');
    const v = execFileSync('rea', ['--version'], { encoding: 'utf8', timeout: 15000, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (v) return v.split(/\s+/).pop();
  } catch (e) {}
  // fallback npm list
  try {
    const { execFileSync } = require('child_process');
    const v = execFileSync('npm', ['list', '-g', 'rea-agents', '--depth=0', '--json'], { encoding: 'utf8', timeout: 20000, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (v) { const j = JSON.parse(v); return (j.dependencies && j.dependencies['rea-agents'] && j.dependencies['rea-agents'].version) || null; }
  } catch (e) {}
  return null;
}

function getLatestReaAgentVersion() {
  const env = Object.assign({}, process.env, { PATH: (process.env.PATH || '') });
  try {
    const { execFileSync } = require('child_process');
    const v = execFileSync('npm', ['view', 'rea-agents', 'version'], { encoding: 'utf8', timeout: 20000, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
      https.get('https://api.github.com/repos/morluto/rea/commits?per_page=1', { headers: { 'User-Agent': 'LocalAI' } }, (r) => {
        let buf = '';
        r.on('data', (c) => (buf += c));
        r.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
      }).on('error', reject);
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
      const r = await fetch(OLLAMA + '/api/tags');
      if (r.ok) {
        const d = await r.json();
        models = d.models || [];
        ollamaStatus = 'connected';
      } else {
        ollamaStatus = 'http ' + r.status;
      }
    } catch (e) {
      ollamaStatus = 'unreachable: ' + (e.message || e);
    }
    const _cv2 = await getCachedVersions();
    const ollamaVer = _cv2.ollamaVer;
    const ollamaLatest = _cv2.ollamaLatest;
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
      about: 'Local LLM server at ' + OLLAMA + '. Models: ' + models.length + '. Version: ' + (ollamaVer || 'unknown') + (ollamaLatest ? ' (latest: ' + ollamaLatest + ')' : '') + '.',
    });
    for (const m of models) {
      comps.push({
        id: 'model:' + m.name,
        name: m.name,
        kind: 'model',
        status: 'available',
        detail: (m.size ? (m.size / 1e9).toFixed(2) + ' GB' : '') + (m.digest ? ' · ' + m.digest.slice(0, 12) : ''),
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
      about: 'Reverse engineering toolset via REA MCP. Tools: ' + mcpTools.length + '. ' + (mcpError ? 'Error: ' + mcpError : '') + '\\nCurrent: ' + (_cv.reaVer || 'unknown') + ', latest (npm): ' + (_cv.reaLatest || 'unknown'),
    });
    // REA source repo
    const reaRepoPath = path.join(__dirname, 'repos', 'rea');
    let reaRepoStatus = 'not cloned';
    let reaRepoAbout = 'Source repo not present at ' + reaRepoPath;
    if (!fs.existsSync(reaRepoPath)) {
      reaRepoStatus = 'not cloned';
      reaRepoAbout = 'REA source repo not cloned locally.\\nLatest on GitHub: ' + ((_cv && _cv.reaRepo && _cv.reaRepo.remote) || 'unknown') + '\\nClone from https://github.com/morluto/rea';
    } else {
      try {
        const { execFileSync } = require('child_process');
        const branch = execFileSync('git', ['-C', reaRepoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 15000 }).trim();
        const commit = execFileSync('git', ['-C', reaRepoPath, 'log', '-1', '--format=%h %s'], { encoding: 'utf8', timeout: 15000 }).trim();
        const dirty = execFileSync('git', ['-C', reaRepoPath, 'status', '--porcelain'], { encoding: 'utf8', timeout: 15000 }).trim();
        reaRepoStatus = branch + (dirty ? ' (dirty)' : ' (clean)');
        reaRepoAbout = 'Local clone of https://github.com/morluto/rea\\nPath: ' + reaRepoPath + '\\nLatest: ' + commit;
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
      about: reaRepoAbout + '\\nVersion: ' + (_rrv.current || 'unknown') + ' (remote: ' + (_rrv.remote || 'unknown') + ', behind by ' + (_rrv.behind || 0) + ' commit(s)).',
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
function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC, urlPath);
  if (!filePath.startsWith(PUBLIC)) { res.statusCode = 403; res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.statusCode = 404; res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.end(data);
  });
}

function proxyToOllama(req, res) {
  const opts = {
    hostname: OLLAMA_URL.hostname,
    port: OLLAMA_URL.port || 80,
    path: req.url,
    method: req.method,
    headers: Object.assign({}, req.headers, { host: OLLAMA_URL.host }),
  };
  const proxyReq = http.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => {
    if (!res.headersSent) { res.statusCode = 502; }
    try { res.end('Ollama proxy error: ' + e.message); } catch (_) {}
  });
  req.pipe(proxyReq);
}

// ---------- Auth + rate limiting ----------
const AUTH_TOKEN = (process.env.LOCALAI_TOKEN || '').trim();
function getAuthToken() {
  if (AUTH_TOKEN) return AUTH_TOKEN;
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join(__dirname, 'auth.json');
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return (j && j.token) ? String(j.token).trim() : '';
    }
  } catch (e) {}
  return '';
}
const _rateLimits = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const windowMs = 60000;
  const maxReq = 120;
  let entry = _rateLimits.get(ip);
  if (!entry || now - entry.start > windowMs) {
    entry = { start: now, count: 0 };
    _rateLimits.set(ip, entry);
  }
  entry.count++;
  return entry.count > maxReq;
}

const server = http.createServer(async (req, res) => {
  // Rate limit
  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimit(ip)) {
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return;
  }
  // Auth check
  const token = getAuthToken();
  if (token) {
    // Allow health check and static assets without auth? No - require auth for everything except a login hint
    const provided = (req.headers['x-auth-token'] || req.headers['authorization'] || '').replace(/^Bearer\\s+/i, '').trim();
    if (provided !== token) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Unauthorized', authRequired: true }));
      return;
    }
  }
  // Custom routes
  if (req.url === '/api/tools' && req.method === 'GET') {
    json(res, 200, { ready: mcpReady, error: mcpError, projectRoot, tools: mcpTools.map((t) => ({ name: t.name, description: t.description })) });
    return;
  }
  if (req.url === '/api/project' && req.method === 'GET') {
    json(res, 200, { projectRoot });
    return;
  }
  if (req.url === '/api/memory' && req.method === 'GET') {
    const mems = loadJsonFile(MEMORY_FILE);
    json(res, 200, { count: mems.length, memories: mems.map((m) => ({ id: m.id, text: m.text, source: m.source, tags: m.tags, created: m.created })) });
    return;
  }
  if (req.url === '/api/project' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { root } = JSON.parse(body || '{}');
      if (root) { projectRoot = root; }
      json(res, 200, { projectRoot });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.url.startsWith('/api/components') && req.method === 'GET') {
    try {
      const u = new URL(req.url, 'http://localhost');
      if (u.searchParams.get('refresh') === '1') invalidateVersionCache();
      const comps = await getComponents();
      json(res, 200, { components: comps });
    } catch (e) { json(res, 500, { error: e.message || String(e) }); }
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
    } catch (e) { json(res, 500, { error: e.message || String(e) }); }
    return;
  }

  // Background update job state
  if (!global._updateJob) global._updateJob = { running: false, status: '', result: null };

  if (req.url === '/api/component/update-status' && req.method === 'GET') {
    json(res, 200, global._updateJob);
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
          const r = await fetch(OLLAMA + '/api/tags');
          result = r.ok ? { ok: true, message: 'Ollama reachable. ' + ((await r.json()).models || []).length + ' model(s). Up to date.' } : { ok: false, message: 'HTTP ' + r.status };
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
        try {
          const cv = await getCachedVersions();
          if (cv.ollamaVer && cv.ollamaLatest && cv.ollamaVer !== cv.ollamaLatest) {
            // Attempt update: try winget first, then download+run installer
            const { exec } = require('child_process');
            const https = require('https');
            const fs = require('fs');
            const path = require('path');
            const os = require('os');
            // Try winget
            const wg = await new Promise((resolve) => {
              exec('winget upgrade Ollama.Ollama --accept-package-agreements --accept-source-agreements --silent', { timeout: 300000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
                resolve({ ok: !err, out: (stdout || '') + (stderr || ''), err: err ? err.message : null });
              });
            });
            if (wg.ok) {
              invalidateVersionCache();
              result = { ok: true, message: 'Ollama updated via winget. Restart may be required. ' + wg.out.slice(0, 200) };
            } else {
              // Fallback: download installer and run it
              const installerPath = path.join(os.tmpdir(), 'OllamaSetup.exe');
              try {
                await new Promise((resolve, reject) => {
                  const file = fs.createWriteStream(installerPath);
                  function get(url) {
                    https.get(url, { headers: { 'User-Agent': 'LocalAI' } }, (r) => {
                      if (r.statusCode === 301 || r.statusCode === 302 || r.statusCode === 307 || r.statusCode === 308) {
                        get(r.headers.location);
                        return;
                      }
                      if (r.statusCode !== 200) { reject(new Error('HTTP ' + r.statusCode)); return; }
                      r.pipe(file);
                      file.on('finish', () => { file.close(); resolve(); });
                    }).on('error', reject);
                  }
                  get('https://ollama.com/download/OllamaSetup.exe');
                });
                // Run installer (silent)
                const inst = await new Promise((resolve) => {
                  exec('"' + installerPath + '" /S', { timeout: 600000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
                    resolve({ ok: !err, out: (stdout || '') + (stderr || ''), err: err ? err.message : null });
                  });
                });
                try { fs.unlinkSync(installerPath); } catch (_) {}
                if (inst.ok) {
                  invalidateVersionCache();
                  result = { ok: true, message: 'Ollama installer ran. Restart Ollama/server to apply. ' + inst.out.slice(0, 200) };
                } else {
                  result = { ok: false, message: 'Installer failed: ' + (inst.err || inst.out).slice(0, 300) + '. Update manually: https://ollama.com/download' };
                }
              } catch (e) {
                result = { ok: false, message: 'Download failed: ' + (e.message || e) + '. Update manually: https://ollama.com/download' };
              }
            }
          } else {
            const r = await fetch(OLLAMA + '/api/tags');
            result = r.ok ? { ok: true, message: 'Ollama reachable. ' + ((await r.json()).models || []).length + ' model(s). Up to date.' } : { ok: false, message: 'HTTP ' + r.status };
          }
        } catch (e) { result = { ok: false, message: String(e.message || e) }; }
      } else if (id.startsWith('model:')) {
        const modelName = id.slice('model:'.length);
        const { exec } = require('child_process');
        result = await new Promise((resolve) => {
          exec(JSON.stringify(resolveOllamaBin()) + ' pull ' + JSON.stringify(modelName), { timeout: 1800000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) resolve({ ok: false, message: (stderr || err.message || '').slice(0, 500) });
            else resolve({ ok: true, message: (stdout || stderr || 'done').trim().slice(0, 500) });
          });
        });
      } else if (id === 're-tools') {
      } else if (id === 're-tools') {
        // Update rea-agents from npm, then reconnect MCP
        const { exec } = require('child_process');
        const npmUpdate = await new Promise((resolve) => {
          exec('npm install -g rea-agents@latest', {
            timeout: 300000,
            maxBuffer: 1024 * 1024,
            env: Object.assign({}, process.env, { PATH: (process.env.PATH || '') }),
          }, (err, stdout, stderr) => {
            if (err) resolve({ ok: false, msg: (stderr || err.message || '').slice(0, 400) });
            else resolve({ ok: true, msg: (stdout || stderr || 'updated').trim().slice(0, 400) });
          });
        });
        mcpReady = false; mcpError = null; mcpClient = null; mcpTools = [];
        await initMcp();
        const connMsg = mcpReady ? ('RE tools ready. ' + mcpTools.length + ' tools.') : (mcpError || 'reconnect failed');
        result = { ok: npmUpdate.ok && mcpReady, message: (npmUpdate.ok ? 'npm: ' + npmUpdate.msg + ' | ' : 'npm failed: ' + npmUpdate.msg + ' | ') + connMsg };
      } else if (id === 'rea-repo') {
        const reaRepoPath = path.join(__dirname, 'repos', 'rea');
        const { exec } = require('child_process');
        result = await new Promise((resolve) => {
          exec('git pull --ff-only', {
            cwd: reaRepoPath,
            timeout: 300000,
            maxBuffer: 1024 * 1024,
            env: Object.assign({}, process.env, { PATH: (process.env.PATH || '') }),
          }, (err, stdout, stderr) => {
            if (err) resolve({ ok: false, message: (stderr || err.message || '').slice(0, 500) });
            else resolve({ ok: true, message: (stdout || stderr || 'Already up to date.').trim().slice(0, 500) });
          });
        });
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
    } catch (e) { json(res, 500, { error: e.message || String(e) }); }
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
    } catch (e) { json(res, 500, { error: e.message }); }
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
    } catch (e) { json(res, 500, { error: e.message }); }
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
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.url === '/api/pull-model' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { name } = JSON.parse(body || '{}');
      if (!name || !name.trim()) { json(res, 400, { ok: false, message: 'Model name required' }); return; }
      const modelName = name.trim();
      const { exec } = require('child_process');
      const result = await new Promise((resolve) => {
        exec(JSON.stringify(resolveOllamaBin()) + ' pull ' + JSON.stringify(modelName), { timeout: 1800000, maxBuffer: 10 * 1024 * 1024, env: Object.assign({}, process.env, { PATH: (process.env.PATH || '') }) }, (err, stdout, stderr) => {
          if (err) resolve({ ok: false, message: (stderr || err.message || ('exit code ' + (err.code || '?'))).slice(0, 500) });
          else resolve({ ok: true, message: (stdout || stderr || 'done').trim().slice(0, 500) });
        });
      });
      invalidateVersionCache();
      json(res, 200, result);
    } catch (e) { json(res, 500, { error: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/scan-models' && req.method === 'GET') {
    try {
      const fs = require('fs');
      const path = require('path');
      const found = [];
      // Ollama default models dir
      const ollamaModels = path.join(process.env.USERPROFILE || '', '.ollama', 'models');
      if (fs.existsSync(ollamaModels)) {
        found.push({ type: 'ollama-store', path: ollamaModels, label: 'Ollama model store' });
      }
      // Scan drives for GGUF files (up to 4 levels deep, skip system dirs)
      const skip = new Set(['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', '$Recycle.Bin', 'System Volume Information', 'node_modules', '.git']);
      function walk(dir, depth) {
        if (depth > 4) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of entries) {
          if (skip.has(e.name)) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full, depth + 1);
          else if (e.isFile() && e.name.toLowerCase().endsWith('.gguf')) {
            try { const st = fs.statSync(full); found.push({ type: 'gguf', path: full, label: e.name, size: st.size }); } catch (_) {}
          }
        }
      }
      // scan drive roots
      const os = require('os');
      // enumerate drives via fs (try A-Z)
      for (let c = 65; c <= 90; c++) {
        const letter = String.fromCharCode(c);
        const root = letter + ':\\';
        try { if (fs.existsSync(root)) walk(root, 0); } catch (_) {}
      }
      json(res, 200, { found });
    } catch (e) { json(res, 500, { error: e.message || String(e) }); }
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
      json(res, 200, { version: current, isGit });
    } catch (e) { json(res, 500, { error: e.message || String(e) }); }
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
    } catch (e) { json(res, 500, { error: e.message || String(e) }); }
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
      const userDataFiles = ['search-config.json', 'memory.json', 'skills.json'];
      const backupDir = path.join(__dirname, '.update-backup');
      try { if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true }); } catch (_) {}
      // Back up user data before update
      const backedUp = [];
      for (const f of userDataFiles) {
        const src = path.join(__dirname, f);
        if (fs.existsSync(src)) {
          try { fs.copyFileSync(src, path.join(backupDir, f)); backedUp.push(f); } catch (_) {}
        }
      }
      if (backedUp.length) output += 'Backed up user data: ' + backedUp.join(', ') + '\\n';
      if (isGit) {
        output += 'Running git pull...\\n';
        const pullRes = await new Promise((resolve) => {
          exec('git pull origin master', { cwd: __dirname, timeout: 120000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ ok: !err, out: (stdout || '') + (stderr || ''), err: err ? err.message : null });
          });
        });
        output += pullRes.out + '\\n';
        if (!pullRes.ok) { json(res, 500, { ok: false, message: 'git pull failed: ' + (pullRes.err || pullRes.out) }); return; }
      } else {
        json(res, 400, { ok: false, message: 'Not a git repository. Please re-install from the latest release zip.' });
        return;
      }
      // npm install
      output += 'Running npm install...\\n';
      const npmRes = await new Promise((resolve) => {
        exec('npm install', { cwd: __dirname, timeout: 300000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          resolve({ ok: !err, out: (stdout || '') + (stderr || ''), err: err ? err.message : null });
        });
      });
      output += npmRes.out + '\\n';
      if (!npmRes.ok) { json(res, 500, { ok: false, message: 'npm install failed: ' + (npmRes.err || npmRes.out), output }); return; }
      // Restore user data if it was overwritten (gitignored files shouldn't be, but be safe)
      const restored = [];
      for (const f of userDataFiles) {
        const backup = path.join(backupDir, f);
        const target = path.join(__dirname, f);
        if (fs.existsSync(backup) && !fs.existsSync(target)) {
          try { fs.copyFileSync(backup, target); restored.push(f); } catch (_) {}
        }
      }
      if (restored.length) output += 'Restored user data: ' + restored.join(', ') + '\\n';
      // read new version
      let newVersion = 'unknown';
      try { newVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown'; } catch (_) {}
      json(res, 200, { ok: true, message: 'Updated to v' + newVersion + '. Restart the server to apply.', version: newVersion, output });
    } catch (e) { json(res, 500, { error: e.message || String(e) }); }
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
    } catch (e) { json(res, 500, { error: e.message || String(e) }); }
    return;
  }

  // ---------- RAG (document upload + retrieval) ----------
  const RAG_FILE = path.join(__dirname, 'rag-store.json');
  function loadRag() {
    try { return JSON.parse(fs.readFileSync(RAG_FILE, 'utf8')); } catch (e) { return { docs: [], chunks: [] }; }
  }
  function saveRag(store) {
    try { fs.writeFileSync(RAG_FILE, JSON.stringify(store)); } catch (e) {}
  }
  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
    return dot / (Math.sqrt(na)*Math.sqrt(nb) + 1e-9);
  }
  async function embedText(text) {
    try {
      const r = await ollamaRequest('/api/embeddings', { model: 'nomic-embed-text', prompt: text.slice(0, 4000) });
      return r.embedding || null;
    } catch (e) { return null; }
  }

  if (req.url === '/api/rag-docs' && req.method === 'GET') {
    const store = loadRag();
    json(res, 200, { docs: store.docs.map(d => ({ id: d.id, name: d.name, chunks: d.chunks })) });
    return;
  }

  if (req.url === '/api/rag-upload' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { name, content, type } = JSON.parse(body || '{}');
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
      // chunk
      const chunks = [];
      const size = 800;
      for (let i = 0; i < text.length; i += size) {
        chunks.push(text.slice(i, i + size));
      }
      const store = loadRag();
      const docId = 'doc_' + Date.now();
      const doc = { id: docId, name, chunks: chunks.length };
      store.docs.push(doc);
      // embed chunks
      for (let i = 0; i < chunks.length; i++) {
        const emb = await embedText(chunks[i]);
        store.chunks.push({ docId, idx: i, text: chunks[i], embedding: emb });
      }
      saveRag(store);
      json(res, 200, { ok: true, message: 'Indexed ' + chunks.length + ' chunks from ' + name, docId });
    } catch (e) { json(res, 500, { ok: false, message: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/rag-query' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { query, topK } = JSON.parse(body || '{}');
      const k = topK || 5;
      const store = loadRag();
      if (!store.chunks.length) { json(res, 200, { chunks: [] }); return; }
      const qEmb = await embedText(query || '');
      let scored = store.chunks.map(c => ({ text: c.text, docId: c.docId, score: qEmb && c.embedding ? cosine(qEmb, c.embedding) : 0 }));
      scored.sort((a, b) => b.score - a.score);
      json(res, 200, { chunks: scored.slice(0, k).map(s => s.text) });
    } catch (e) { json(res, 500, { ok: false, message: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/rag-clear' && req.method === 'POST') {
    saveRag({ docs: [], chunks: [] });
    json(res, 200, { ok: true });
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
      let cmd = '';
      if (lang === 'python') {
        const f = tmp + '.py';
        fs.writeFileSync(f, code || '');
        cmd = 'python "' + f + '"';
      } else if (lang === 'javascript' || lang === 'js') {
        const f = tmp + '.js';
        fs.writeFileSync(f, code || '');
        cmd = 'node "' + f + '"';
      } else {
        json(res, 400, { ok: false, message: 'Unsupported language. Use python or javascript.' }); return;
      }
      const result = await new Promise((resolve) => {
        exec(cmd, { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          // cleanup
          try { fs.unlinkSync(tmp + (lang === 'python' ? '.py' : '.js')); } catch (_) {}
          resolve({ ok: !err, stdout: (stdout || '').slice(0, 4000), stderr: (stderr || '').slice(0, 2000), code: err ? (err.code || 1) : 0 });
        });
      });
      json(res, 200, result);
    } catch (e) { json(res, 500, { ok: false, message: e.message || String(e) }); }
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
    } catch (e) { json(res, 500, { error: e.message || String(e) }); }
    return;
  }

  if (req.url === '/api/agent' && req.method === 'POST') {
    // SSE streaming
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const sendEvent = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\\n\\n'); } catch (_) {} };
    // abort handling
    let aborted = false;
    req.on('close', () => { aborted = true; });
    try {
      const body = await readBody(req);
      const { model, messages, includeRe, includeCoding } = JSON.parse(body || '{}');
      const result = await runAgent(model, messages || [], undefined, {
        includeRe: includeRe !== false,
        includeCoding: includeCoding !== false,
        onEvent: (ev) => { if (!aborted) sendEvent(ev); },
      });
      if (!aborted) {
        sendEvent({ type: 'done', final: result.final, thinking: result.thinking, toolLog: result.toolLog, toolsDisabled: result.toolsDisabled });
        // background learning
        autoExtractMemories(result.messages || messages || []).catch(() => {});
      }
    } catch (e) {
      console.error('agent error:', e && e.stack || e);
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
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Local AI web UI: http://0.0.0.0:${PORT}`);
  console.log(`Ollama backend: ${OLLAMA}`);
  if (!getAuthToken()) {
    console.warn('WARNING: No auth token set. Set LOCALAI_TOKEN env var or auth.json for LAN security.');
    console.warn('Anyone on your network can access this UI. For remote access, use Tailscale or set a token.');
  }
});

// Init MCP after server start
initMcp();
