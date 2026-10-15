'use strict';
// Assembly parsing, symbol names, source mapping and compiler diagnostics.
// Pure functions: no dependency on the VS Code API.
const path = require('path');

const IS_WIN = process.platform === 'win32';
function normPath(p) { const n = path.resolve(p); return IS_WIN ? n.toLowerCase() : n; }

// ---------------------------------------------------------------------------
// Source mapping

// Turns Compiler Explorer's per-row `source` metadata into { key, line, column }
// where `key` identifies a real local file. Rows from files we did not upload
// (system headers) resolve to undefined instead of being mis-mapped to the
// analyzed file.
function makeRefResolver(mainKey, pathMap) {
  const entries = (pathMap || [])
    .map(e => ({ virtual: e.virtual, key: normPath(e.real) }))
    .sort((a, b) => b.virtual.length - a.virtual.length);
  return function resolveRef(row) {
    const s = row && typeof row === 'object' ? row.source : undefined;
    if (s === undefined || s === null) return undefined;
    if (Number.isInteger(s)) return s > 0 ? { key: mainKey, line: s - 1 } : undefined;
    if (typeof s !== 'object' || !Number.isInteger(s.line) || s.line <= 0) return undefined;
    const column = Number.isInteger(s.column) && s.column > 0 ? s.column - 1 : undefined;
    const line = s.line - 1;
    const file = s.file;
    if (file === null || file === undefined || file === 0 || s.mainsource === true) return { key: mainKey, line, column };
    if (typeof file !== 'string') return undefined;
    const norm = file.replace(/\\/g, '/');
    for (const e of entries) {
      if (norm === e.virtual || norm.endsWith('/' + e.virtual)) return { key: e.key, line, column };
    }
    if (/<source>|<stdin>|(^|\/)example\.[^/]+$/.test(norm)) return { key: mainKey, line, column };
    return undefined;
  };
}

// Headers of compilers, SDKs and toolchains: their code is never mapped onto workspace files.
const SYSTEM_PATH_RE = /^\/usr\/|^\/opt\/homebrew\/|^\/Library\/Developer\/|^\/Applications\/Xcode|\/include\/c\+\+\/|[\\/](?:mingw(?:32|64)?|msys64|ucrt64|clang64|clangarm64)[\\/]|[\\/]Program Files(?: \(x86\))?[\\/]|[\\/]\.rustup[\\/]|[\\/]rustlib[\\/]|^\/rustc\/|^<[\w -]+>$/i;
function isSystemPath(p) { return SYSTEM_PATH_RE.test(String(p).replace(/\\/g, '/')) || SYSTEM_PATH_RE.test(String(p)); }

// Maps `.file`/`.loc` paths from local compiler output to local files. "<stdin>"
// and every path in `mainAliases` (a temporary copy) are the analyzed file.
// `realDirs` maps folders as the compiler reports them (symlinks resolved, e.g.
// macOS /private/var) back to how the editor names them: [[real, editor], ...].
function makeLocalRefResolver(mainKey, cwd, mainAliases = [], realDirs = []) {
  const aliases = new Set(mainAliases.map(normPath));
  const prefixes = realDirs.filter(([real, given]) => real && given && normPath(real) !== normPath(given))
    .map(([real, given]) => [normPath(real) + path.sep, path.resolve(given) + path.sep]);
  // key -> the path as the compiler wrote it (keys are lowercase on Windows).
  const pathOf = new Map();
  resolveRef.pathOf = pathOf;
  return resolveRef;
  function resolveRef(row) {
    const s = row && typeof row === 'object' ? row.source : undefined;
    if (!s || !Number.isInteger(s.line) || s.line <= 0) return undefined;
    const line = s.line - 1;
    const column = Number.isInteger(s.column) && s.column > 0 ? s.column - 1 : undefined;
    const file = String(s.file || '');
    if (!file || file === '-' || /(?:^|[\\/])<stdin>$/.test(file)) return { key: mainKey, line, column };
    if (/^<[^<>]*>$/.test(file)) return undefined;                 // <built-in>, <command-line>, <compiler-generated>
    let abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
    for (const [real, given] of prefixes) {
      if (normPath(abs).startsWith(real)) { abs = given + path.resolve(abs).slice(real.length); break; }
    }
    const key = normPath(abs);
    if (aliases.has(key)) return { key: mainKey, line, column };
    if (isSystemPath(abs)) return undefined;
    if (!pathOf.has(key)) pathOf.set(key, path.resolve(abs));
    return { key, line, column };
  }
}

