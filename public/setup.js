// AegisAI first-run setup wizard
const TOTAL_STEPS = 5;
let currentStep = 0;
let setupData = { ollamaOk: false, models: [], selectedModels: [], token: '' };

const stepContent = document.getElementById('stepContent');
const btnRow = document.getElementById('btnRow');
const steps = document.querySelectorAll('.step');

function renderSteps() {
  steps.forEach((s, i) => {
    s.classList.remove('active', 'done');
    if (i < currentStep) s.classList.add('done');
    else if (i === currentStep) s.classList.add('active');
  });
}

function setButtons(prev, next, nextLabel) {
  btnRow.innerHTML = '';
  if (prev) {
    const b = document.createElement('button');
    b.textContent = 'Back';
    b.addEventListener('click', () => { currentStep--; renderStep(); });
    btnRow.appendChild(b);
  }
  if (next) {
    const b = document.createElement('button');
    b.className = 'primary';
    b.textContent = nextLabel || 'Next';
    b.addEventListener('click', next);
    btnRow.appendChild(b);
  }
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function api(path, opts) {
  const o = Object.assign({}, opts || {});
  if (o.body && typeof o.body === 'object') o.body = JSON.stringify(o.body);
  const r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, o));
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || d.message || ('HTTP ' + r.status));
  return d;
}

function renderStep() {
  renderSteps();
  switch (currentStep) {
    case 0: renderWelcome(); break;
    case 1: renderOllama(); break;
    case 2: renderModels(); break;
    case 3: renderAuth(); break;
    case 4: renderDone(); break;
  }
}

function renderWelcome() {
  stepContent.innerHTML = `
    <h2>Welcome to AegisAI</h2>
    <p>This wizard will help you get started. It takes about a minute.</p>
    <div class="check"><span class="icon">✓</span><span class="label">AegisAI web UI is running.</span></div>
    <p style="font-size:12px;color:var(--muted);">You can re-run this wizard anytime from Settings.</p>
  `;
  setButtons(false, () => { currentStep = 1; renderStep(); }, 'Get started');
}

async function renderOllama() {
  stepContent.innerHTML = '<h2>Backend</h2><p>Checking configured backend...</p><div class="spinner"></div>';
  setButtons(true, null);
  let backend = 'ollama', backendUrl = '';
  try {
    const v = await api('/api/version');
    backend = v.backend || 'ollama';
    backendUrl = v.backendUrl || '';
  } catch (e) {}
  setupData.backend = backend;
  setupData.backendUrl = backendUrl;
  if (backend !== 'ollama') {
    // Non-Ollama backend: Ollama is not required.
    setupData.ollamaOk = true;
    stepContent.innerHTML = `
      <h2>Backend</h2>
      <p>AegisAI is configured to use a non-Ollama backend.</p>
      <div class="check ok">
        <span class="icon">✓</span>
        <span class="label">Backend: ${esc(backend)} at ${esc(backendUrl)}</span>
      </div>
      <p style="font-size:12px;color:var(--muted);">Make sure the backend server is running and reachable before continuing. Models are managed by the backend itself.</p>
    `;
    setButtons(true, () => { currentStep = 2; renderStep(); }, 'Next');
    return;
  }
  // Ollama backend: check if it's running
  let ok = false, ver = '';
  try {
    const tr = await fetch('/api/tags');
    if (tr.ok) { const j = await tr.json(); ok = true; ver = (j.models || []).length + ' model(s) installed'; }
    else { ok = false; ver = 'HTTP ' + tr.status; }
  } catch (e) { ok = false; ver = e.message; }
  setupData.ollamaOk = ok;
  stepContent.innerHTML = `
    <h2>Ollama backend</h2>
    <p>Ollama is the local LLM runtime that powers AegisAI.</p>
    <div class="check ${ok ? 'ok' : 'fail'}">
      <span class="icon">${ok ? '✓' : '✗'}</span>
      <span class="label">${ok ? 'Ollama is running (' + ver + ').' : 'Ollama is not running.'}</span>
    </div>
    ${ok ? '' : `<p>Start Ollama and click Retry:</p>
      <p><code>ollama serve</code></p>
      <p style="font-size:12px;">Or launch the Ollama app from your Start menu / Applications.</p>
      <button id="retryOllama" style="margin-top:8px;">Retry</button>`}
  `;
  if (!ok) {
    document.getElementById('retryOllama').addEventListener('click', () => renderOllama());
    setButtons(true, null);
  } else {
    setButtons(true, () => { currentStep = 2; renderStep(); }, 'Next');
  }
}

