// The extension under a mock VS Code, with a fake Compiler Explorer.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { makeProject, start, fixture } = require('../helpers/env');

// A fake Compiler Explorer: `respond(body)` returns { code, stderr, asm } for a compile request.
function fakeCompilerExplorer(respond) {
  const real = global.fetch;
  const requests = [];
  global.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url: String(url), body });
    let json;
    if (/\/api\/languages/.test(url)) json = [{ id: 'rust', defaultCompiler: 'r_default' }];
    else if (/\/api\/compilers\//.test(url)) json = [{ id: 'g1', name: 'GCC 1' }, { id: 'g2', name: 'GCC 2', semver: '2.0' }];
    else json = respond(body);
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
  };
  return { requests, restore: () => { global.fetch = real; } };
}

const asmFor = (...fns) => fns.flatMap(([name, line]) => [{ text: `${name}:` }, { text: '        mov eax, 1', source: { file: null, line } }, { text: '        ret', source: { file: null, line } }]);
const err = (...lines) => lines.map(text => ({ text }));

test('resolveSettings: VS Code settings without a project file', async t => {
  const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\n', 'b.c': 'int g(void) { return 1; }\n', 'c.rs': 'pub fn h() {}\n' });
  const x = start(dir, { settings: { 'asmLens.compilerId': 'clang1910', 'asmLens.flags': '-O1' } });
  const r = await x.ext._internals.resolveSettings(x.open('a.cpp'));
  assert.equal(r.active.id, 'clang1910');
  assert.equal(r.flags, '-O1');
  assert.equal(r.mode, 'remote');
  assert.equal(r.localCompiler, 'g++');
  assert.equal(r.configFile, undefined);
  const c = await x.ext._internals.resolveSettings(x.open('b.c'));
  assert.equal(c.language, 'c++', 'unchanged: without a project file the asmLens.language setting applies');
  const rs = await x.ext._internals.resolveSettings(x.open('c.rs'));
  assert.equal(rs.active.isDefault, true);
  assert.equal(rs.flags, '-O');
  assert.equal(rs.language, 'rust');
  assert.equal(rs.localCompiler, 'rustc');
});

test('resolveSettings: .asm-lens.json compilers, languages, modes and relative compiler paths', async () => {
  const dir = makeProject({ 'a.cpp': '', 'b.c': '', 'c.rs': '', 'd.py': '' }, {
    mode: 'local',
    compiler: './tools/gcc',
    flags: '-O3',
    defines: ['A'],
    compilers: [
      { id: 'cc', name: 'C only', language: 'c', flags: '-O0' },
      { id: 'cpp1', name: 'C++ one' },
      { id: 'r1', name: 'Rust', language: 'rust', mode: 'remote', flags: '-C opt-level=3' },
      { id: 'py', language: 'python', compiler: 'python3.12' }
    ]
  });
  const x = start(dir, { settings: { 'asmLens.mode': 'remote' } });
  const cpp = await x.ext._internals.resolveSettings(x.open('a.cpp'));
  assert.equal(cpp.active.id, 'cpp1');
  assert.deepEqual(cpp.compilers.map(c => c.id), ['cpp1'], 'Rust/Python compilers never apply to C++');
  assert.equal(cpp.flags, '-O3');
  assert.equal(cpp.mode, 'local', 'the project file wins over the VS Code setting');
  assert.equal(cpp.localCompiler, path.join(dir, 'tools', 'gcc'));
  assert.deepEqual(cpp.defines, ['A']);
  const c = await x.ext._internals.resolveSettings(x.open('b.c'));
  assert.equal(c.active.id, 'cc');
  assert.equal(c.flags, '-O0');
  assert.equal(c.language, 'c');
  const rs = await x.ext._internals.resolveSettings(x.open('c.rs'));
  assert.equal(rs.active.id, 'r1');
  assert.equal(rs.mode, 'remote', 'a compiler\'s own mode wins');
  assert.equal(rs.flags, '-C opt-level=3');
  assert.deepEqual(rs.defines, [], 'C/C++ defines are not used for Rust');
  const py = await x.ext._internals.resolveSettings(x.open('d.py'));
  assert.equal(py.mode, 'local');
  assert.equal(py.localCompiler, 'python3.12');
});

test('resolveSettings: compilers chosen with Select Compiler are remembered per language', async () => {
  const dir = makeProject({ 'a.cpp': '', 'c.rs': '' }, { compilers: ['g152', 'g132'] });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: [] }));
  try {
    const x = start(dir);
    x.vscode._showDocument(x.at('c.rs'));
    // No Rust compilers in the file, so the list of Compiler Explorer's Rust compilers opens directly.
    x.state.quickPickAnswers.push(list => list.find(i => i.compiler && i.compiler.id === 'g2'));
    await x.state.commands.get('asmLens.selectCompiler')();
    assert.equal((await x.ext._internals.resolveSettings(x.open('c.rs'))).active.id, 'g2');
    assert.equal((await x.ext._internals.resolveSettings(x.open('a.cpp'))).active.id, 'g152', 'the C++ choice is unaffected');
    assert.match(ce.requests.find(r => r.url.includes('/api/compilers/')).url, /\/api\/compilers\/rust$/);
  } finally { ce.restore(); }
});

test('remote: analysis stores functions matched to source; CodeLens titles; panel and hover', async () => {
  const dir = makeProject({ 'a.cpp': 'int one() { return 1; }\nint two() { return 2; }\nint unused();\n' });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: asmFor(['one()', 1], ['two()', 2]) }));
  try {
    const x = start(dir);
    const msg = await x.analyze('a.cpp');
    assert.deepEqual(msg.info, ['Asm Lens: found 2 emitted function bodies.']);
    const lenses = await x.lenses('a.cpp');
    assert.deepEqual(lenses.map(l => [l.line, l.title]), [
      [1, '$(symbol-numeric) 2 instructions · g152 · -O2'],
      [2, '$(symbol-numeric) 2 instructions · g152 · -O2']
    ]);
    await x.state.commands.get('asmLens.showAssembly')(x.vscode.Uri.file(x.at('a.cpp')), 'two', 1);
    assert.equal(x.state.lastRender().title, 'two — 2 instructions');
    assert.ok(x.state.lastRender().rows.some(r => r.t === 'mov eax, 1'));
    const hover = x.state.hoverProviders[0].provider.provideHover(x.open('a.cpp'), new x.vscode.Position(0, 5));
    assert.match(hover.contents.value, /\*\*one\*\* — 2 instructions/);
    const body = ce.requests.at(-1).body;
    assert.equal(body.lang, 'c++');
    assert.equal(body.options.userArguments, '-O2', 'the syntax flag is left to Compiler Explorer (filters.intel)');
    assert.equal(body.options.filters.intel, true);
  } finally { ce.restore(); }
});

test('remote: missing headers become empty files and failing functions are skipped (recovery)', async () => {
  const src = '#include "missing/gen.h"\nint ok() { return 1; }\nint bad() { return GEN_VALUE; }\n';
  const dir = makeProject({ 'a.cpp': src });
  const ce = fakeCompilerExplorer(body => {
    if (!body.files || !body.files.some(f => f.filename === 'missing/gen.h')) return { code: 1, stderr: err('<source>:1:10: fatal error: missing/gen.h: No such file or directory') };
    if (body.source.includes('GEN_VALUE')) return { code: 1, stderr: err("<source>:3:21: error: 'GEN_VALUE' was not declared in this scope") };
    return { code: 0, asm: asmFor(['ok()', 2]) };
  });
  try {
    const x = start(dir);
    const msg = await x.analyze('a.cpp');
    assert.match(msg.info[0], /found 1 emitted function bodies \(1 quoted include\(s\) not found; 1 header\(s\) replaced by empty files; 1 function\/declaration\(s\) skipped/);
    assert.equal(ce.requests.length, 3);
    assert.match(ce.requests[1].body.options.userArguments, /-I\./);
    assert.equal(await x.lensAt('a.cpp', 2), '$(symbol-numeric) 2 instructions · g152 · -O2');
    assert.match(await x.lensAt('a.cpp', 3), /Not compiled/);
  } finally { ce.restore(); }
});

test('remote: with skipFailingFunctions off, a compile error is reported', async () => {
  const dir = makeProject({ 'a.cpp': 'int bad() { return nope; }\n' });
  const ce = fakeCompilerExplorer(() => ({ code: 1, stderr: err("<source>:1:20: error: 'nope' was not declared in this scope") }));
  try {
    const x = start(dir, { settings: { 'asmLens.skipFailingFunctions': false } });
    const msg = await x.analyze('a.cpp');
    assert.match(msg.error[0], /'nope' was not declared/);
    assert.equal(ce.requests.length, 1);
  } finally { ce.restore(); }
});

test('remote: local headers are uploaded with their layout; analyzing a .cpp gives its headers CodeLens', async () => {
  const dir = makeProject({
    'src/main.cpp': '#include "../include/util.hpp"\n#include <vector>\nint use() { return twice(2); }\n',
    'include/util.hpp': '#pragma once\ninline int twice(int x) { return x * 2; }\ninline int unused(int x) { return x; }\n'
  });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: [
    { text: 'use():' },
    { text: '        mov eax, 4', source: { file: 'asm_lens/include/util.hpp', line: 2 } },
    { text: '        ret', source: { file: null, line: 3 } }
  ] }));
  try {
    const x = start(dir, { settings: { 'asmLens.reanalyzeOn': 'never' } });
    await x.analyze('src/main.cpp');
    const body = ce.requests[0].body;
    assert.deepEqual(body.files.map(f => f.filename).sort(), ['asm_lens/include/util.hpp', 'asm_lens/src/.asm_lens_keep']);
    assert.match(body.options.userArguments, /-Iasm_lens\/src/);
    assert.equal(await x.lensAt('include/util.hpp', 2), '$(symbol-numeric) 1 inlined instructions · used in 1 function(s) · via main.cpp');
    assert.equal(await x.lensAt('include/util.hpp', 3), '$(play) No separate code in main.cpp (inlined or not used) · click to analyze this file');
    const hover = x.state.hoverProviders[0].provider.provideHover(x.open('include/util.hpp'), new x.vscode.Position(1, 30));
    assert.match(hover.contents.value, /Line 2.*1 instruction/s);
  } finally { ce.restore(); }
});

test('analysisFor: the newest analysis that covers a header wins', async () => {
  const dir = makeProject({ 'm.hxx': '#pragma once\ninline int h() { return 1; }\n', 'u.cpp': '#include "m.hxx"\nint u() { return h(); }\n' });
  const ce = fakeCompilerExplorer(body => body.source.includes('int u()')
    ? { code: 0, asm: [{ text: 'u():' }, { text: '        mov eax, 1', source: { file: 'asm_lens/m.hxx', line: 2 } }, { text: '        ret', source: { file: null, line: 2 } }] }
    : { code: 0, asm: asmFor(['h()', 2]) });
  try {
    const x = start(dir);
    await x.analyze('m.hxx');
    assert.equal(x.analysis('m.hxx').rootPath, x.at('m.hxx'));
    assert.match(ce.requests[0].body.source, /__attribute__\(\(used\)\) inline int h\(\)/, 'a header compiled alone keeps its inline functions');
    await x.analyze('u.cpp');
    assert.equal(x.analysis('m.hxx').rootPath, x.at('u.cpp'));
    await x.analyze('m.hxx');
    assert.equal(x.analysis('m.hxx').rootPath, x.at('m.hxx'));
  } finally { ce.restore(); }
});

test('header: rejected __attribute__((used)) lines are reverted one by one; plain text is the last resort', async () => {
  const dir = makeProject({ 'h.hpp': 'inline int a() { return 1; }\ninline int b() { return 2; }\n' });
  const ce = fakeCompilerExplorer(body => /__attribute__\(\(used\)\) inline int b/.test(body.source)
    ? { code: 1, stderr: err('<source>:2:1: error: attribute rejected') }
    : { code: 0, asm: asmFor(['a()', 1]) });
  try {
    const x = start(dir);
    await x.analyze('h.hpp');
    assert.equal(ce.requests.length, 3, 'marked; as written (compiles); marked without the line in error');
    assert.match(ce.requests[2].body.source, /^__attribute__\(\(used\)\) inline int a\(\)/);
    assert.match(ce.requests[2].body.source, /\ninline int b\(\)/);
  } finally { ce.restore(); }
});

test('header without code: a message that points at Instantiate…', async () => {
  const dir = makeProject({ 't.hpp': 'template <class T> T id(T x) { return x; }\n' });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: [] }));
  try {
    const x = start(dir);
    const msg = await x.analyze('t.hpp');
    assert.match(msg.info[0], /emitted no code: none of its templates compiled with the types tried\. Click "Instantiate…"/);
    const lenses = await x.lenses('t.hpp');
    assert.deepEqual(lenses.map(l => l.title), ['$(info) Template: no code yet · click to choose types', '$(symbol-type-parameter) Instantiate…']);
  } finally { ce.restore(); }
});

