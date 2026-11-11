// lib/db.js - SQLite persistence for AegisAI (chats, memories, skills, settings).
// Uses better-sqlite3 (synchronous, fast). Migrates legacy JSON files on first run.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

let db = null;

function open(dbPath) {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
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

// ---------- Chats ----------
function listChats() {
  return get().prepare('SELECT id, title, updated, parent_id, branch_from FROM chats ORDER BY updated DESC').all();
}
function getChat(id) {
  const row = get().prepare('SELECT * FROM chats WHERE id = ?').get(id);
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
  const existing = get().prepare('SELECT id FROM chats WHERE id = ?').get(id);
  if (existing) {
    get().prepare('UPDATE chats SET title=?, updated=?, messages=?, parent_id=?, branch_from=? WHERE id=?')
      .run(title, updated, messages, parentId, branchFrom, id);
  } else {
    get().prepare('INSERT INTO chats (id, title, updated, parent_id, branch_from, messages) VALUES (?,?,?,?,?,?)')
      .run(id, title, updated, parentId, branchFrom, messages);
  }
  return id;
}
function deleteChat(id) {
  get().prepare('DELETE FROM chats WHERE id = ?').run(id);
}
function listBranches(parentId) {
  return get().prepare('SELECT id, title, updated, branch_from FROM chats WHERE parent_id = ? ORDER BY updated DESC').all();
}
function chatCount() { return get().prepare('SELECT COUNT(*) AS n FROM chats').get().n; }

// ---------- Memories ----------
function listMemories() { return get().prepare('SELECT * FROM memories ORDER BY created DESC').all().map(rowToMemory); }
function getMemory(id) { const r = get().prepare('SELECT * FROM memories WHERE id = ?').get(id); return r ? rowToMemory(r) : null; }
function rowToMemory(r) {
  return { id: r.id, text: r.text, source: r.source, tags: JSON.parse(r.tags || '[]'), created: r.created, updated: r.updated, embedding: r.embedding ? JSON.parse(r.embedding) : null };
}
function saveMemory(m) {
  const id = m.id || ('m_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
  const existing = get().prepare('SELECT id FROM memories WHERE id = ?').get(id);
  if (existing) {
    get().prepare('UPDATE memories SET text=?, source=?, tags=?, updated=?, embedding=? WHERE id=?')
      .run(m.text, m.source || 'manual', JSON.stringify(m.tags || []), new Date().toISOString(), m.embedding ? JSON.stringify(m.embedding) : null, id);
  } else {
    get().prepare('INSERT INTO memories (id, text, source, tags, created, embedding) VALUES (?,?,?,?,?,?)')
      .run(id, m.text, m.source || 'manual', JSON.stringify(m.tags || []), m.created || new Date().toISOString(), m.embedding ? JSON.stringify(m.embedding) : null);
  }
  return id;
}
function deleteMemory(id) { get().prepare('DELETE FROM memories WHERE id = ?').run(id); }
function memoryCount() { return get().prepare('SELECT COUNT(*) AS n FROM memories').get().n; }

// ---------- Skills ----------
function listSkills() { return get().prepare('SELECT name, description, code, created, updated FROM skills ORDER BY created DESC').all(); }
function getSkill(name) { return get().prepare('SELECT name, description, code, created, updated FROM skills WHERE name = ?').get(name) || null; }
function saveSkill(s) {
  const existing = get().prepare('SELECT name FROM skills WHERE name = ?').get(s.name);
  if (existing) {
    get().prepare('UPDATE skills SET description=?, code=?, updated=? WHERE name=?').run(s.description, s.code, new Date().toISOString(), s.name);
  } else {
    get().prepare('INSERT INTO skills (name, description, code, created) VALUES (?,?,?,?)').run(s.name, s.description, s.code, s.created || new Date().toISOString());
  }
}
function deleteSkill(name) { get().prepare('DELETE FROM skills WHERE name = ?').run(name); }

// ---------- Migration from JSON ----------
function migrateFromJson(dataDir) {
  const chatsPath = path.join(dataDir, 'chats.json');
  if (fs.existsSync(chatsPath) && chatCount() === 0) {
    try {
      const chats = JSON.parse(fs.readFileSync(chatsPath, 'utf8'));
      const insert = get().prepare('INSERT OR IGNORE INTO chats (id, title, updated, messages) VALUES (?,?,?,?)');
      const tx = get().transaction((rows) => { for (const c of rows) insert.run(c.id || ('chat_' + Date.now()), c.title || 'Untitled', c.updated || new Date().toISOString(), JSON.stringify(c.messages || [])); });
      tx(Array.isArray(chats) ? chats : []);
      console.log('Migrated', Array.isArray(chats) ? chats.length : 0, 'chats from JSON to SQLite');
    } catch (e) { console.error('chat migration failed:', e.message); }
  }
  const memPath = path.join(dataDir, 'memory.json');
  if (fs.existsSync(memPath) && memoryCount() === 0) {
    try {
      const mems = JSON.parse(fs.readFileSync(memPath, 'utf8'));
      const insert = get().prepare('INSERT OR IGNORE INTO memories (id, text, source, tags, created, embedding) VALUES (?,?,?,?,?,?)');
      const tx = get().transaction((rows) => { for (const m of rows) insert.run(m.id, m.text, m.source, JSON.stringify(m.tags || []), m.created || new Date().toISOString(), m.embedding ? JSON.stringify(m.embedding) : null); });
      tx(Array.isArray(mems) ? mems : []);
      console.log('Migrated', Array.isArray(mems) ? mems.length : 0, 'memories from JSON to SQLite');
    } catch (e) { console.error('memory migration failed:', e.message); }
  }
  const skillsPath = path.join(dataDir, 'skills.json');
  if (fs.existsSync(skillsPath)) {
    try {
      const skills = JSON.parse(fs.readFileSync(skillsPath, 'utf8'));
      const insert = get().prepare('INSERT OR IGNORE INTO skills (name, description, code, created) VALUES (?,?,?,?)');
      const tx = get().transaction((rows) => { for (const s of rows) insert.run(s.name, s.description, s.code, s.created || new Date().toISOString()); });
      tx(Array.isArray(skills) ? skills : []);
    } catch (e) { console.error('skills migration failed:', e.message); }
  }
}

function close() { if (db) { db.close(); db = null; } }

module.exports = { open, get, close, migrateFromJson,
  listChats, getChat, saveChat, deleteChat, listBranches, chatCount,
  listMemories, getMemory, saveMemory, deleteMemory, memoryCount,
  listSkills, getSkill, saveSkill, deleteSkill };
