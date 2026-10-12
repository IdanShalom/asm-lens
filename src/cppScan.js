'use strict';
// C/C++ source scanning without a compiler: masking comments and strings,
// finding function and class definitions with their enclosing scopes, and the
// source edits made before compiling (blanking a failing function, keeping
// unused header functions, requesting template instantiations).
// Pure functions: no dependency on the VS Code API.

// Copy of `text` with comments, string/char literals and preprocessor lines
// replaced by spaces (newlines kept), plus the offsets where directives end.
function maskCode(text) {
  const n = text.length;
  const out = text.split('');
  const directiveEnds = [];
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0, lineStart = true;
  while (i < n) {
    const c = text[i];
    if (c === '\n') { lineStart = true; i++; continue; }
    if (lineStart && /\s/.test(c)) { i++; continue; }
    if (lineStart && c === '#') {
      let j = i;
      while (j < n && !(text[j] === '\n' && text[j - 1] !== '\\')) j++;
      // comments inside the directive are blanked along with it
      blank(i, j); directiveEnds.push(j); i = j; continue;
    }
    lineStart = false;
    if (c === '/' && text[i + 1] === '/') { let j = i; while (j < n && text[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '/' && text[i + 1] === '*') { let j = text.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; blank(i, j); i = j; continue; }
    if (c === '"' || c === "'") {
      // raw string R"delim( ... )delim"
      if (c === '"' && text[i - 1] === 'R') {
        const d = text.slice(i + 1).match(/^([^()\\\s]{0,16})\(/);
        if (d) { const endTok = ')' + d[1] + '"'; let j = text.indexOf(endTok, i); j = j < 0 ? n : j + endTok.length; blank(i, j); i = j; continue; }
      }
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') { if (text[j] === '\\') j++; j++; }
      blank(i, Math.min(j + 1, n)); i = j + 1; continue;
    }
    i++;
  }
  return { text: out.join(''), directiveEnds };
}

// Looks at the text between the previous boundary and a `{` and decides whether
// it opens a function body (as opposed to a class, namespace, enum, control block...).
function classifyFunctionSegment(seg) {
  const s = seg.replace(/\btemplate\s*<[^;{}]*?>\s*/g, '').trim();
  if (!s || !s.includes('(')) return undefined;
  if (/^(?:if|for|while|switch|catch|else|do|try)\b/.test(s)) return undefined;
  if (/^(?:namespace|class|struct|union|enum|extern)\b/.test(s) && !/\)\s*(?:const|noexcept|override|final|\s)*$/.test(s)) return undefined;
  if (!/\)\s*(?:(?:const|volatile|noexcept(?:\s*\([^)]*\))?|override|final|&&?|->[^;{}]*|\s)*)$/.test(s) && !/\)\s*:/.test(s) && !/\)\s*\{?$/.test(s)) return undefined;
  const nm = s.match(/([~A-Za-z_][\w:~]*(?:\s*<[^()]*>)?|operator\s*[^\s(]+)\s*\(/);
  return { name: nm ? nm[1] : undefined };
}

// Blank the function (signature and body) or statement that contains `line`,
// replacing every character but newlines with spaces so line numbers survive.
// Returns { text, name, startLine, endLine } or undefined if nothing safe to cut.
function blankEnclosingDeclaration(text, line) {
  const n = text.length;
  const masked = maskCode(text);
  const lineStarts = [0];
  for (let i = 0; i < n; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineOf = idx => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; } return lo; };
  const dirEnds = masked.directiveEnds;
  let dirPtr = 0;
  const m = masked.text;
  const stack = []; // { isFunc, declStart }
  let boundary = 0;
  let candidate;
  const inFunc = () => stack.some(s => s.isFunc);
  const consider = (start, end, name) => {
    if (candidate) return;
    // Begin at the first code character, so comments above the declaration stay.
    const offset = m.slice(start, end).search(/\S/);
    if (offset < 0) return;
    const from = start + offset;
    const first = lineOf(from), last = lineOf(end - 1);
    if (line >= first && line <= last) candidate = { start: from, end, name, startLine: first, endLine: last };
  };
  for (let i = 0; i < n; i++) {
    while (dirPtr < dirEnds.length && dirEnds[dirPtr] <= i) { if (!inFunc()) boundary = Math.max(boundary, dirEnds[dirPtr]); dirPtr++; }
    const c = m[i];
    if (c === '{') {
      if (inFunc()) { stack.push({ isFunc: false }); continue; }
      const seg = m.slice(boundary, i).replace(/^\s*(?:public|private|protected)\s*:/, '');
      const fn = classifyFunctionSegment(seg);
      stack.push({ isFunc: !!fn, declStart: boundary, name: fn?.name });
      boundary = i + 1;
    } else if (c === '}') {
      const top = stack.pop();
      if (top && top.isFunc) consider(top.declStart, i + 1, top.name);
      if (!inFunc()) boundary = i + 1;
    } else if (c === ';' && !inFunc()) {
      if (/\S/.test(m.slice(boundary, i))) consider(boundary, i + 1, undefined);
      boundary = i + 1;
    }
  }
  if (!candidate) return undefined;
  const out = text.slice(0, candidate.start) + text.slice(candidate.start, candidate.end).replace(/[^\n]/g, ' ') + text.slice(candidate.end);
  return { text: out, name: candidate.name, startLine: candidate.startLine, endLine: candidate.endLine };
}