test('instantiate: requests are appended, remembered per file, deduplicated, failing ones dropped', async () => {
  const dir = makeProject({ 'm.hxx': fixture('headers', 'mathx.hxx') });
  const ce = fakeCompilerExplorer(body => {
    const lines = body.source.split('\n');
    const bad = lines.findIndex(l => l.includes('Nope'));
    if (bad >= 0) return { code: 1, stderr: err(`<source>:${bad + 1}:30: error: 'Nope' was not declared in this scope`) };
    const out = [];
    if (body.source.includes('&square<int>')) out.push(...asmFor(['int square<int>(int)', 5]));
    if (body.source.includes('template struct mx::Box<long>')) out.push(...asmFor(['mx::Box<long>::twice() const', 32]));
    return { code: 0, asm: out };
  });
  try {
    const x = start(dir, { settings: { 'asmLens.autoInstantiateTemplates': false } });
    await x.instantiate('m.hxx', 5, 'int');
    await x.instantiate('m.hxx', 5, 'int');
    await x.instantiate('m.hxx', 32, 'long');
    const failed = await x.instantiate('m.hxx', 21, 'Nope');
    assert.match(failed.warning[0], /could not instantiate mx::cube<Nope>: 'Nope' was not declared in this scope/);
    const doc = x.open('m.hxx');
    assert.deepEqual(x.ext._internals.instantiationsFor(doc), [{ kind: 'address', expr: 'square<int>' }, { kind: 'class', expr: 'mx::Box<long>', keyword: 'struct', member: 'mx::Box<long>::twice' }]);
    const src = ce.requests.at(-1).body.source.split('\n');
    assert.equal(src[34], 'auto __asm_lens_inst_0 = &square<int>;');
    assert.equal(src[35], 'template struct mx::Box<long>;');
    assert.equal(src.length, fixture('headers', 'mathx.hxx').split('\n').length + 3);
    assert.equal(await x.lensAt('m.hxx', 4), '$(symbol-numeric) 2 instructions · square<int> · g152 · -O2');
    assert.equal(await x.lensAt('m.hxx', 32), '$(symbol-numeric) 2 instructions · mx::Box<long> · g152 · -O2');
    const top = (await x.lenses('m.hxx')).find(l => l.command === 'asmLens.manageInstantiations');
    assert.equal(top.title, '$(symbol-type-parameter) Instantiated: square<int>, template struct mx::Box<long> · edit');
    // The input box suggests the arguments used last time.
    let suggested;
    x.state.inputBoxAnswers.push(opts => { suggested = opts.value; return undefined; });
    await x.state.commands.get('asmLens.instantiateTemplate')(x.vscode.Uri.file(x.at('m.hxx')), 3);
    assert.equal(suggested, 'int');
    // Removing one.
    x.state.quickPickAnswers.push(items => [items[0]]);
    await x.state.commands.get('asmLens.manageInstantiations')(x.vscode.Uri.file(x.at('m.hxx')));
    assert.deepEqual(x.ext._internals.instantiationsFor(doc).map(i => i.expr), ['mx::Box<long>']);
  } finally { ce.restore(); }
});

test('instantiate: not a template, unsupported shapes, cancelled input, C files', async () => {
  const dir = makeProject({ 'a.cpp': 'int plain() { return 1; }\nstruct W { template <class U> W(U) {} };\ntemplate <class T> T t(T x) { return x; }\n', 'b.c': 'int f(void) { return 0; }\n' });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: [] }));
  try {
    const x = start(dir);
    assert.match((await x.instantiate('a.cpp', 1)).info[0], /put the cursor in a template function/);
    assert.match((await x.instantiate('a.cpp', 2)).warning[0], /Constructors and destructors/);
    await x.instantiate('a.cpp', 3, undefined);
    assert.deepEqual(x.ext._internals.instantiationsFor(x.open('a.cpp')), []);
    assert.equal(ce.requests.length, 0, 'cancelling does not compile');
    assert.match((await x.instantiate('b.c', 1)).info[0], /C\+\+ files only/);
  } finally { ce.restore(); }
});

test('CodeLens before any analysis: Analyze on every function, Instantiate on templates', async () => {
  const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\ntemplate <class T> T g(T x) { return x; }\n' });
  const x = start(dir);
  assert.deepEqual((await x.lenses('a.cpp')).map(l => [l.line, l.title]), [
    [1, '$(play) Analyze with Asm Lens'], [2, '$(play) Analyze with Asm Lens'], [2, '$(symbol-type-parameter) Instantiate…']
  ]);
  x.state.settings['asmLens.showCounts'] = false;
  assert.deepEqual(await x.lenses('a.cpp'), []);
});

test('language-server symbols are used, and the source scan adds what they miss', async () => {
  const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\nint main() { return f(); }\n' });
  const x = start(dir);
  const { Range, SymbolKind } = x.vscode;
  x.state.symbols.set(x.at('a.cpp'), [{ name: 'f()', kind: SymbolKind.Function, range: new Range(0, 0, 0, 21), selectionRange: new Range(0, 4, 0, 5), children: [] }]);
  const fns = x.ext._internals.sourceFunctionsOf(x.open('a.cpp'), x.state.symbols.get(x.at('a.cpp')));
  assert.deepEqual(fns.map(s => s.name), ['f()', 'main']);
});

test('editing keeps the results: lines below move, only edited functions change, one compile after the pause', async () => {
  const src = 'int a() { return 1; }\nint b() { return 2; }\nint c() { return 3; }\n';
  const dir = makeProject({ 'a.cpp': src });
  const ce = fakeCompilerExplorer(body => {
    const lines = body.source.split('\n');
    const out = [];
    lines.forEach((l, i) => { const m = /^int (\w)\(\)/.exec(l); if (m) out.push(...asmFor([`${m[1]}()`, i + 1])); });
    return { code: 0, asm: out };
  });
  try {
    const x = start(dir, { settings: { 'asmLens.reanalyzeDelayMs': 200 } });
    await x.analyze('a.cpp');
    assert.equal(ce.requests.length, 1);
    // Two new lines at the top: everything moves down two lines, nothing is "changed".
    x.edit('a.cpp', 0, 0, 0, 0, '// one\n// two\n');
    const moved = await x.lenses('a.cpp');
    assert.deepEqual(moved.map(l => [l.line, l.title.split(' · ')[0]]), [[3, '$(symbol-numeric) 2 instructions'], [4, '$(symbol-numeric) 2 instructions'], [5, '$(symbol-numeric) 2 instructions']]);
    const hover = x.state.hoverProviders[0].provider.provideHover(x.open('a.cpp'), new x.vscode.Position(3, 15));
    assert.match(hover.contents.value, /\*\*b\*\*|Line 4/, 'hover follows the moved line');
    // Typing inside b(): only b() is "updating"; a() and c() keep their numbers.
    x.edit('a.cpp', 3, 17, 3, 18, '20');
    x.edit('a.cpp', 3, 18, 3, 18, '0');
    const typing = await x.lenses('a.cpp');
    assert.deepEqual(typing.map(l => l.title.split(' · ')[0]), ['$(symbol-numeric) 2 instructions', '$(sync~spin) Updating…', '$(symbol-numeric) 2 instructions']);
    assert.equal(x.state.hoverProviders[0].provider.provideHover(x.open('a.cpp'), new x.vscode.Position(3, 5)), undefined, 'no stale instructions on an edited line');
    assert.equal(ce.requests.length, 1, 'nothing is compiled while typing');
    await new Promise(r => setTimeout(r, 400));
    assert.equal(ce.requests.length, 2, 'one compile after the pause');
    assert.deepEqual((await x.lenses('a.cpp')).map(l => [l.line, l.title.split(' · ')[0]]), [[3, '$(symbol-numeric) 2 instructions'], [4, '$(symbol-numeric) 2 instructions'], [5, '$(symbol-numeric) 2 instructions']]);
    assert.equal(x.state.progress.at(-1).opts.location, x.vscode.ProgressLocation.Window, 'background analyses do not pop up a notification');
  } finally { ce.restore(); }
});

test('editing while a compile runs cancels it; the next one starts after the pause', async () => {
  const dir = makeProject({ 'a.cpp': 'int a() { return 1; }\n' });
  const real = global.fetch;
  const calls = [];
  global.fetch = (url, init) => new Promise((resolve, reject) => {
    const call = { body: JSON.parse(init.body), aborted: false };
    calls.push(call);
    init.signal.addEventListener('abort', () => { call.aborted = true; const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ code: 0, asm: asmFor(['a()', 1]) }), text: async () => JSON.stringify({ code: 0, asm: asmFor(['a()', 1]) }) }), 300);
  });
  try {
    const x = start(dir, { settings: { 'asmLens.reanalyzeDelayMs': 200 } });
    await x.analyze('a.cpp');
    x.edit('a.cpp', 0, 17, 0, 18, '2');
    await new Promise(r => setTimeout(r, 250));      // the background compile has started
    assert.equal(calls.length, 2);
    x.edit('a.cpp', 0, 17, 0, 18, '3');               // ... and is now outdated
    assert.equal(calls[1].aborted, true);
    await new Promise(r => setTimeout(r, 700));
    assert.equal(calls.length, 3);
    assert.match(calls[2].body.source, /return 3;/);
    assert.equal(x.state.messages.error.length, 0);
    assert.ok(x.state.outputLines.some(l => l.startsWith('Outdated')));
  } finally { global.fetch = real; }
});

test('reanalyzeOn "save" and "never"', async () => {
  const dir = makeProject({ 'a.cpp': 'int a() { return 1; }\n' });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: asmFor(['a()', 1]) }));
  try {
    const x = start(dir, { settings: { 'asmLens.reanalyzeOn': 'save', 'asmLens.reanalyzeDelayMs': 200 } });
    await x.analyze('a.cpp');
    x.edit('a.cpp', 0, 18, 0, 19, '5');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(ce.requests.length, 1, 'no compile while editing');
    const lens = (await x.lenses('a.cpp'))[0];
    assert.equal(lens.title, '$(edit) Changed since the last analysis · click to update');
    assert.equal(lens.command, 'asmLens.analyzeFile');
    await x.state.saveListener(x.open('a.cpp'));
    assert.equal(ce.requests.length, 2, 'saving compiles');
    x.state.settings['asmLens.reanalyzeOn'] = 'never';
    x.edit('a.cpp', 0, 18, 0, 19, '6');
    await x.state.saveListener(x.open('a.cpp'));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(ce.requests.length, 2, 'never: only on request');
  } finally { ce.restore(); }
});

test('the open assembly view follows the new code after a re-analysis', async () => {
  const dir = makeProject({ 'a.cpp': 'int a() { return 1; }\n' });
  let n = 0;
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: [{ text: 'a():' }, ...Array.from({ length: ++n }, () => ({ text: '        nop', source: { file: null, line: 1 } }))] }));
  try {
    const x = start(dir, { settings: { 'asmLens.reanalyzeDelayMs': 200 } });
    await x.analyze('a.cpp');
    await x.state.commands.get('asmLens.showAssembly')(x.vscode.Uri.file(x.at('a.cpp')), 'a', 0);
    assert.equal(x.state.lastRender().title, 'a — 1 instructions');
    x.edit('a.cpp', 0, 18, 0, 19, '2');
    await new Promise(r => setTimeout(r, 400));
    assert.equal(x.state.lastRender().title, 'a — 2 instructions');
  } finally { ce.restore(); }
});

test('other languages (remote): Compiler Explorer default compiler, required flags, Python rows', async () => {
  const dir = makeProject({ 'a.rs': 'pub fn sq(x: i32) -> i32 {\n    x * x\n}\n', 'p.py': 'def f(x):\n    return x\n' });
  const ce = fakeCompilerExplorer(body => body.lang === 'python'
    ? { code: 0, asm: [{ text: '  0           RESUME 0', source: { line: 0, file: null } }, { text: 'Disassembly of <code object f at 0x1, file "example.py", line 1>:', source: { line: null } }, { text: '  2           LOAD_FAST                0 (x)', source: { line: 2, file: null } }, { text: '              RETURN_VALUE', source: { line: 2, file: null } }] }
    : { code: 0, asm: [{ text: 'example::sq:' }, { text: '        imul edi, edi', source: { file: null, line: 2 } }, { text: '        ret', source: { file: null, line: 3 } }] });
  try {
    const x = start(dir);
    const msg = await x.analyze('a.rs');
    assert.match(msg.info[0], /found 1 emitted function bodies \(Rust\)/);
    const rustReq = ce.requests.find(r => /\/compile$/.test(r.url));
    assert.match(rustReq.url, /\/api\/compiler\/r_default\/compile$/, 'the default compiler comes from /api/languages');
    assert.equal(rustReq.body.options.userArguments, '-O -C link-dead-code');
    assert.equal(rustReq.body.files, undefined);
    assert.equal(await x.lensAt('a.rs', 1), '$(symbol-numeric) 2 instructions · Rust r_default · -O -C link-dead-code');
    await x.analyze('p.py');
    assert.equal(await x.lensAt('p.py', 1), '$(symbol-numeric) 2 instructions · Python python314 · ');
  } finally { ce.restore(); }
});

test('local mode errors are reported: missing compiler, unsupported language', async () => {
  const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\n', 'b.d': 'int f() { return 1; }\n' }, { mode: 'local', compiler: 'definitely-not-a-compiler-xyz' });
  const x = start(dir);
  assert.match((await x.analyze('a.cpp')).error[0], /"definitely-not-a-compiler-xyz" was not found/);
  assert.match((await x.analyze('b.d')).error[0], /Local mode is not available for D/);
});

test('unsupported file types get a clear message', async () => {
  const dir = makeProject({ 'a.txt': 'hello' });
  const x = start(dir);
  x.open('a.txt');
  const msg = await x.analyze('a.txt');
  assert.match(msg.warning[0], /supports C, C\+\+/);
});

