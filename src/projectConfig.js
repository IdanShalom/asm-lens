// Project configuration file (".asm-lens.json") for Asm Lens.
// Pure helpers: no dependency on the VS Code API, so they can be tested alone.
const fs = require('fs/promises');
const path = require('path');

const CONFIG_NAMES = ['.asm-lens.json', path.join('.vscode', 'asm-lens.json')];

const TEMPLATE = `{
  // "remote": compile on Compiler Explorer (godbolt.org). "local": run "compiler" on this machine.
  "mode": "remote",
  // First compiler is the default; switch with the status-bar item.
  "compilers": [
    { "id": "g152", "name": "GCC 15.2", "flags": "-O2 -masm=intel" }
  ],
  // Searched in this order.
  "includePaths": [
    "include",
    "src",
    { "path": "third_party", "recursive": true }
  ],
  // Searched last, for generated headers.
  "buildFolders": ["build", "out"],
  // Never take headers from these folders (added to the built-in list).
  "excludePaths": [],
  // Passed as -D<name>.
  "defines": [],
  "extraFlags": ""
}
`;

// JSON with // and /* */ comments and trailing commas is accepted.
function parseJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') { if (text[j] === '\\') j++; j++; }
      out += text.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { const j = text.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue; }
    out += c; i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// Accepted "language" values -> Compiler Explorer language ids.
const LANGUAGE_NAMES = {
  c: 'c', 'c++': 'c++', cpp: 'c++', cxx: 'c++',
  rust: 'rust', rs: 'rust', go: 'go', golang: 'go', python: 'python', py: 'python',
  zig: 'zig', swift: 'swift', d: 'd', fortran: 'fortran'
};
const LANGUAGE_LIST = '"c", "c++", "rust", "go", "python", "zig", "swift", "d" or "fortran"';

function normalizeLanguage(value) {
  return LANGUAGE_NAMES[String(value || '').trim().toLowerCase()];
}

function normalizeMode(value, label, warnings) {
  if (value === undefined) return undefined;
  const m = String(value).toLowerCase();
  if (m === 'local' || m === 'remote') return m;
  warnings.push(`Unknown ${label}: ${JSON.stringify(value)} (use "local" or "remote").`);
  return undefined;
}

function stringList(value, label, warnings) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) { warnings.push(`"${label}" must be an array of strings.`); return undefined; }
  return value.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
}
function normalizeDefines(value, label, warnings) {
  const list = stringList(value, label, warnings);
  return list ? list.map(d => d.replace(/^-D/, '')).filter(Boolean) : undefined;
}
function normalizeFlags(value, label, warnings) {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.filter(x => typeof x === 'string').join(' ').trim();
  warnings.push(`"${label}" must be a string or an array of strings.`);
  return undefined;
}