const RECOMMENDED_MODELS = [
  { name: 'llama3.2:3b', size: '~2.0 GB' },
  { name: 'llama3.2:1b', size: '~1.3 GB' },
  { name: 'qwen2.5:14b', size: '~9.0 GB' },
  { name: 'qwen2.5-coder:14b', size: '~9.0 GB' },
  { name: 'qwen2.5-coder:7b', size: '~4.7 GB' },
  { name: 'mistral:7b', size: '~4.1 GB' },
  { name: 'phi3:mini', size: '~2.3 GB' },
  { name: 'gemma2:9b', size: '~5.4 GB' },
  { name: 'deepseek-coder:6.7b', size: '~3.8 GB' },
  { name: 'deepseek-coder-v2:16b', size: '~8.9 GB' },
  { name: 'deepseek-r1:14b', size: '~9.0 GB' },
  { name: 'nomic-embed-text', size: '~0.3 GB' },
  { name: 'moondream', size: '~1.7 GB' },
];

async function renderModels() {
  const backend = setupData.backend || 'ollama';
  if (backend !== 'ollama') {
    stepContent.innerHTML = `
      <h2>Models</h2>
      <p>Models are managed by the ${esc(backend)} backend. Pull or load models using the backend's own tools.</p>
      <div class="check ok"><span class="icon">✓</span><span class="label">Skipping Ollama model pull (backend: ${esc(backend)}).</span></div>
    `;
    setButtons(true, () => { currentStep = 3; renderStep(); }, 'Next');
    return;
  }
  let installed = [];
  try {
    const d = await api('/api/tags').catch(() => ({ models: [] }));
    installed = (d.models || []).map(m => m.name);
  } catch (e) {}
  stepContent.innerHTML = `
    <h2>Models</h2>
    <p>Select models to pull (optional). You can skip this and pull later from the Models button.</p>
    <div style="display:flex;gap:8px;margin-bottom:8px;">
      <button id="selAll" style="font-size:11px;padding:2px 6px;">Select all</button>
      <button id="selNone" style="font-size:11px;padding:2px 6px;">Select none</button>
    </div>
    <div class="model-list" id="modelList"></div>
    <div class="status" id="pullStatus"></div>
    <div class="progress" id="pullProgress" style="display:none;"><div class="progress-bar" id="pullBar"></div></div>
  `;
  const list = document.getElementById('modelList');
  RECOMMENDED_MODELS.forEach(m => {
    const already = installed.includes(m.name);
    const div = document.createElement('div');
    div.className = 'model-item';
    div.innerHTML = `<input type="checkbox" data-model="${esc(m.name)}" ${already ? 'checked disabled' : ''} /> <span>${esc(m.name)}</span> <span class="size">${m.size}${already ? ' (installed)' : ''}</span>`;
    list.appendChild(div);
  });
  document.getElementById('selAll').addEventListener('click', () => list.querySelectorAll('input:not(:disabled)').forEach(c => c.checked = true));
  document.getElementById('selNone').addEventListener('click', () => list.querySelectorAll('input:not(:disabled)').forEach(c => c.checked = false));

  async function pullSelected() {
    const selected = [...list.querySelectorAll('input:checked:not(:disabled)')].map(c => c.dataset.model);
    if (selected.length === 0) { currentStep = 3; renderStep(); return; }
    const btn = document.getElementById('pullBtn');
    if (btn) btn.disabled = true;
    const st = document.getElementById('pullStatus');
    const prog = document.getElementById('pullProgress');
    const bar = document.getElementById('pullBar');
    prog.style.display = 'block';
    let done = 0;
    for (const m of selected) {
      st.textContent = 'Pulling ' + m + ' (' + (done + 1) + '/' + selected.length + ')...';
      st.className = 'status';
      try {
        const r = await api('/api/pull-model', { method: 'POST', body: { name: m } });
        if (!r.ok) throw new Error(r.message || 'pull failed');
        st.textContent = 'Pulled ' + m;
        st.className = 'status ok';
      } catch (e) {
        st.textContent = 'Failed: ' + m + ' — ' + e.message;
        st.className = 'status err';
      }
      done++;
      bar.style.width = Math.round((done / selected.length) * 100) + '%';
    }
    st.textContent = 'Done. ' + done + ' model(s) processed.';
    st.className = 'status ok';
    if (btn) btn.disabled = false;
    currentStep = 3; renderStep();
  }

  setButtons(true, pullSelected, 'Pull selected & continue');
  // Allow skipping
  const skipBtn = document.createElement('button');
  skipBtn.textContent = 'Skip';
  skipBtn.style.fontSize = '12px';
  skipBtn.addEventListener('click', () => { currentStep = 3; renderStep(); });
  btnRow.insertBefore(skipBtn, btnRow.firstChild);
}