test('collectLocalIncludes: search order, recursion, system headers, excludes, limits', async () => {
  const dir = makeProject({
    'src/a.cpp': '#include "local.h"\n#include <lib/api.h>\n#include <vector>\n#include "nowhere.h"\n/* #include "commented.h" */\n',
    'src/local.h': '#include "sub/deep.h"\n',
    'src/sub/deep.h': '#include "local.h"\n',
    'third/lib/api.h': '#include "../impl/x.h"\n',
    'third/impl/x.h': '',
    'vendor/lib/api.h': '// excluded copy',
    'build/gen/version.h': ''
  });
  const x = start(dir);
  const doc = x.open('src/a.cpp');
  const b = await x.ext._internals.collectLocalIncludes(doc, [{ dir: path.join(dir, 'third'), recursive: false }], { excludePaths: ['**/vendor/**'] });
  assert.deepEqual(b.pathMap.map(e => path.relative(dir, e.real).replace(/\\/g, '/')).sort(), ['src/local.h', 'src/sub/deep.h', 'third/impl/x.h', 'third/lib/api.h']);
  assert.deepEqual(b.unresolved.map(u => u.name), ['nowhere.h']);
  assert.deepEqual(b.skippedSystem, ['vector']);
  const limited = await x.ext._internals.collectLocalIncludes(doc, [{ dir: path.join(dir, 'third'), recursive: false }], { maxFiles: 1 });
  assert.equal(limited.truncated, true);
  assert.equal(limited.pathMap.length, 1);
});

test('header with an MSVC compiler on Compiler Explorer: no __attribute__((used)) (MSVC does not know it)', async () => {
  const dir = makeProject({ 'h.hpp': 'inline int a() { return 1; }\n' }, { compilers: [{ id: 'vcpp_v19_latest_x64', name: 'x64 msvc v19.latest' }] });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: asmFor(['int a(void)', 1]) }));
  try {
    const x = start(dir);
    await x.analyze('h.hpp');
    assert.equal(ce.requests.length, 1);
    assert.equal(ce.requests[0].body.source, 'inline int a() { return 1; }\nauto __asm_lens_keep_0 = &a;\n');
  } finally { ce.restore(); }
});

test('progress: a notification with steps for a requested analysis, a status-bar spinner for automatic ones', async () => {
  const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\n' });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: asmFor(['f()', 1]) }));
  try {
    const x = start(dir);
    await x.analyze('a.cpp');
    const p = x.state.progress[0];
    assert.equal(p.opts.location, x.vscode.ProgressLocation.Notification);
    assert.equal(p.opts.cancellable, true);
    assert.deepEqual(p.messages, ['reading settings…', 'finding local headers…', 'compiling with g152 on godbolt.org…', 'matching functions with the source…']);
    // Saving the analyzed file analyzes it again, quietly.
    await x.state.saveListener(x.open('a.cpp'));
    const auto = x.state.progress[1];
    assert.equal(auto.opts.location, x.vscode.ProgressLocation.Window);
    assert.equal(auto.opts.cancellable, false);
  } finally { ce.restore(); }
});

test('cancel: stops the request, reports nothing as an error, keeps no result', async () => {
  const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\n' });
  const real = global.fetch;
  let started;
  global.fetch = (url, init) => new Promise((resolve, reject) => {
    started();
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  try {
    const x = start(dir);
    const running = x.analyze('a.cpp');
    await new Promise(r => { started = r; });
    assert.deepEqual((await x.lenses('a.cpp')).map(l => l.title), ['$(sync~spin) Analyzing…']);
    x.state.cancelProgress();
    const msg = await running;
    assert.deepEqual(msg.error, []);
    assert.equal(x.analysis('a.cpp'), undefined);
    assert.ok(x.state.outputLines.some(l => l.startsWith('Cancelled:')));
    assert.deepEqual((await x.lenses('a.cpp')).map(l => l.title), ['$(play) Analyze with Asm Lens']);
  } finally { global.fetch = real; }
});

test('cancel in local mode kills the compiler process', { skip: process.platform === 'win32' && 'uses a POSIX shell script as the compiler' }, async () => {
  const fs = require('fs');
  const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\n', 'slow-cc': '#!/bin/sh\nsleep 30\n' });
  fs.chmodSync(path.join(dir, 'slow-cc'), 0o755);
  fs.writeFileSync(path.join(dir, '.asm-lens.json'), JSON.stringify({ mode: 'local', compiler: './slow-cc' }));
  const x = start(dir);
  const t0 = Date.now();
  const running = x.analyze('a.cpp');
  setTimeout(() => x.state.cancelProgress(), 300);
  const msg = await running;
  assert.ok(Date.now() - t0 < 10000, 'returned soon after cancel');
  assert.deepEqual(msg.error, []);
});

test('unchanged code is not compiled twice (reply cache)', async () => {
  const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\n' });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: asmFor(['f()', 1]) }));
  try {
    const x = start(dir);
    await x.analyze('a.cpp');
    await x.analyze('a.cpp');
    assert.equal(ce.requests.length, 1);
    x.state.settings['asmLens.reanalyzeOn'] = 'never';
    x.edit('a.cpp', 0, 17, 0, 18, '2');
    await x.analyze('a.cpp');
    assert.equal(ce.requests.length, 2);
  } finally { ce.restore(); }
});

test('saving a header analyzes again the .cpp whose results it shows (unless turned off)', async () => {
  const dir = makeProject({ 'm.hxx': '#pragma once\ninline int h() { return 1; }\n', 'u.cpp': '#include "m.hxx"\nint u() { return h(); }\n', 'other.hxx': '#pragma once\n' });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: [{ text: 'u():' }, { text: '        mov eax, 1', source: { file: 'asm_lens/m.hxx', line: 2 } }, { text: '        ret', source: { file: null, line: 2 } }] }));
  try {
    const x = start(dir);
    await x.analyze('u.cpp');
    x.state.settings['asmLens.reanalyzeOn'] = 'save';
    const header = x.edit('m.hxx', 1, 25, 1, 26, '7');
    assert.match(await x.lensAt('m.hxx', 2), /Changed since the last analysis/, 'the edited header function is marked');
    await x.state.saveListener(header);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(ce.requests.length, 2);
    assert.equal(x.analysis('m.hxx').rootPath, x.at('u.cpp'));
    await x.state.saveListener(x.open('other.hxx'));
    assert.equal(ce.requests.length, 2, 'an unrelated file does not trigger anything');
    x.state.settings['asmLens.reanalyzeOn'] = 'never';
    await x.state.saveListener(x.open('u.cpp'));
    assert.equal(ce.requests.length, 2);
  } finally { ce.restore(); }
});

// ---------------------------------------------------------------------------
// 0.7.0: MSVC, syntax flags, rejected flags, rate limits, compiler selection, highlighting

const msvcRows = [
  { text: 'x$ = 8' },
  { text: 'int one(void) PROC                                    ; one, COMDAT' },
  { text: '        mov     eax, 1', source: { file: null, line: 1 } },
  { text: '        ret     0', source: { file: null, line: 1 } },
  { text: 'int one(void) ENDP                                    ; one' },
  { text: 'int two(void) PROC                                    ; two, COMDAT' },
  { text: '        mov     eax, 2', source: { file: null, line: 2 } },
  { text: '        ret     0', source: { file: null, line: 2 } },
  { text: 'int two(void) ENDP                                    ; two' }
];

test('MSVC on Compiler Explorer: functions are found, no -masm flag is sent (it warns D9002), -O2 is sent as /O2 /EHsc', async () => {
  const dir = makeProject({ 'a.cpp': 'int one() { return 1; }\nint two() { return 2; }\n' }, { compilers: [{ id: 'vcpp_v19_latest_x64', name: 'x64 msvc' }] });
  const ce = fakeCompilerExplorer(body => /-masm/.test(body.options.userArguments)
    ? { code: 0, stderr: err("cl : Command line warning D9002 : ignoring unknown option '-masm=intel'"), asm: [] }
    : { code: 0, asm: msvcRows });
  try {
    const x = start(dir);
    const msg = await x.analyze('a.cpp');
    assert.match(msg.info[0], /found 2 emitted function bodies/);
    assert.equal(ce.requests[0].body.options.userArguments, '/O2 /EHsc');
    assert.equal(ce.requests[0].body.options.filters.intel, true);
    assert.equal(await x.lensAt('a.cpp', 1), '$(symbol-numeric) 2 instructions · x64 msvc · /O2 /EHsc');
    assert.equal(await x.lensAt('a.cpp', 2), '$(symbol-numeric) 2 instructions · x64 msvc · /O2 /EHsc');
    assert.ok(x.state.outputLines.some(l => /Flags for vcpp_v19_latest_x64: -O2 -> \/O2, added \/EHsc/.test(l)), 'the translation is logged');
  } finally { ce.restore(); }
});

test('syntax: -masm=att in the flags asks Compiler Explorer for AT&T syntax; -masm is never sent', async () => {
  const dir = makeProject({ 'a.cpp': 'int one() { return 1; }\n' }, { flags: '-O1 -masm=att', compilers: ['g152'] });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: asmFor(['one()', 1]) }));
  try {
    const x = start(dir);
    await x.analyze('a.cpp');
    assert.equal(ce.requests[0].body.options.userArguments, '-O1');
    assert.equal(ce.requests[0].body.options.filters.intel, false);
  } finally { ce.restore(); }
});

test('a flag the compiler rejects is left out and the file compiled again', async () => {
  const dir = makeProject({ 'a.c': 'int one(void) { return 1; }\n' }, { compilers: [{ id: 'cc65_219', flags: '-O2 -DX' }] });
  const ce = fakeCompilerExplorer(body => /-O2/.test(body.options.userArguments)
    ? { code: 1, stderr: err('cc65: Unknown option: -O2') }
    : { code: 0, asm: asmFor(['_one', 1]) });
  try {
    const x = start(dir);
    x.vscode._openDocument(x.at('a.c'), 'c');
    const msg = await x.analyze('a.c');
    assert.equal(ce.requests.length, 2);
    assert.equal(ce.requests[1].body.options.userArguments, '-DX');
    assert.match(msg.info[0], /flags the compiler does not accept were left out: -O2/);
    assert.equal(await x.lensAt('a.c', 1), '$(symbol-numeric) 2 instructions · cc65_219 · -DX', '"_one" is the C symbol of one()');
  } finally { ce.restore(); }
});

test('Compiler Explorer rate limit (HTTP 429) and non-JSON replies give clear messages; automatic re-analysis waits', async () => {
  const dir = makeProject({ 'a.cpp': 'int one() { return 1; }\n' });
  const real = global.fetch;
  let mode = 'ok';
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (mode === '429') return { ok: false, status: 429, text: async () => 'Your request has hit our rate limit.' };
    if (mode === 'html') return { ok: true, status: 200, text: async () => '<html>maintenance</html>' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, asm: asmFor(['one()', 1]) }) };
  };
  try {
    const x = start(dir, { settings: { 'asmLens.reanalyzeDelayMs': 200 } });
    await x.analyze('a.cpp');
    mode = 'html';
    x.edit('a.cpp', 0, 18, 0, 19, '2');
    assert.match((await x.analyze('a.cpp')).error[0], /not JSON: <html>maintenance/);
    mode = '429';
    x.edit('a.cpp', 0, 18, 0, 19, '3');
    assert.match((await x.analyze('a.cpp')).error[0], /limiting how often it compiles \(HTTP 429\)/);
    const before = calls;
    x.edit('a.cpp', 0, 18, 0, 19, '4');
    await new Promise(r => setTimeout(r, 400));
    assert.equal(calls, before, 'no automatic request while rate-limited');
  } finally { global.fetch = real; }
});

test('select compiler: a Compiler Explorer compiler is used even when the project file says local mode', async () => {
  const dir = makeProject({ 'a.cpp': '', 'b.c': '' }, { mode: 'local', compilers: [{ id: 'local-gcc', compiler: 'g++' }, { id: 'local-cc', compiler: 'gcc', language: 'c' }] });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: [] }));
  try {
    const x = start(dir);
    x.vscode._showDocument(x.at('a.cpp'));
    x.state.quickPickAnswers.push(items => items.find(i => i.browse), items => items.find(i => i.compiler.id === 'g2'));
    await x.state.commands.get('asmLens.selectCompiler')();
    const r = await x.ext._internals.resolveSettings(x.open('a.cpp'));
    assert.deepEqual([r.active.id, r.mode], ['g2', 'remote']);
    assert.match(x.state.messages.info.at(-1), /set to GCC 2 \(Compiler Explorer\)/);
    // The C++ pick is not used for C files (the project's first compiler is, as before).
    const c = await x.ext._internals.resolveSettings(x.vscode._openDocument(x.at('b.c'), 'c'));
    assert.deepEqual([c.active.id, c.mode], ['local-gcc', 'local']);
    // Picking a project compiler again goes back to it.
    x.state.quickPickAnswers.push(items => items.find(i => i.compiler && i.compiler.id === 'local-gcc'));
    await x.state.commands.get('asmLens.selectCompiler')();
    const back = await x.ext._internals.resolveSettings(x.open('a.cpp'));
    assert.deepEqual([back.active.id, back.mode], ['local-gcc', 'local']);
  } finally { ce.restore(); }
});

test('select compiler: works while the assembly view has the focus (no active editor)', async () => {
  const dir = makeProject({ 'a.cpp': '' }, { compilers: ['g152', 'g132'] });
  const x = start(dir);
  x.vscode._showDocument(x.at('a.cpp'));
  x.vscode._focusPanel();
  x.state.quickPickAnswers.push(items => items.find(i => i.compiler && i.compiler.id === 'g132'));
  await x.state.commands.get('asmLens.selectCompiler')();
  assert.equal((await x.ext._internals.resolveSettings(x.open('a.cpp'))).active.id, 'g132');
  assert.equal(x.state.settings['asmLens.compilerId'], undefined, 'the project choice is not written to the VS Code settings');
});

