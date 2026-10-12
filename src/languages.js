'use strict';
// Languages beyond C/C++: Compiler Explorer language ids, default flags, how
// their output becomes assembly-like rows ({ text, source }), how to run their
// local compiler, and a small function finder used when no language server
// reports symbols. Pure functions: no dependency on the VS Code API.
const { guessCFunctions } = require('./cppScan');

const IS_WIN = process.platform === 'win32';

// VS Code language id -> language. C, C++ and Objective-C use the full C/C++
// pipeline in extension.js (include upload, error recovery, header support).
const LANGUAGES = {
  c: { id: 'c', label: 'C', family: 'c' },
  cpp: { id: 'c++', label: 'C++', family: 'c' },
  'objective-c': { id: 'c++', label: 'Objective-C', family: 'c' },
  'objective-cpp': { id: 'c++', label: 'Objective-C++', family: 'c' },
  // -C link-dead-code: with -O, rustc would otherwise leave small pub functions
  // uncompiled in a library (they are inlined into the crates that use them).
  rust: { id: 'rust', label: 'Rust', flags: '-O', requiredFlags: '-C link-dead-code', compiler: 'r1990', local: 'rustc' },
  go: { id: 'go', label: 'Go', flags: '', compiler: 'gl1260', local: 'go' },
  python: { id: 'python', label: 'Python', flags: '', compiler: 'python314', local: IS_WIN ? 'python' : 'python3', requireName: true },
  zig: { id: 'zig', label: 'Zig', flags: '-O ReleaseFast', compiler: 'z0160', local: 'zig' },
  swift: { id: 'swift', label: 'Swift', flags: '-O', compiler: 'swift640', local: 'swiftc' },
  d: { id: 'd', label: 'D', flags: '-O', compiler: 'ldc1_42' },
  fortran: { id: 'fortran', label: 'Fortran', flags: '-O2', compiler: 'gfortran162', local: 'gfortran' }
};
// Other VS Code ids used by popular extensions for the same languages.
const ALIASES = { FortranFreeForm: 'fortran', 'fortran-modern': 'fortran', 'fortran_free-form': 'fortran', 'fortran_fixed-form': 'fortran', 'fortran90': 'fortran' };
const LANGUAGE_IDS = [...Object.keys(LANGUAGES), ...Object.keys(ALIASES)];

function languageOf(languageId) {
  const key = ALIASES[languageId] || languageId;
  const lang = LANGUAGES[key];
  return lang ? { key, ...lang } : undefined;
}

// ---------------------------------------------------------------------------
// Compiler Explorer output -> rows

// Python: "Disassembly of <code object f at ...>:" starts a function; module
// code comes first. Rows keep only the opcode and its argument.
function pythonRows(rows) {
  const out = [{ text: '<module>:' }];
  for (const row of rows) {
    const text = typeof row === 'string' ? row : row.text || '';
    const def = /^Disassembly of <code object (\S+) at /.exec(text);
    if (def) { out.push({ text: `${def[1]}:` }); continue; }
    const op = /(?:^|\s)([A-Z][A-Z0-9_]{2,})(?:\s+(.*))?$/.exec(text);
    if (!op || /^\s*ExceptionTable\b/.test(text) || /^\s*L\d+ to L\d+/.test(text)) continue;
    const arg = (op[2] || '').trim();
    out.push({ text: `        ${op[1]}${arg ? ` ${arg}` : ''}`, source: row.source });
  }
  return out;
}

// Go: a function starts at its TEXT pseudo-instruction; FUNCDATA/PCDATA are
// metadata; jump targets (main_main_pc48) are local labels.
function goRows(rows) {
  const targets = new Set();
  for (const row of rows) { const m = /^([^\s:]+_pc\d+):$/.exec((row.text || '').trim()); if (m) targets.add(m[1]); }
  const retarget = t => targets.size ? t.replace(/[^\s,()]+_pc\d+/g, x => targets.has(x) ? `.L${x}` : x) : t;
  const out = [];
  for (const row of rows) {
    const t = (row.text || '').trim();
    const text = /^TEXT\s+(.+?)\(SB\)/.exec(t);
    if (text) { out.push({ text: `${text[1]}:` }); continue; }
    if (/^(?:FUNCDATA|PCDATA)\b/.test(t)) continue;
    const label = /^([^\s:]+_pc\d+):$/.exec(t);
    if (label) { out.push({ text: `.L${label[1]}:` }); continue; }
    out.push({ ...row, text: retarget(row.text || '') });
  }
  return out;
}