// ---------------------------------------------------------------------------
// Function and class definitions with their enclosing scopes

function lineLocator(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return idx => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo;
  };
}

// Index of the bracket closing the one at `i` in masked text, or -1.
function closingBracket(m, i) {
  const open = m[i];
  const close = { '{': '}', '(': ')', '[': ']' }[open];
  let depth = 0;
  for (let j = i; j < m.length; j++) {
    if (m[j] === open) depth++;
    else if (m[j] === close && --depth === 0) return j;
  }
  return -1;
}

// Leading `template <...>` groups: their parameter lists ('' for `template <>`) and where the rest starts.
function splitTemplatePrefixes(s) {
  const params = [];
  let pos = 0;
  for (;;) {
    const m = /^\s*template\s*</.exec(s.slice(pos));
    if (!m) break;
    let j = pos + m[0].length, angle = 1, paren = 0;
    for (; j < s.length && angle > 0; j++) {
      const c = s[j];
      if (c === '(') paren++;
      else if (c === ')') paren--;
      else if (!paren && c === '<') angle++;
      else if (!paren && c === '>') angle--;
    }
    if (angle > 0) break;
    params.push(s.slice(pos + m[0].length, j - 1).trim());
    pos = j;
  }
  return { params, restStart: pos };
}

// Splits "ns::Box<std::pair<int, int>>::get" at top-level "::".
function splitQualified(name) {
  const parts = [];
  let depth = 0, cur = '';
  const s = String(name);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<' && !/\boperator\s*<*$/.test(cur + c)) depth++;
    else if (c === '>' && depth && !/\boperator\s*$/.test(cur)) depth--;
    if (!depth && c === ':' && s[i + 1] === ':') { parts.push(cur); cur = ''; i++; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map(p => p.trim()).filter((p, i) => p || i > 0);
}

// Attribute syntax that may hold parentheses, replaced by spaces (same length).
function blankAttributes(s) {
  return s.replace(/\[\[[\s\S]*?\]\]|\b(?:alignas|__declspec)\s*\((?:[^()]|\([^()]*\))*\)|\b__attribute__\s*\(\((?:[^()]|\([^()]*\))*\)\)/g, x => ' '.repeat(x.length));
}

// `auto f = [](int x) {` or `int a[] = {` start an initializer, not a function body.
function hasTopLevelAssignment(s) {
  const t = s.replace(/\boperator\s*(?:\(\s*\)|\[\s*\]|[-+*/%^&|~!=<>,]+)/g, 'operator');
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '(' || c === '[' || c === '<') depth++;
    else if ((c === ')' || c === ']' || c === '>') && depth) depth--;
    else if (c === '=' && !depth && t[i + 1] !== '=' && !/[=!<>]/.test(t[i - 1] || '')) return true;
  }
  return false;
}