test('select compiler without a project file: the setting is changed where it is in effect; local mode switches to remote', async () => {
  const dir = makeProject({ 'a.cpp': '' });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: [] }));
  try {
    const x = start(dir, { workspaceSettings: { 'asmLens.compilerId': 'g132', 'asmLens.mode': 'local' } });
    x.vscode._showDocument(x.at('a.cpp'));
    x.state.quickPickAnswers.push(items => items.find(i => i.compiler.id === 'g2'));
    await x.state.commands.get('asmLens.selectCompiler')();
    assert.equal(x.state.workspaceSettings['asmLens.compilerId'], 'g2', 'the workspace value, which hides the user value');
    assert.equal(x.state.workspaceSettings['asmLens.mode'], 'remote');
    const r = await x.ext._internals.resolveSettings(x.open('a.cpp'));
    assert.deepEqual([r.active.id, r.mode], ['g2', 'remote']);
  } finally { ce.restore(); }
});

test('select compiler: a choice saved by 0.6 (browsed, without mode) compiles on Compiler Explorer', async () => {
  const dir = makeProject({ 'a.cpp': '' }, { mode: 'local', compilers: [{ id: 'local-gcc', compiler: 'g++' }] });
  const x = start(dir);
  x.state.workspaceState.set('asmLens.activeCompiler', { id: 'clang1910', name: 'Clang', browsed: true });
  const r = await x.ext._internals.resolveSettings(x.open('a.cpp'));
  assert.deepEqual([r.active.id, r.mode], ['clang1910', 'remote']);
});

test('highlighting: the view is built once; switching functions and highlighting are messages without delays', async () => {
  const dir = makeProject({ 'a.cpp': 'int one() { return 1; }\nint two() { return 2; }\n' });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: asmFor(['one()', 1], ['two()', 2]) }));
  try {
    const x = start(dir);
    await x.analyze('a.cpp');
    await x.state.commands.get('asmLens.showAssembly')(x.vscode.Uri.file(x.at('a.cpp')), 'one', 0);
    const html = x.state.webviewHtml;
    const editor = x.state.activeEditor;
    const select = line => x.state.selectionListeners.forEach(fn => fn({ textEditor: editor, selections: [{ active: { line } }], kind: x.vscode.TextEditorSelectionChangeKind.Keyboard }));
    x.state.webviewMessages.length = 0;
    select(0);
    assert.deepEqual(x.state.webviewMessages, [{ type: 'highlightAsm', file: 0, line: 0 }], 'same function: highlighted at once');
    x.state.webviewMessages.length = 0;
    select(1);
    await new Promise(r => setTimeout(r, 60));
    assert.deepEqual(x.state.webviewMessages.map(m => m.type), ['render', 'highlightAsm'], 'other function: rendered, then highlighted');
    assert.equal(x.state.webviewMessages[0].title, 'two — 2 instructions');
    assert.equal(x.state.webviewHtml, html, 'the page itself was not rebuilt');
    // A reloaded webview gets the current function again.
    x.state.webviewMessages.length = 0;
    x.state.webviewHandler({ type: 'ready' });
    assert.equal(x.state.webviewMessages[0].title, 'two — 2 instructions');
  } finally { ce.restore(); }
});

test('highlighting: hovering an instruction highlights its line; the rest stays as it is unless dimOtherLines is on', async () => {
  const dir = makeProject({ 'a.cpp': 'int f(int x) {\n  int y = x * 2;\n  y += 3;\n  return y;\n}\n' });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: [
    { text: 'f(int):' },
    { text: '        lea eax, [rdi+rdi]', source: { file: null, line: 2, column: 13 } },
    { text: '        add eax, 3', source: { file: null, line: 3 } },
    { text: '        ret', source: { file: null, line: 5 } }
  ] }));
  try {
    const x = start(dir);
    await x.analyze('a.cpp');
    await x.state.commands.get('asmLens.showAssembly')(x.vscode.Uri.file(x.at('a.cpp')), 'f', 0);
    const editor = x.state.activeEditor;
    const byType = () => [...editor.decorations.entries()].map(([type, ranges]) => [type.options, ranges.map(r => (r.range || r).start.line + '-' + (r.range || r).end.line)]);
    assert.equal(x.state.lastRender().dim, false, 'the assembly view does not fade the other instructions');
    x.state.webviewHandler({ type: 'highlight', file: 0, line: 2 });
    let decos = byType();
    assert.deepEqual(decos.find(([o]) => o.isWholeLine && o.borderColor)[1], ['2-2']);
    assert.ok(decos.filter(([o]) => o.opacity).every(([, r]) => r.length === 0), 'nothing is dimmed by default');
    x.state.webviewHandler({ type: 'clearHighlight' });
    await x.vscode.workspace.getConfiguration('asmLens').update('dimOtherLines', true);
    assert.equal(x.state.lastRender().dim, true, 'the assembly view is redrawn with fading');
    x.state.webviewHandler({ type: 'highlight', file: 0, line: 2 });
    decos = byType();
    assert.deepEqual(decos.find(([o]) => o.isWholeLine && o.borderColor)[1], ['2-2']);
    assert.deepEqual(decos.find(([o]) => o.opacity)[1], ['0-1', '3-4'], 'the other lines of f() are dimmed');
    x.state.webviewHandler({ type: 'clearHighlight' });
    assert.ok(byType().filter(([o]) => o.opacity || o.borderColor).every(([, r]) => r.length === 0), 'line, token and dim highlights are cleared');
  } finally { ce.restore(); }
});

test('header with MSVC: functions are kept by taking their address; lines that do not compile are dropped quietly', async () => {
  const dir = makeProject({ 'h.hpp': 'inline int a() { return 1; }\ninline int b(int) { return 2; }\ninline int b(double) { return 3; }\n' }, { compilers: [{ id: 'vcpp_v19_latest_x64', name: 'x64 msvc' }] });
  const ce = fakeCompilerExplorer(body => {
    const lines = body.source.split('\n');
    const bad = lines.findIndex(l => /static_cast<int \(\*\)\(double\)>/.test(l));
    if (bad >= 0) return { code: 2, stderr: err(`<source>(${bad + 1}): error C2440: 'static_cast': cannot convert`) };
    return { code: 0, asm: [{ text: 'int a(void) PROC' }, { text: '        mov eax, 1', source: { file: null, line: 1 } }, { text: '        ret 0', source: { file: null, line: 1 } }, { text: 'int a(void) ENDP' }] };
  });
  try {
    const x = start(dir);
    const msg = await x.analyze('h.hpp');
    assert.equal(ce.requests[0].body.source.split('\n').slice(3).join('|'), 'auto __asm_lens_keep_0 = &a;|auto __asm_lens_keep_1 = static_cast<int (*)(int)>(&b);|auto __asm_lens_keep_2 = static_cast<int (*)(double)>(&b);|');
    assert.ok(!/__attribute__/.test(ce.requests[0].body.source));
    assert.deepEqual(msg.warning, [], 'no "could not instantiate" for our own lines');
    assert.equal(await x.lensAt('h.hpp', 1), '$(symbol-numeric) 2 instructions · x64 msvc · /O2 /EHsc');
  } finally { ce.restore(); }
});

// ---------------------------------------------------------------------------
// 0.7.1: the chosen compiler is the one used

function fakeWithMsvc(respond) {
  const real = global.fetch;
  const requests = [];
  global.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url: String(url), body });
    const json = /\/api\/compilers\//.test(url)
      ? [{ id: 'clang2310', name: 'x86-64 clang 23.1.0' }, { id: 'vcpp_v19_latest_x64', name: 'x64 msvc v19.latest' }]
      : respond(body, String(url));
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
  };
  return { requests, restore: () => { global.fetch = real; } };
}

test('select compiler without a project file: MSVC is used, not an older stored pick (status bar, request, re-analysis)', async () => {
  const dir = makeProject({ 'main.cpp': 'int main() { return 0; }\n' });
  const ce = fakeWithMsvc((body, url) => /vcpp/.test(url) ? { code: 0, asm: msvcRows.slice(0, 5) } : { code: 0, asm: asmFor(['main', 1]) });
  try {
    const x = start(dir);
    // Picked with Browse in an earlier session (for example while a .asm-lens.json existed).
    x.state.workspaceState.set('asmLens.activeCompiler', { id: 'clang2310', name: 'x86-64 clang 23.1.0', browsed: true, mode: 'remote', language: 'c++' });
    x.vscode._showDocument(x.at('main.cpp'));
    assert.equal((await x.ext._internals.resolveSettings(x.open('main.cpp'))).active.id, 'g152', 'the settings decide without a project file');
    await x.analyze('main.cpp');
    x.state.quickPickAnswers.push(items => items.find(i => i.compiler.id === 'vcpp_v19_latest_x64'));
    await x.state.commands.get('asmLens.selectCompiler')();
    assert.equal(x.state.settings['asmLens.compilerId'], 'vcpp_v19_latest_x64');
    assert.equal(x.state.workspaceState.get('asmLens.activeCompiler'), undefined, 'the older pick is cleared');
    const r = await x.ext._internals.resolveSettings(x.open('main.cpp'));
    assert.deepEqual([r.active.id, r.active.name, r.mode], ['vcpp_v19_latest_x64', 'x64 msvc v19.latest', 'remote']);
    assert.match(x.state.statusItem.text, /x64 msvc v19\.latest/);
    const compiles = ce.requests.filter(q => /\/compile$/.test(q.url));
    assert.match(compiles.at(-1).url, /\/api\/compiler\/vcpp_v19_latest_x64\/compile$/, 'the file is analyzed again, with MSVC');
    assert.match(await x.lensAt('main.cpp', 1), /x64 msvc v19\.latest/);
  } finally { ce.restore(); }
});

test('select compiler: a pick belongs to the project file it was made in', async () => {
  const dir = makeProject({
    'a/.asm-lens.json': JSON.stringify({ compilers: ['g152', 'clang2310'] }),
    'a/x.cpp': '',
    'b/.asm-lens.json': JSON.stringify({ compilers: ['g132'] }),
    'b/y.cpp': ''
  });
  const ce = fakeWithMsvc(() => ({ code: 0, asm: [] }));
  try {
    const x = start(dir);
    x.vscode._showDocument(x.at('a/x.cpp'));
    x.state.quickPickAnswers.push(items => items.find(i => i.browse), items => items.find(i => i.compiler.id === 'vcpp_v19_latest_x64'));
    await x.state.commands.get('asmLens.selectCompiler')();
    assert.equal((await x.ext._internals.resolveSettings(x.open('a/x.cpp'))).active.id, 'vcpp_v19_latest_x64');
    assert.equal((await x.ext._internals.resolveSettings(x.open('b/y.cpp'))).active.id, 'g132', 'not used by another project');
  } finally { ce.restore(); }
});

test('select compiler with a project file: the file is analyzed again with the new compiler', async () => {
  const dir = makeProject({ 'a.cpp': 'int main() { return 0; }\n' }, { compilers: ['g152', 'vcpp_v19_latest_x64'] });
  const ce = fakeWithMsvc((body, url) => /vcpp/.test(url) ? { code: 0, asm: msvcRows.slice(0, 5) } : { code: 0, asm: asmFor(['main', 1]) });
  try {
    const x = start(dir);
    await x.analyze('a.cpp');
    x.state.quickPickAnswers.push(items => items.find(i => i.compiler && i.compiler.id === 'vcpp_v19_latest_x64'));
    await x.state.commands.get('asmLens.selectCompiler')();
    assert.match(ce.requests.at(-1).url, /vcpp_v19_latest_x64\/compile$/);
    assert.match(x.state.statusItem.text, /vcpp_v19_latest_x64/);
  } finally { ce.restore(); }
});

test('header: when the marked text fails elsewhere, the text as written is compiled before any function is skipped', async () => {
  const dir = makeProject({ 'h.hpp': 'inline int a() { return 1; }\nint broken_on_purpose_only_when_marked();\n' });
  const ce = fakeCompilerExplorer(body => /__attribute__/.test(body.source)
    ? { code: 1, stderr: err('<source>:2:5: error: something the marks caused far away') }
    : { code: 0, asm: asmFor(['a()', 1]) });
  try {
    const x = start(dir);
    await x.analyze('h.hpp');
    assert.equal(ce.requests.length, 2);
    assert.ok(/__attribute__/.test(ce.requests[0].body.source) && !/__attribute__/.test(ce.requests[1].body.source));
    assert.equal(x.analysis('h.hpp').skipped.length, 0, 'nothing is blanked because of the marks');
  } finally { ce.restore(); }
});

test('functions split by the compiler (MSVC funclets, GCC cold paths) are counted as one', async () => {
  const dir = makeProject({ 'a.cpp': 'int main() {\n  return 0;\n}\n' });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: [
    { text: 'main PROC' }, { text: '        xor eax, eax', source: { file: null, line: 2 } }, { text: '        ret 0', source: { file: null, line: 3 } }, { text: 'main ENDP' },
    { text: 'main$dtor$0 PROC' }, { text: '        jmp foo', source: { file: null, line: 3 } }, { text: 'main$dtor$0 ENDP' }
  ] }));
  try {
    const x = start(dir);
    await x.analyze('a.cpp');
    assert.match(await x.lensAt('a.cpp', 1), /^\$\(symbol-numeric\) 3 instructions · /);
  } finally { ce.restore(); }
});

