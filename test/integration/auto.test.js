// A header opened after the .cpp that includes it was analyzed: no click, and
// every function shows code. static inline functions in all their spellings,
// struct templates with the types the .cpp uses (else int), friend functions,
// requires clauses, and headers that compile only after the .cpp's own includes.
// With every local C++ compiler found here, and GCC, Clang and MSVC on Compiler
// Explorer (recorded responses; live with `node test/run.js --remote`).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeProject, start, FIXTURES, hasCommand, IS_WIN } = require('../helpers/env');
const { installFetch } = require('../helpers/ce-replay');

function localCompilers() {
  const seen = new Set();
  return (IS_WIN ? ['g++', 'clang++'] : ['g++', 'clang++', 'g++-14']).filter(cc => {
    if (!hasCommand(cc)) return false;
    const id = spawnSync(cc, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout.split('\n')[0];
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function files(...names) {
  const out = {};
  for (const n of names) out[n] = fs.readFileSync(path.join(FIXTURES, 'auto', n), 'utf8');
  return out;
}

const CODE = /^\$\(symbol-numeric\) \d+ (?:inlined )?instructions|^\$\(symbol-numeric\) \d+ instantiations/;
const main = all => all.filter(l => !l.title.endsWith('Instantiate…') && l.command !== 'asmLens.manageInstantiations');

// Lines of forms.hxx
const OFF = 39;
const ATTRIBUTES = [16, 18, 19];         // use __attribute__, which MSVC rejects
const LINES = [8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27, 28, 31, 32, 33, 36];

async function staticInline(config, { msvc = false } = {}) {
  const x = start(makeProject(files('forms.hxx', 'tmpl.hxx', 'user.cpp'), config));
  assert.deepEqual((await x.analyze('user.cpp')).error, [], x.state.outputLines.join('\n'));
  const lenses = main(await x.settled('forms.hxx'));
  for (const line of LINES) {
    const title = lenses.find(l => l.line === line)?.title || '';
    if (msvc && ATTRIBUTES.includes(line)) assert.match(title, /Not compiled/, `line ${line}`);
    else assert.match(title, CODE, `line ${line}: ${title}\n${x.state.outputLines.slice(-10).join('\n')}`);
  }
  assert.match(lenses.find(l => l.line === OFF).title, /Not compiled · inside #ifdef NOT_DEFINED_HERE, which is off/);
  assert.ok(!lenses.some(l => /not used|never instantiated/.test(l.title)), JSON.stringify(lenses.map(l => l.title)));
}

// Lines of tmpl.hxx, with the instantiation each shows.
const TEMPLATE_LINES = {
  8: 'Box<int>', 9: 'Box<int>', 10: 'Box<int>', 11: 'Box<int>', 12: 'Box<int>', 13: 'Box<int>', 14: 'Box<int>', 15: 'Box<int>',
  17: 'Box<int>', 18: 'Box<int>', 20: 'Box<int>::conv<int>', 23: 'Box<int>', 27: 'Box<int>',
  33: 'Arr<int', 34: 'Arr<int', 35: 'Arr<int',
  42: 'Pair<int', 43: 'Pair<int',
  49: 'Vec<int>', 50: 'Vec<int>', 51: 'Vec<int>',
  55: 'Base<int>', 59: 'Derived<int>', 65: 'Constrained<int>', 68: 'tfree<int>'
};
const FRIEND = 19;

async function structTemplates(config) {
  const x = start(makeProject(files('forms.hxx', 'tmpl.hxx', 'user.cpp'), config));
  assert.deepEqual((await x.analyze('user.cpp')).error, [], x.state.outputLines.join('\n'));
  const lenses = main(await x.settled('tmpl.hxx'));
  // Clang for Windows writes MSVC names, readable only when llvm-undname is installed.
  const readable = !x.ext._internals.analysesFor(x.open('tmpl.hxx')).some(a => a.functions.some(f => /^"?\?/.test(f.name)));
  for (const [line, name] of Object.entries(TEMPLATE_LINES)) {
    const title = lenses.find(l => l.line === Number(line))?.title || '';
    assert.match(title, CODE, `line ${line}: ${title}\n${x.state.outputLines.slice(-10).join('\n')}`);
    assert.ok(!readable || title.includes(name) || /via user\.cpp/.test(title), `line ${line}: ${title}`);
  }
  assert.match(lenses.find(l => l.line === FRIEND).title, /^\$\(symbol-numeric\) \d+ /, 'a friend function, which only a call makes the compiler emit');
  assert.ok(!lenses.some(l => /not instantiated|not used/.test(l.title)), JSON.stringify(lenses.map(l => l.title)));
}

// Lines of needs.hxx, which has no includes of its own.
const NEEDS = { px: 3, always: 4, featured: 6, never: 9, get: 15, scaled: 16 };

async function needsIncluder(config, root, wrap, { first = false } = {}) {
  const names = ['needs.hxx', 'sub/types.h', root, ...(root === 'needs_indirect.cpp' ? ['needs_mid.h'] : [])];
  const x = start(makeProject(files(...names), config));
  if (!first) assert.deepEqual((await x.analyze(root)).error, [], x.state.outputLines.join('\n'));
  else assert.deepEqual((await x.analyze('needs.hxx')).error, [], 'the .cpp is found in the workspace');
  const lenses = main(await x.settled('needs.hxx'));
  const at = l => lenses.find(k => k.line === l)?.title || '';
  for (const line of [NEEDS.px, NEEDS.always, NEEDS.featured]) assert.match(at(line), CODE, `line ${line}: ${at(line)}\n${x.state.outputLines.slice(-14).join('\n')}`);
  assert.match(at(NEEDS.never), /Not compiled · inside #ifdef NEVER_ON/);
  const readable = !x.ext._internals.analysesFor(x.open('needs.hxx')).some(a => a.functions.some(f => /^"?\?/.test(f.name)));
  // Members compile separately when the class cannot: Wrap<Point*> has get(), though its scaled() does not compile.
  for (const line of [NEEDS.get, NEEDS.scaled]) { assert.match(at(line), CODE, at(line)); assert.ok(!readable || at(line).includes(wrap) || /\d+ instantiations/.test(at(line)), at(line)); }
}

// Lines of realworld.hxx: types in capitals, macros after the parameters and around the type.
const REALWORLD = [11, 12, 13, 14, 15, 16, 18, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29];

async function realWorld(config) {
  const x = start(makeProject(files('realworld.hxx'), config));
  assert.deepEqual((await x.analyze('realworld.hxx')).error, [], x.state.outputLines.join('\n'));
  const lenses = main(await x.lenses('realworld.hxx'));
  for (const line of REALWORLD) assert.match(lenses.find(l => l.line === line)?.title || '(no lens)', CODE, `line ${line}\n${x.state.outputLines.slice(-10).join('\n')}`);
}

// A function that fails only when it is emitted: GCC and Clang.
async function emitted(config) {
  const x = start(makeProject(files('emitted.hxx'), config));
  assert.deepEqual((await x.analyze('emitted.hxx')).error, [], x.state.outputLines.join('\n'));
  const lenses = main(await x.lenses('emitted.hxx'));
  const at = l => lenses.find(k => k.line === l)?.title || '';
  assert.match(at(3), CODE, `the function before it: ${at(3)}\n${x.state.outputLines.slice(-10).join('\n')}`);
  assert.match(at(8), CODE, `the function after it: ${at(8)}`);
  // Clang before 14 does not know this attribute: then it simply compiles.
  assert.match(at(4), /^\$\(warning\) Not compiled · .*cannot be called|^\$\(symbol-numeric\)/, at(4));
  assert.match(at(9), CODE, `gnu_inline has no code of its own, but a call shows it: ${at(9)}`);
}

// compile_commands.json: a header compiled the way the files listed there see it.
function databaseProject(config, compiler = 'g++') {
  const names = ['include/feature.hxx', 'include/mid.h', 'include/config.h', 'src/a.cpp', 'src/b.cpp'];
  const all = {};
  for (const n of names) all[n] = fs.readFileSync(path.join(FIXTURES, 'db', n), 'utf8');
  all['compile_commands.json'] = JSON.stringify([
    { directory: '.', file: 'src/a.cpp', command: `${compiler} -DFEATURE_A -Iinclude -O2 -std=c++17 -c src/a.cpp -o a.o` },
    { directory: '.', file: 'src/b.cpp', command: `${compiler} -DFEATURE_B -Iinclude -O2 -std=c++17 -flto -c src/b.cpp -o b.o` }
  ]);
  return makeProject(all, { ...config, compileCommands: 'compile_commands.json' });
}

async function database(config, compiler) {
  const x = start(databaseProject(config, compiler));
  assert.deepEqual((await x.analyze('include/feature.hxx')).error, [], x.state.outputLines.join('\n'));
  const lenses = main(await x.lenses('include/feature.hxx'));
  const at = l => lenses.find(k => k.line === l)?.title || '';
  for (const [name, line] of [['always', 2], ['only_a', 4], ['only_b', 7], ['from_config', 13]]) assert.match(at(line), CODE, `${name}: ${at(line)}\n${x.state.outputLines.slice(-16).join('\n')}`);
  assert.match(at(10), /Not compiled · inside #ifdef NOWHERE/);
  // A file with an entry of its own, with -flto in it: real assembly anyway.
  assert.deepEqual((await x.analyze('src/b.cpp')).error, []);
  assert.match(await x.lensAt('src/b.cpp', 2), CODE);
}

// A forced include (a precompiled header) that already includes the header, and -Werror.
async function forcedInclude(cc) {
  const dir = makeProject({
    'include/h.hxx': '#pragma once\nstatic inline int one(int x) { return x + 1; }\n',
    'include/pch.h': '#pragma once\n#include "h.hxx"\n',
    'src/a.cpp': 'int a() { return one(1); }\n',
    'compile_commands.json': JSON.stringify([{ directory: '.', file: 'src/a.cpp', command: `${cc} -Iinclude -include pch.h -Winvalid-pch -O2 -std=c++17 -c src/a.cpp` }])
  }, { mode: 'local', compileCommands: 'compile_commands.json' });
  const x = start(dir);
  assert.deepEqual((await x.analyze('include/h.hxx')).error, [], x.state.outputLines.join('\n'));
  assert.match(await x.lensAt('include/h.hxx', 2) || '', CODE, x.state.outputLines.slice(-10).join('\n'));
  assert.ok(x.state.outputLines.some(l => /left out the forced include pch\.h/.test(l)));
}

async function werror(config) {
  const x = start(makeProject({ 'h.hxx': '#pragma once\nstatic inline int unused_var(int x) { int y; return x; }\nstatic inline int two(int x) { return x + 2; }\n' }, config));
  assert.deepEqual((await x.analyze('h.hxx')).error, [], x.state.outputLines.join('\n'));
  assert.match(await x.lensAt('h.hxx', 2) || '', CODE);
  assert.match(await x.lensAt('h.hxx', 3) || '', CODE);
}

// Two builds of the same file; what each has off, the other shows. Real -m32 and -m64 where they work.
async function twoBuilds(config, flagA, flagB, macroA, macroB) {
  const header = `#pragma once\nstatic inline int both(int x) { return x + 1; }\n#ifdef ${macroA}\nstatic inline long only_a(long x) { return x + 2; }\n#endif\n#ifdef ${macroB}\nstatic inline long long only_b(long long x) { return x + 3; }\n#endif\n#if defined(${macroB})\nstatic inline int same(int x) { return x + 6; }\n#else\nstatic inline int same(int x) { return x + 7; }\n#endif\n#ifdef NEVER_DEFINED\nstatic inline int never(int x) { return x; }\n#endif\n`;
  const entry = flag => ({ directory: '.', file: 'u.cpp', command: `${config.cc || 'g++'} ${flag} -O2 -c u.cpp -o u.o` });
  const x = start(makeProject({
    'arch.hxx': header,
    'u.cpp': '#include "arch.hxx"\nint u(int x) { return both(x); }\n',
    'compile_commands.json': JSON.stringify([entry(flagA), entry(flagB)])
  }, { ...config.json, compileCommands: 'compile_commands.json' }));
  assert.deepEqual((await x.analyze('arch.hxx')).error, [], x.state.outputLines.join('\n'));
  const lenses = main(await x.lenses('arch.hxx'));
  const at = l => lenses.find(k => k.line === l)?.title || '';
  for (const line of [2, 4, 7, 10, 12]) assert.match(at(line), CODE, `line ${line}: ${at(line)}\n${x.state.outputLines.slice(-14).join('\n')}`);
  assert.match(at(15), /Not compiled · inside #ifdef NEVER_DEFINED, which is off in all \d+ compile commands tried/);
}

// A member template overloaded through SFINAE, with a return type in a macro that is #undef'd later:
// the plain form works, where a cast copied from the source cannot.
async function sfinaeMacro(config) {
  const text = fs.readFileSync(path.join(FIXTURES, 'templates', 'sfinae.hxx'), 'utf8');
  const x = start(makeProject({ 'sfinae.hxx': text }, config), { settings: { 'asmLens.reanalyzeOn': 'never', 'asmLens.autoInstantiateTemplates': false } });
  for (const [line, type] of [[6, 'int'], [7, 'long long']]) {
    const r = await x.instantiate('sfinae.hxx', line, type, type);
    assert.deepEqual(r.warning, [], x.state.outputLines.slice(-8).join('\n'));
    assert.match(await x.lensAt('sfinae.hxx', line) || '', CODE, `line ${line}: ${await x.lensAt('sfinae.hxx', line)}\n${x.state.outputLines.slice(-8).join('\n')}`);
  }
}

// One member that does not compile for the type must not stop the others.
async function brokenMember(config) {
  const text = fs.readFileSync(path.join(FIXTURES, 'templates', 'broken_member.hxx'), 'utf8');
  const x = start(makeProject({ 'broken_member.hxx': text }, config), { settings: { 'asmLens.reanalyzeOn': 'never', 'asmLens.autoInstantiateTemplates': false } });
  const r = await x.instantiate('broken_member.hxx', 5, 'S');
  assert.deepEqual(r.warning, [], x.state.outputLines.slice(-8).join('\n'));
  const lenses = main(await x.lenses('broken_member.hxx'));
  const at = l => lenses.find(k => k.line === l)?.title || '';
  for (const [name, line] of [['default constructor', 2], ['constructor', 3], ['destructor', 4], ['get', 5], ['at', 7], ['const at', 8]]) assert.match(at(line), /^\$\(symbol-numeric\) \d+ /, `${name}: ${at(line)}\n${x.state.outputLines.slice(-10).join('\n')}`);
  assert.match(at(6), /^\$\(warning\) Box<S>::broken does not compile: .* · click to choose types$/, at(6));
  assert.deepEqual(x.ext._internals.instantiationsFor(x.open('broken_member.hxx')).map(i => i.expr), ['Box<S>']);
}

// An error Clang's notes do not connect to the line that was added: inside the class, or in another header.
async function noChain(config) {
  const text = fs.readFileSync(path.join(FIXTURES, 'templates', 'no_chain.hxx'), 'utf8');
  const x = start(makeProject({ 'no_chain.hxx': text }, config), { settings: { 'asmLens.reanalyzeOn': 'never', 'asmLens.autoInstantiateTemplates': false } });
  const r = await x.instantiate('no_chain.hxx', 4, 'S');
  assert.deepEqual([r.error, r.warning], [[], []], x.state.outputLines.slice(-10).join('\n'));
  const lenses = main(await x.lenses('no_chain.hxx'));
  const at = l => lenses.find(k => k.line === l)?.title || '';
  assert.match(at(4), CODE, `get: ${at(4)}\n${x.state.outputLines.slice(-10).join('\n')}`);
  assert.match(at(5), /^\$\(warning\) Box<S>::broken does not compile: /, at(5));
  for (const line of [8, 9]) assert.match(at(line), CODE, `line ${line}: the file is not at fault: ${at(line)}`);
  assert.ok(!lenses.some(l => /Not compiled/.test(l.title)), JSON.stringify(lenses.map(l => l.title)));
}

async function noChainOtherFile(config) {
  const x = start(makeProject({
    'no_chain_other.hxx': fs.readFileSync(path.join(FIXTURES, 'templates', 'no_chain_other.hxx'), 'utf8'),
    'no_chain_cell.h': fs.readFileSync(path.join(FIXTURES, 'templates', 'no_chain_cell.h'), 'utf8')
  }, config), { settings: { 'asmLens.reanalyzeOn': 'never', 'asmLens.autoInstantiateTemplates': false } });
  await x.analyze('no_chain_other.hxx');
  const r = await x.instantiate('no_chain_other.hxx', 3, 'S');
  assert.deepEqual(r.error, [], `the analysis goes on\n${x.state.outputLines.slice(-10).join('\n')}`);
  const lenses = main(await x.lenses('no_chain_other.hxx'));
  const at = l => lenses.find(k => k.line === l)?.title || '';
  assert.match(at(3), CODE, `get: ${at(3)}\n${x.state.outputLines.slice(-10).join('\n')}`);
  assert.match(at(8), CODE, `a function of the file: ${at(8)}`);
}

// That is not the same as a file that does not compile by itself: its error is still reported.
async function headerWithItsOwnError(config) {
  const x = start(makeProject({
    'h.hxx': '#include "bad.h"\nstatic inline int plain_one(int x) { return x + 1; }\ntemplate <class T> struct B { T b() const { return T{}; } };\n',
    'bad.h': '#pragma once\ninline int bad() { return nope(); }\n'
  }, config), { settings: { 'asmLens.reanalyzeOn': 'never' } });
  const r = await x.analyze('h.hxx');
  const lens = await x.lensAt('h.hxx', 2) || '';
  assert.ok(r.error.length > 0 || /Not compiled|^\$\(symbol-numeric\)/.test(lens), `no error and no result: ${lens}`);
  assert.ok(!/does not compile: .*nope/.test(await x.lensAt('h.hxx', 3) || ''), 'an added line is not blamed for an error of the file');
}

// Types chosen by hand that need what the .cpp includes, or a standard header nobody included.
async function chosenTypes(config) {
  const types = '#pragma once\nstruct Point { int x, y; Point operator+(const Point& o) const { return {x + o.x, y + o.y}; } };\n';
  const tmpl = '#pragma once\n#include <cstddef>\ntemplate <typename T>\nT dot(const T* a, std::size_t n) { T s{}; for (std::size_t i = 0; i < n; ++i) s = s + a[i]; return s; }\ntemplate <typename C>\nauto count(const C& c) { return c.size(); }\ntemplate <typename T>\nstruct Box {\n  T v;\n  T get() const { return v; }\n  template <typename U> U conv() const { return static_cast<U>(1); }\n};\ntemplate <typename T>\nstruct NeedsType { typename T::value_type first(const T& c) const { return *c.begin(); } };\n';
  const x = start(makeProject({ 'tmpl.hxx': tmpl, 'types.h': types, 'u.cpp': '#include "tmpl.hxx"\n#include "types.h"\nint u() { Box<Point> b{}; return b.get().x; }\n' }, config));
  const lens = async l => main(await x.settled('tmpl.hxx')).find(k => k.line === l)?.title || '';
  assert.deepEqual((await x.analyze('u.cpp')).error, [], x.state.outputLines.join('\n'));
  await x.settled('tmpl.hxx');
  // Clang for Windows writes MSVC names, readable only when llvm-undname is installed: code, but no name to show.
  const readable = () => !x.ext._internals.analysesFor(x.open('tmpl.hxx')).some(a => a.functions.some(f => /^"?\?/.test(f.name)));
  assert.match(await lens(10), readable() ? /^\$\(symbol-numeric\).*Box<Point>/ : CODE, `the type the .cpp uses: ${await lens(10)}`);
  assert.match(await lens(11), CODE, `a member template of it: ${await lens(11)}`);
  assert.match(await lens(14), /^\$\(warning\) NeedsType<int>(?:::first)? does not compile: .* · click to choose types$/, await lens(14));
  // A lens sits on the first line of the definition: `template <...>` for these two.
  for (const [line, at, type, name] of [[6, 5, 'std::vector<int>', 'count'], [4, 3, 'Point', 'dot'], [14, 14, 'std::vector<int>', 'NeedsType']]) {
    assert.deepEqual((await x.instantiate('tmpl.hxx', line, type)).warning, [], `${name}<${type}>\n${x.state.outputLines.slice(-10).join('\n')}`);
    assert.match(await lens(at), CODE, `${name}<${type}>: ${await lens(at)}\n${x.state.outputLines.slice(-10).join('\n')}`);
    assert.ok(!readable() || (await lens(at)).includes(name), await lens(at));
  }
  assert.deepEqual(x.ext._internals.instantiationsFor(x.open('tmpl.hxx')).map(i => i.expr).sort(), ['NeedsType<std::vector<int>>', 'count<std::vector<int>>', 'dot<Point>']);
}

for (const cc of localCompilers()) {
  const config = { mode: 'local', compiler: cc, flags: '-O2 -std=c++20' };
  test(`local ${cc}: an added class the compiler's notes do not name`, () => noChain({ mode: 'local', compiler: cc, flags: '-O2 -std=c++17' }));
  test(`local ${cc}: the same, with the error in another header`, () => noChainOtherFile({ mode: 'local', compiler: cc, flags: '-O2 -std=c++17' }));
  test(`local ${cc}: a file that does not compile by itself still reports its error`, () => headerWithItsOwnError({ mode: 'local', compiler: cc, flags: '-O2 -std=c++17' }));
  test(`local ${cc}: a member template overloaded through SFINAE, with a macro that is gone`, () => sfinaeMacro({ mode: 'local', compiler: cc, flags: '-O2 -std=c++17' }));
  test(`local ${cc}: one member that does not compile costs only itself`, () => brokenMember({ mode: 'local', compiler: cc, flags: '-O2 -std=c++17' }));
  test(`local ${cc}: two builds of a file in compile_commands.json`, () => twoBuilds({ cc, json: { mode: 'local' } }, '-DBUILD_A', '-DBUILD_B', 'BUILD_A', 'BUILD_B'));
  if (process.platform === 'linux' && process.arch === 'x64') test(`local ${cc}: real -m32 and -m64 builds`, () => twoBuilds({ cc, json: { mode: 'local' } }, '-m32', '-m64', '__i386__', '__x86_64__'));
  test(`local ${cc}: chosen types that need the .cpp's includes or a standard header`, () => chosenTypes(config));
  test(`local ${cc}: a forced include that already includes the header is left out`, () => forcedInclude(cc));
  test(`local ${cc}: -Wall -Werror does not stop a header`, () => werror({ mode: 'local', compiler: cc, flags: '-O2 -std=c++17 -Wall -Wextra -Werror' }));
  test(`local ${cc}: types in capitals, macros around the signature`, () => realWorld(config));
  test(`local ${cc}: one function that cannot be emitted costs only that function`, () => emitted(config));
  test(`local ${cc}: a header takes the compile command of each file in compile_commands.json that includes it`, () => database({ mode: 'local' }, cc));
  test(`local ${cc}: static inline functions in a header show code without a click`, () => staticInline(config));
  test(`local ${cc}: struct templates in a header show code without a click`, () => structTemplates(config));
  test(`local ${cc}: a header that compiles only after the .cpp's own lines`, () => needsIncluder(config, 'needs_direct.cpp', 'Wrap<long>'));
  test(`local ${cc}: the same through another header`, () => needsIncluder(config, 'needs_indirect.cpp', 'Wrap<int>'));
  test(`local ${cc}: the same when only the header is analyzed`, () => needsIncluder(config, 'needs_direct.cpp', 'Wrap<int>', { first: true }));
}

for (const id of ['g152', 'clang2010', 'vcpp_v19_latest_x64']) {
  const config = { flags: '-O2 -std=c++20', compilers: [{ id, name: id }] };
  const msvc = /^vcpp/.test(id);
  const remote = fn => async () => { const ce = installFetch(); try { await fn(); } finally { ce.restore(); } };
  test(`remote ${id} (Compiler Explorer): an added class the compiler's notes do not name`, remote(() => noChain({ flags: '-O2 -std=c++17', compilers: [{ id, name: id }] })));
  test(`remote ${id} (Compiler Explorer): the same, with the error in another header`, remote(() => noChainOtherFile({ flags: '-O2 -std=c++17', compilers: [{ id, name: id }] })));
  test(`remote ${id} (Compiler Explorer): a member template overloaded through SFINAE, with a macro that is gone`, remote(() => sfinaeMacro({ flags: '-O2 -std=c++17', compilers: [{ id, name: id }] })));
  test(`remote ${id} (Compiler Explorer): one member that does not compile costs only itself`, remote(() => brokenMember({ flags: '-O2 -std=c++17', compilers: [{ id, name: id }] })));
  test(`remote ${id} (Compiler Explorer): types in capitals, macros around the signature`, remote(() => realWorld(config)));
  test(`remote ${id} (Compiler Explorer): two builds of a file in compile_commands.json`, remote(() => twoBuilds({ json: { compilers: [{ id, name: id }] } }, '-DBUILD_A', '-DBUILD_B', 'BUILD_A', 'BUILD_B')));
  test(`remote ${id} (Compiler Explorer): chosen types that need the .cpp's includes or a standard header`, remote(() => chosenTypes(config)));
  if (!msvc) test(`remote ${id} (Compiler Explorer): one function that cannot be emitted costs only that function`, remote(() => emitted(config)));
  test(`remote ${id} (Compiler Explorer): a header takes the flags of each file in compile_commands.json that includes it`, remote(() => database({ compilers: [{ id, name: id }] })));
  test(`remote ${id} (Compiler Explorer): static inline functions in a header show code without a click`, remote(() => staticInline(config, { msvc })));
  test(`remote ${id} (Compiler Explorer): struct templates in a header show code without a click`, remote(() => structTemplates(config)));
  test(`remote ${id} (Compiler Explorer): a header that compiles only after the .cpp's own lines`, remote(() => needsIncluder(config, 'needs_direct.cpp', 'Wrap<long>')));
  test(`remote ${id} (Compiler Explorer): the same through another header`, remote(() => needsIncluder(config, 'needs_indirect.cpp', 'Wrap<int>')));
}