// The qualified name right before a parameter list `(` at `end` of `s`:
// "ns::Box<T>::get", "operator==", "~Acc". Returns { name, start } or undefined.
function nameBefore(s, end) {
  while (end > 0 && /\s/.test(s[end - 1])) end--;
  const head = s.slice(0, end);
  let start;
  const op = /\boperator\s*(?:\(\s*\)|\[\s*\]|(?:new|delete)\s*(?:\[\s*\])?|co_await|""\s*\w+|[-+*/%^&|~!=<>,]+|[A-Za-z_][\w:<>,&* ]*?)\s*$/.exec(head);
  if (op) start = op.index;
  else {
    let i = end, depth = 0;
    while (i > 0) {
      const c = s[i - 1];
      if (c === '>') depth++;
      else if (c === '<') { if (!depth) break; depth--; }
      else if (!depth && !/[\w:~]/.test(c)) break;
      i--;
    }
    start = i;
  }
  // qualifiers in front of an operator: "Acc::operator()"
  while (start >= 2 && s[start - 1] === ':' && s[start - 2] === ':') {
    let i = start - 2, depth = 0;
    while (i > 0) {
      const c = s[i - 1];
      if (c === '>') depth++;
      else if (c === '<') { if (!depth) break; depth--; }
      else if (!depth && !/[\w:]/.test(c)) break;
      i--;
    }
    if (i === start - 2) break;
    start = i;
  }
  const name = s.slice(start, end).replace(/\s+/g, ' ').replace(/\s*(::|<|>|,)\s*/g, '$1').trim();
  if (!name || /^\d/.test(name) || !/[A-Za-z_]/.test(name)) return undefined;
  return { name, start };
}

const NOT_FUNCTION_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'alignof', 'decltype', 'noexcept', 'requires', 'static_assert', 'new', 'delete', 'throw', 'case', 'do', 'else', 'try']);
const PAREN_KEYWORDS = /\b(?:decltype|alignas|alignof|__declspec|__attribute__|sizeof|noexcept|requires|_Alignas)\s*$/;
const SPECIFIERS = /\b(?:inline|static|extern|constexpr|consteval|constinit|virtual|explicit|friend|__inline|__inline__|__forceinline|__attribute__|thread_local|mutable|export)\b/g;

// The parameter list `(` of a function head: the first top-level `(` that
// follows a name (skipping decltype(...), attributes and the like).
function parameterListOf(head) {
  let angle = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === '<') { if (!/\boperator\s*<*$/.test(head.slice(0, i))) angle++; continue; }
    if (c === '>') { if (angle && !/\boperator\s*>*$/.test(head.slice(0, i)) && head[i - 1] !== '-') angle--; continue; }
    if (c !== '(' || angle) continue;
    const before = head.slice(0, i);
    if (/\boperator\s*$/.test(before) && /^\(\s*\)/.test(head.slice(i))) { i = head.indexOf(')', i); continue; }
    if (PAREN_KEYWORDS.test(before)) { const close = closingBracket(head, i); if (close < 0) return undefined; i = close; continue; }
    const named = nameBefore(head, i);
    if (!named) return undefined;
    const close = closingBracket(head, i);
    return { open: i, close: close < 0 ? head.length : close, ...named };
  }
  return undefined;
}

const ACCESS_LABEL = /^\s*(?:(?:public|private|protected|signals|Q_SIGNALS|slots|Q_SLOTS)\s*(?:(?:slots|Q_SLOTS)\s*)?:(?!:)\s*)+/;