test('changing the compiler in the settings by hand analyzes the visible file again with it', async () => {
  const dir = makeProject({ 'main.cpp': 'int main() { return 0; }\n' });
  const ce = fakeWithMsvc((body, url) => /vcpp/.test(url) ? { code: 0, asm: msvcRows.slice(0, 5) } : { code: 0, asm: asmFor(['main', 1]) });
  try {
    const x = start(dir);
    await x.analyze('main.cpp');
    await x.vscode.workspace.getConfiguration('asmLens').update('compilerId', 'vcpp_v19_latest_x64', 1);
    await new Promise(r => setTimeout(r, 700));
    assert.match(ce.requests.at(-1).url, /vcpp_v19_latest_x64\/compile$/);
    assert.match(await x.lensAt('main.cpp', 1), /vcpp_v19_latest_x64/, 'without a compilerName the id is shown');
    x.state.settings['asmLens.reanalyzeOn'] = 'never';
    const before = ce.requests.length;
    await x.vscode.workspace.getConfiguration('asmLens').update('compilerId', 'g152', 1);
    await new Promise(r => setTimeout(r, 700));
    assert.equal(ce.requests.length, before);
  } finally { ce.restore(); }
});

// ---------------------------------------------------------------------------
// 0.8.0: functions defined in classes, one main, MSVC flags

const CLASSY = [
  'struct P { int dot() const { return 1; } };',                                        // 1
  'static int helper(int x) { return x; }',                                             // 2
  'int ext(int x) { return x; }',                                                       // 3
  'int main() {',                                                                       // 4
  '  auto l = [](int a) { return a + 1; };',                                            // 5
  '  P p; return p.dot() + l(1) + helper(2);',                                          // 6
  '}'                                                                                   // 7
].join('\n') + '\n';

const classyRows = () => [
  { text: 'P::dot() const:' }, { text: '        mov eax, 1', source: { file: null, line: 1 } }, { text: '        ret', source: { file: null, line: 1 } },
  { text: 'helper(int):' }, { text: '        mov eax, edi', source: { file: null, line: 2 } }, { text: '        ret', source: { file: null, line: 2 } },
  { text: 'ext(int):' }, { text: '        mov eax, edi', source: { file: null, line: 3 } }, { text: '        ret', source: { file: null, line: 3 } },
  { text: 'main::{lambda(int)#1}::operator()(int) const:' }, { text: '        lea eax, [rdi+1]', source: { file: null, line: 5 } }, { text: '        ret', source: { file: null, line: 5 } },
  { text: 'main:' }, { text: '        push rbx', source: { file: null, line: 4 } }, { text: '        mov eax, 5', source: { file: null, line: 6 } }, { text: '        lea eax, [rax+1]', source: { file: null, line: 5 } }, { text: '        pop rbx', source: { file: null, line: 7 } }, { text: '        ret', source: { file: null, line: 7 } },
  { text: 'typeinfo for P:' }, { text: '        .quad 0', source: { file: null, line: 1 } }
];

test('.cpp with GCC/Clang: in-class, static and inline functions are marked used (same lines); external ones and main are not; asmLens.emitUnusedFunctions turns it off', async () => {
  const dir = makeProject({ 'a.cpp': CLASSY });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: classyRows() }));
  try {
    const x = start(dir);
    await x.analyze('a.cpp');
    const sent = ce.requests[0].body.source.split('\n');
    assert.equal(sent.length, CLASSY.split('\n').length, 'line numbers are unchanged');
    assert.equal(sent[0], 'struct P { __attribute__((used)) int dot() const { return 1; } };');
    assert.equal(sent[1], '__attribute__((used)) static int helper(int x) { return x; }');
    assert.deepEqual(sent.slice(2), CLASSY.split('\n').slice(2), 'external functions and main are sent as written');
    assert.equal(await x.lensAt('a.cpp', 1), '$(symbol-numeric) 2 instructions · g152 · -O2');
    assert.equal(await x.lensAt('a.cpp', 4), '$(symbol-numeric) 5 instructions · g152 · -O2', 'main: one result (not its lambda, not typeinfo)');
    await x.vscode.workspace.getConfiguration('asmLens').update('emitUnusedFunctions', false);
    await x.analyze('a.cpp');
    assert.equal(ce.requests.at(-1).body.source, CLASSY, 'turned off: the text as written');
  } finally { ce.restore(); }
});

test('.cpp with MSVC: functions are kept by taking their address (members qualified); the flags are written for cl.exe', async () => {
  const dir = makeProject({ 'a.cpp': CLASSY }, { compilers: [{ id: 'vcpp_v19_latest_x64', name: 'x64 msvc v19.latest', flags: '-O3 -std=c++20 -march=native' }] });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: classyRows() }));
  try {
    const x = start(dir);
    await x.analyze('a.cpp');
    const { source, options } = ce.requests[0].body;
    assert.ok(!source.includes('__attribute__'));
    assert.deepEqual(source.split('\n').slice(7), ['auto __asm_lens_keep_0 = &P::dot;', 'auto __asm_lens_keep_1 = &helper;', '']);
    assert.equal(options.userArguments, '/O2 /std:c++20 /EHsc');
    assert.equal(await x.lensAt('a.cpp', 1), '$(symbol-numeric) 2 instructions · x64 msvc v19.latest · /O2 /std:c++20 /EHsc');
  } finally { ce.restore(); }
});

test('.cpp: when the marked text fails and the text as written compiles, the marks are not tried again for that file and compiler', async () => {
  const dir = makeProject({ 'a.cpp': CLASSY });
  const ce = fakeCompilerExplorer(body => body.source.includes('__attribute__')
    ? { code: 1, stderr: err('<source>:6:3: error: something the marks broke') }
    : { code: 0, asm: classyRows() });
  try {
    const x = start(dir);
    assert.deepEqual((await x.analyze('a.cpp')).error, []);
    assert.equal(ce.requests.length, 2);
    assert.ok(x.state.outputLines.some(l => /compiling it again without __attribute__\(\(used\)\)/.test(l)));
    x.edit('a.cpp', 6, 1, 6, 1, ' // edited');
    await x.analyze('a.cpp');
    assert.equal(ce.requests.length, 3, 'one request: the text as written');
    assert.ok(!ce.requests[2].body.source.includes('__attribute__'));
  } finally { ce.restore(); }
});

test('constructors: copies with the same code are one result; different ones are "versions", not "instantiations"', async () => {
  const dir = makeProject({ 'a.cpp': 'struct Q {\n  Q() : v(1) {}\n  ~Q() { v = 0; }\n  int v;\n};\nQ make() { return Q(); }\n' });
  const ctor = (suffix, code) => [{ text: `Q::Q()${suffix}:` }, ...code.map(text => ({ text, source: { file: null, line: 2 } }))];
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: [
    ...ctor('', ['mov DWORD PTR [rdi], 1', 'ret']), ...ctor('', ['mov DWORD PTR [rdi], 1', 'ret']),
    { text: 'Q::~Q():' }, { text: '        mov DWORD PTR [rdi], 0', source: { file: null, line: 3 } }, { text: '        ret', source: { file: null, line: 3 } },
    { text: 'Q::~Q():' }, { text: '        jmp Q::~Q()', source: { file: null, line: 3 } }
  ] }));
  try {
    const x = start(dir);
    await x.analyze('a.cpp');
    assert.equal(await x.lensAt('a.cpp', 2), '$(symbol-numeric) 2 instructions · g152 · -O2');
    assert.equal(await x.lensAt('a.cpp', 3), '$(symbol-numeric) 2 versions · 2 / 1 instructions · g152');
  } finally { ce.restore(); }
});

test('functionForLine: a line of main is main, not the lambda or library code that shares it', async () => {
  const dir = makeProject({ 'a.cpp': CLASSY });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: classyRows() }));
  try {
    const x = start(dir);
    await x.analyze('a.cpp');
    const a = x.analysis('a.cpp');
    assert.equal(x.ext._internals.functionForLine(a, a.rootPathKey, 4).name, 'main', 'line 5 (the lambda) is in main');
    assert.equal(x.ext._internals.functionForLine(a, a.rootPathKey, 0).name, 'P::dot() const');
  } finally { ce.restore(); }
});

// ---------------------------------------------------------------------------
// 0.8.1: a slow Compiler Explorer

// Replies in order; 'hang' never answers (until the request is aborted), { delay, reply } answers late.
function scriptedCompilerExplorer(script) {
  const real = global.fetch;
  const requests = [];
  global.fetch = (url, init = {}) => {
    requests.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    const step = script.length > 1 ? script.shift() : script[0];
    const answer = reply => ({ ok: true, status: 200, json: async () => reply, text: async () => JSON.stringify(reply) });
    return new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      if (init.signal?.aborted) return abort();
      init.signal?.addEventListener('abort', abort);
      if (step === 'hang') return;
      setTimeout(() => resolve(answer(step.reply || step)), step.delay || 0);
    });
  };
  return { requests, restore: () => { global.fetch = real; } };
}

const slowRows = [{ text: 'f():' }, { text: '        mov eax, 1', source: { file: null, line: 1 } }, { text: '        ret', source: { file: null, line: 1 } }];

test('a Compiler Explorer request without an answer in time is sent once more', async () => {
  const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\n' });
  const ce = scriptedCompilerExplorer(['hang', { code: 0, asm: slowRows }]);
  try {
    const x = start(dir, { settings: { 'asmLens.requestTimeoutMs': 1000 } });
    const msg = await x.analyze('a.cpp');
    assert.deepEqual(msg.error, []);
    assert.equal(ce.requests.length, 2);
    assert.ok(x.state.outputLines.some(l => /godbolt\.org did not answer within 1 s; asking again/.test(l)), x.state.outputLines.join('\n'));
    assert.match(await x.lensAt('a.cpp', 1), /^\$\(symbol-numeric\) 2 instructions/);
  } finally { ce.restore(); }
});

test('no answer twice: a clear error, and the text is not compiled again without the marks', async () => {
  const dir = makeProject({ 'a.cpp': 'struct S { int g() const { return 2; } };\nint f() { return 1; }\n' });
  const ce = scriptedCompilerExplorer(['hang']);
  try {
    const x = start(dir, { settings: { 'asmLens.requestTimeoutMs': 1000 } });
    const msg = await x.analyze('a.cpp');
    assert.match(msg.error[0] || '', /godbolt\.org did not answer within 1 s, twice\. .*asmLens\.requestTimeoutMs/);
    assert.equal(ce.requests.length, 2, 'the marked text twice; no third request');
  } finally { ce.restore(); }
});

test('while Compiler Explorer is slow, the progress shows how long it has waited', async () => {
  const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\n' });
  const ce = scriptedCompilerExplorer([{ delay: 3600, reply: { code: 0, asm: slowRows } }]);
  try {
    const x = start(dir, { settings: { 'asmLens.requestTimeoutMs': 20000 } });
    assert.deepEqual((await x.analyze('a.cpp')).error, []);
    const messages = x.state.progress.at(-1).messages;
    assert.ok(messages.some(m => /^compiling with g152 on godbolt\.org… 3 s$/.test(m)), messages.join('\n'));
  } finally { ce.restore(); }
});

test('Python on Compiler Explorer: a request without an answer in time is sent once more', async () => {
  const dir = makeProject({ 'p.py': 'def f(x):\n    return x\n' }, { compilers: [{ id: 'python314', name: 'Python 3.14', language: 'python' }] });
  const pyReply = { code: 0, asm: [{ text: 'Disassembly of <code object f at 0x1, file "example.py", line 1>:' }, { text: '  2           LOAD_FAST                0 (x)', source: { line: 2, file: null } }, { text: '              RETURN_VALUE', source: { line: 2, file: null } }] };
  const ce = scriptedCompilerExplorer(['hang', pyReply]);
  try {
    const x = start(dir, { settings: { 'asmLens.requestTimeoutMs': 1000 } });
    assert.deepEqual((await x.analyze('p.py')).error, []);
    assert.equal(ce.requests.length, 2);
    assert.match(await x.lensAt('p.py', 1), /^\$\(symbol-numeric\) 2 instructions · Python 3\.14/);
  } finally { ce.restore(); }
});

// ---------------------------------------------------------------------------
// 0.8.2: a header keeps what its own analysis found

const HEADER = '#pragma once\ninline int used() { return 1; }\ninline int spare() { return 2; }\ntemplate <class T> T t(T v) { return v; }\n';
const USER = '#include "m.hxx"\nint u() { return used(); }\n';
const headerReply = body => (body.source.includes('int u()')
  ? { code: 0, asm: [{ text: 'u():' }, { text: '        mov eax, 1', source: { file: 'asm_lens/m.hxx', line: 2 } }, { text: '        ret', source: { file: null, line: 2 } }] }
  : { code: 0, asm: asmFor(['used()', 2], ['spare()', 3], ...(body.source.includes('&t<int>') ? [['int t<int>(int)', 4]] : [])) });
const noWatch = { settings: { 'asmLens.reanalyzeOn': 'never' } };

test('header: a .cpp analyzed later does not hide what the header\'s own analysis found', async () => {
  const dir = makeProject({ 'm.hxx': HEADER, 'u.cpp': USER });
  const ce = fakeCompilerExplorer(headerReply);
  try {
    const x = start(dir, noWatch);
    await x.analyze('m.hxx');
    await x.instantiate('m.hxx', 4, 'int');
    await x.analyze('u.cpp');
    assert.equal(x.analysis('m.hxx').rootPath, x.at('u.cpp'), 'the newest analysis still decides');
    assert.equal(await x.lensAt('m.hxx', 2), '$(symbol-numeric) 1 inlined instructions · used in 1 function(s) · via u.cpp', 'what the .cpp used');
    assert.equal(await x.lensAt('m.hxx', 3), '$(symbol-numeric) 2 instructions · g152 · -O2', 'not used by the .cpp: the header\'s own result');
    assert.equal(await x.lensAt('m.hxx', 4), '$(symbol-numeric) 2 instructions · t<int> · g152 · -O2', 'a requested instantiation stays');
    // The assembly view, the hover and the cursor use the same result.
    const lens = (await x.lenses('m.hxx')).find(l => l.line === 3 && l.command === 'asmLens.showAssembly');
    await x.state.commands.get('asmLens.showAssembly')(...lens.args);
    assert.match(x.state.lastRender().title, /^spare/);
    const doc = x.open('m.hxx');
    assert.match(x.state.hoverProviders[0].provider.provideHover(doc, new x.vscode.Position(2, 12)).contents.value, /spare/);
    assert.equal(x.ext._internals.analysisAt(doc, 2).rootPath, x.at('m.hxx'));
    assert.equal(x.ext._internals.analysisAt(doc, 1).rootPath, x.at('u.cpp'));
    // Its numbers do not survive an edit of that function.
    x.edit('m.hxx', 2, 0, 2, 0, ' ');
    const stale = (await x.lenses('m.hxx')).find(l => l.line === 3 && l.command === 'asmLens.analyzeFile');
    assert.match(stale.title, /Changed since the last analysis/);
    assert.equal(stale.args[0].fsPath, x.at('m.hxx'));
  } finally { ce.restore(); }
});