// `.file` strings use C escapes: "C:\\src\\a.h" -> C:\src\a.h
function unescapeAsmString(s) {
  return String(s).replace(/\\([0-7]{1,3}|.)/g, (all, c) => /^[0-7]+$/.test(c) ? String.fromCharCode(parseInt(c, 8)) : c === 'n' ? '\n' : c === 't' ? '\t' : c);
}
function isAbsolutePath(p) { return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p); }

// Section directives: true for code, false for data/debug, undefined if not one.
function sectionKind(t) {
  if (/^\.text\b/.test(t)) return true;
  if (/^\.(?:data|bss|const|cstring|const_data|literal(?:4|8|16)|static_data|mod_init_func|mod_term_func|tdata|tbss|objc_\w+)\b/.test(t) && !/^\.(?:end_)?data_region\b/.test(t)) return false;
  const m = /^\.(?:section|pushsection)\s+(.*)$/.exec(t);
  if (!m) return undefined;
  const spec = m[1].trim();
  if (/^__[A-Z]+\s*,/.test(spec)) {                                   // Mach-O: segment,section
    const [segment, section = ''] = spec.split(',').map(x => x.trim());
    return segment === '__TEXT' && (/^__(?:text|StaticInit)/.test(section) || /\b(?:pure|some)_instructions\b/.test(spec));
  }
  const name = (/^"([^"]*)"|^([^,\s]+)/.exec(spec) || []).slice(1).find(Boolean) || '';
  const flags = (/,\s*"([^"]*)"/.exec(spec) || [])[1] || '';
  return /^\.text(?:[.$]|$)/.test(name) || /^\.(?:init|fini|ltext)$/.test(name) || /x/.test(flags);
}

