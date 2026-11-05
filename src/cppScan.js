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
  const s = withoutRequires(blankAttributes(seg).replace(/\btemplate\s*<[^;{}]*?>\s*/g, '').trim());
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

// Where a `requires` clause that starts at `pos` of masked text `s` ends (its
// primary expressions joined by && and ||), or `pos` when there is none.
function skipRequiresClause(s, pos) {
  const start = /^\s*requires\b/.exec(s.slice(pos));
  if (!start) return pos;
  let i = pos + start[0].length;
  const spaces = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const closing = () => { const c = closingBracket(s, i); if (c < 0) return false; i = c + 1; return true; };
  for (;;) {
    spaces();
    if (s[i] === '(') { if (!closing()) return pos; } else {
      const id = /^[A-Za-z_:][\w:]*/.exec(s.slice(i));
      if (!id) return pos;
      i += id[0].length;
      if (id[0] === 'requires') {                       // a requires expression
        spaces();
        if (s[i] === '(' && !closing()) return pos;
        spaces();
        if (s[i] === '{' && !closing()) return pos;
      } else {
        for (;;) {                                      // C<T>, C<T>::value
          spaces();
          if (s[i] === '<') {
            let depth = 0, paren = 0, j = i;
            for (; j < s.length; j++) {
              if (s[j] === '(') paren++;
              else if (s[j] === ')') paren--;
              else if (!paren && s[j] === '<') depth++;
              else if (!paren && s[j] === '>' && --depth === 0) break;
            }
            if (j >= s.length) return pos;
            i = j + 1;
            spaces();
          }
          const more = /^::[\w:]*/.exec(s.slice(i));
          if (!more) break;
          i += more[0].length;
        }
      }
    }
    const op = /^\s*(?:&&|\|\|)/.exec(s.slice(i));
    if (!op) return i;
    i += op[0].length;
  }
}

// Whether a `{` after `seg` opens a requires expression: "requires", "requires(T a)".
function endsWithRequiresHead(seg) {
  const at = /\brequires\b(?![\s\S]*\brequires\b)/.exec(seg);
  if (!at) return false;
  let j = at.index + 'requires'.length;
  while (j < seg.length && /\s/.test(seg[j])) j++;
  if (seg[j] === '(') {
    const close = closingBracket(seg, j);
    if (close < 0) return false;
    j = close + 1;
  }
  return !seg.slice(j).trim();
}

// Declaration text without its requires clauses: the leading one (after
// `template <...>`) and the one after the parameter list.
function withoutRequires(text) {
  const s = text.slice(skipRequiresClause(text, 0)).trim();
  if (!/\brequires\b/.test(s)) return s;
  let depth = 0, seenParams = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') { if (--depth === 0) seenParams = true; }
    else if (!depth && seenParams && /^requires\b/.test(s.slice(i, i + 9)) && !/\w/.test(s[i - 1] || '')) return s.slice(0, i).trim();
  }
  return s;
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

const LEADING_MACROS = /^(?:[A-Z_][A-Z0-9_]{2,}\b(?:\s*\((?:[^()]|\([^()]*\))*\))?\s+)+(?=(?:export\s+|inline\s+)?namespace\b|(?:typedef\s+|export\s+)?(?:class|struct|union|enum)\b|template\s*<|extern\b)/;
const ACCESS_LABEL = /^\s*(?:(?:public|private|protected|signals|Q_SIGNALS|slots|Q_SLOTS)\s*(?:(?:slots|Q_SLOTS)\s*)?:(?!:)\s*)+/;