test('header seen only through a .cpp: lenses offer to analyze it, and saved instantiations are not called "not instantiated"', async () => {
  const dir = makeProject({ 'm.hxx': HEADER, 'u.cpp': USER });
  const ce = fakeCompilerExplorer(headerReply);
  try {
    const x = start(dir, noWatch);
    await x.analyze('u.cpp');
    assert.equal(await x.lensAt('m.hxx', 3), '$(play) No separate code in u.cpp (inlined or not used) · click to analyze this file');
    assert.equal(await x.lensAt('m.hxx', 4), '$(info) No separate code in u.cpp (inlined or not used) · click to choose types', 'it may be inlined there, so not "not instantiated"');
    const choose = (await x.lenses('m.hxx')).find(l => l.line === 4 && l.command === 'asmLens.instantiateTemplate' && /choose types/.test(l.title));
    assert.equal(choose.args[1], 3, 'clicking it asks for the types of this template');
    // Instantiations saved in an earlier session: nothing has compiled them yet.
    x.state.workspaceState.set('asmLens.instantiations', { [require('../../src/asm').normPath(x.at('m.hxx'))]: [{ kind: 'address', expr: 't<int>' }] });
    assert.equal(await x.lensAt('m.hxx', 4), '$(play) Instantiations not compiled yet · click to analyze this file');
    const click = (await x.lenses('m.hxx')).find(l => l.line === 4 && l.command === 'asmLens.analyzeFile');
    assert.equal(click.args[0].fsPath, x.at('m.hxx'));
    await x.state.commands.get('asmLens.analyzeFile')(...click.args);
    assert.equal(await x.lensAt('m.hxx', 3), '$(symbol-numeric) 2 instructions · g152 · -O2');
    assert.equal(await x.lensAt('m.hxx', 4), '$(symbol-numeric) 2 instructions · t<int> · g152 · -O2');
  } finally { ce.restore(); }
});

test('header: older results fill gaps only for the same compiler, and never for a function that no longer compiles', async () => {
  const dir = makeProject({ 'm.hxx': HEADER, 'u.cpp': USER });
  const ce = fakeCompilerExplorer(headerReply);
  try {
    const x = start(dir, noWatch);
    await x.analyze('m.hxx');
    await x.analyze('u.cpp');
    const { lastAnalysis } = x.ext._internals._state();
    const newest = x.analysis('m.hxx');
    const own = [...lastAnalysis.values()].find(a => a.rootPath === x.at('m.hxx'));
    newest.skipped = [{ key: require('../../src/asm').normPath(x.at('m.hxx')), startLine: 2, endLine: 2 }];
    assert.match(await x.lensAt('m.hxx', 3), /^\$\(warning\) Not compiled/);
    newest.skipped = [];
    own.compilerId = 'another-compiler';
    assert.equal(await x.lensAt('m.hxx', 3), '$(play) No separate code in u.cpp (inlined or not used) · click to analyze this file');
    assert.equal(x.ext._internals.analysisAt(x.open('m.hxx'), 2).rootPath, x.at('u.cpp'));
  } finally { ce.restore(); }
});

// ---------------------------------------------------------------------------
// 0.8.3: requests say who is asking

test('every request to Compiler Explorer identifies the extension, as sent on the wire', async () => {
  const http = require('http');
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ path: req.url, agent: req.headers['user-agent'], accept: req.headers.accept, type: req.headers['content-type'] });
      const json = req.url.startsWith('/api/languages') ? [{ id: 'rust', defaultCompiler: 'r_default' }]
        : req.url.startsWith('/api/compilers/') ? [{ id: 'r2', name: 'Rust 2' }]
          : { code: 0, asm: [{ text: 'example::sq:' }, { text: '        ret', source: { file: null, line: 1 } }] };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(json));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const dir = makeProject({ 'c.rs': 'pub fn sq() {}\n' });
    const x = start(dir, { settings: { 'asmLens.baseUrl': `http://127.0.0.1:${server.address().port}`, 'asmLens.reanalyzeOn': 'never' } });
    assert.deepEqual((await x.analyze('c.rs')).error, []);
    x.state.quickPickAnswers.push(() => undefined);
    await x.state.commands.get('asmLens.selectCompiler')();
    const paths = seen.map(s => s.path.split('?')[0]);
    assert.ok(paths.includes('/api/languages'), paths.join());
    assert.ok(paths.includes('/api/compiler/r_default/compile'), paths.join());
    assert.ok(paths.includes('/api/compilers/rust'), paths.join());
    const expected = `asm-lens/${require('../../package.json').version} (+https://github.com/IdanShalom/asm-lens)`;
    for (const s of seen) {
      assert.equal(s.agent, expected, s.path);
      assert.equal(s.accept, 'application/json', s.path);
    }
    assert.equal(seen.find(s => s.path.endsWith('/compile')).type, 'application/json');
  } finally { server.close(); }
});

// ---------------------------------------------------------------------------
// One function that does not compile costs only that function

const BROKEN = '#pragma once\nstatic inline int good(int a) { return a; }\nstatic inline int bad(Missing* m) { return m->v; }\nclass T { public: int member() const { return 1; } };\n';
const hasBad = source => /Missing\* m/.test(source);
const goodRows = () => asmFor(['good(int)', 2], ['T::member() const', 4]);

test('header with a function that does not compile: the others keep their code (GCC, Clang)', async () => {
  const dir = makeProject({ 'b.hxx': BROKEN });
  const ce = fakeCompilerExplorer(body => hasBad(body.source)
    ? { code: 1, stderr: err("<source>:3:30: error: 'Missing' has not been declared") }
    : { code: 0, asm: /__attribute__\(\(used\)\) static inline int good/.test(body.source) ? goodRows() : [] });
  try {
    const x = start(dir);
    const msg = await x.analyze('b.hxx');
    assert.deepEqual(msg.error, []);
    assert.match(await x.lensAt('b.hxx', 2), /^\$\(symbol-numeric\) 2 instructions/);
    assert.match(await x.lensAt('b.hxx', 3), /^\$\(warning\) Not compiled/);
    assert.match(await x.lensAt('b.hxx', 4), /^\$\(symbol-numeric\) 2 instructions/);
    const sources = ce.requests.map(r => r.body.source);
    assert.equal(sources.length, 3, 'marked; as written (fails too); marked without the bad function');
    assert.ok(!/__attribute__/.test(sources[1]), 'as written');
    assert.ok(/__attribute__/.test(sources[2]) && !hasBad(sources[2]));
    assert.equal(x.analysis('b.hxx').skipped[0].name, 'bad');
  } finally { ce.restore(); }
});

test('header with a function that does not compile: the others keep their code (MSVC)', async () => {
  const dir = makeProject({ 'b.hxx': BROKEN }, { compilers: [{ id: 'vcpp_v19_latest_x64', name: 'x64 msvc' }] });
  const ce = fakeCompilerExplorer(body => hasBad(body.source)
    ? { code: 2, stdout: err("<source>(3): error C2061: syntax error: identifier 'Missing'") }
    : { code: 0, asm: /__asm_lens_keep/.test(body.source) ? goodRows() : [] });
  try {
    const x = start(dir);
    await x.analyze('b.hxx');
    assert.match(await x.lensAt('b.hxx', 2), /^\$\(symbol-numeric\) 2 instructions/);
    assert.match(await x.lensAt('b.hxx', 3), /^\$\(warning\) Not compiled/);
    assert.match(ce.requests.at(-1).body.source, /= &good;/);
    assert.ok(!/= &bad;/.test(ce.requests.at(-1).body.source), 'the bad function was blanked, so nothing refers to it');
  } finally { ce.restore(); }
});

test('nothing but failures: the message says why, not that the header has only declarations', async () => {
  const dir = makeProject({ 'b.hxx': '#pragma once\nstatic inline int bad(Missing* m) { return m->v; }\n' });
  const ce = fakeCompilerExplorer(body => hasBad(body.source) ? { code: 1, stderr: err("<source>:2:30: error: 'Missing' has not been declared") } : { code: 0, asm: [] });
  try {
    const x = start(dir);
    const msg = await x.analyze('b.hxx');
    assert.match(msg.info.join(' '), /1 function\(s\) do not compile on their own/);
    assert.ok(!/only has declarations/.test(msg.info.join(' ')));
  } finally { ce.restore(); }
});

test('a class that does not compile as a whole for the types: only the member that was clicked is compiled', async () => {
  const dir = makeProject({ 'm.h': 'template <class T> struct M {\n  T v;\n  T get() const { return v; }\n  auto len() const { return v.size(); }\n};\n' });
  const ce = fakeCompilerExplorer(body => {
    const lines = body.source.split('\n');
    const whole = lines.findIndex(l => l === 'template struct M<int>;');
    if (whole >= 0) return { code: 1, stderr: err(`<source>:4:30: error: request for member 'size' in 'int'`, `<source>:${whole + 1}:17:   required from here`) };
    return { code: 0, asm: lines.some(l => /= &M<int>::get;/.test(l)) ? asmFor(['M<int>::get() const', 3]) : [] };
  });
  try {
    const x = start(dir, { settings: { 'asmLens.reanalyzeOn': 'never' } });
    const msg = await x.instantiate('m.h', 3, 'int');
    assert.match(msg.info.join(' '), /M<int> does not compile as a whole for these types, so only M<int>::get is compiled/);
    assert.deepEqual(msg.warning, []);
    for (let i = 0; i < 100 && !/2 instructions/.test(await x.lensAt('m.h', 3) || ''); i++) await new Promise(r => setTimeout(r, 20));
    assert.match(await x.lensAt('m.h', 3), /^\$\(symbol-numeric\) 2 instructions/);
    assert.deepEqual(x.ext._internals.instantiationsFor(x.open('m.h')), [{ kind: 'address', expr: 'M<int>::get' }]);
  } finally { ce.restore(); }
});

// ---------------------------------------------------------------------------
// Asking before code leaves the machine

const compiles = ce => ce.requests.filter(r => /\/compile$/.test(r.url)).length;
const ASK = { 'asmLens.confirmRemoteUpload': true, 'asmLens.reanalyzeOn': 'never' };
const oneFn = () => ({ code: 0, asm: asmFor(['f()', 1]) });

test('remote: nothing is sent until the user agrees; Cancel sends nothing', async () => {
  const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\n' });
  const ce = fakeCompilerExplorer(oneFn);
  try {
    const x = start(dir, { settings: ASK });
    await x.analyze('a.cpp');
    assert.equal(compiles(ce), 0);
    assert.equal(x.state.dialogs.length, 1);
    assert.equal(x.state.dialogs[0].message, 'Send your code to godbolt.org?');
    assert.match(x.state.dialogs[0].detail, /the file you analyze and the local headers it needs/);
    assert.deepEqual(x.state.dialogs[0].items, ['Send', "Send, Don't Show Again", 'Use Local Compiler']);
    assert.equal(await x.lensAt('a.cpp', 1), '$(play) Analyze with Asm Lens');
  } finally { ce.restore(); }
});

test('remote: "Send" holds for this session and asks again after a restart', async () => {
  const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\n', 'b.cpp': 'int f() { return 2; }\n' });
  const ce = fakeCompilerExplorer(oneFn);
  try {
    const x = start(dir, { settings: ASK });
    x.state.dialogAnswers.push('Send');
    await x.analyze('a.cpp');
    await x.analyze('b.cpp');
    assert.equal(compiles(ce), 2);
    assert.equal(x.state.dialogs.length, 1, 'asked once');
    const restarted = start(dir, { settings: ASK });
    await restarted.analyze('a.cpp');
    assert.equal(restarted.state.dialogs.length, 1, 'a new session asks again');
  } finally { ce.restore(); }
});

test('remote: "Don\'t Show Again" is remembered per server, so a project pointing elsewhere asks again', async () => {
  const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\n', 'other/c.cpp': 'int f() { return 3; }\n' });
  const ce = fakeCompilerExplorer(oneFn);
  try {
    const x = start(dir, { settings: ASK });
    x.state.dialogAnswers.push("Send, Don't Show Again");
    await x.analyze('a.cpp');
    assert.deepEqual(x.state.globalState.get('asmLens.trustedUploadHosts'), ['godbolt.org']);
    x.open('a.cpp').setText('int f() { return 9; }\n');
    await x.analyze('a.cpp');
    assert.equal(x.state.dialogs.length, 1, 'not asked again for this server');
    assert.equal(compiles(ce), 2);
    require('fs').writeFileSync(x.at('other/.asm-lens.json'), JSON.stringify({ baseUrl: 'https://compile.example.net', compilers: [{ id: 'g1' }] }));
    await x.analyze('other/c.cpp');
    assert.equal(x.state.dialogs.length, 2, 'another server asks');
    assert.equal(x.state.dialogs[1].message, 'Send your code to compile.example.net?');
    assert.equal(compiles(ce), 2, 'and nothing went there');
  } finally { ce.restore(); }
});

