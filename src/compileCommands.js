'use strict';
// compile_commands.json databases: loading (reloaded when the file changes) and
// choosing the entry whose compiler and flags are used for a file. No
// dependency on the VS Code API.
const fs = require('fs/promises');
const path = require('path');
const { normPath } = require('./asm');

const cache = new Map();   // database path -> { mtimeMs, size, entries, byFile, error }

// Loads a database, or returns the cached one when the file did not change.
async function loadDatabase(file) {
  let stat;
  try { stat = await fs.stat(file); } catch (e) { return { file, entries: [], byFile: new Map(), error: `${file} was not found.` }; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
  let db;
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(raw)) throw new Error('it must contain a JSON array of entries');
    const entries = [];
    const byFile = new Map();
    for (const e of raw) {
      if (!e || typeof e !== 'object' || typeof e.file !== 'string' || (typeof e.command !== 'string' && !Array.isArray(e.arguments))) continue;
      const directory = path.resolve(path.dirname(file), typeof e.directory === 'string' ? e.directory : '.');
      const entry = { ...e, directory, file: path.resolve(directory, e.file), database: file };
      entries.push(entry);
      const key = normPath(entry.file);
      if (!byFile.has(key)) byFile.set(key, entry);
    }
    db = { file, mtimeMs: stat.mtimeMs, size: stat.size, entries, byFile };
  } catch (e) {
    db = { file, mtimeMs: stat.mtimeMs, size: stat.size, entries: [], byFile: new Map(), error: `Could not read ${file}: ${e.message}` };
  }
  cache.set(file, db);
  return db;
}

// All databases, merged: the first database that lists a file wins.
async function loadDatabases(files) {
  const dbs = await Promise.all(files.map(loadDatabase));
  const entries = [];
  const byFile = new Map();
  for (const db of dbs) {
    entries.push(...db.entries);
    for (const [k, e] of db.byFile) if (!byFile.has(k)) byFile.set(k, e);
  }
  const stamp = dbs.map(d => `${d.file}:${d.mtimeMs}:${d.size}`).join('|');
  return { files, stamp, entries, byFile, errors: dbs.filter(d => d.error).map(d => d.error) };
}

function reload() { cache.clear(); }

// Number of folder steps between two folders (0 = same folder).
function folderDistance(a, b) {
  const rel = path.relative(a, b);
  return rel ? rel.split(/[\\/]+/).length : 0;
}

const INCLUDE_RE = /^[ \t]*#[ \t]*(?:include|import|include_next)[ \t]*[<"]([^">\n]+)[">]/gm;

// Whether `text` (of the file at `from`) includes the file `target`.
function includes(text, from, target) {
  const t = normPath(target);
  const tail = `/${path.basename(target).toLowerCase()}`;
  for (const m of text.matchAll(INCLUDE_RE)) {
    const name = m[1].trim();
    if (normPath(path.resolve(path.dirname(from), name)) === t) return true;
    const spelled = `/${name.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()}`;
    if (t.replace(/\\/g, '/').toLowerCase().endsWith(spelled) && spelled.endsWith(tail)) return true;
  }
  return false;
}

const includerCache = new Map();   // `${database stamps}\n${file}` -> entry | null

// The entry to compile `file` with, and why:
//   1. its own entry;
//   2. the entry of a file known to include it (`includedBy`, e.g. analyzed .cpp files);
//   3. the entry of a source file that includes it (searched nearest folders first);
//   4. an entry in the same folder, else the nearest folder.
// Returns { entry, reason } or undefined.
async function entryFor(db, file, { includedBy = [], readText = defaultRead, maxScan = 400 } = {}) {
  if (!db || !db.entries.length) return undefined;
  const key = normPath(file);
  const own = db.byFile.get(key);
  if (own) return { entry: own, reason: 'its own entry' };
  for (const p of includedBy) {
    const e = db.byFile.get(normPath(p));
    if (e) return { entry: e, reason: `the entry of ${path.basename(p)}, which includes it` };
  }
  const dir = path.dirname(file);
  const byDistance = db.entries
    .map(e => ({ e, d: folderDistance(dir, path.dirname(e.file)) }))
    .sort((a, b) => a.d - b.d);
  const stamp = `${db.stamp || ''}\n${key}`;
  if (!includerCache.has(stamp)) {
    let found = null;
    for (const { e } of byDistance.slice(0, maxScan)) {
      const text = await readText(e.file);
      if (text !== undefined && includes(text, e.file, file)) { found = e; break; }
    }
    includerCache.set(stamp, found);
  }
  const includer = includerCache.get(stamp);
  if (includer) return { entry: includer, reason: `the entry of ${path.basename(includer.file)}, which includes it` };
  const nearest = byDistance[0];
  return { entry: nearest.e, reason: nearest.d === 0 ? `the entry of ${path.basename(nearest.e.file)} in the same folder` : `the entry of ${path.basename(nearest.e.file)} in the nearest folder` };
}

async function defaultRead(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (_) { return undefined; }
}

function clearIncluderCache() { includerCache.clear(); }

module.exports = { loadDatabase, loadDatabases, reload: () => { reload(); clearIncluderCache(); }, entryFor, includes, folderDistance };