// What the declaration head in front of a `{` opens.
function classifyHead(m, segStart, segEnd, scopes) {
  const seg = m.slice(segStart, segEnd);
  const acc = ACCESS_LABEL.exec(seg);
  let start = acc ? acc[0].length : 0;
  start += /^\s*/.exec(seg.slice(start))[0].length;
  const decl = seg.slice(start);
  const base = { declStart: segStart + start };
  if (!decl.trim()) return { ...base, kind: 'other' };
  const tp = splitTemplatePrefixes(decl);
  const restOff = tp.restStart + /^\s*/.exec(decl.slice(tp.restStart))[0].length;
  const rest = decl.slice(restOff);
  const clean = blankAttributes(rest).replace(/\s+/g, ' ').trim();
  base.templateParams = tp.params;
  base.restStart = segStart + start + restOff;
  let x;
  if ((x = /^(?:export )?(?:inline )?namespace\b ?([\w:]*) ?$/.exec(clean))) return { ...base, kind: 'namespace', name: x[1] };
  if (/^extern ?$/.test(clean)) return { ...base, kind: 'linkage' };
  if (/^(?:typedef )?enum\b/.test(clean)) return { ...base, kind: 'other' };
  if ((x = /^(?:typedef |export )?(class|struct|union) (?:[A-Z_][A-Z0-9_]* )?([A-Za-z_]\w*) ?(<.*>)? ?(?:final ?)?(?:(?<!:):(?!:).*)?$/.exec(clean))) {
    return { ...base, kind: 'class', keyword: x[1], name: x[2] };
  }
  if (hasTopLevelAssignment(clean) || !classifyFunctionSegment(rest)) return { ...base, kind: 'other' };
  const params = parameterListOf(blankAttributes(rest));
  if (!params || NOT_FUNCTION_NAMES.has(params.name)) return { ...base, kind: 'other' };
  const name = params.name;
  const beforeName = blankAttributes(rest).slice(0, params.start).replace(SPECIFIERS, ' ').replace(/\[\[[\s\S]*?\]\]/g, ' ').trim();
  const cls = [...scopes].reverse().find(s => s.kind === 'class');
  const last = splitQualified(name).pop() || '';
  const isCtorOrDtor = last.startsWith('~') || (cls && last === cls.name) || /^(\w+)::~?\1$/.test(name.replace(/<[^<>]*>/g, ''));
  const paramText = rest.slice(params.open + 1, params.close);
  return {
    ...base,
    kind: 'function',
    name,
    nameIndex: base.restStart + params.start,
    // No return type and not a constructor: a macro such as TEST(a, b) { ... }.
    macroLike: !beforeName && !isCtorOrDtor && !/\boperator\b/.test(name) && !name.includes('::'),
    abbreviated: /(?:^|,)\s*(?:const\s+)?auto\b(?!\s*\()/.test(paramText),
    consteval: /\bconsteval\b/.test(rest.slice(0, params.start))
  };
}

// Every function and class definition outside function bodies, with its
// enclosing namespaces/classes. Lines are 0-based.
function scanDefinitions(text) {
  const m = maskCode(text).text;
  const lineOf = lineLocator(text);
  const defs = [];
  const scopes = [];
  let boundary = 0;
  for (let i = 0; i < m.length; i++) {
    const c = m[i];
    if (c === ';') { boundary = i + 1; continue; }
    if (c === '}') { scopes.pop(); boundary = i + 1; continue; }
    if (c !== '{') continue;
    const seg = m.slice(boundary, i);
    // `Foo() : a{1}, b{2} {`: braces of a member initializer belong to the head.
    if (/\)[^(){};]*(?<!:):(?!:)/.test(seg) && /[\w>]\s*$/.test(seg) && !/^\s*(?:template\s*<[^{]*>\s*)?(?:class|struct|union|enum)\b/.test(seg)) {
      const close = closingBracket(m, i);
      if (close < 0) break;
      i = close;
      continue;
    }
    const head = classifyHead(m, boundary, i, scopes);
    const close = closingBracket(m, i);
    const end = close < 0 ? m.length - 1 : close;
    if (head.kind === 'namespace' || head.kind === 'linkage' || head.kind === 'class') {
      const own = (head.templateParams || []).filter(p => p !== '');
      const scope = { kind: head.kind, name: head.name || '', keyword: head.keyword, templated: own.length > 0, templateParams: own[own.length - 1] };
      if (head.kind === 'class') {
        defs.push({ ...head, ...scope, scopes: scopes.slice(), startLine: lineOf(head.declStart), endLine: lineOf(end), bodyOpen: i, bodyClose: end });
      }
      scopes.push(scope);
      boundary = i + 1;
      continue;
    }
    if (head.kind === 'function') {
      const own = head.templateParams.filter(p => p !== '');
      defs.push({
        ...head,
        scopes: scopes.slice(),
        templated: own.length > 0 || head.abbreviated || scopes.some(s => s.kind === 'class' && s.templated),
        explicitSpecialization: head.templateParams.length > 0 && own.length === 0,
        startLine: lineOf(head.declStart),
        nameLine: lineOf(head.nameIndex),
        endLine: lineOf(end),
        bodyOpen: i,
        bodyClose: end
      });
    }
    // Function bodies and other blocks (enums, initializers) are skipped whole.
    i = end;
    boundary = end + 1;
  }
  return defs;
}

// Function definitions found by scanning, for when no language server reports symbols.
function guessCFunctions(text) {
  return scanDefinitions(text).filter(d => d.kind === 'function')
    .map(d => ({ name: d.name, startLine: d.startLine, endLine: d.endLine, nameLine: d.nameLine }));
}

// ---------------------------------------------------------------------------
// Keeping unused functions of a header that is compiled on its own

const KEEP = '__attribute__((used)) ';
const LEGACY_KEEP_RE = /^([ \t]*)((?:static|inline|__inline__|__inline)(?:[ \t]+(?:static|inline|__inline__|__inline|constexpr))*)(?=[ \t])(?![ \t]+namespace\b)/gm;

// For analyzing a header on its own: mark every non-template function defined
// in it __attribute__((used)), so the compiler emits it even though nothing
// calls it. Edits stay on the same line, so line numbers are unchanged.
function keepHeaderFunctions(text) {
  const lineOf = lineLocator(text);
  const at = new Set();
  for (const d of scanDefinitions(text)) {
    if (d.kind !== 'function' || d.templated || d.macroLike || d.consteval) continue;
    let pos = d.restStart;
    // after leading [[attributes]], alignas(...) and extern "C"
    for (;;) {
      const tail = text.slice(pos, pos + 400);
      const skip = /^\s*(?:\[\[[\s\S]*?\]\]|alignas\s*\((?:[^()]|\([^()]*\))*\)|extern\s*"[^"]*")/.exec(tail);
      if (!skip) break;
      pos += skip[0].length;
    }
    pos += /^\s*/.exec(text.slice(pos, pos + 200))[0].length;
    at.add(pos);
  }
  const touched = new Set([...at].map(lineOf));
  let out = text;
  for (const pos of [...at].sort((a, b) => b - a)) out = out.slice(0, pos) + KEEP + out.slice(pos);
  // Lines the scanner did not handle keep the earlier line-start rule.
  const outLineOf = lineLocator(out);
  return out.replace(LEGACY_KEEP_RE, (all, indent, words, offset) => touched.has(outLineOf(offset)) ? all : `${indent}${KEEP}${words}`);
}

// ---------------------------------------------------------------------------
// Template instantiation requests

// Suggested arguments for a template parameter list: `int` for types, `1` for values.
function defaultTemplateArgs(params) {
  const out = [];
  for (const p of splitTopLevel(params || '')) {
    const t = p.trim();
    if (!t) continue;
    if (/[^=]=[^=]/.test(` ${t} `.replace(/<[^<>]*>/g, ''))) break;          // has a default: stop here
    if (/^template\s*</.test(t)) out.push('std::vector');
    else if (/^(?:typename|class)\b|\.\.\./.test(t) || /^auto$/.test(t)) out.push('int');
    else if (/^(?:const\s+)?(?:auto|bool|char|short|int|long|unsigned|signed|size_t|std::size_t|u?int\d+_t|std::u?int\d+_t|ptrdiff_t|std::ptrdiff_t)\b/.test(t)) out.push(/^(?:const\s+)?bool\b/.test(t) ? 'true' : '1');
    else out.push('int');                                                      // constrained type: `std::integral T`
  }
  return out.join(', ');
}

function splitTopLevel(s) {
  const parts = [];
  let depth = 0, cur = '';
  for (const c of s) {
    if (c === '<' || c === '(' || c === '[' || c === '{') depth++;
    else if ((c === '>' || c === ')' || c === ']' || c === '}') && depth) depth--;
    if (c === ',' && !depth) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// What has to be instantiated to get code for the template function at `line`.
// Returns undefined when the function there is not a template, or
// { label, prompts: [{ name, params, suggestion }], make(args) -> { kind, expr, keyword } }
// where kind 'address' takes the address of a function template specialization
// and kind 'class' explicitly instantiates a class template specialization.
// { unsupported: reason } when the shape is not handled.
function templateTargetAt(text, line, defs = scanDefinitions(text)) {
  const fns = defs.filter(d => d.kind === 'function' && d.startLine <= line && line <= d.endLine);
  const def = fns.sort((a, b) => b.startLine - a.startLine)[0];
  if (!def || !def.templated) return undefined;
  const classes = defs.filter(d => d.kind === 'class');
  const parts = [];
  for (const s of def.scopes) {
    if (s.kind === 'namespace') { for (const n of s.name.split('::').filter(Boolean)) parts.push({ name: n }); continue; }
    if (s.kind === 'class') parts.push({ name: s.name, params: s.templated ? s.templateParams : undefined, keyword: s.keyword, isClass: true });
  }
  const comps = splitQualified(def.name);
  const own = def.templateParams.filter(p => p !== '');
  for (const comp of comps.slice(0, -1)) {
    const name = comp.replace(/<[\s\S]*$/, '').trim();
    const hasArgs = comp.includes('<');
    const known = classes.find(c => c.name === name);
    parts.push({ name, params: hasArgs && own.length ? own.shift() : undefined, keyword: known?.keyword || 'class', isClass: hasArgs || !!known });
  }
  const last = comps[comps.length - 1] || '';
  const fnName = /^operator\b/.test(last) ? last : last.replace(/<[\s\S]*$/, '').trim();
  const fnParams = own.length ? own.join(', ') : (def.abbreviated && !parts.some(p => p.params !== undefined) ? 'auto' : undefined);
  const holder = p => ({ name: p.name, params: p.params, suggestion: defaultTemplateArgs(p.params) });
  const build = (list, args) => list.map(p => p.params !== undefined ? `${p.name}<${args.shift() ?? ''}>` : p.name).join('::');
  const display = list => list.map(p => p.params !== undefined ? `${p.name}<${p.params.replace(/\s*=[^,]*/g, '').replace(/\b(?:typename|class)\s+/g, '')}>` : p.name).join('::');

  if (fnParams !== undefined) {
    const lastClass = [...parts].reverse().find(p => p.isClass);
    if (fnName.startsWith('~') || (lastClass && fnName === lastClass.name)) {
      return { unsupported: 'Constructors and destructors that are templates themselves cannot be instantiated automatically. Add a use of them to a .cpp file and analyze that file.' };
    }
    const fnPart = { name: fnName, params: fnParams };
    const all = [...parts, fnPart];
    return {
      label: display(all),
      prompts: all.filter(p => p.params !== undefined).map(holder),
      make: args => ({ kind: 'address', expr: build(all, [...args]) })
    };
  }
  const idx = parts.map(p => p.isClass).lastIndexOf(true);
  if (idx < 0) return undefined;
  const scope = parts.slice(0, idx + 1);
  if (!scope.some(p => p.params !== undefined)) return undefined;
  return {
    label: display(scope),
    prompts: scope.filter(p => p.params !== undefined).map(holder),
    make: args => ({ kind: 'class', expr: build(scope, [...args]), keyword: scope[idx].keyword === 'union' ? 'union' : scope[idx].keyword || 'class' })
  };
}

// Source lines that request the instantiations, appended after the file's own
// text so its line numbers do not change. `firstLine` is the 0-based line of the
// first request; request i is on line firstLine + i.
function appendInstantiations(text, list) {
  if (!list || !list.length) return { text, firstLine: -1 };
  const base = text.endsWith('\n') ? text : `${text}\n`;
  const firstLine = (base.match(/\n/g) || []).length;
  const lines = list.map((it, i) => it.kind === 'class'
    ? `template ${it.keyword || 'class'} ${it.expr};`
    : `auto __asm_lens_inst_${i} = &${it.expr};`);
  return { text: `${base}${lines.join('\n')}\n`, firstLine };
}

module.exports = {
  maskCode, classifyFunctionSegment, blankEnclosingDeclaration,
  scanDefinitions, guessCFunctions, keepHeaderFunctions, templateTargetAt, appendInstantiations,
  defaultTemplateArgs, splitQualified, splitTemplatePrefixes, lineLocator
};