// Converts raw `-S -g` output into Compiler Explorer-style rows: { text, source }.
// Reads .file/.loc (DWARF) and .cv_file/.cv_loc (CodeView) for line info, keeps
// only code sections and drops directives, comments and assembler-local labels.
// Handles ELF (Linux), COFF (Windows) and Mach-O (macOS, after prepareMachO).
function localAsmToRows(asm, cwd) {
  const files = new Map();
  const cvFiles = new Map();
  let cur = null;
  let code = true, previous = true;
  const stack = [];
  const rows = [];
  for (const raw of asm.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const t = line.trim();
    let m;
    if ((m = t.match(/^\.file\s+(\d+)\s+"((?:[^"\\]|\\.)*)"(?:\s+"((?:[^"\\]|\\.)*)")?/))) {
      const first = unescapeAsmString(m[2]);
      const second = m[3] !== undefined ? unescapeAsmString(m[3]) : undefined;
      files.set(Number(m[1]), second === undefined ? first : isAbsolutePath(second) ? second : path.join(first || cwd, second));
      continue;
    }
    if ((m = t.match(/^\.cv_file\s+(\d+)\s+"((?:[^"\\]|\\.)*)"/))) { cvFiles.set(Number(m[1]), unescapeAsmString(m[2])); continue; }
    if ((m = t.match(/^\.loc\s+(\d+)\s+(\d+)(?:\s+(\d+))?/))) {
      const line0 = Number(m[2]);
      cur = line0 > 0 ? { file: files.get(Number(m[1])) || '<stdin>', line: line0, column: m[3] ? Number(m[3]) : undefined } : null;
      continue;
    }
    if ((m = t.match(/^\.cv_loc\s+\d+\s+(\d+)\s+(\d+)(?:\s+(\d+))?/))) {
      const line0 = Number(m[2]);
      cur = line0 > 0 ? { file: cvFiles.get(Number(m[1])) || '<stdin>', line: line0, column: m[3] ? Number(m[3]) : undefined } : null;
      continue;
    }
    const kind = sectionKind(t);
    if (kind !== undefined) {
      if (/^\.pushsection\b/.test(t)) stack.push(code);
      previous = code;
      code = kind;
      continue;
    }
    if (/^\.popsection\b/.test(t)) { code = stack.length ? stack.pop() : code; continue; }
    if (/^\.previous\b/.test(t)) { [code, previous] = [previous, code]; continue; }
    if (!code) continue;
    if (!t || /^(?:#|\/\/|;|@)/.test(t)) continue;                       // comments
    const label = /^([^\s;#].*?):(?:\s*(?:[#;@].*|\/\/.*))?$/.exec(line);
    if (label) {
      if (/^\.L(?:tmp|func_end|fe|ASF|FB|FE|VL|ehtable|Lexception|Ldebug|Linfo|Lsection)/.test(label[1])) continue; // debug/EH labels
      rows.push({ text: `${label[1]}:` });
      continue;
    }
    if (/^\.[A-Za-z_]/.test(t)) continue;                                  // directive
    rows.push({ text: line, source: cur ? { ...cur } : undefined });
  }
  return rows;
}

// Mach-O (macOS) output marks global symbols with a leading underscore and
// assembler-local labels with L/l. Local labels get a '.' prefix (like ELF's
// .L labels); C symbols lose the underscore; C++/Swift/Rust symbols keep it so
// the demangler recognizes them (see finishMachO).
function isMachO(asm) {
  return /^\s*\.(?:section\s+__TEXT\s*,|build_version\s|macosx_version_min\s|ios_version_min\s|subsections_via_symbols\b)/m.test(asm);
}
function prepareMachO(asm) {
  return asm.replace(/^([^\s:;#"][^:\s]*):/gm, (all, label) => {
    if (!label.startsWith('_')) return `.${label}:`;
    if (/^(?:__Z|_\$[sSe]|__R)/.test(label)) return all;
    return `${label.slice(1)}:`;
  });
}
// After demangling: names the demangler left alone lose the Mach-O underscore.
function finishMachO(asm) {
  return asm.replace(/^_(_Z|\$[sSe]|_R)/gm, '$1');
}

// ---------------------------------------------------------------------------
// Assembly parsing

// Compilers also state the mapping inside the assembly (`.file N "name"`,
// `.loc N line col`). Compiler Explorer's per-row `source` metadata is preferred;
// these directives are the fallback when a row has none.
const FILE_DIRECTIVE = /^\.file\s+(\d+)\s+"((?:[^"\\]|\\.)*)"(?:\s+"((?:[^"\\]|\\.)*)")?/;
const LOC_DIRECTIVE = /^\.loc\s+(\d+)\s+(\d+)(?:\s+(\d+))?/;

const BARE_KEYWORDS = new Set(['END', 'ENDP', 'ENDS', 'ENDM', 'ENDIF', 'ELSE', 'ALIGN', 'CODE', 'DATA', 'PUBLIC', 'EXTERN', 'EXPORT', 'IMPORT', 'INCLUDE', 'PRESERVE8', 'THUMB', 'ARM', 'LTORG', 'NOP', 'RET', 'RETURN']);
const MASM_PROC = /^(\S.*?)\s+PROC\b(?:\s+(?:NEAR|FAR|FRAME(?::\s*\S+)?))*\s*(?:;.*)?$/;
const MASM_ENDP = /^(?:\S.*?\s+)?ENDP\b\s*(?:;.*)?$/;
const CA65_PROC = /^\.proc\s+([^\s:]+)(?:\s*:\s*\w+)?\s*(?:;.*)?$/i;
const CA65_ENDPROC = /^\.endproc\b/i;
const ORCA_START = /^([A-Za-z_~][\w~]*)\s+start(?:\s+\w+)?\s*(?:;.*)?$/i;
const ORCA_END = /^end\s*(?:;.*)?$/i;

function parseFunctions(rows, resolveRef) {
  const functions = [];
  const fileTable = new Map();
  for (const row of rows) {
    const t = (typeof row === 'string' ? row : row.text || '').trim();
    const m = t.match(FILE_DIRECTIVE);
    if (m) fileTable.set(Number(m[1]), m[3] !== undefined && !/^[/<]|^[A-Za-z]:[\\/]/.test(m[3]) ? `${m[2]}/${m[3]}` : (m[3] !== undefined ? m[3] : m[2]));
  }
  let current = null;
  let loc;
  for (const row of rows) {
    const text = (typeof row === 'string' ? row : row.text || '').replace(/\r/g, '');
    const trimmed = text.trim();
    const lm = resolveRef ? trimmed.match(LOC_DIRECTIVE) : null;
    if (lm) {
      const name = fileTable.get(Number(lm[1]));
      loc = name === undefined ? undefined : resolveRef({ source: { file: name, line: Number(lm[2]), column: lm[3] && Number(lm[3]) > 0 ? Number(lm[3]) : undefined } });
    }
    const hasMeta = row && typeof row === 'object' && row.source !== undefined && row.source !== null;
    let ref = resolveRef ? resolveRef(row) : undefined;
    if (!ref && !hasMeta && loc && isInstructionLine(trimmed)) ref = loc;
    // Functions written as blocks: MASM (MSVC) "int square(int) PROC" ... "ENDP",
    // ca65 (cc65) ".proc _square: near" ... ".endproc", ORCA/M "square  start" ... "end".
    const block = MASM_PROC.exec(trimmed) || CA65_PROC.exec(trimmed) || (/^\S/.test(text) ? ORCA_START.exec(trimmed) : null);
    if (block) {
      if (current) functions.push(finalizeFunction(current));
      // ARM listings put the name in pipes: |int square(int)| PROC
      current = { name: block[1].trim().replace(/^\|([\s\S]*)\|$/, '$1'), block: true, rows: [{ text, ref: undefined }], lines: [text], count: 0, instructionLines: [], instructionRows: [] };
      continue;
    }
    if (current && current.block && (MASM_ENDP.test(trimmed) || CA65_ENDPROC.test(trimmed) || ORCA_END.test(trimmed))) {
      current.rows.push({ text, ref: undefined });
      current.lines.push(text);
      functions.push(finalizeFunction(current));
      current = null;
      continue;
    }
    // ARM assembler style (Norcroft, armasm): a label is a bare name at column 0, without a colon.
    const bare = /^[A-Za-z_][\w$.@]*$/.test(text) && !BARE_KEYWORDS.has(text.toUpperCase()) ? text : undefined;
    const labelMatch = bare ? [text, bare] : trimmed.match(/^([^\s].*?):(?:\s*(?:[#;].*|\/\/.*)|\s+@.*)?$/);
    // Inside a function block, labels are jump targets, not functions.
    if (labelMatch && !(current && current.block) && !trimmed.startsWith('.L') && !isLocalDollarLabel(trimmed)) {
      const label = labelMatch[1].trim();
      if (looksLikeFunctionLabel(label)) {
        if (current) functions.push(finalizeFunction(current));
        current = { name: label, rows: [{ text, ref: undefined }], lines: [text], count: 0, instructionLines: [], instructionRows: [] };
        continue;
      }
    }
    if (current) {
      current.rows.push({ text, ref });
      current.lines.push(text);
      // "L0001:  jsr incsp2": a label and an instruction on one line.
      const afterLabel = trimmed.replace(/^[A-Za-z_.$@?][\w.$@?]*:\s+(?=\S)/, '');
      if (isInstructionLine(trimmed) || (afterLabel !== trimmed && isInstructionLine(afterLabel))) {
        current.count++;
        current.instructionLines.push(text);
        current.instructionRows.push({ text, ref });
      }
    }
  }
  if (current) functions.push(finalizeFunction(current));
  return functions;
}
// "$LN5@f" and "$L2" are local labels; "$s4geom6squareyS2iF" is a (mangled) Swift function.
function isLocalDollarLabel(label) { return label.startsWith('$') && !/^\$[sSe]\w/.test(label); }

// Pieces of a function that compilers emit separately: GCC's cold paths
// ("f(int) [clone .cold]", "f.cold"), MSVC's exception funclets ("main$dtor$0",
// "f$catch$1", "`f'::`1'::dtor$0"). Returns the name of the function they belong to.
const PART_RE = /^(.*?)(?:\s*\[clone \.cold(?:\.\d+)?\]|\.cold(?:\.\d+)?|\$(?:dtor|catch|fin|filt|unwind)\$\d+)$/;
function partOf(name) {
  const m = PART_RE.exec(String(name || ''));
  if (m && m[1]) return m[1];
  const msvc = /^`(.+)'::`\d+'::(?:dtor|catch|fin|filt)\$\d+$/.exec(String(name || ''));
  return msvc ? msvc[1] : undefined;
}

// Folds those pieces into their function, so it is counted and shown whole.
function mergeFunctionParts(functions) {
  const byName = new Map(functions.map(f => [f.name, f]));
  const out = [];
  for (const f of functions) {
    if (isDataSymbol(f.name)) continue;
    const parentName = partOf(f.name);
    const parent = parentName !== undefined && (byName.get(parentName) || functions.find(g => g !== f && partOf(g.name) === undefined && g.name.replace(/\(.*$/, '') === parentName.replace(/\(.*$/, '')));
    if (!parent || parent === f) { out.push(f); continue; }
    parent.rows = [...parent.rows, ...f.rows];
    parent.lines = [...parent.lines, ...f.lines];
    parent.instructionRows = [...parent.instructionRows, ...f.instructionRows];
    parent.instructionLines = [...parent.instructionLines, ...f.instructionLines];
    parent.count += f.count;
    for (const k of f.fileKeys) parent.fileKeys.add(k);
    parent.assembly = parent.lines.join('\n');
    parent.parts = [...(parent.parts || []), f.name];
  }
  // Labels without instructions are data (string literals, tables, aliases), not functions.
  return out.filter(f => f.instructionRows.length > 0);
}

// Data the compiler emits next to the functions: RTTI, vtables, guard variables
// (GCC/Clang), and MSVC's vftables and RTTI. Their names would otherwise look
// like the class's constructor.
const DATA_SYMBOL_RE = /^(?:typeinfo(?: name)? for|vtable for|VTT for|construction vtable for|guard variable for|reference temporary(?: #\d+)? for)\s|`(?:vftable|vbtable|RTTI [^']*|string)'/;
function isDataSymbol(name) { return DATA_SYMBOL_RE.test(String(name || '')); }

// Copies of one function with the same name and the same code (a constructor's
// complete- and base-object versions on macOS) are shown once.
function distinctCode(list) {
  const seen = new Set();
  return list.filter(f => {
    const code = f.instructionRows.map(r => String(r.text || '').trim().replace(/\.?L[\w$.]+/g, 'L')).join('\n');
    const key = `${String(f.name).replace(/\s*\[[^\]]*\]$/, '')}\n${code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function looksLikeFunctionLabel(label) {
  if (!label || label.startsWith('.') || isLocalDollarLabel(label)) return false;
  if (/^(?:[#;]|\/\/)/.test(label)) return false;   // comment lines such as LLVM's "# %bb.0:"
  if (/^(?:LBB|LBE|Ltmp|LCFI|Lfunc_begin|Lfunc_end|\.L)/.test(label)) return false;
  return /[A-Za-z_?@]/.test(label) && label.length < 500;
}
function isInstructionLine(line) {
  if (!line || line.startsWith('.') || line.startsWith('#') || line.startsWith(';') || line.endsWith(':')) return false;
  if (/^(?:[A-Za-z_.$?@][\w.$?@]*):/.test(line)) return false;
  const token = line.split(/\s+/)[0];
  if (!token || token.startsWith('.')) return false;
  if (/^(?:section|global|type|size|align|p2align|file|loc|cfi_\w*|intel_syntax|att_syntax|ident|weak|hidden|globl|end|proc|endp|public|extern|assume|segment|ends|equ|db|dw|dd|dq|dt|org|include|includelib|macro|endm|title|subttl|model|code|data|const|byte|word|dword|qword|zero|string|ascii|asciz|long|quad|short|value|text|bss|comm|lcomm|set|option|ALIGN|PUBLIC|EXTRN)$/i.test(token)) return false;
  return /^[A-Za-z][A-Za-z0-9_.]*$/.test(token);
}
function finalizeFunction(fn) {
  const fileKeys = new Set();
  for (const r of fn.instructionRows) if (r.ref) fileKeys.add(r.ref.key);
  return { ...fn, fileKeys, assembly: fn.lines.join('\n') };
}
function cleanInstruction(text) { return text.trim().replace(/\s+#.*$/, '').trim(); }

// key -> line -> [{ fnName, text }]: every emitted instruction by source line.
function buildLineIndex(functions) {
  const index = new Map();
  for (const fn of functions) {
    for (const r of fn.instructionRows) {
      if (!r.ref) continue;
      let lines = index.get(r.ref.key);
      if (!lines) index.set(r.ref.key, lines = new Map());
      let list = lines.get(r.ref.line);
      if (!list) lines.set(r.ref.line, list = []);
      list.push({ fnName: fn.sourceName || fn.name, text: cleanInstruction(r.text), fn });
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// Names

// Drops <...> template arguments (nesting-aware).
function stripTemplateArgs(s) {
  let out = '', depth = 0;
  for (const c of s) {
    if (c === '<') { depth++; continue; }
    if (c === '>') { if (depth) depth--; continue; }
    if (!depth) out += c;
  }
  return out;
}

// Replaces each balanced {...} group: "f()::{lambda(int)#1}" -> "f()::lambda".
function replaceBraced(s, word) {
  let out = '', depth = 0;
  for (const c of s) {
    if (c === '{') { if (!depth) out += word; depth++; continue; }
    if (c === '}') { if (depth) depth--; continue; }
    if (!depth) out += c;
  }
  return out;
}

const OPERATOR_TOKEN = /^\s*(\(\s*\)|\[\s*\]|(?:new|delete)\s*(?:\[\s*\])?|co_await|""\s*\w+|<=>|<<=|>>=|->\*|<<|>>|<=|>=|==|!=|&&|\|\||\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|->|[-+*/%^&|~!=<>,])/;

// The bare function name used to match emitted code with source symbols:
// "ns::Foo<int>::bar<std::string>(std::vector<int> const&) const" -> "bar",
// "int square<int>(int)" -> "square", "foo[abi:cxx11]()" -> "foo",
// "example::generic::<i64>" -> "generic", "main.(*P).Sum" -> "Sum",
// "output.square(Swift.Int) -> Swift.Int" -> "square", "S::operator==(S) const" -> "operator==".
// Swift-mangled names (when no demangler is installed): the last of the
// length-prefixed identifiers: "$s4geom6squareyS2iF" -> "square", "$s4geom3AccV4pushyySiF" -> "push".
function swiftMangledName(s) {
  const m = /^_?\$[sSe]/.exec(s);
  if (!m) return undefined;
  let i = m[0].length, last;
  for (;;) {
    if (/[A-Z]/.test(s[i] || '') && /\d/.test(s[i + 1] || '') && last) i++;   // a kind letter between names (V struct, C class, ...)
    const n = /^(\d+)/.exec(s.slice(i));
    if (!n) break;
    const len = Number(n[1]);
    const id = s.slice(i + n[1].length, i + n[1].length + len);
    if (id.length !== len) break;
    last = id;
    i += n[1].length + len;
  }
  return last;
}

// MSVC-mangled names (Clang targeting Windows/MSVC, when no demangler handles
// them): "?push@Acc@mx@@QEAAXH@Z" -> "push", "??$square@H@@YAHH@Z" -> "square",
// "??0Acc@mx@@QEAA@XZ" -> "Acc", "??1Acc@@..." -> "~Acc", "??8S@@..." -> "operator==".
const MSVC_OPERATORS = { 2: 'new', 3: 'delete', 4: '=', 5: '>>', 6: '<<', 7: '!', 8: '==', 9: '!=', A: '[]', C: '->', D: '*', E: '++', F: '--', G: '-', H: '+', I: '&', K: '/', L: '%', M: '<', N: '<=', O: '>', P: '>=', R: '()', S: '~', T: '^', U: '|', V: '&&', W: '||', Y: '+=', Z: '-=' };
function msvcName(s) {
  let m;
  if ((m = /^\?\?\$([A-Za-z_$][\w$]*)@/.exec(s))) return m[1];
  if ((m = /^\?\?([01])([A-Za-z_$][\w$]*)@/.exec(s))) return m[1] === '1' ? `~${m[2]}` : m[2];
  if ((m = /^\?\?([2-9A-Z])/.exec(s)) && MSVC_OPERATORS[m[1]]) return `operator${MSVC_OPERATORS[m[1]]}`;
  if ((m = /^\?([A-Za-z_$][\w$]*)@/.exec(s))) return m[1];
  return undefined;
}

function normalizeName(name) {
  const unquoted = String(name || '').trim().replace(/^"([\s\S]*)"$/, '$1');   // LLVM quotes names with ?, @, $
  const msvc = /^\?[?A-Za-z_$]/.test(unquoted) ? msvcName(unquoted) : undefined;
  if (msvc !== undefined) return msvc;
  let s = String(name || '').trim()
    .replace(/^"([\s\S]*)"$/, '$1')
    .replace(/\s*\[clone[^\]]*\]/g, '')
    .replace(/\[abi:[^\]]*\]/g, '')
    .replace(/(?:\.(?:part|isra|constprop|cold|clone|lto_priv|localalias|resolver)(?:\.\d+)?)+$/, '')
    .replace(/\(anonymous namespace\)::/g, '')
    .replace(/::h[0-9a-f]{16}$/, '');
  if (/^<[\w.-]+>$/.test(s)) return s;                       // Python: <module>, <lambda>
  const swift = swiftMangledName(s);
  if (swift) return swift;
  const py = /\.(<[\w-]+>)$/.exec(s);
  if (py) return py[1];
  s = replaceBraced(s, 'lambda');
  s = s.replace(/\.\(\*?([\w.]+)\)\./g, '.$1.');             // Go: main.(*T).Method
  const k = s.search(/\boperator\b/);
  if (k >= 0) {
    const rest = s.slice(k + 8);
    const op = OPERATOR_TOKEN.exec(rest);
    if (op) return `operator${op[1].replace(/\s+/g, '')}`;
    const cut = rest.indexOf('(');
    return `operator${stripTemplateArgs(cut < 0 ? rest : rest.slice(0, cut)).replace(/\s+/g, '')}`;
  }
  let depth = 0, cut = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<') depth++;
    else if (c === '>' && depth) depth--;
    else if (c === '(' && !depth) { cut = i; break; }
  }
  const head = stripTemplateArgs(s.slice(0, cut));
  const parts = head.split(/::|\./).map(p => p.trim()).filter(Boolean);
  const last = (parts[parts.length - 1] || head.trim()).split(/\s+/).pop() || '';
  return last.replace(/[&*]/g, '');
}

// ---------------------------------------------------------------------------
// Matching emitted functions with source symbols ({ name, range })

// Names the same function could have in the assembly and in the source:
// C symbols carry a leading underscore on several targets (SDCC, Z80, SH,
// 32-bit Windows, Mach-O): "_square" is "square".
function sameName(asmNorm, symNorm) {
  return asmNorm === symNorm || (asmNorm.startsWith('_') && !symNorm.startsWith('_') && asmNorm.slice(1) === symNorm);
}

// Source function for an emitted function. By location: the source function
// of the same name that contains some of its instructions; otherwise the one
// that contains most of them, if that is most of the function (lambdas, names
// the source spells differently). A function that inlines another function of
// the file has instructions on that function's lines too, so the name decides
// first; and a library function that inlined a lambda (std::sort's internals)
// is not taken for the function around the lambda. With `requireName`, only
// symbols of the same name are considered.
function matchSourceSymbol(asmName, symbols, fn, docKey, opts = {}) {
  const norm = normalizeName(asmName);
  const named = symbols.filter(s => sameName(norm, normalizeName(s.name)));
  const candidates = opts.requireName ? named : symbols;
  if (fn && docKey) {
    const mapped = fn.instructionRows.filter(r => r.ref);
    const lines = mapped.filter(r => r.ref.key === docKey).map(r => r.ref.line);
    if (lines.length) {
      const byName = mostHits(named, lines);
      if (byName) return byName;
      const byPlace = mostHits(candidates, lines);
      if (byPlace) {
        const inside = lines.filter(l => l >= byPlace.range.start.line && l <= byPlace.range.end.line).length;
        if (inside * 2 >= Math.max(fn.instructionRows.length, 1)) return byPlace;
      }
      return undefined;
    }
    // All of its code comes from other files (e.g. a header template): not a function of this file.
    if (mapped.length && !lines.length) return undefined;
  }
  return named[0];
}

function mostHits(symbols, lines) {
  let best, bestHits = 0;
  for (const s of symbols) {
    if (!s.range) continue;
    const hits = lines.filter(l => l >= s.range.start.line && l <= s.range.end.line).length;
    if (hits > bestHits || (hits && hits === bestHits && best &&
        (s.range.end.line - s.range.start.line) < (best.range.end.line - best.range.start.line))) {
      best = s; bestHits = hits;
    }
  }
  return best;
}

// Whether `f` has instructions from lines `range` of file `docKey`.
function hasRowsIn(f, docKey, range) {
  return f.instructionRows.some(r => r.ref && r.ref.key === docKey && r.ref.line >= range.start.line && r.ref.line <= range.end.line);
}

// The analyzed function for a source symbol: by position first, then by name.
function findFunctionResult(symbol, functions, docKey, rootKey) {
  if (!symbol) return undefined;
  const usable = f => !docKey || !f.fileKeys || f.fileKeys.size === 0 || f.fileKeys.has(docKey);
  if (symbol.range && (!rootKey || docKey === rootKey)) {
    const line = symbol.range.start.line;
    const byRange = functions.find(f => usable(f) && f.sourceRange && f.sourceRange.start.line === line);
    if (byRange) return byRange;
    // Another overload with this name was matched by position: don't reuse its assembly.
    const norm = normalizeName(symbol.name);
    if (functions.some(f => f.sourceRange && normalizeName(f.sourceName) === norm)) return undefined;
  }
  const exact = functions.find(f => usable(f) && (f.sourceName === symbol.name || f.name === symbol.name));
  if (exact) return exact;
  const normalized = normalizeName(symbol.name);
  const named = f => sameName(normalizeName(f.sourceName), normalized) || sameName(normalizeName(f.name), normalized);
  // A prefix match only for compiler-made variants ("foo.constprop.0", "foo$1"),
  // never for other functions ("cube" is not "cube_int").
  const variant = n => n.startsWith(normalized) && /^[^\w]/.test(n.slice(normalized.length));
  return functions.find(f => usable(f) && named(f))
    || functions.find(f => usable(f) && (variant(normalizeName(f.sourceName)) || variant(normalizeName(f.name))));
}

// Every emitted function for a source symbol (all template instantiations).
// In a file other than the analyzed one (a header), functions are matched by
// name and then by which of the header's lines their instructions come from,
// so overloads and same-named functions elsewhere in the header stay apart.
function findAllFunctionResults(symbol, functions, docKey, rootKey) {
  if (!symbol) return [];
  const usable = f => !docKey || !f.fileKeys || f.fileKeys.size === 0 || f.fileKeys.has(docKey);
  if (symbol.range && docKey === rootKey) {
    const all = functions.filter(f => usable(f) && f.sourceRange && f.sourceRange.start.line === symbol.range.start.line);
    // Several are instantiations when they carry the symbol's name; lambdas and other
    // functions inside it (main's lambdas) are not listed as its instantiations.
    const norm = normalizeName(symbol.name);
    const named = all.filter(f => sameName(normalizeName(f.name), norm));
    if (named.length) return distinctCode(named);
    if (all.length) return distinctCode(all);
  }
  if (docKey !== rootKey) {
    const norm = normalizeName(symbol.name);
    const all = functions.filter(f => f.fileKeys && f.fileKeys.has(docKey) && !f.sourceRange && sameName(normalizeName(f.name), norm));
    if (all.length) {
      if (!symbol.range || symbol.range.start.line === symbol.range.end.line) return distinctCode(all);
      return distinctCode(all.filter(f => hasRowsIn(f, docKey, symbol.range)));
    }
  }
  const one = findFunctionResult(symbol, functions, docKey, rootKey);
  return one ? [one] : [];
}

// ---------------------------------------------------------------------------
// Compiler diagnostics (GCC, Clang and MSVC formats)

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

// Names of includes the compiler reported as missing.
function missingIncludesFrom(errText) {
  const names = new Set();
  for (const m of errText.matchAll(/fatal error:\s*(.+?):\s*No such file or directory/g)) names.add(m[1].trim());
  for (const m of errText.matchAll(/fatal error:\s*'(.+?)' file not found/g)) names.add(m[1].trim());
  for (const m of errText.matchAll(/fatal error C1083:\s*Cannot open include file:\s*'(.+?)'/g)) names.add(m[1].trim());
  return [...names];
}

// Files that broke during preprocessing (#error, malformed #if, ...).
function preprocessorErrorFilesFrom(errText) {
  const files = new Set();
  const re = /^(.+?):\d+(?::\d+)?:\s*(?:fatal )?error:\s*(?:#error|#if|#elif|missing binary operator|missing '\)'|invalid preprocessing directive|unterminated|token ".*" is not valid|operator '.*' has no)/gm;
  for (const m of errText.matchAll(re)) files.add(m[1].trim());
  return [...files];
}

// [{ file, line (0-based), message }] for every `error:` diagnostic.
function errorLocationsFrom(errText) {
  const out = [];
  for (const m of errText.matchAll(/^(.+?):(\d+)(?::\d+)?:\s*(?:fatal )?error:\s*(.*)$/gm)) out.push({ file: m[1].trim(), line: Number(m[2]) - 1, message: m[3].trim() });
  for (const m of errText.matchAll(/^(.+?)\((\d+)(?:,\d+)?\)\s*:\s*(?:fatal )?error\s+[A-Z]+\d+\s*:\s*(.*)$/gm)) out.push({ file: m[1].trim(), line: Number(m[2]) - 1, message: m[3].trim() });
  return out;
}

// Where an empty stand-in for a missing include goes (the remote working
// directory, which `-I.` adds to the search path). Names that try to leave it are refused.
function stubFilename(name) {
  const norm = path.posix.normalize(String(name).replace(/\\/g, '/'));
  if (!norm || norm.startsWith('../') || norm === '..' || path.posix.isAbsolute(norm)) return undefined;
  return norm;
}

// ---------------------------------------------------------------------------
// Display

function cleanAssemblyRowsForDisplay(result) {
  const rows = result.rows || String(result.assembly || '').split(/\r?\n/).map(text => ({ text }));
  const referencedLocalLabels = new Set();
  for (const row of rows) {
    const text = (typeof row === 'string' ? row : row.text || '').trim();
    if (!isInstructionLine(text)) continue;
    const withoutComment = text.replace(/\s+#.*$/, '');
    const refs = withoutComment.matchAll(/(?:^|[\s,])\|?((?:\.L|\$L)[\w.$@]*)/g);
    for (const match of refs) referencedLocalLabels.add(match[1]);
  }
  const cleaned = [];
  for (const row of rows) {
    const rawText = typeof row === 'string' ? row : row.text || '';
    const text = rawText.trim();
    if (!text) continue;
    if (isInstructionLine(text)) {
      cleaned.push({ text: cleanInstruction(text), ref: typeof row === 'object' ? row.ref : undefined });
      continue;
    }
    const label = text.match(/^\|?((?:\.L|\$L)[\w.$@]*)\|?:?$/);
    if (label && referencedLocalLabels.has(label[1])) cleaned.push({ text, ref: undefined });
  }
  return cleaned;
}
function cleanAssemblyForDisplay(result) {
  return cleanAssemblyRowsForDisplay(result).map(row => row.text).join('\n');
}

module.exports = {
  IS_WIN, normPath, isSystemPath,
  makeRefResolver, makeLocalRefResolver, localAsmToRows, sectionKind, unescapeAsmString, isMachO, prepareMachO, finishMachO,
  parseFunctions, mergeFunctionParts, partOf, isDataSymbol, looksLikeFunctionLabel, isInstructionLine, cleanInstruction, buildLineIndex,
  stripTemplateArgs, normalizeName, msvcName, sameName, matchSourceSymbol, findFunctionResult, findAllFunctionResults,
  ANSI_RE, missingIncludesFrom, preprocessorErrorFilesFrom, errorLocationsFrom, stubFilename,
  cleanAssemblyRowsForDisplay, cleanAssemblyForDisplay
};
