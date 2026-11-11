// lib/db.js - SQLite persistence for AegisAI (chats, memories, skills, settings).
// Tries better-sqlite3 (fast, native) first, then Node's built-in node:sqlite
// (Node 22.5+, no native compilation). Migrates legacy JSON files on first run.
// If neither backend is available, open() throws and server.js falls back to JSON.
let backend = null; // 'better' | 'node'
let DatabaseCtor = null;
// Prefer node:sqlite (built into Node 22.5+, no native compilation needed).
try {
  const ns = require('node:sqlite');
  DatabaseCtor = ns.DatabaseSync;
  backend = 'node';
} catch (e) {
  try {
    DatabaseCtor = require('better-sqlite3');
    backend = 'better';
  } catch (e2) {
    backend = null;
  }
}

let db = null;

function open(dbPath) {
  if (!backend) throw new Error('No SQLite backend available (install better-sqlite3 or use Node 22.5+)');
  if (backend === 'better') {
    db = new DatabaseCtor(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  } else {
    db = new DatabaseCtor(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'Untitled',
      updated TEXT NOT NULL,
      parent_id TEXT,
      branch_from INTEGER,
      messages TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated DESC);
    CREATE INDEX IF NOT EXISTS idx_chats_parent ON chats(parent_id);
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      source TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created TEXT NOT NULL,
      updated TEXT,
      embedding TEXT
    );
    CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      description TEXT,
      code TEXT,
      created TEXT NOT NULL,
      updated TEXT
    );
  `);
  return db;
}

function get() { if (!db) throw new Error('Database not opened'); return db; }

function run(sql, params) {
  const stmt = get().prepare(sql);
  return stmt.run.apply(stmt, params || []);
}
function all(sql, params) {
  const stmt = get().prepare(sql);
  return stmt.all.apply(stmt, params || []);
}
function one(sql, params) {
  const stmt = get().prepare(sql);
  return stmt.get.apply(stmt, params || []);
}

// ---------- Chats ----------
function listChats() {
  return all('SELECT id, title, updated, parent_id, branch_from FROM chats ORDER BY updated DESC');
}
function getChat(id) {
  const row = one('SELECT * FROM chats WHERE id = ?', [id]);
  if (!row) return null;
  return { id: row.id, title: row.title, updated: row.updated, parent_id: row.parent_id, branch_from: row.branch_from, messages: JSON.parse(row.messages || '[]') };
}
function saveChat(chat) {
  const id = chat.id || ('chat_' + Date.now());
  const title = chat.title || 'Untitled';
  const messages = JSON.stringify(chat.messages || []);
  const updated = new Date().toISOString();
  const parentId = chat.parent_id || null;
  const branchFrom = (chat.branch_from === undefined) ? null : chat.branch_from;
  const existing = one('SELECT id FROM chats WHERE id = ?', [id]);
  if (existing) {
    run('UPDATE chats SET title=?, updated=?, messages=?, parent_id=?, branch_from=? WHERE id=?', [title, updated, messages, parentId, branchFrom, id]);
  } else {
    run('INSERT INTO chats (id, title, updated, parent_id, branch_from, messages) VALUES (?,?,?,?,?,?)', [id, title, updated, parentId, branchFrom, messages]);
  }
  return id;
}
function deleteChat(id) {
  run('DELETE FROM chats WHERE id = ?', [id]);
}
function listBranches(parentId) {
  return all('SELECT id, title, updated, branch_from FROM chats WHERE parent_id = ? ORDER BY updated DESC', [parentId]);
}
function chatCount() { return one('SELECT COUNT(*) AS n FROM chats').n; }

// ---------- Memories ----------
function rowToMemory(r) {
  return { id: r.id, text: r.text, source: r.source, tags: JSON.parse(r.tags || '[]'), created: r.created, updated: r.updated, embedding: r.embedding ? JSON.parse(r.embedding) : null };
}
function listMemories() { return all('SELECT * FROM memories ORDER BY created DESC').map(rowToMemory); }
function getMemory(id) { const r = one('SELECT * FROM memories WHERE id = ?', [id]); return r ? rowToMemory(r) : null; }
function saveMemory(m) {
  const id = m.id || ('m_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
  const existing = one('SELECT id FROM memories WHERE id = ?', [id]);
  if (existing) {
    run('UPDATE memories SET text=?, source=?, tags=?, updated=?, embedding=? WHERE id=?', [m.text, m.source || 'manual', JSON.stringify(m.tags || []), new Date().toISOString(), m.embedding ? JSON.stringify(m.embedding) : null, id]);
  } else {
    run('INSERT INTO memories (id, text, source, tags, created, embedding) VALUES (?,?,?,?,?,?)', [id, m.text, m.source || 'manual', JSON.stringify(m.tags || []), m.created || new Date().toISOString(), m.embedding ? JSON.stringify(m.embedding) : null]);
  }
  return id;
}
function deleteMemory(id) { run('DELETE FROM memories WHERE id = ?', [id]); }
function memoryCount() { return one('SELECT COUNT(*) AS n FROM memories').n; }

// ---------- Skills ----------
function listSkills() { return all('SELECT name, description, code, created, updated FROM skills ORDER BY created DESC'); }
function getSkill(name) { return one('SELECT name, description, code, created, updated FROM skills WHERE name = ?', [name]) || null; }
function saveSkill(s) {
  const existing = one('SELECT name FROM skills WHERE name = ?', [s.name]);
  if (existing) {
    run('UPDATE skills SET description=?, code=?, updated=? WHERE name=?', [s.description, s.code, new Date().toISOString(), s.name]);
  } else {
    run('INSERT INTO skills (name, description, code, created) VALUES (?,?,?,?)', [s.name, s.description, s.code, s.created || new Date().toISOString()]);
  }
}
function deleteSkill(name) { run('DELETE FROM skills WHERE name = ?', [name]); }

// ---------- Migration from JSON ----------
function migrateFromJson(dataDir) {
  const fs2 = require('fs');
  const chatsPath = require('path').join(dataDir, 'chats.json');
  if (fs2.existsSync(chatsPath) && chatCount() === 0) {
    try {
      const chats = JSON.parse(fs2.readFileSync(chatsPath, 'utf8'));
      const tx = () => { get().exec('BEGIN'); for (const c of (Array.isArray(chats) ? chats : [])) { run('INSERT OR IGNORE INTO chats (id, title, updated, messages) VALUES (?,?,?,?)', [c.id || ('chat_' + Date.now()), c.title || 'Untitled', c.updated || new Date().toISOString(), JSON.stringify(c.messages || [])]); } get().exec('COMMIT'); };
      try { tx(); console.log('Migrated', Array.isArray(chats) ? chats.length : 0, 'chats from JSON to SQLite'); } catch (e) { try { get().exec('ROLLBACK'); } catch (e2) {} console.error('chat migration failed:', e.message); }
    } catch (e) { console.error('chat migration failed:', e.message); }
  }
  const memPath = require('path').join(dataDir, 'memory.json');
  if (fs2.existsSync(memPath) && memoryCount() === 0) {
    try {
      const mems = JSON.parse(fs2.readFileSync(memPath, 'utf8'));
      const tx = () => { get().exec('BEGIN'); for (const m of (Array.isArray(mems) ? mems : [])) { run('INSERT OR IGNORE INTO memories (id, text, source, tags, created, embedding) VALUES (?,?,?,?,?,?)', [m.id, m.text, m.source, JSON.stringify(m.tags || []), m.created || new Date().toISOString(), m.embedding ? JSON.stringify(m.embedding) : null]); } get().exec('COMMIT'); };
      try { tx(); console.log('Migrated', Array.isArray(mems) ? mems.length : 0, 'memories from JSON to SQLite'); } catch (e) { try { get().exec('ROLLBACK'); } catch (e2) {} console.error('memory migration failed:', e.message); }
    } catch (e) { console.error('memory migration failed:', e.message); }
  }
  const skillsPath = require('path').join(dataDir, 'skills.json');
  if (fs2.existsSync(skillsPath)) {
    try {
      const skills = JSON.parse(fs2.readFileSync(skillsPath, 'utf8'));
      const tx = () => { get().exec('BEGIN'); for (const s of (Array.isArray(skills) ? skills : [])) { run('INSERT OR IGNORE INTO skills (name, description, code, created) VALUES (?,?,?,?)', [s.name, s.description, s.code, s.created || new Date().toISOString()]); } get().exec('COMMIT'); };
      try { tx(); } catch (e) { try { get().exec('ROLLBACK'); } catch (e2) {} console.error('skills migration failed:', e.message); }
    } catch (e) { console.error('skills migration failed:', e.message); }
  }
}

function close() { if (db) { db.close(); db = null; } }

module.exports = { open, get, close, migrateFromJson, backend,
  listChats, getChat, saveChat, deleteChat, listBranches, chatCount,
  listMemories, getMemory, saveMemory, deleteMemory, memoryCount,
  listSkills, getSkill, saveSkill, deleteSkill };
