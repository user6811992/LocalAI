// lib/settings.js - agent settings (tool budget, tool sources) persistence.
const fs = require('fs');
const path = require('path');

function make(dataDir) {
  const file = path.join(dataDir, 'settings.json');
  function load() {
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return (j && typeof j === 'object') ? j : {}; } catch (e) { return {}; }
  }
  function save(s) { try { fs.writeFileSync(file, JSON.stringify(s || {}, null, 2), 'utf8'); } catch (e) {} }
  function getToolBudget() { const s = load(); return (s.toolBudget && s.toolBudget > 0) ? s.toolBudget : null; }
  function getSources() { return load().sources || { re: true, ghidra: true, craft: true, are: true }; }
  return { load, save, getToolBudget, getSources, file };
}

module.exports = { make };
