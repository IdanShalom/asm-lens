'use strict';
// compile_commands.json databases: loading (reloaded when the file changes) and
// choosing the entry whose compiler and flags are used for a file. No
// dependency on the VS Code API.
const fs = require('fs/promises');
const path = require('path');
const { normPath } = require('./asm');
const { compileFlagsOf, includeDirsOf, entryCompiler, macroFlags } = require('./flags');

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

const includerCache = new Map();   // `${database stamps}\n${file}` -> entries

// All entries of a file. It can be listed more than once: a 32-bit and a 64-bit build,
// in one database or in several.
function entriesOf(db, file) {
  const key = normPath(file);
  return (db?.entries || []).filter(e => normPath(e.file) === key);
}

// What makes a build different for the preprocessor: its compiler, defines and target.
function buildOf(entry) {
  return [entryCompiler(entry), ...macroFlags(compileFlagsOf(entry))].join(' ');
}

// The entries whose source file includes `file`, directly or through other headers
// (followed the way the entry's own include folders find them), nearest folders first,
// with one of each build before a second one of any: thousands of files of a 32-bit build
// listed first must not hide the 64-bit one.
async function includersOf(db, file, { readText = defaultRead, maxScan = 400, maxFiles = 3000, max = 8 } = {}) {
  if (!db || !db.entries.length) return [];
  const stamp = `${db.stamp || ''}\n${normPath(file)}`;
  if (includerCache.has(stamp)) return includerCache.get(stamp);
  const dir = path.dirname(file);
  const target = normPath(file);
  const nearest = db.entries.map(e => ({ e, d: folderDistance(dir, path.dirname(e.file)) })).sort((a, b) => a.d - b.d).map(x => x.e);
  const texts = new Map();
  const read = async p => {
    const key = normPath(p);
    if (!texts.has(key)) texts.set(key, texts.size < maxFiles ? await readText(p) : undefined);
    return texts.get(key);
  };
  const found = [];
  const perBuild = new Map();
  let scanned = 0;
  for (const entry of nearest) {
    if (found.length >= max || scanned >= maxScan) break;
    if (normPath(entry.file) === target) continue;
    const build = buildOf(entry);
    if ((perBuild.get(build) || 0) >= 2) continue;
    scanned++;
    if (!await reaches(entry.file, file, includeDirsOf(compileFlagsOf(entry), entry.directory), read)) continue;
    perBuild.set(build, (perBuild.get(build) || 0) + 1);
    found.push(entry);
  }
  const seen = new Set();
  const firsts = found.filter(e => { const b = buildOf(e); if (seen.has(b)) return false; seen.add(b); return true; });
  const result = [...firsts, ...found.filter(e => !firsts.includes(e))];
  includerCache.set(stamp, result);
  return result;
}

// Whether `from` includes `file`, directly or through other headers found in `dirs`.
async function reaches(from, file, dirs = [], read = defaultRead) {
  const target = normPath(file);
  const tail = `/${path.basename(file).toLowerCase()}`;
  const seen = new Set([normPath(from)]);
  const queue = [from];
  while (queue.length) {
    const current = queue.shift();
    const text = await read(current);
    if (text === undefined) continue;
    for (const m of text.matchAll(INCLUDE_RE)) {
      const name = m[1].trim();
      if (path.isAbsolute(name)) { if (normPath(name) === target) return true; continue; }
      const spelled = `/${name.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()}`;
      if (normPath(path.resolve(path.dirname(current), name)) === target || (target.replace(/\\/g, '/').toLowerCase().endsWith(spelled) && spelled.endsWith(tail))) return true;
      for (const base of [path.dirname(current), ...dirs]) {
        const next = path.resolve(base, name);
        if (seen.has(normPath(next))) break;
        if (await read(next) === undefined) continue;
        seen.add(normPath(next));
        queue.push(next);
        break;
      }
    }
  }
  return false;
}