test('remote: automatic analyses never ask and never send', async () => {
  const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\n' });
  const ce = fakeCompilerExplorer(oneFn);
  try {
    const x = start(dir, { settings: ASK });
    await x.ext._internals.analyzeDocument(x.open('a.cpp'), { auto: true });
    assert.equal(x.state.dialogs.length, 0);
    assert.equal(compiles(ce), 0);
  } finally { ce.restore(); }
});

test('other languages ask too; local mode and the setting do not', async () => {
  const dir = makeProject({ 'p.py': 'def f():\n    return 1\n' }, { compilers: [{ id: 'python314', language: 'python' }] });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: [] }));
  try {
    const x = start(dir, { settings: ASK });
    await x.analyze('p.py');
    assert.equal(x.state.dialogs.length, 1);
    assert.equal(compiles(ce), 0);
    const off = start(dir, { settings: { 'asmLens.confirmRemoteUpload': false } });
    assert.equal(await off.ext._internals.mayUpload(off.open('p.py')), true);
    const local = start(makeProject({ 'a.cpp': '' }, { mode: 'local' }), { settings: ASK });
    assert.equal(await local.ext._internals.mayUpload(local.open('a.cpp')), true);
    assert.equal(local.state.dialogs.length, 0);
  } finally { ce.restore(); }
});

test('"Use Local Compiler": sets local mode without a project file, and opens the project file with one', async () => {
  const ce = fakeCompilerExplorer(oneFn);
  try {
    const x = start(makeProject({ 'a.cpp': 'int f() { return 1; }\n' }), { settings: ASK });
    x.state.dialogAnswers.push('Use Local Compiler');
    assert.equal(await x.ext._internals.mayUpload(x.open('a.cpp')), true);
    assert.equal(x.vscode.workspace.getConfiguration('asmLens').get('mode'), 'local');
    assert.equal((await x.ext._internals.resolveSettings(x.open('a.cpp'))).mode, 'local');
    const y = start(makeProject({ 'a.cpp': 'int f() { return 1; }\n' }, { compilers: ['g152'] }), { settings: ASK });
    y.state.dialogAnswers.push('Use Local Compiler');
    assert.equal(await y.ext._internals.mayUpload(y.open('a.cpp')), false, 'the project file decides, so nothing is sent');
    assert.match(y.state.messages.info.join(' '), /set "mode": "local" in \.asm-lens\.json/);
    assert.equal(compiles(ce), 0);
  } finally { ce.restore(); }
});

// ---------------------------------------------------------------------------
// 0.8.4: a header compiles by itself; compiling again with what comes before its #include

const AUTO_HEADER = '#pragma once\nstatic inline int spare(int x) { return x + 1; }\nstatic inline int spare2(int x) { return x + 2; }\ntemplate <typename T> struct Box { T get() const { return T{}; } };\n';
const AUTO_USER = '#include "m.hxx"\nint u() { Box<long> b; return (int)b.get(); }\n';
function autoReply(body) {
  if (body.source.includes('int u()')) return { code: 0, asm: asmFor(['u()', 2]) };
  const out = [...asmFor(['spare(int)', 2]), ...asmFor(['spare2(int)', 3])];
  if (body.source.includes('template struct Box<long>;')) out.push(...asmFor(['Box<long>::get() const', 4]));
  return { code: 0, asm: out };
}

test('a header known through a .cpp compiles by itself when it is looked at, once, with the types the .cpp uses', async () => {
  const dir = makeProject({ 'm.hxx': AUTO_HEADER, 'u.cpp': AUTO_USER });
  const ce = fakeCompilerExplorer(autoReply);
  try {
    const x = start(dir);
    await x.analyze('u.cpp');
    assert.equal(ce.requests.length, 1, 'opening nothing compiles nothing');
    const lenses = await x.settled('m.hxx');
    assert.equal(ce.requests.length, 2);
    assert.match(ce.requests[1].body.source, /^template struct Box<long>;$/m);
    assert.equal(lenses.find(l => l.line === 2).title, '$(symbol-numeric) 2 instructions · g152 · -O2');
    assert.equal(lenses.find(l => l.line === 3).title, '$(symbol-numeric) 2 instructions · g152 · -O2');
    assert.equal(lenses.find(l => l.line === 4 && !l.title.endsWith('Instantiate…')).title, '$(symbol-numeric) 2 instructions · Box<long> · g152 · -O2');
    await x.settled('m.hxx');
    assert.equal(ce.requests.length, 2, 'not again for the same text');
    assert.deepEqual(x.state.messages.error, []);
    assert.equal(x.state.messages.info.length, 1, 'only the analysis that was asked for reports');
  } finally { ce.restore(); }
});

test('a header does not compile by itself: reanalyzeOn never; nothing known; unsaved; and it asks nobody', async () => {
  const dir = makeProject({ 'm.hxx': AUTO_HEADER, 'u.cpp': AUTO_USER, 'alone.hxx': 'inline int a() { return 1; }\n' });
  let ce = fakeCompilerExplorer(autoReply);
  try {
    const never = start(dir, { settings: { 'asmLens.reanalyzeOn': 'never' } });
    await never.analyze('u.cpp');
    await never.lenses('m.hxx');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(ce.requests.length, 1, 'reanalyzeOn: never compiles only when asked');
  } finally { ce.restore(); }
  ce = fakeCompilerExplorer(autoReply);
  try {
    const x = start(dir);
    await x.lenses('alone.hxx');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(ce.requests.length, 0, 'no file that includes it was analyzed');
    await x.analyze('u.cpp');
    x.state.settings['asmLens.reanalyzeOn'] = 'save';
    x.edit('m.hxx', 1, 0, 1, 0, ' ');
    await x.lenses('m.hxx');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(ce.requests.length, 1, 'being edited: on save, as asked');
  } finally { ce.restore(); }
  ce = fakeCompilerExplorer(autoReply);
  try {
    const x = start(dir, { settings: { 'asmLens.confirmRemoteUpload': true } });
    x.state.dialogAnswers.push('Send');
    await x.analyze('u.cpp');
    assert.equal(x.state.dialogs.length, 1);
    await x.settled('m.hxx');
    assert.equal(x.state.dialogs.length, 1, 'the answer given for the .cpp holds');
    assert.equal(ce.requests.length, 2);
  } finally { ce.restore(); }
});

test('a header that fails when compiled alone is compiled with what comes before its #include; a message only if that fails too', async () => {
  const header = '#pragma once\nstatic inline int px(Point p) { return p.x; }\nstatic inline int ok(int x) { return x; }\n';
  const reply = body => (/#define HAS_POINT/.test(body.source)
    ? { code: 0, asm: [...asmFor(['px(Point)', 2]), ...asmFor(['ok(int)', 3])] }
    : { code: 1, stderr: err("<source>:2:24: error: unknown type name 'Point'") });
  const dir = makeProject({ 'n.hxx': header, 'c.cpp': '#define HAS_POINT\n#include "n.hxx"\nint c() { return 1; }\n' });
  const ce = fakeCompilerExplorer(body => (body.source.includes('int c()') ? { code: 0, asm: asmFor(['c()', 3]) } : reply(body)));
  try {
    const x = start(dir);
    const msg = await x.analyze('n.hxx');
    assert.deepEqual(msg.error, []);
    const sent = ce.requests.at(-1).body.source;
    assert.ok(sent.startsWith('#define HAS_POINT\n#line 1\n#pragma once\n'), sent);
    assert.equal(await x.lensAt('n.hxx', 2), '$(symbol-numeric) 2 instructions · g152 · -O2');
    assert.equal(await x.lensAt('n.hxx', 3), '$(symbol-numeric) 2 instructions · g152 · -O2');
  } finally { ce.restore(); }

  const noIncluder = makeProject({ 'n.hxx': header });
  const failing = fakeCompilerExplorer(() => ({ code: 1, stderr: err('<source>:1:1: error: expected unqualified-id') }));
  try {
    const x = start(noIncluder);
    const msg = await x.analyze('n.hxx');
    assert.equal(msg.error.length, 1, 'nothing else to try');
  } finally { failing.restore(); }
});

test('the compile with an includer\'s lines is kept only when it finds more', async () => {
  const header = '#pragma once\nstatic inline int ok(int x) { return x; }\nstatic inline int bad(int x) { return nope(x); }\n';
  const dir = makeProject({ 'n.hxx': header, 'c.cpp': '#include <vector>\n#include "n.hxx"\n' });
  const ce = fakeCompilerExplorer(body => {
    const lines = body.source.split('\n');
    const at = lines.findIndex(l => l.includes('nope(x)'));
    if (at >= 0) return { code: 1, stderr: err(`<source>:3:40: error: 'nope' was not declared in this scope`) };
    return { code: 0, asm: body.source.includes('#line 1') ? [] : asmFor(['ok(int)', 2]) };
  });
  try {
    const x = start(dir);
    await x.analyze('n.hxx');
    assert.ok(ce.requests.some(r => r.body.source.startsWith('#include <vector>\n#line 1\n')), 'it was tried');
    assert.equal(await x.lensAt('n.hxx', 2), '$(symbol-numeric) 2 instructions · g152 · -O2', 'the first compile found more');
    assert.match(await x.lensAt('n.hxx', 3), /Not compiled/);
  } finally { ce.restore(); }
});

test('a server failure while compiling with marks does not turn the marks off', async () => {
  const dir = makeProject({ 'h.hxx': 'static inline int a() { return 1; }\n' });
  let calls = 0;
  const ce = fakeCompilerExplorer(body => {
    calls++;
    if (calls === 1) { const e = new Error('Bad Gateway'); e.status = 502; throw e; }
    return { code: 0, asm: body.source.includes('__attribute__((used))') ? asmFor(['a()', 1]) : [] };
  });
  try {
    const x = start(dir);
    await x.analyze('h.hxx').catch(() => {});
    await x.analyze('h.hxx');
    assert.ok(/__attribute__\(\(used\)\)/.test(ce.requests.at(-1).body.source), 'marks are still used');
    assert.equal(await x.lensAt('h.hxx', 1), '$(symbol-numeric) 2 instructions · g152 · -O2');
  } finally { ce.restore(); }
});

test('no code: the lens says why', async () => {
  const dir = makeProject({ 'h.hxx': '#ifdef OFF\nstatic inline int gated(int x) { return x; }\n#endif\nconsteval int ce(int x) { return x; }\nstatic inline int dropped(int x) { return x; }\ntemplate <class T> T t(T x) { return x; }\n' });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: asmFor(['other()', 99]) }));
  try {
    const x = start(dir);
    await x.analyze('h.hxx');
    assert.equal(await x.lensAt('h.hxx', 2), '$(info) Not compiled · inside #ifdef OFF, which is off · g152');
    assert.equal(await x.lensAt('h.hxx', 4), '$(info) consteval: it runs only while compiling, so it has no code');
    assert.equal(await x.lensAt('h.hxx', 5), '$(warning) No code found · click for details');
    assert.ok(x.state.outputLines.some(l => /no code for dropped at line 5: it was kept and called/.test(l)), x.state.outputLines.join('\n'));
    assert.equal(await x.lensAt('h.hxx', 6), '$(info) Template: no code yet · click to choose types');
  } finally { ce.restore(); }
});

test('a declaration from a language server whose range stops before the `;` gets no lens (clangd)', async () => {
  const dir = makeProject({ 'h.hxx': 'struct S {\n  int decl(int a) const;\n  int body() const { return 1; }\n  virtual int pure() = 0;\n};\n' });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: asmFor(['S::body() const', 3]) }));
  try {
    const x = start(dir);
    const vs = x.vscode;
    x.state.symbols.set(x.at('h.hxx'), [
      { name: 'decl', kind: vs.SymbolKind.Method, range: new vs.Range(1, 2, 1, 23), selectionRange: new vs.Range(1, 6, 1, 10), children: [] },
      { name: 'body', kind: vs.SymbolKind.Method, range: new vs.Range(2, 2, 2, 32), selectionRange: new vs.Range(2, 6, 2, 10), children: [] },
      { name: 'pure', kind: vs.SymbolKind.Method, range: new vs.Range(3, 2, 3, 24), selectionRange: new vs.Range(3, 14, 3, 18), children: [] }
    ]);
    await x.analyze('h.hxx');
    assert.deepEqual((await x.lenses('h.hxx')).map(l => l.line), [3]);
  } finally { ce.restore(); }
});

test('instantiating a class also covers the classes nested in it', async () => {
  const dir = makeProject({ 'h.hxx': 'template <class T> struct A {\n  T a() const { return T{}; }\n  struct In { T i() const { return T{}; } };\n};\n' });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: [] }));
  try {
    const x = start(dir, { settings: { 'asmLens.autoInstantiateTemplates': false } });
    await x.instantiate('h.hxx', 2, 'int');
    await x.instantiate('h.hxx', 3, 'int');
    assert.deepEqual(x.ext._internals.instantiationsFor(x.open('h.hxx')).map(i => i.expr), ['A<int>']);
    x.state.workspaceState.set('asmLens.instantiations', { [require('../../src/asm').normPath(x.at('h.hxx'))]: [{ kind: 'class', expr: 'A<long>::In', keyword: 'struct' }] });
    await x.instantiate('h.hxx', 2, 'long');
    assert.deepEqual(x.ext._internals.instantiationsFor(x.open('h.hxx')).map(i => i.expr), ['A<long>']);
  } finally { ce.restore(); }
});

