// lib/memory.js - semantic memory (embeddings, search, auto-extraction).
const fs = require('fs');
const path = require('path');

function make({ dataDir, ollamaRequest }) {
  const MEMORY_FILE = path.join(dataDir, 'memory.json');
  function load() { try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } catch (e) { return []; } }
  function save(mems) { try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(mems, null, 2), 'utf8'); } catch (e) {} }
  async function embed(text) {
    try {
      const r = await ollamaRequest('/api/embeddings', { model: 'nomic-embed-text', prompt: (text || '').slice(0, 4000) });
      if (r.data && Array.isArray(r.data.embedding)) return r.data.embedding;
    } catch (e) {}
    return null;
  }
  function cosineSim(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
  async function add(text, source, tags) {
    text = (text || '').trim();
    if (!text || text.length < 8) return null;
    const mems = load();
    if (mems.some((m) => m.text === text)) return null;
    const emb = await embed(text);
    const entry = { id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), text, source: source || 'manual', tags: tags || [], created: new Date().toISOString(), embedding: emb };
    mems.push(entry);
    if (mems.length > 5000) mems.splice(0, mems.length - 5000);
    save(mems);
    return entry.id;
  }
  async function search(query, topK) {
    topK = topK || 6;
    const mems = load();
    if (!mems.length) return [];
    const qEmb = await embed(query);
    const scored = mems.map((m) => ({ m, score: qEmb && m.embedding ? cosineSim(qEmb, m.embedding) : (m.text.toLowerCase().includes((query || '').toLowerCase()) ? 0.5 : 0) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.filter((s) => s.score > 0.05).slice(0, topK).map((s) => s.m);
  }
  async function autoExtract(messages, model) {
    try {
      const convo = messages.map((m) => (m.role + ': ' + (m.content || '').slice(0, 1500))).join('\n').slice(0, 8000);
      const r = await ollamaRequest('/api/chat', {
        model: model || process.env.LOCALAI_MEMORY_MODEL || 'llama3.2:1b',
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
        if (typeof f === 'string' && f.trim().length > 8) await add(f.trim(), 'auto', ['auto-extracted']);
      }
    } catch (e) {}
  }
  function forget(id) {
    const mems = load();
    const idx = mems.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    mems.splice(idx, 1);
    save(mems);
    return true;
  }
  function edit(id, text, tags) {
    const mems = load();
    const idx = mems.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    if (text) mems[idx].text = text;
    if (tags) mems[idx].tags = tags;
    mems[idx].updated = new Date().toISOString();
    save(mems);
    return true;
  }
  return { MEMORY_FILE, load, save, embed, cosineSim, add, search, autoExtract, forget, edit };
}

module.exports = { make };