// The entry to compile `file` with, and why:
//   1. its own entry;
//   2. the entry of a file known to include it (`includedBy`, e.g. analyzed .cpp files);
//   3. the entry of a source file that includes it, also through other headers (searched nearest folders first);
//   4. an entry in the same folder, else the nearest folder.
// Returns { entry, reason } or undefined.
async function entryFor(db, file, { includedBy = [], readText = defaultRead, maxScan = 400 } = {}) {
  if (!db || !db.entries.length) return undefined;
  const key = normPath(file);
  const own = db.byFile.get(key);
  if (own) return { entry: own, reason: 'its own entry', kind: 'own' };
  for (const p of includedBy) {
    const e = db.byFile.get(normPath(p));
    if (e) return { entry: e, reason: `the entry of ${path.basename(p)}, which includes it`, kind: 'includer' };
  }
  const dir = path.dirname(file);
  const byDistance = db.entries
    .map(e => ({ e, d: folderDistance(dir, path.dirname(e.file)) }))
    .sort((a, b) => a.d - b.d);
  const includer = (await includersOf(db, file, { readText, maxScan }))[0];
  if (includer) return { entry: includer, reason: `the entry of ${path.basename(includer.file)}, which includes it`, kind: 'includer' };
  const nearest = byDistance[0];
  return { entry: nearest.e, reason: nearest.d === 0 ? `the entry of ${path.basename(nearest.e.file)} in the same folder` : `the entry of ${path.basename(nearest.e.file)} in the nearest folder`, kind: 'nearest' };
}

// A build to compile with, chosen by the user: { with: [flags], without: [flags], database, compiler }.
// An entry belongs to it when it has every flag of `with`, none of `without`, and the database and
// compiler, when those are given.
function inBuild(entry, build) {
  if (!build) return true;
  if (build.database && normPath(entry.database || '') !== normPath(build.database)) return false;
  if (build.compiler && normPath(entryCompiler(entry)) !== normPath(build.compiler)) return false;
  const args = compileFlagsOf(entry);
  const has = new Set([...args, ...macroFlags(args)]);
  return (build.with || []).every(f => has.has(f)) && !(build.without || []).some(f => has.has(f));
}

// The database with only the entries of `build` (the same object without one). Kept while the
// database files do not change: a big database is not filtered again for every compile.
const filtered = new Map();   // `${stamp}\n${build}` -> view
function filterDatabase(db, build) {
  if (!db || !build) return db;
  const stamp = `${db.stamp || ''}\n${JSON.stringify(build)}`;
  if (db.stamp && filtered.has(stamp)) return filtered.get(stamp);
  const entries = db.entries.filter(e => inBuild(e, build));
  const byFile = new Map();
  for (const e of entries) { const k = normPath(e.file); if (!byFile.has(k)) byFile.set(k, e); }
  const view = { ...db, entries, byFile, stamp, build };
  if (filtered.size > 20) filtered.clear();
  if (db.stamp) filtered.set(stamp, view);
  return view;
}

// The builds among `entries` (a file listed for a 32-bit and a 64-bit build, say), each with
// what tells it from the others: [{ build, label, entries }]. One build or none: [].
function buildsAmong(entries) {
  const groups = new Map();
  for (const e of entries) {
    const key = `${normPath(e.database || '')}\n${buildOf(e)}`;
    if (!groups.has(key)) groups.set(key, { entries: [], database: e.database, compiler: entryCompiler(e), flags: new Set(macroFlags(compileFlagsOf(e))) });
    groups.get(key).entries.push(e);
  }
  const list = [...groups.values()];
  if (list.length < 2) return [];
  const differ = f => new Set(list.map(f)).size > 1;
  const byDatabase = differ(g => normPath(g.database || ''));
  const byCompiler = differ(g => normPath(g.compiler));
  return list.map(g => {
    const others = list.filter(o => o !== g);
    const own = [...g.flags].filter(f => others.some(o => !o.flags.has(f)));
    const missing = [...new Set(others.flatMap(o => [...o.flags]))].filter(f => !g.flags.has(f));
    const build = {
      with: own,
      // Only what is needed to tell it apart: a 64-bit build written without -m64 is "without -m32".
      without: own.length ? [] : missing,
      ...(byDatabase ? { database: g.database } : {}),
      ...(byCompiler ? { compiler: g.compiler } : {})
    };
    const label = [
      byDatabase ? path.basename(path.dirname(g.database || '')) + '/' + path.basename(g.database || '') : '',
      byCompiler ? path.basename(g.compiler) : '',
      own.join(' '),
      !own.length && missing.length && !byDatabase && !byCompiler ? `without ${missing.join(' ')}` : ''
    ].filter(Boolean).join(' ');
    return { build, label: label || buildOf(g.entries[0]), entries: g.entries };
  });
}

async function defaultRead(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (_) { return undefined; }
}

function clearIncluderCache() { includerCache.clear(); filtered.clear(); }

module.exports = {
  loadDatabase, loadDatabases, reload: () => { reload(); clearIncluderCache(); }, entryFor, entriesOf, buildOf, includersOf, reaches, includes, folderDistance,
  inBuild, filterDatabase, buildsAmong
};
