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
      [1, '$(symbol-numeric) 2 instructions · GCC (selected ID) · -O2'],
      [2, '$(symbol-numeric) 2 instructions · GCC (selected ID) · -O2']
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
    assert.equal(await x.lensAt('a.cpp', 2), '$(symbol-numeric) 2 instructions · GCC (selected ID) · -O2 -I.');
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
    const x = start(dir);
    await x.analyze('src/main.cpp');
    const body = ce.requests[0].body;
    assert.deepEqual(body.files.map(f => f.filename).sort(), ['asm_lens/include/util.hpp', 'asm_lens/src/.asm_lens_keep']);
    assert.match(body.options.userArguments, /-Iasm_lens\/src/);
    assert.equal(await x.lensAt('include/util.hpp', 2), '$(symbol-numeric) 1 inlined instructions · used in 1 function(s) · via main.cpp');
    assert.match(await x.lensAt('include/util.hpp', 3), /No code emitted/);
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
    assert.equal(ce.requests.length, 2);
    assert.match(ce.requests[1].body.source, /^__attribute__\(\(used\)\) inline int a\(\)/);
    assert.match(ce.requests[1].body.source, /\ninline int b\(\)/);
  } finally { ce.restore(); }
});

test('header without code: a message that points at Instantiate…', async () => {
  const dir = makeProject({ 't.hpp': 'template <class T> T id(T x) { return x; }\n' });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: [] }));
  try {
    const x = start(dir);
    const msg = await x.analyze('t.hpp');
    assert.match(msg.info[0], /emitted no code: its functions are templates\. Click "Instantiate…"/);
    const lenses = await x.lenses('t.hpp');
    assert.deepEqual(lenses.map(l => l.title), ['$(info) No code emitted: template not instantiated · GCC (selected ID)', '$(symbol-type-parameter) Instantiate…']);
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
    const x = start(dir);
    await x.instantiate('m.hxx', 5, 'int');
    await x.instantiate('m.hxx', 5, 'int');
    await x.instantiate('m.hxx', 32, 'long');
    const failed = await x.instantiate('m.hxx', 21, 'Nope');
    assert.match(failed.warning[0], /could not instantiate mx::cube<Nope>: 'Nope' was not declared in this scope/);
    const doc = x.open('m.hxx');
    assert.deepEqual(x.ext._internals.instantiationsFor(doc), [{ kind: 'address', expr: 'square<int>' }, { kind: 'class', expr: 'mx::Box<long>', keyword: 'struct' }]);
    const src = ce.requests.at(-1).body.source.split('\n');
    assert.equal(src[34], 'auto __asm_lens_inst_0 = &square<int>;');
    assert.equal(src[35], 'template struct mx::Box<long>;');
    assert.equal(src.length, fixture('headers', 'mathx.hxx').split('\n').length + 3);
    assert.equal(await x.lensAt('m.hxx', 4), '$(symbol-numeric) 2 instructions · GCC (selected ID) · -O2');
    assert.equal(await x.lensAt('m.hxx', 32), '$(symbol-numeric) 2 instructions · GCC (selected ID) · -O2');
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
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: [] }));
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

test('MSVC on Compiler Explorer: functions are found, and no -masm flag is sent (it warns D9002)', async () => {
  const dir = makeProject({ 'a.cpp': 'int one() { return 1; }\nint two() { return 2; }\n' }, { compilers: [{ id: 'vcpp_v19_latest_x64', name: 'x64 msvc' }] });
  const ce = fakeCompilerExplorer(body => /-masm/.test(body.options.userArguments)
    ? { code: 0, stderr: err("cl : Command line warning D9002 : ignoring unknown option '-masm=intel'"), asm: [] }
    : { code: 0, asm: msvcRows });
  try {
    const x = start(dir);
    const msg = await x.analyze('a.cpp');
    assert.match(msg.info[0], /found 2 emitted function bodies/);
    assert.equal(ce.requests[0].body.options.userArguments, '-O2');
    assert.equal(ce.requests[0].body.options.filters.intel, true);
    assert.equal(await x.lensAt('a.cpp', 1), '$(symbol-numeric) 2 instructions · x64 msvc · -O2');
    assert.equal(await x.lensAt('a.cpp', 2), '$(symbol-numeric) 2 instructions · x64 msvc · -O2');
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

test('highlighting: hovering an instruction highlights its line and dims the rest of the function (unless turned off)', async () => {
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
    x.state.webviewHandler({ type: 'highlight', file: 0, line: 2 });
    const decos = byType();
    const line = decos.find(([o]) => o.isWholeLine && o.borderColor);
    const dim = decos.find(([o]) => o.opacity);
    assert.deepEqual(line[1], ['2-2']);
    assert.deepEqual(dim[1], ['0-1', '3-4'], 'the other lines of f() are dimmed');
    x.state.webviewHandler({ type: 'clearHighlight' });
    assert.ok(byType().filter(([o]) => o.opacity || o.borderColor).every(([, r]) => r.length === 0), 'line, token and dim highlights are cleared');
    x.state.settings['asmLens.dimOtherLines'] = false;
    x.state.webviewHandler({ type: 'highlight', file: 0, line: 1 });
    assert.deepEqual(byType().find(([o]) => o.opacity)[1], []);
  } finally { ce.restore(); }
});

test('header with MSVC: functions are kept by taking their address; lines that do not compile are dropped quietly', async () => {
  const dir = makeProject({ 'h.hpp': 'inline int a() { return 1; }\ninline int b(int) { return 2; }\ninline int b(double) { return 3; }\n' }, { compilers: [{ id: 'vcpp_v19_latest_x64', name: 'x64 msvc' }] });
  const ce = fakeCompilerExplorer(body => {
    const lines = body.source.split('\n');
    const bad = lines.findIndex(l => /= &b;/.test(l));
    if (bad >= 0) return { code: 2, stderr: err(`<source>(${bad + 1}): error C3535: cannot deduce type for 'auto' from 'overloaded-function'`) };
    return { code: 0, asm: [{ text: 'int a(void) PROC' }, { text: '        mov eax, 1', source: { file: null, line: 1 } }, { text: '        ret 0', source: { file: null, line: 1 } }, { text: 'int a(void) ENDP' }] };
  });
  try {
    const x = start(dir);
    const msg = await x.analyze('h.hpp');
    assert.equal(ce.requests[0].body.source.split('\n').slice(3).join('|'), 'auto __asm_lens_keep_0 = &a;|auto __asm_lens_keep_1 = &b;|auto __asm_lens_keep_2 = &b;|');
    assert.ok(!/__attribute__/.test(ce.requests[0].body.source));
    assert.deepEqual(msg.warning, [], 'no "could not instantiate" for our own lines');
    assert.equal(await x.lensAt('h.hpp', 1), '$(symbol-numeric) 2 instructions · x64 msvc · -O2');
  } finally { ce.restore(); }
});