test('an automatic instantiation that does not compile is dropped silently, and not retried by automatic analyses', async () => {
  const dir = makeProject({ 'h.hxx': 'template <class T> struct A { typename T::x a() const { return {}; } };\ntemplate <class T> struct B { T b() const { return T{}; } };\n' });
  const ce = fakeCompilerExplorer(body => {
    const lines = body.source.split('\n');
    const bad = lines.findIndex(l => l.trim() === 'template struct A<int>;');
    if (bad >= 0) return { code: 1, stderr: err(`<source>:1:40: error: 'int' is not a class`, `<source>:${bad + 1}:17: required from here`) };
    return { code: 0, asm: asmFor(['B<int>::b() const', 2]) };
  });
  try {
    const x = start(dir);
    const msg = await x.analyze('h.hxx');
    assert.deepEqual([msg.warning, msg.error], [[], []], 'nobody asked for it');
    assert.equal(ce.requests.length, 2);
    assert.equal(await x.lensAt('h.hxx', 1), '$(info) Template: no code yet · click to choose types');
    assert.equal(await x.lensAt('h.hxx', 2), '$(symbol-numeric) 2 instructions · B<int> · g152 · -O2');
    x.edit('h.hxx', 1, 0, 1, 0, ' ');
    for (let i = 0; i < 400 && ce.requests.length < 3; i++) await new Promise(r => setTimeout(r, 10));
    await x.settled('h.hxx');
    assert.equal(ce.requests.length, 3, 'one compile for the edit');
    assert.ok(!ce.requests[2].body.source.includes('template struct A<int>;'));
    await x.analyze('h.hxx');
    assert.ok(ce.requests.at(-2).body.source.includes('template struct A<int>;'), 'asked for: tried again');
  } finally { ce.restore(); }
});

test('errors on an automatic line and a chosen one: the automatic line goes first, the chosen one stays if it compiles without it', async () => {
  const dir = makeProject({ 'h.hxx': 'template <class T> struct A { T a() const { return T{}; } T bad() const { return T{}.x; } };\ntemplate <class T> struct B { T b() const { return T{}; } };\n' });
  const ce = fakeCompilerExplorer(body => {
    const lines = body.source.split('\n');
    const manual = lines.findIndex(l => l.includes('&A<long>::a'));
    const auto = lines.findIndex(l => l.trim() === 'template struct B<int>;');
    // MSVC names the line that first used a class, whichever line is at fault.
    if (auto >= 0) return { code: 2, stdout: err(`<source>(1): error C2228: left of '.x' must have class/struct/union`, `<source>(${manual + 1}): note: see reference to class template instantiation 'A<long>' being compiled`, `<source>(${auto + 1}): note: see reference to class template instantiation 'B<int>' being compiled`) };
    return { code: 0, asm: asmFor(['A<long>::a() const', 1]) };
  });
  try {
    const x = start(dir);
    x.state.workspaceState.set('asmLens.instantiations', { [require('../../src/asm').normPath(x.at('h.hxx'))]: [{ kind: 'address', expr: 'A<long>::a' }] });
    const msg = await x.analyze('h.hxx');
    assert.deepEqual(msg.warning, []);
    assert.deepEqual(x.ext._internals.instantiationsFor(x.open('h.hxx')).map(i => i.expr), ['A<long>::a'], 'the chosen one is kept');
    assert.match(ce.requests.at(-1).body.source, /&A<long>::a;/);
  } finally { ce.restore(); }
});

// ---------------------------------------------------------------------------
// 0.8.5: one function that cannot be emitted costs only that function; compile_commands.json for headers

test('a function that fails only when it is emitted loses its mark alone, and the lens gives the compiler\'s reason', async () => {
  const src = 'static inline int good(int x) { return x + 1; }\nstatic inline int bad(int x)\n{\n  return forbidden(x);\n}\nstatic inline int also_good(int x) { return x + 2; }\n';
  const dir = makeProject({ 'h.hxx': src });
  const ce = fakeCompilerExplorer(body => {
    const marked = body.source.split('\n')[1].includes('__attribute__((used))');
    if (marked) return { code: 1, stderr: err("<source>:4:10: error: call to 'forbidden' declared with attribute error: cannot be called") };
    const out = [];
    if (body.source.includes('__attribute__((used)) static inline int good')) out.push(...asmFor(['good(int)', 1]), ...asmFor(['also_good(int)', 6]));
    return { code: 0, asm: out };
  });
  try {
    const x = start(dir);
    await x.analyze('h.hxx');
    assert.equal(await x.lensAt('h.hxx', 1), '$(symbol-numeric) 2 instructions · g152 · -O2');
    assert.equal(await x.lensAt('h.hxx', 6), '$(symbol-numeric) 2 instructions · g152 · -O2');
    assert.match(await x.lensAt('h.hxx', 2), /^\$\(warning\) Not compiled · call to 'forbidden' declared with attribute error: cannot be called · g152$/);
  } finally { ce.restore(); }
});

test('a SIMD helper without the flag for it is compiled for that feature, and the lens says so', async () => {
  const src = 'static inline int good(int x) { return x + 1; }\nstatic inline __m256i simd(__m256i a)\n{\n  return _mm256_abs_epi32(a);\n}\n';
  const dir = makeProject({ 'h.hxx': src });
  const ce = fakeCompilerExplorer(body => {
    const line = body.source.split('\n')[1];
    if (/__attribute__\(\(used\)\)/.test(line)) return { code: 1, stderr: err("/x/avx2intrin.h:119:1: error: inlining failed in call to 'always_inline' '_mm256_abs_epi32': target specific option mismatch", '<source>:4:10: note: called from here') };
    if (/target\("avx2"\)/.test(line)) return { code: 0, asm: [...asmFor(['good(int)', 1]), ...asmFor(['simd(long long __vector(4))', 2])] };
    return { code: 0, asm: [] };
  });
  try {
    const x = start(dir);
    await x.analyze('h.hxx');
    assert.equal(await x.lensAt('h.hxx', 2), '$(symbol-numeric) 2 instructions · for -mavx2 (not in your flags) · g152 · -O2');
    assert.equal(await x.lensAt('h.hxx', 1), '$(symbol-numeric) 2 instructions · g152 · -O2');
  } finally { ce.restore(); }
});

test('-Werror in the flags does not stop an analysis: a warning is only a warning here', async () => {
  const dir = makeProject({ 'h.hxx': '#pragma once\nstatic inline int a() { return 1; }\n' }, { flags: '-O2 -Wall -Werror=format -Werror', compilers: [{ id: 'g152', name: 'g152' }] });
  const ce = fakeCompilerExplorer(body => (/-Werror/.test(body.options.userArguments) ? { code: 1, stderr: err("<source>:1:9: error: '#pragma once' in main file [-Werror]") } : { code: 0, asm: asmFor(['a()', 2]) }));
  try {
    const x = start(dir);
    const msg = await x.analyze('h.hxx');
    assert.deepEqual(msg.error, []);
    assert.equal(await x.lensAt('h.hxx', 2), '$(symbol-numeric) 2 instructions · g152 · -O2 -Wall');
    assert.ok(x.state.outputLines.some(l => /left out -Werror=format -Werror/.test(l)));
  } finally { ce.restore(); }
});

test('a server failure does not count as a compile error that needs other compilations', async () => {
  const dir = makeProject({ 'n.hxx': '#ifdef A\nstatic inline int a() { return 1; }\n#endif\n', 'c.cpp': '#define A\n#include "n.hxx"\n' });
  const real = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 502, text: async () => 'Bad Gateway', json: async () => ({}) }; };
  try {
    const x = start(dir);
    const msg = await x.analyze('n.hxx');
    assert.equal(calls, 1);
    assert.match(msg.error[0], /HTTP 502/);
  } finally { global.fetch = real; }
});

test('functions still without code are called from added lines, and what that inlined counts', async () => {
  const dir = makeProject({ 'h.hxx': 'extern inline int gnu(int x) { return x + 1; }\nstatic inline int other(int x) { return x + 2; }\n' });
  const ce = fakeCompilerExplorer(body => {
    const out = [...asmFor(['other(int)', 2])];
    if (body.source.includes('__asm_lens_call_0(int x) { return gnu(x); }')) out.push(...asmFor(['__asm_lens_call_0(int)', 1]));
    return { code: 0, asm: out };
  });
  try {
    const x = start(dir);
    await x.analyze('h.hxx');
    assert.equal(await x.lensAt('h.hxx', 1), '$(symbol-numeric) 2 instructions · g152 · -O2');
    assert.ok(!/used in/.test(await x.lensAt('h.hxx', 1)), 'nobody wrote that call');
    assert.equal(await x.lensAt('h.hxx', 2), '$(symbol-numeric) 2 instructions · g152 · -O2');
  } finally { ce.restore(); }
});

test('remote with compile_commands.json: the entry\'s defines and folders are used; flags in .asm-lens.json win', async () => {
  const dir = makeProject({
    'inc/h.hxx': '#ifdef FROM_DB\nstatic inline int on(int x) { return x; }\n#endif\n',
    'inc/more/m.h': '#pragma once\n',
    'src/a.cpp': '#include "../inc/h.hxx"\n#include "m.h"\n',
    'compile_commands.json': '[]'
  }, { flags: '-O2 -std=c++20', compileCommands: 'compile_commands.json', compilers: [{ id: 'g152', name: 'g152' }] });
  require('fs').writeFileSync(path.join(dir, 'compile_commands.json'), JSON.stringify([{ directory: dir, file: 'src/a.cpp', command: 'g++ -DFROM_DB "-DNAME=a b" -Iinc/more -std=c++11 -O0 -Wall -mavx2 -c src/a.cpp -o a.o' }]));
  const ce = fakeCompilerExplorer(body => ({ code: 0, asm: /-DFROM_DB/.test(body.options.userArguments) ? asmFor(['on(int)', 2]) : [] }));
  try {
    const x = start(dir);
    await x.analyze('inc/h.hxx');
    const args = ce.requests[0].body.options.userArguments;
    assert.match(args, /-DFROM_DB "-DNAME=a b" -std=c\+\+11 -mavx2 -O2 -std=c\+\+20/);
    assert.ok(!/-O0|-Wall/.test(args), args);
    assert.ok(ce.requests[0].body.files === undefined || !ce.requests[0].body.files.some(f => f.filename.endsWith('a.cpp')), 'the .cpp itself is not uploaded');
    assert.equal(await x.lensAt('inc/h.hxx', 2), '$(symbol-numeric) 2 instructions · g152 · -DFROM_DB "-DNAME=a b" -std=c++11 -mavx2 -O2 -std=c++20');
  } finally { ce.restore(); }
});

test('automatic analyses of a header go straight to what worked, and do not search again on every edit', async () => {
  const dir = makeProject({ 'n.hxx': '#ifdef ON\nstatic inline int a() { return 1; }\n#endif\n#ifdef NEVER\nstatic inline int z() { return 2; }\n#endif\n', 'c.cpp': '#define ON\n#include "n.hxx"\nint c() { return 1; }\n' });
  const ce = fakeCompilerExplorer(body => (body.source.includes('int c()') ? { code: 0, asm: asmFor(['c()', 3]) } : { code: 0, asm: /^#define ON/.test(body.source) ? asmFor(['a()', 2]) : [] }));
  try {
    const x = start(dir);
    await x.analyze('c.cpp');
    await x.settled('n.hxx');
    assert.equal(await x.lensAt('n.hxx', 2), '$(symbol-numeric) 2 instructions · g152 · -O2');
    assert.match(await x.lensAt('n.hxx', 5), /^\$\(info\) Not compiled · inside #ifdef NEVER, which is off in c\.cpp · g152$/);
    const before = ce.requests.length;
    x.edit('n.hxx', 5, 0, 5, 0, ' ');
    for (let i = 0; i < 400 && ce.requests.length === before; i++) await new Promise(r => setTimeout(r, 10));
    await x.settled('n.hxx');
    assert.equal(ce.requests.length, before + 1, 'one compile for the edit');
    assert.match(ce.requests.at(-1).body.source, /^#define ON\n#line 1\n/);
  } finally { ce.restore(); }
});

test('a call added for a function counts as its code wherever the compiler says the instructions are; a real call does not', async () => {
  const dir = makeProject({ 'h.hxx': 'extern inline int gnu(int x) { return x + 1; }\nextern inline int other(int x) { return x + 2; }\n' });
  const ce = fakeCompilerExplorer(body => {
    if (!body.source.includes('__asm_lens_call_')) return { code: 0, asm: [] };
    assert.match(body.source, /__attribute__\(\(used, always_inline\)\) int gnu|extern __attribute__\(\(used, always_inline\)\) inline int gnu|__attribute__\(\(used, always_inline\)\) extern inline int gnu/);
    const lines = body.source.split('\n');
    const line = name => lines.findIndex(l => l.includes(`return ${name}(`)) + 1;
    return { code: 0, asm: [
      // Credited to the line of the call, as GCC on macOS does for a short body.
      { text: '__asm_lens_call_0(int):' }, { text: '        lea eax, [rdi+1]', source: { file: null, line: line('gnu') } }, { text: '        ret', source: { file: null, line: line('gnu') } },
      // Not inlined.
      { text: '__asm_lens_call_1(int):' }, { text: '        jmp other(int)', source: { file: null, line: line('other') } }
    ] };
  });
  try {
    const x = start(dir);
    await x.analyze('h.hxx');
    assert.match(await x.lensAt('h.hxx', 1), /^\$\(symbol-numeric\) 2 instructions/);
    assert.equal(await x.lensAt('h.hxx', 2), '$(warning) No code found · click for details');
  } finally { ce.restore(); }
});