function remoteRows(langKey, rows) {
  if (langKey === 'python') return pythonRows(rows);
  if (langKey === 'go') return goRows(rows);
  return rows;
}

// ---------------------------------------------------------------------------
// Local compilers. Each returns the command line for one compile; `run` in
// extension.js executes it and hands the output to `parse`.

// Prints the bytecode of every code object as JSON rows. Compiling does not run
// the program. Works with Python 3.6+ (line numbers changed shape in 3.13).
const PYTHON_DIS = `
import sys, dis, json, types
src = sys.stdin.buffer.read().decode('utf-8')
code = compile(src, sys.argv[1] if len(sys.argv) > 1 else '<stdin>', 'exec')
out = []
def emit(co, name):
    out.append({'text': name + ':'})
    line = None
    for ins in dis.get_instructions(co):
        if hasattr(ins, 'line_number'):
            line = ins.line_number
        elif ins.starts_line is not None and ins.starts_line is not False and ins.starts_line is not True:
            line = ins.starts_line
        arg = ins.argrepr if ins.argrepr else ('' if ins.arg is None else str(ins.arg))
        out.append({'text': '        ' + ins.opname + (' ' + arg if arg else ''), 'source': {'line': line} if line else None})
    for c in co.co_consts:
        if isinstance(c, types.CodeType):
            emit(c, getattr(c, 'co_qualname', None) or (c.co_name if name == '<module>' else name + '.' + c.co_name))
emit(code, '<module>')
sys.stdout.write(json.dumps(out))
`;

function hasFlag(flags, re) { return flags.some(f => re.test(f)); }

function crateName(file) {
  const base = file.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '').replace(/\W/g, '_') || 'example';
  return /^\d/.test(base) ? `_${base}` : base;
}

// { args, input?, output: 'stdout'|'stderr'|'file', format: 'gas'|'python'|'go', demanglers, copy?, cwd? }
// `file` is the source to compile; `out` a writable output path in a temporary folder.
function localCommand(langKey, { file, out, flags, text }) {
  switch (langKey) {
    case 'python':
      return { args: ['-c', PYTHON_DIS, file], input: text, output: 'stdout', format: 'python' };
    case 'go':
      // A unique comment defeats the build cache, which would otherwise skip the compile (and the listing).
      return { args: ['build', `-gcflags=-S${flags.length ? ' ' + flags.join(' ') : ''}`, '-o', out, file], output: 'stderr', format: 'go', copy: true, uniqueSuffix: true };
    case 'rust':
      return {
        args: ['--crate-type=lib', `--crate-name=${crateName(file)}`, `--emit=asm=${out}`, '-C', 'debuginfo=1',
          ...(hasFlag(flags, /^--edition/) ? [] : ['--edition=2021']), ...flags, file],
        output: 'file', format: 'gas', demanglers: [['rustfilt', []], ['c++filt', []]]
      };
    case 'swift':
      return {
        args: ['-emit-assembly', '-g', ...flags, '-module-name', crateName(file), file, '-o', out],
        output: 'file', format: 'gas', demanglers: [['swift-demangle', ['--simplified']], ['xcrun', ['swift-demangle', '--simplified']]]
      };
    case 'zig':
      return { args: ['build-obj', ...flags, `-femit-asm=${out}`, '-fno-emit-bin', file], output: 'file', format: 'gas', cwdTemp: true };
    case 'fortran':
      return { args: ['-S', '-g', ...flags, '-o', out, file], output: 'file', format: 'gas' };
    default:
      return undefined;
  }
}

