// Project configuration file (".asm-lens.json") for Asm Lens.
// Pure helpers: no dependency on the VS Code API, so they can be tested alone.
const fs = require('fs/promises');
const path = require('path');

const CONFIG_NAMES = ['.asm-lens.json', path.join('.vscode', 'asm-lens.json')];

const TEMPLATE = `{
  "compilers": [
    { "id": "g152", "name": "GCC 15.2", "flags": "-O2 -masm=intel" }
  ],
  "includePaths": [
    "include",
    "src",
    { "path": "third_party", "recursive": true }
  ],
  "buildFolders": ["build", "out"]
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

function normalizeLanguage(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'c') return 'c';
  if (v === 'c++' || v === 'cpp' || v === 'cxx') return 'c++';
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
  if (raw.language !== undefined && !lang) warnings.push(`Unknown "language": ${JSON.stringify(raw.language)} (use "c" or "c++").`);
  if (lang) out.language = lang;
  if (Number.isFinite(raw.maxIncludeFiles) && raw.maxIncludeFiles > 0) out.maxIncludeFiles = Math.floor(raw.maxIncludeFiles);

  (Array.isArray(raw.compilers) ? raw.compilers : raw.compilers === undefined ? [] : (warnings.push('"compilers" must be an array.'), [])).forEach((c, i) => {
    const item = typeof c === 'string' ? { id: c } : c;
    if (!item || typeof item.id !== 'string' || !item.id.trim()) { warnings.push(`compilers[${i}] needs an "id".`); return; }
    const entry = { id: item.id.trim(), name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.id.trim() };
    if (typeof item.flags === 'string') entry.flags = item.flags;
    const l = normalizeLanguage(item.language);
    if (item.language !== undefined && !l) warnings.push(`compilers[${i}]: unknown "language" ${JSON.stringify(item.language)}.`);
    if (l) entry.language = l;
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

module.exports = { CONFIG_NAMES, TEMPLATE, parseJsonc, normalizeConfig, configBaseDir, loadProjectConfig };
