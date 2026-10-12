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
      [1, '$(symbol-numeric) 2 instructions · GCC (selected ID) · -O2 -masm=intel'],
      [2, '$(symbol-numeric) 2 instructions · GCC (selected ID) · -O2 -masm=intel']
    ]);
    await x.state.commands.get('asmLens.showAssembly')(x.vscode.Uri.file(x.at('a.cpp')), 'two', 1);
    assert.match(x.state.webviewHtml, /two — 2 instructions/);
    assert.match(x.state.webviewHtml, /mov eax, 1/);
    const hover = x.state.hoverProviders[0].provider.provideHover(x.open('a.cpp'), new x.vscode.Position(0, 5));
    assert.match(hover.contents.value, /\*\*one\*\* — 2 instructions/);
    const body = ce.requests.at(-1).body;
    assert.equal(body.lang, 'c++');
    assert.equal(body.options.userArguments, '-O2 -masm=intel');
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
    assert.equal(await x.lensAt('a.cpp', 2), '$(symbol-numeric) 2 instructions · GCC (selected ID) · -O2 -masm=intel -I.');
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
    assert.equal(await x.lensAt('m.hxx', 4), '$(symbol-numeric) 2 instructions · GCC (selected ID) · -O2 -masm=intel');
    assert.equal(await x.lensAt('m.hxx', 32), '$(symbol-numeric) 2 instructions · GCC (selected ID) · -O2 -masm=intel');
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

test('editing a file invalidates the analyses that used it', async () => {
  const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\n' });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: asmFor(['f()', 1]) }));
  try {
    const x = start(dir);
    await x.analyze('a.cpp');
    assert.ok(x.analysis('a.cpp'));
    const doc = x.open('a.cpp');
    doc.setText('int f() { return 2; }\n');
    x.state.changeListener({ document: doc, contentChanges: [{}] });
    assert.equal(x.analysis('a.cpp'), undefined);
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

test('header with an MSVC compiler on Compiler Explorer: no __attribute__((used)) is added', async () => {
  const dir = makeProject({ 'h.hpp': 'inline int a() { return 1; }\n' }, { compilers: [{ id: 'vcpp_v19_latest_x64', name: 'x64 msvc v19.latest' }] });
  const ce = fakeCompilerExplorer(() => ({ code: 0, asm: [] }));
  try {
    const x = start(dir);
    await x.analyze('h.hpp');
    assert.equal(ce.requests.length, 1);
    assert.equal(ce.requests[0].body.source, 'inline int a() { return 1; }\n');
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
    const doc = x.open('a.cpp');
    doc.setText('int f() { return 2; }\n');
    x.state.changeListener({ document: doc, contentChanges: [{}] });
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
    const header = x.open('m.hxx');
    header.setText('#pragma once\ninline int h() { return 7; }\n');
    x.state.changeListener({ document: header, contentChanges: [{}] });
    assert.equal(x.analysis('m.hxx'), undefined, 'the edit invalidated the results');
    await x.state.saveListener(header);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(ce.requests.length, 2);
    assert.equal(x.analysis('m.hxx').rootPath, x.at('u.cpp'));
    await x.state.saveListener(x.open('other.hxx'));
    assert.equal(ce.requests.length, 2, 'an unrelated file does not trigger anything');
    x.state.settings['asmLens.reanalyzeOnSave'] = false;
    await x.state.saveListener(x.open('u.cpp'));
    assert.equal(ce.requests.length, 2);
  } finally { ce.restore(); }
});