// `go build -gcflags=-S` listing -> rows. Functions are "pkg.Name STEXT ..."
// headers; instructions carry "(file:line)".
function goLocalRows(listing, packageName) {
  const out = [];
  let inText = false;
  for (const line of listing.split(/\r?\n/)) {
    const fn = /^(\S+) STEXT\b/.exec(line);
    if (fn) {
      inText = true;
      out.push({ text: `${fn[1].replace(/^command-line-arguments\./, `${packageName || 'main'}.`)}:` });
      continue;
    }
    if (/^\S/.test(line)) { inText = false; continue; }
    if (!inText) continue;
    const ins = /^\s+0x[0-9a-f]+\s+\d+\s+\((.*):(\d+)\)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!ins || /^(?:TEXT|FUNCDATA|PCDATA)$/.test(ins[3])) continue;
    out.push({ text: `        ${ins[3]}${ins[4] ? ` ${ins[4].trim()}` : ''}`, source: { file: ins[1], line: Number(ins[2]) } });
  }
  return out;
}

function goPackageName(text) {
  const m = /^\s*package\s+(\w+)/m.exec(String(text).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''));
  return m ? m[1] : 'main';
}

// ---------------------------------------------------------------------------
// Finding functions in source (used when no language server reports symbols)

// Comments and string/char literals blanked out (newlines kept), for brace languages.
function maskBraces(text, langKey) {
  const out = text.split('');
  const n = text.length;
  const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' '; };
  const toEol = i => { const j = text.indexOf('\n', i); return j < 0 ? n : j; };
  let i = 0;
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (c === '/' && d === '/') { const j = toEol(i); blank(i, j); i = j; continue; }
    if (c === '/' && d === '*') {
      let depth = 0, j = i;
      while (j < n) {
        if (text[j] === '/' && text[j + 1] === '*') { depth++; j += 2; continue; }
        if (text[j] === '*' && text[j + 1] === '/') { j += 2; if (--depth === 0) break; if (langKey !== 'rust' && langKey !== 'swift') break; continue; }
        j++;
      }
      blank(i, j); i = j; continue;
    }
    if (langKey === 'zig' && c === '\\' && d === '\\') { const j = toEol(i); blank(i, j); i = j; continue; }
    if (langKey === 'go' && c === '`') { let j = text.indexOf('`', i + 1); j = j < 0 ? n : j + 1; blank(i, j); i = j; continue; }
    if (langKey === 'rust' && (c === 'r' || (c === 'b' && d === 'r')) && !/\w/.test(text[i - 1] || '')) {
      const raw = /^b?r(#*)"/.exec(text.slice(i, i + 300));
      if (raw) { const endTok = `"${raw[1]}`; let j = text.indexOf(endTok, i + raw[0].length); j = j < 0 ? n : j + endTok.length; blank(i, j); i = j; continue; }
    }
    if (c === '"') {
      if (langKey === 'swift' && text.startsWith('"""', i)) { let j = text.indexOf('"""', i + 3); j = j < 0 ? n : j + 3; blank(i, j); i = j; continue; }
      let j = i + 1;
      while (j < n && text[j] !== '"' && text[j] !== '\n') { if (text[j] === '\\') j++; j++; }
      blank(i, j + 1); i = j + 1; continue;
    }
    if (c === "'") {
      // A complete character literal; otherwise (Rust lifetimes 'a) leave it.
      const lit = /^'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/.exec(text.slice(i, i + 16));
      if (lit) { blank(i, i + lit[0].length); i += lit[0].length; continue; }
    }
    i++;
  }
  return out.join('');
}

function lineOfIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return idx => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; } return lo; };
}

// Functions whose header matches `re` (name in group 1, or 2), with a `{...}` body
// that starts before `stop` matches (a body-less declaration).
function braceFunctions(text, langKey, re, stop) {
  const m = maskBraces(text, langKey);
  const lineOf = lineOfIndex(text);
  const out = [];
  for (const hit of m.matchAll(re)) {
    const name = hit[1] || hit[2];
    if (!name) continue;
    const from = hit.index + hit[0].length;
    const rest = m.slice(from);
    const open = rest.indexOf('{');
    if (open < 0) continue;
    const stopAt = rest.search(stop);
    if (stopAt >= 0 && stopAt < open) continue;
    let depth = 0, close = -1;
    for (let j = from + open; j < m.length; j++) {
      if (m[j] === '{') depth++;
      else if (m[j] === '}' && --depth === 0) { close = j; break; }
    }
    if (close < 0) continue;
    const start = lineOf(hit.index + (hit[0].length - hit[0].trimStart().length));
    out.push({ name, startLine: start, endLine: lineOf(close), nameLine: start });
  }
  return out;
}