function renderAuth() {
  let host = '';
  try { host = window.location.hostname; } catch (e) {}
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
  stepContent.innerHTML = `
    <h2>Security</h2>
    <p>${isLocal ? 'You are accessing locally. An auth token is optional but recommended for LAN access.' : 'You are accessing over the network. Setting an auth token is strongly recommended.'}</p>
    <label>Auth token (leave blank to skip):
      <input type="text" id="tokenInput" placeholder="Enter a secret token" />
    </label>
    <p style="font-size:11px;color:var(--muted);margin-top:8px;">Note: this stores the token in your browser only. To enforce auth on the server, set LOCALAI_TOKEN or create auth.json in the app folder before starting the server (required for LAN/Docker exposure). You can change it later via the LOCALAI_TOKEN env var or auth.json.</p>
  `;
  setButtons(true, async () => {
    const tok = document.getElementById('tokenInput').value.trim();
    if (tok) {
      try { localStorage.setItem('localai_token', tok); } catch (e) {}
      try {
        await fetch('/api/search-config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Auth-Token': tok }, body: JSON.stringify({}) }).catch(() => {});
      } catch (e) {}
    }
    // Persist token server-side via auth.json is not directly supported; store in localStorage (client-side) is enough for the UI.
    currentStep = 4; renderStep();
  }, 'Next');
}

function renderDone() {
  stepContent.innerHTML = `
    <h2>Setup complete!</h2>
    <p>AegisAI is ready to use.</p>
    <div class="check ok"><span class="icon">&#10003;</span><span class="label">Ollama ${setupData.ollamaOk ? 'connected' : 'not connected (start it later)'}</span></div>
    <p style="font-size:12px;color:var(--muted);margin-top:12px;">You can re-run this wizard from Settings -> "Re-run setup".</p>
  `;
  try { localStorage.setItem('localai_firstRunDone', '1'); } catch (e) {}
  // Mark setup as complete on the server so the redirect stops happening
  fetch('/api/setup/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' } }).catch(() => {});
  setButtons(true, () => { window.location.href = '/'; }, 'Open AegisAI');
}

// Check if setup is needed
(async function checkSetup() {
  try {
    const r = await fetch('/api/setup/status');
    const d = await r.json();
    if (d && d.needsSetup) { renderStep(); return; }
  } catch (e) {}
  // Already set up; redirect to main UI
  window.location.href = '/';
})();