// What the declaration head in front of a `{` opens.
function classifyHead(m, segStart, segEnd, scopes) {
  const seg = m.slice(segStart, segEnd);
  const acc = ACCESS_LABEL.exec(seg);
  let start = acc ? acc[0].length : 0;
  start += /^\s*/.exec(seg.slice(start))[0].length;
  // Macros used as statements before a declaration (no semicolon), e.g.
  // "NLOHMANN_JSON_NAMESPACE_BEGIN namespace detail {", "MACRO template <...> struct X {".
  const macros = LEADING_MACROS.exec(seg.slice(start));
  if (macros) start += macros[0].length;
  const unknownMacro = Boolean(macros);
  const decl = seg.slice(start);
  const base = { declStart: segStart + start };
  if (!decl.trim()) return { ...base, kind: 'other' };
  const tp = splitTemplatePrefixes(decl);
  const afterRequires = skipRequiresClause(decl, tp.restStart);
  const restOff = afterRequires + /^\s*/.exec(decl.slice(afterRequires))[0].length;
  const rest = decl.slice(restOff);
  const clean = blankAttributes(rest).replace(/\s+/g, ' ').trim();
  base.templateParams = tp.params;
  base.restStart = segStart + start + restOff;
  let x;
  if ((x = /^(?:export )?(?:inline )?namespace\b ?([\w:]*) ?$/.exec(clean))) return { ...base, kind: 'namespace', name: x[1] };
  if (/^extern ?$/.test(clean)) return { ...base, kind: 'linkage' };
  if (/^(?:typedef )?enum\b/.test(clean)) return { ...base, kind: 'other' };
  if ((x = /^(?:typedef |export )?(class|struct|union) (?:[A-Z_][A-Z0-9_]* (?!final\b)(?=[A-Za-z_]))?([A-Za-z_]\w*) ?(<.*>)? ?(?:final ?)?(?:(?<!:):(?!:).*)?$/.exec(clean))) {
    // A macro in front ("NLOHMANN_BASIC_JSON_TPL_DECLARATION class basic_json") may be template<...>.
    return { ...base, kind: 'class', keyword: x[1], name: x[2], specialization: x[3], maybeTemplate: unknownMacro };
  }
  if (hasTopLevelAssignment(clean) || !classifyFunctionSegment(rest)) return { ...base, kind: 'other' };
  const params = parameterListOf(blankAttributes(rest));
  if (!params || NOT_FUNCTION_NAMES.has(params.name)) return { ...base, kind: 'other' };
  const name = params.name;
  const beforeName = blankAttributes(rest).slice(0, params.start).replace(SPECIFIERS, ' ').replace(/\[\[[\s\S]*?\]\]/g, ' ').trim();
  // Only macro names before the function name (no type we can see): what they expand to is unknown.
  const onlyMacros = beforeName !== '' && /^(?:[A-Z_][A-Z0-9_]{2,}\b(?:\s*\((?:[^()]|\([^()]*\))*\))?\s*)+$/.test(beforeName);
  const cls = [...scopes].reverse().find(s => s.kind === 'class');
  const last = splitQualified(name).pop() || '';
  const isCtorOrDtor = last.startsWith('~') || (cls && last === cls.name) || /^(\w+)::~?\1$/.test(name.replace(/<[^<>]*>/g, ''));
  const paramText = rest.slice(params.open + 1, params.close);
  const specifiers = rest.slice(0, params.start);
  return {
    ...base,
    kind: 'function',
    name,
    paramText,
    returnText: blankAttributes(specifiers).replace(SPECIFIERS, ' ').replace(/\s+/g, ' ').trim(),
    afterParams: withoutRequires(blankAttributes(rest.slice(params.close + 1))),
    friend: /\bfriend\b/.test(specifiers),
    isStatic: /\bstatic\b/.test(specifiers),
    nameIndex: base.restStart + params.start,
    // No return type and not a constructor: a macro such as TEST(a, b) { ... }.
    macroLike: !beforeName && !isCtorOrDtor && !/\boperator\b/.test(name) && !name.includes('::'),
    onlyMacros,
    abbreviated: /(?:^|,)\s*(?:const\s+)?auto\b(?!\s*\()/.test(paramText),
    // Compilers drop it when nothing calls it: defined in a class (implicitly inline), or inline/static/constexpr.
    droppable: Boolean(cls) || /\b(?:inline|static|constexpr|__inline|__inline__|__forceinline)\b/.test(rest.slice(0, params.start)),
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
    // A brace inside unclosed parentheses is an expression: "decltype(f(priority_tag<3>{}))".
    if ((seg.match(/\(/g) || []).length > (seg.match(/\)/g) || []).length) {
      const close = closingBracket(m, i);
      if (close < 0) break;
      i = close;
      continue;
    }
    // `Foo() : a{1}, b{2} {`: braces of a member initializer belong to the head.
    if (/\)[^(){};]*(?<!:):(?!:)/.test(seg) && /[\w>]\s*$/.test(seg) && !/^\s*(?:template\s*<[^{]*>\s*)?(?:class|struct|union|enum)\b/.test(seg)) {
      const close = closingBracket(m, i);
      if (close < 0) break;
      i = close;
      continue;
    }
    // `requires requires(T a) { a + a; } struct X {`: the first braces belong to the head.
    if (endsWithRequiresHead(seg)) {
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
      const scope = { kind: head.kind, name: head.name || '', keyword: head.keyword, specialization: own.length > 0 ? head.specialization : undefined, templated: own.length > 0, maybeTemplate: Boolean(head.maybeTemplate), templateParams: own[own.length - 1] };
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
        droppable: head.droppable || scopes.some(s => s.kind === 'namespace' && !s.name),
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
// Keeping functions that compilers drop when nothing calls them

// Never kept: entry points (taking main's address is not allowed), and functions
// whose shape is unknown (templates, macros, consteval).
const ENTRY_POINTS = new Set(['main', 'wmain', 'WinMain', 'wWinMain', 'DllMain']);
function keepable(d, all) {
  if (d.kind !== 'function' || d.templated || d.macroLike || d.consteval || d.onlyMacros || d.scopes.some(s => s.maybeTemplate)) return false;
  if (ENTRY_POINTS.has(splitQualified(d.name).pop())) return false;
  return all || d.droppable;
}

const KEEP = '__attribute__((used)) ';
const LEGACY_KEEP_RE = /^([ \t]*)((?:static|inline|__inline__|__inline)(?:[ \t]+(?:static|inline|__inline__|__inline|constexpr))*)(?=[ \t])(?![ \t]+namespace\b)/gm;

// For analyzing a header on its own: mark every non-template function defined
// in it __attribute__((used)), so the compiler emits it even though nothing
// calls it. Edits stay on the same line, so line numbers are unchanged.
// `all`: every non-template function (a header compiled on its own); otherwise
// only those compilers drop when unused (in-class, inline, static, constexpr).
function keepHeaderFunctions(text, { all = true } = {}) {
  const lineOf = lineLocator(text);
  const at = new Set();
  for (const d of scanDefinitions(text)) {
    if (!keepable(d, all)) continue;
    let pos = d.restStart;
    // After leading [[attributes]], alignas(...), extern "C", and macros (DOCTEST_NORETURN,
    // FMT_API, a macro for template<...>) as long as a type is still left before the name.
    for (;;) {
      const tail = text.slice(pos, pos + 400);
      const skip = /^\s*(?:\[\[[\s\S]*?\]\]|alignas\s*\((?:[^()]|\([^()]*\))*\)|extern\s*"[^"]*")/.exec(tail);
      if (skip) { pos += skip[0].length; continue; }
      const macro = /^\s*[A-Z_][A-Z0-9_]{2,}(?:\s*\((?:[^()]|\([^()]*\))*\))?(?=\s)/.exec(tail);
      if (macro && /[A-Za-z_]/.test(text.slice(pos + macro[0].length, d.nameIndex).replace(/\b(?:const|volatile|static|inline|constexpr|virtual|explicit|friend)\b/g, ''))) { pos += macro[0].length; continue; }
      break;
    }
    pos += /^\s*/.exec(text.slice(pos, pos + 200))[0].length;
    at.add(pos);
  }
  const touched = new Set([...at].map(lineOf));
  const parts = [];
  let prev = 0;
  for (const pos of [...at].sort((a, b) => a - b)) { parts.push(text.slice(prev, pos), KEEP); prev = pos; }
  parts.push(text.slice(prev));
  const out = parts.join('');
  // In a header, lines the scanner did not handle keep the earlier line-start rule.
  if (!all) return out;
  const outLineOf = lineLocator(out);
  return out.replace(LEGACY_KEEP_RE, (all, indent, words, offset) => touched.has(outLineOf(offset)) ? all : `${indent}${KEEP}${words}`);
}

// Parameters without their default values, as text for a function type.
function paramsWithoutDefaults(paramText) {
  return splitTopLevel(paramText || '').map(p => {
    let depth = 0;
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if ('<([{'.includes(c)) depth++;
      else if ('>)]}'.includes(c) && depth) depth--;
      else if (c === '=' && !depth) return p.slice(0, i).trim();
    }
    return p.trim();
  }).join(', ');
}

// The function pointer type of definition `d`, which selects it among overloads:
// `int (*)(int)`, `int (ns::C::*)(float) const`. `owner` is the qualified class for
// a member, `subst` adjusts text (template arguments). undefined when the return
// type is deduced, so that the type cannot be written.
function pointerTypeOf(d, owner, subst = s => s) {
  const trailing = /->\s*([\s\S]+)$/.exec(d.afterParams || '');
  const ret = trailing ? trailing[1].trim() : d.returnText;
  if (!ret || /\b(?:auto|decltype)\b/.test(ret) || d.friend) return undefined;
  const quals = ((d.afterParams || '').replace(/->[\s\S]*$/, '').match(/\bconst\b|\bvolatile\b|&&?/g) || []).join(' ');
  const member = owner && !d.isStatic;
  return subst(`${ret} (${member ? `${owner}::*` : '*'})(${paramsWithoutDefaults(d.paramText)})${member && quals ? ` ${quals}` : ''}`);
}

// Names defined or declared more than once in the file: `&name` is ambiguous for those.
let overloadCache;
function overloadedNames(text, defs) {
  if (overloadCache && overloadCache.text === text) return overloadCache.names;
  const count = new Map();
  for (const d of defs) {
    if (d.kind !== 'function') continue;
    const key = (splitQualified(d.name).pop() || '').replace(/<[\s\S]*$/, '').trim();
    count.set(key, (count.get(key) || 0) + 1);
  }
  const names = new Set([...count].filter(([, n]) => n > 1).map(([k]) => k));
  // A prototype next to a definition: `int f(int); inline int f(float x) { ... }`.
  // A type comes before the name, which tells it from a call: `x.f(1);`, `return f(1);`, `f(1);`.
  for (const x of maskCode(text).text.matchAll(/(?<!\b(?:return|else|case|throw|delete|new|co_return|co_yield|co_await|goto)\s+)(?<=[\w>&*]\s+|[&*])([A-Za-z_]\w*)\s*\([^;{}]*\)[^;{}()]*;/g)) {
    if (count.has(x[1])) names.add(x[1]);
  }
  overloadCache = { text, names };
  return names;
}

// For compilers without __attribute__((used)) (MSVC): one line per non-template
// function that takes its address, which makes the compiler emit it. Appended
// after the file's last line like instantiation requests; a line that does not
// compile is dropped by the caller. An overloaded name is cast to the function's
// type, in its namespace so that the types in the signature are found. `c` selects C syntax.
function keepByAddress(text, { c = false, all = true, defs = scanDefinitions(text) } = {}) {
  const lines = [];
  let needsNew = false;
  const overloaded = c ? new Set() : overloadedNames(text, defs);
  for (const d of defs) {
    if (!keepable(d, all) || d.friend) continue;
    const comps = splitQualified(d.name);
    const last = comps[comps.length - 1] || '';
    const owner = [...d.scopes].reverse().find(s => s.kind === 'class');
    const ownerName = comps.length > 1 ? comps[comps.length - 2].replace(/<[\s\S]*$/, '') : owner && owner.name;
    const scope = d.scopes.filter(s => s.kind === 'namespace' || s.kind === 'class').flatMap(s => s.name.split('::')).filter(Boolean);
    const qualified = [...scope, ...comps].join('::');
    const index = lines.length;
    // Constructors and destructors have no address: a small function calls them instead.
    if (last.startsWith('~') || last === ownerName) {
      if (c) continue;
      const cls = [...scope, ...comps.slice(0, -1)].join('::');
      if (last.startsWith('~')) { lines.push(`void __asm_lens_keep_${index}(${cls}* __asm_lens_at) { __asm_lens_at->${last}(); }`); continue; }
      const params = namedParameters(d.paramText);
      if (params.some(p => !p)) continue;
      needsNew = true;
      lines.push(`void __asm_lens_keep_${index}(${['void* __asm_lens_at', ...params.map(p => p.text)].join(', ')}) { ::new (__asm_lens_at) ${cls}(${params.map(p => p.name).join(', ')}); }`);
      continue;
    }
    if (c) { lines.push(`void (*__asm_lens_keep_${index})(void) = (void (*)(void))&${qualified};`); continue; }
    const type = overloaded.has(last.replace(/<[\s\S]*$/, '').trim())
      ? pointerTypeOf(d, comps.length > 1 || owner ? [...scope, ...comps.slice(0, -1)].join('::') : undefined)
      : undefined;
    const isMember = comps.length > 1 || Boolean(owner);
    const namespaces = d.scopes.filter(s => s.kind === 'namespace').flatMap(s => s.name.split('::')).filter(Boolean);
    if (type && !isMember && namespaces.length) {
      lines.push(`${namespaces.map(n => `namespace ${n} {`).join(' ')} auto __asm_lens_keep_${index} = static_cast<${type}>(&${comps.join('::')}); ${namespaces.map(() => '}').join(' ')}`);
    } else lines.push(`auto __asm_lens_keep_${index} = ${type ? `static_cast<${type}>(&${qualified})` : `&${qualified}`};`);
  }
  return needsNew ? ['#include <new>', ...lines] : lines;
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
function templateTargetAt(text, line, defs = scanDefinitions(text), known) {
  const fns = known ? [known] : defs.filter(d => d.kind === 'function' && d.startLine <= line && line <= d.endLine);
  const def = fns.sort((a, b) => b.startLine - a.startLine)[0];
  if (!def || !def.templated) return undefined;
  const classes = defs.filter(d => d.kind === 'class');
  const parts = [];
  for (const s of def.scopes) {
    if (s.kind === 'namespace') { for (const n of s.name.split('::').filter(Boolean)) parts.push({ name: n }); continue; }
    if (s.kind === 'class') parts.push({ name: s.name, params: s.templated ? s.templateParams : undefined, spec: s.specialization, keyword: s.keyword, isClass: true });
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
  const holder = p => ({ name: p.name, params: p.params, suggestion: defaultTemplateArgs(p.params), ...(p.spec ? { specialization: true } : {}) });
  // A partial specialization takes its arguments in its own form: Derived<T*> with T = int is Derived<int*>.
  const filled = (p, given) => {
    if (!p.spec) return `${p.name}<${given}>`;
    const values = splitTopLevel(given).map(v => v.trim());
    const names = splitTopLevel(p.params).map(q => /([A-Za-z_]\w*)\s*(?:\.\.\.)?\s*$/.exec(q.replace(/=[\s\S]*$/, ''))?.[1]);
    return p.name + p.spec.replace(/\b[A-Za-z_]\w*\b/g, w => (names.includes(w) && values[names.indexOf(w)] !== undefined ? values[names.indexOf(w)] : w));
  };
  const build = (list, args) => list.map(p => p.params !== undefined ? filled(p, args.shift() ?? '') : p.name).join('::');
  const display = list => list.map(p => p.spec ? `${p.name}${p.spec}` : p.params !== undefined ? `${p.name}<${p.params.replace(/\s*=[^,]*/g, '').replace(/\b(?:typename|class)\s+/g, '')}>` : p.name).join('::');

  if (fnParams !== undefined) {
    const lastClass = [...parts].reverse().find(p => p.isClass);
    if (fnName.startsWith('~') || (lastClass && fnName === lastClass.name)) {
      return { unsupported: 'Constructors and destructors that are templates themselves cannot be instantiated automatically. Add a use of them to a .cpp file and analyze that file.' };
    }
    const fnPart = { name: fnName, params: fnParams };
    const all = [...parts, fnPart];
    const isOverloaded = overloadedNames(text, defs).has(fnName);
    return {
      label: display(all),
      prompts: all.filter(p => p.params !== undefined).map(holder),
      make: args => {
        const expr = build(all, [...args]);
        if (!isOverloaded || def.abbreviated) return { kind: 'address', expr };
        // An overloaded template: its type says which one is meant.
        const values = new Map();
        const given = [...args];
        for (const p of all) {
          if (p.params === undefined) continue;
          const list = splitTopLevel(given.shift() ?? '').map(v => v.trim());
          parameterNames(p.params).forEach((n, i) => { if (n && list[i] !== undefined) values.set(n, list[i]); });
        }
        const subst = s => s.replace(/\b[A-Za-z_]\w*\b/g, w => values.get(w) ?? w);
        const owner = lastClass ? build(parts, [...args]) : undefined;
        const cast = pointerTypeOf(def, owner, subst);
        return cast ? { kind: 'address', expr, cast } : { kind: 'address', expr };
      }
    };
  }
  const idx = parts.map(p => p.isClass).lastIndexOf(true);
  if (idx < 0) return undefined;
  const scope = parts.slice(0, idx + 1);
  if (!scope.some(p => p.params !== undefined)) return undefined;
  return {
    label: display(scope),
    prompts: scope.filter(p => p.params !== undefined).map(holder),
    make: args => {
      const expr = build(scope, [...args]);
      // Not for constructors and destructors, whose address cannot be taken.
      const memberOfScope = idx === parts.length - 1 && fnName !== parts[idx].name && !fnName.startsWith('~');
      return { kind: 'class', expr, keyword: scope[idx].keyword === 'union' ? 'union' : scope[idx].keyword || 'class', ...(memberOfScope ? { member: `${expr}::${fnName}` } : {}) };
    }
  };
}

// Source lines that request the instantiations, appended after the file's own
// text so its line numbers do not change. `firstLine` is the 0-based line of the
// first request; request i is on line firstLine + i.
function appendInstantiations(text, list, extraLines = []) {
  if ((!list || !list.length) && !extraLines.length) return { text, firstLine: -1 };
  const base = text.endsWith('\n') ? text : `${text}\n`;
  const firstLine = (base.match(/\n/g) || []).length;
  const lines = (list || []).map((it, i) => it.kind === 'class'
    ? `template ${it.keyword || 'class'} ${it.expr};`
    : `auto __asm_lens_inst_${i} = ${it.cast ? `static_cast<${it.cast}>(&${it.expr})` : `&${it.expr}`};`);
  return { text: `${base}${[...lines, ...extraLines].join('\n')}\n`, firstLine };
}

// The name in each parameter of a template parameter list ("typename T, int N = 3" -> T, N).
function parameterNames(params) {
  return splitTopLevel(params || '').map(q => /([A-Za-z_]\w*)\s*(?:\.\.\.)?\s*$/.exec(q.replace(/=[\s\S]*$/, ''))?.[1]);
}

// Arguments written in `text` for template `name`: Box<int> gives "int". Uses
// inside templates are left out (Box<T> says nothing), as are template heads.
function templateUsesIn(text, name, defs = scanDefinitions(text), m = maskCode(text).text) {
  const spans = [];
  for (const d of defs) {
    if (d.kind === 'function' && d.templated) spans.push([d.declStart, d.bodyClose]);
    if (d.kind === 'class') {
      if (d.templated || d.maybeTemplate) spans.push([d.declStart, d.bodyClose]);
      else if (/^\s*template\b/.test(m.slice(d.declStart, d.bodyOpen))) spans.push([d.declStart, d.bodyOpen]);       // template <> struct Box<int>
    }
  }
  const out = [];
  const re = new RegExp(`(?<![\\w:.])(?:[A-Za-z_]\\w*::)*${name.replace(/[^\w]/g, '')}\\s*<`, 'g');
  for (let x; (x = re.exec(m));) {
    const open = x.index + x[0].length - 1;
    let depth = 0, paren = 0, j = open;
    for (; j < m.length; j++) {
      const c = m[j];
      if (c === '(') paren++;
      else if (c === ')') paren--;
      else if (c === ';' || c === '{') { j = m.length; break; }
      else if (!paren && c === '<') depth++;
      else if (!paren && c === '>' && --depth === 0) break;
    }
    if (j >= m.length) continue;
    if (spans.some(([a, b]) => a <= x.index && x.index <= b)) continue;
    const args = m.slice(open + 1, j).replace(/\s+/g, ' ').trim();
    if (args && !/\bauto\b|\.\.\./.test(args) && !out.includes(args)) out.push(args);
  }
  return out;
}

// Instantiations to compile without being asked, so that a template shows its
// code at once: for each template, the arguments written where it is used
// (`contexts`: this file and the files including it), else the suggested ones.
// Templates with requests of their own (`manual`) are left to those.
function autoInstantiations(text, { defs = scanDefinitions(text), manual = [], contexts = [], rejected = new Set(), max = 30, maxPerTemplate = 3 } = {}) {
  const withoutArgs = s => splitQualified(s).map(p => p.replace(/<[\s\S]*$/, '').trim()).join('::');
  const asked = new Set(manual.map(it => withoutArgs(it.expr)));
  // A member asked for on its own (Mixed<int>::get) means its class does not compile as a whole.
  for (const it of manual) {
    const comps = splitQualified(it.expr);
    if (it.kind === 'address' && comps.length > 1 && !comps[comps.length - 1].includes('<')) asked.add(withoutArgs(comps.slice(0, -1).join('::')));
  }
  const seen = new Set();
  const taken = new Set(manual.map(it => it.expr));
  const out = [];
  const sources = [{ text, defs, masked: maskCode(text).text }, ...contexts.filter(c => c !== text).map(c => ({ text: c, defs: scanDefinitions(c), masked: maskCode(c).text }))];
  // Instantiated in the file itself: a second time would be an error.
  const written = new Set([...sources[0].masked.matchAll(/(?<!\bextern\s+)\btemplate\s+(?:class|struct|union)\s+([^;{}]+);/g)].map(x => x[1].replace(/\s+/g, '')));
  for (const d of defs) {
    if (out.length >= max) break;
    if (d.kind !== 'function' || !d.templated) continue;
    const target = templateTargetAt(text, d.nameLine ?? d.startLine, defs, d);
    if (!target || target.unsupported || !target.prompts.length) continue;
    const name = withoutArgs(target.label);
    if (seen.has(target.label) || [...asked].some(a => name === a || name.startsWith(`${a}::`))) continue;
    seen.add(target.label);
    const first = target.prompts[0];
    // The arguments of a partial specialization are its own (T of Box<T*>), not those written where it is used.
    const uses = first.specialization ? [] : sources.flatMap(s => templateUsesIn(s.text, first.name, s.defs, s.masked)).filter((u, i, all) => all.indexOf(u) === i).slice(0, maxPerTemplate);
    for (const a of uses.length ? uses : [first.suggestion]) {
      const it = target.make([a, ...target.prompts.slice(1).map(p => p.suggestion)]);
      if (taken.has(it.expr) || out.length >= max || rejected.has(it.expr)) continue;
      taken.add(it.expr);
      if (it.kind === 'class' && (written.has(it.expr.replace(/\s+/g, '')) || out.some(o => o.kind === 'class' && it.expr.startsWith(`${o.expr}::`)))) continue;
      out.push(it);
    }
  }
  // Instantiating a class also instantiates the classes nested in it; twice is an error.
  const classes = [...manual, ...out].filter(it => it.kind === 'class').map(it => it.expr);
  return out.filter(it => it.kind !== 'class' || !classes.some(c => it.expr.startsWith(`${c}::`)));
}

// Parameters of a function, each with a name: the type and name as text, and the name.
function namedParameters(paramText) {
  const text = paramsWithoutDefaults(paramText);
  if (!text || /^void$/.test(text.trim())) return [];
  const BUILTIN = /^(?:void|bool|char|short|int|long|float|double|signed|unsigned|wchar_t|char8_t|char16_t|char32_t|auto|const|volatile)$/;
  return splitTopLevel(text).map((raw, i) => {
    const p = raw.trim();
    if (/\(\s*[*&]|\.\.\./.test(p)) return undefined;                          // function pointers, variadics
    const array = /\[[^\]]*\]\s*$/.test(p);
    const words = p.replace(/\[[^\]]*\]\s*$/, '').replace(/\b(?:const|volatile|struct|class|enum|typename)\b/g, ' ').replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, ' ').trim();
    const last = /([A-Za-z_]\w*)\s*$/.exec(words);
    const named = last && !BUILTIN.test(last[1]) && /[\s&*>]/.test(words.slice(0, last.index).replace(/\s+$/, ' ') || '') && words.slice(0, last.index).trim() !== '';
    if (named) return { text: p, name: last[1] };
    if (array) return undefined;
    return { text: `${p} __asm_lens_p${i}`, name: `__asm_lens_p${i}` };
  });
}

// Lines that call the friend functions defined in the class templates of `requests`.
// A friend defined in a class template gets code only when something calls it, even
// when the class is instantiated explicitly, and its address cannot be taken: only
// argument-dependent lookup finds it. The result is returned so that the call stays.
function friendUseLines(text, requests, defs = scanDefinitions(text)) {
  const lines = [];
  for (const it of requests || []) {
    if (it.kind !== 'class') continue;
    const comps = splitQualified(it.expr);
    const lastComp = comps[comps.length - 1] || '';
    const open = lastComp.indexOf('<');
    if (open < 0) continue;
    const className = lastComp.slice(0, open).trim();
    const values = splitTopLevel(lastComp.slice(open + 1, lastComp.lastIndexOf('>'))).map(v => v.trim());
    for (const d of defs) {
      if (d.kind !== 'function' || !d.friend) continue;
      const owner = d.scopes[d.scopes.length - 1];
      if (!owner || owner.kind !== 'class' || owner.name !== className || owner.specialization || !owner.templated) continue;
      const names = parameterNames(owner.templateParams);
      const map = new Map(names.map((n, i) => [n, values[i]]).filter(([n, v]) => n && v !== undefined));
      const subst = s => s.replace(/\b[A-Za-z_]\w*\b(?!\s*<)/g, w => (w === className ? lastComp : map.get(w) ?? w));
      const params = namedParameters(d.paramText);
      if (!params.length || params.some(p => !p)) continue;
      const namespaces = d.scopes.filter(s => s.kind === 'namespace').flatMap(s => s.name.split('::')).filter(Boolean);
      const body = `decltype(auto) __asm_lens_use_${lines.length}(${params.map(p => subst(p.text)).join(', ')}) { return ${d.name}(${params.map(p => p.name).join(', ')}); }`;
      lines.push(`${namespaces.map(n => `namespace ${n} {`).join(' ')}${namespaces.length ? ' ' : ''}${body}${namespaces.length ? ' ' : ''}${namespaces.map(() => '}').join(' ')}`);
    }
  }
  return lines;
}

// For each line, the preprocessor condition around it ("#ifdef X"), not counting an include guard.
function conditionsByLine(text) {
  const lines = text.split(/\r?\n/);
  const masked = maskBlockComments(text).split(/\r?\n/);
  const out = new Array(lines.length);
  const stack = [];
  let current;
  const update = () => { current = undefined; for (let k = stack.length - 1; k >= 0; k--) if (!stack[k].guard) { current = stack[k].shown; break; } };
  for (let i = 0; i < lines.length; i++) {
    out[i] = current;
    const m = /^\s*#\s*(if|ifdef|ifndef|elif|elifdef|elifndef|else|endif)\b(.*)$/.exec(masked[i]);
    if (!m) continue;
    const word = m[1];
    const shown = lines[i].trim().replace(/\s*\/\/.*$/, '').replace(/\s+/g, ' ').slice(0, 60);
    if (word === 'endif') stack.pop();
    else if (word.startsWith('if')) {
      const macro = m[2].trim().replace(/[^\w]/g, '');
      const guard = word === 'ifndef' && Boolean(macro) && new RegExp(`^\\s*#\\s*define\\s+${macro}\\b`).test(masked[i + 1] || '');
      stack.push({ shown, guard });
    } else if (stack.length) stack[stack.length - 1] = { shown, guard: false };
    update();
  }
  return out;
}

function conditionAt(text, line) { return conditionsByLine(text)[line]; }

function maskBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '));
}

// The preprocessor lines of `text` before the #include of the file named `target`,
// which is what that file sees of `text` besides declarations. Undefined when it is
// not included here. `follow(name)` gives the text of another included file, to look
// through (a.cpp includes b.h, which includes the target); `found.dirs` collects
// the folders whose relative includes the result depends on.
async function includeContext(text, target, { follow, dir, depth = 0 } = {}) {
  const lines = maskBlockComments(text).split(/\r?\n/);
  const kept = [];
  let open = 0;
  const closeAll = () => [...kept, ...Array(Math.max(open, 0)).fill('#endif')];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!/^\s*#/.test(line)) continue;
    let n = i;
    while (/\\\s*$/.test(lines[n]) && n + 1 < lines.length) line += `\n${lines[++n]}`;
    i = n;
    const inc = /^\s*#\s*include\s*(["<])([^">\n]+)[">]/.exec(line);
    if (inc) {
      const name = inc[2].trim();
      if (name.replace(/\\/g, '/').split('/').pop().toLowerCase() === target.toLowerCase()) return { text: closeAll().join('\n'), dirs: dir ? [dir] : [] };
      if (inc[1] === '"' && follow && depth < 8) {
        const inner = await follow(name, dir);
        if (inner) {
          const sub = await includeContext(inner.text, target, { follow, dir: inner.dir, depth: depth + 1 });
          if (sub) return { text: [...kept, sub.text, ...Array(Math.max(open, 0)).fill('#endif')].filter(Boolean).join('\n'), dirs: [...new Set([...(dir ? [dir] : []), ...sub.dirs])] };
        }
      }
      kept.push(line);
      continue;
    }
    if (/^\s*#\s*pragma\s+once\b/.test(line)) continue;
    if (/^\s*#\s*(?:if|ifdef|ifndef)\b/.test(line)) open++;
    else if (/^\s*#\s*endif\b/.test(line)) open--;
    if (/^\s*#\s*(?:include|define|undef|if|ifdef|ifndef|else|elif|elifdef|elifndef|endif|pragma)\b/.test(line)) kept.push(line);
  }
  return undefined;
}

module.exports = {
  maskCode, classifyFunctionSegment, blankEnclosingDeclaration,
  scanDefinitions, guessCFunctions, keepHeaderFunctions, keepByAddress, templateTargetAt, appendInstantiations,
  autoInstantiations, templateUsesIn, friendUseLines, conditionAt, conditionsByLine, includeContext,
  defaultTemplateArgs, splitQualified, splitTemplatePrefixes, lineLocator, classifyHead
};