// Validates a parsed config. Invalid entries are skipped and reported in `warnings`.
function normalizeConfig(raw, baseDir) {
  const warnings = [];
  const out = { compilers: [], includePaths: [], warnings };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('The config file must contain a JSON object.');
    return out;
  }
  if (typeof raw.baseUrl === 'string' && raw.baseUrl.trim()) out.baseUrl = raw.baseUrl.trim().replace(/\/$/, '');
  if (typeof raw.flags === 'string') out.flags = raw.flags;
  const lang = normalizeLanguage(raw.language);
  if (raw.language !== undefined && (!lang || (lang !== 'c' && lang !== 'c++'))) warnings.push(`Unknown "language": ${JSON.stringify(raw.language)} (use "c" or "c++"; other languages are set per compiler).`);
  else if (lang) out.language = lang;
  if (Number.isFinite(raw.maxIncludeFiles) && raw.maxIncludeFiles > 0) out.maxIncludeFiles = Math.floor(raw.maxIncludeFiles);

  (Array.isArray(raw.compilers) ? raw.compilers : raw.compilers === undefined ? [] : (warnings.push('"compilers" must be an array.'), [])).forEach((c, i) => {
    const item = typeof c === 'string' ? { id: c } : c;
    if (!item || typeof item.id !== 'string' || !item.id.trim()) { warnings.push(`compilers[${i}] needs an "id".`); return; }
    const entry = { id: item.id.trim(), name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.id.trim() };
    if (typeof item.flags === 'string') entry.flags = item.flags;
    const l = normalizeLanguage(item.language);
    if (item.language !== undefined && !l) warnings.push(`compilers[${i}]: unknown "language" ${JSON.stringify(item.language)} (use ${LANGUAGE_LIST}).`);
    if (l) entry.language = l;
    const mode = normalizeMode(item.mode, `compilers[${i}].mode`, warnings);
    if (mode) entry.mode = mode;
    const defs = normalizeDefines(item.defines, `compilers[${i}].defines`, warnings);
    if (defs) entry.defines = defs;
    const extra = normalizeFlags(item.extraFlags, `compilers[${i}].extraFlags`, warnings);
    if (extra) entry.extraFlags = extra;
    if (typeof item.compiler === 'string' && item.compiler.trim()) entry.compiler = item.compiler.trim();
    out.compilers.push(entry);
  });

  (Array.isArray(raw.includePaths) ? raw.includePaths : raw.includePaths === undefined ? [] : (warnings.push('"includePaths" must be an array.'), [])).forEach((p, i) => {
    const rawPath = typeof p === 'string' ? p : p && typeof p.path === 'string' ? p.path : undefined;
    if (!rawPath || !rawPath.trim()) { warnings.push(`includePaths[${i}] needs a path.`); return; }
    const t = rawPath.trim();
    out.includePaths.push({ dir: path.isAbsolute(t) ? path.resolve(t) : path.resolve(baseDir, t), recursive: typeof p === 'object' && p.recursive === true });
  });

  if (Array.isArray(raw.buildFolders)) out.buildFolders = raw.buildFolders.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
  else if (raw.buildFolders !== undefined) warnings.push('"buildFolders" must be an array of folder names.');

  const excludes = stringList(raw.excludePaths, 'excludePaths', warnings);
  if (excludes) out.excludePaths = excludes;
  const defines = normalizeDefines(raw.defines, 'defines', warnings);
  if (defines) out.defines = defines;
  const extraFlags = normalizeFlags(raw.extraFlags, 'extraFlags', warnings);
  if (extraFlags) out.extraFlags = extraFlags;
  if (raw.uploadSystemHeaders !== undefined) out.uploadSystemHeaders = raw.uploadSystemHeaders === true;
  const mode = normalizeMode(raw.mode, '"mode"', warnings);
  if (mode) out.mode = mode;
  if (typeof raw.compiler === 'string' && raw.compiler.trim()) out.compiler = raw.compiler.trim();
  return out;
}

// Directory that relative paths in the file are resolved against: the folder
// containing the file, or the project root for ".vscode/asm-lens.json".
function configBaseDir(configFile) {
  const dir = path.dirname(configFile);
  return path.basename(dir) === '.vscode' ? path.dirname(dir) : dir;
}

// Looks for the config file in `startDir` and each parent up to `stopDir`
// (inclusive; without it, up to 8 levels). `readText(path)` returns the file
// text or undefined, which lets the caller supply unsaved editor contents.
async function loadProjectConfig(startDir, stopDir, readText = readFromDisk) {
  let dir = path.resolve(startDir);
  const stop = stopDir ? path.resolve(stopDir) : undefined;
  for (let depth = 0; depth < 8; depth++) {
    for (const name of CONFIG_NAMES) {
      const file = path.join(dir, name);
      const text = await readText(file);
      if (text === undefined) continue;
      try {
        const config = normalizeConfig(parseJsonc(text), configBaseDir(file));
        return { file, config, warnings: config.warnings };
      } catch (e) {
        return { file, config: undefined, error: `Could not parse ${file}: ${e.message}`, warnings: [] };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir || (stop && dir === stop)) break;
    dir = parent;
  }
  return undefined;
}

async function readFromDisk(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (_) { return undefined; }
}

module.exports = { CONFIG_NAMES, TEMPLATE, LANGUAGE_NAMES, parseJsonc, normalizeConfig, normalizeLanguage, configBaseDir, loadProjectConfig };