function pythonFunctions(text) {
  const lines = text.split(/\r?\n/);
  const indentOf = l => /^[ \t]*/.exec(l)[0].replace(/\t/g, '    ').length;
  // Lines inside triple-quoted strings do not end a function.
  const inString = new Array(lines.length).fill(false);
  let open = null;
  lines.forEach((l, i) => {
    if (open) inString[i] = true;
    const re = /"""|'''/g;
    let q;
    const code = open ? l : l.replace(/#.*$/, '');
    while ((q = re.exec(code))) { if (!open) open = q[0]; else if (open === q[0]) open = null; }
  });
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (inString[i]) continue;
    const m = /^([ \t]*)(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*[([]/.exec(lines[i]);
    if (!m) continue;
    const indent = indentOf(lines[i]);
    let j = i, depth = 0;
    for (; j < lines.length; j++) {
      for (const ch of lines[j].replace(/#.*$/, '')) { if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--; }
      if (depth <= 0 && /:/.test(lines[j])) break;
    }
    let end = Math.min(j, lines.length - 1);
    for (let k = j + 1; k < lines.length; k++) {
      const l = lines[k];
      if (inString[k]) { end = k; continue; }
      if (!l.trim() || /^\s*#/.test(l)) continue;
      if (indentOf(l) <= indent) break;
      end = k;
    }
    out.push({ name: m[2], startLine: i, endLine: end, nameLine: i });
  }
  return out;
}

function fortranFunctions(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const head = /^\s*(?:(?:pure|elemental|impure|recursive|module|integer|real|logical|complex|character|double\s+precision|type\s*\([^)]*\)|class\s*\([^)]*\))(?:\s*\([^)]*\)|\*\d+)?\s+)*(function|subroutine)\s+([A-Za-z_]\w*)/i;
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i].replace(/!.*$/, ''));
    if (!m || /^\s*end\b/i.test(lines[i])) continue;
    let end = i;
    for (let k = i + 1; k < lines.length; k++) {
      const l = lines[k].replace(/!.*$/, '');
      if (/^\s*end\s*(?:(?:function|subroutine)\b.*)?$/i.test(l)) { end = k; break; }
      end = k;
    }
    out.push({ name: m[2], startLine: i, endLine: end, nameLine: i });
  }
  return out;
}

const DECL_STOP = /;|\b(?:fn|func|struct|enum|impl|trait|class|protocol|extension|var|let|const|pub)\b/;

// [{ name, startLine, endLine, nameLine }] (0-based lines).
function guessFunctions(langKey, text) {
  switch (langKey) {
    case 'python': return pythonFunctions(text);
    case 'rust': return braceFunctions(text, 'rust', /\bfn\s+([A-Za-z_]\w*)/g, DECL_STOP);
    case 'go': return braceFunctions(text, 'go', /(?:^|\n)[ \t]*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[[(]/g, /\n[ \t]*(?:func|type|var|const|import)\b/);
    case 'zig': return braceFunctions(text, 'zig', /\bfn\s+([A-Za-z_]\w*)/g, DECL_STOP);
    case 'swift': return braceFunctions(text, 'swift', /\bfunc\s+([A-Za-z_]\w*|[^\s\w(<]+)|\b(init|deinit)\b(?=\s*[?!]?\s*[({<])/g, /\b(?:func|var|let|struct|enum|class|protocol|extension|init|deinit)\b|}/);
    case 'fortran': return fortranFunctions(text);
    default: return guessCFunctions(text);
  }
}

module.exports = {
  LANGUAGES, ALIASES, LANGUAGE_IDS, languageOf,
  remoteRows, pythonRows, goRows, goLocalRows, goPackageName,
  PYTHON_DIS, localCommand, crateName,
  maskBraces, guessFunctions
};
