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
  for (const line of [NEEDS.get, NEEDS.scaled]) { assert.match(at(line), CODE, at(line)); assert.ok(!readable || at(line).includes(wrap), at(line)); }
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

for (const cc of localCompilers()) {
  const config = { mode: 'local', compiler: cc, flags: '-O2 -std=c++20' };
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
  test(`remote ${id} (Compiler Explorer): types in capitals, macros around the signature`, remote(() => realWorld(config)));
  if (!msvc) test(`remote ${id} (Compiler Explorer): one function that cannot be emitted costs only that function`, remote(() => emitted(config)));
  test(`remote ${id} (Compiler Explorer): a header takes the flags of each file in compile_commands.json that includes it`, remote(() => database({ compilers: [{ id, name: id }] })));
  test(`remote ${id} (Compiler Explorer): static inline functions in a header show code without a click`, remote(() => staticInline(config, { msvc })));
  test(`remote ${id} (Compiler Explorer): struct templates in a header show code without a click`, remote(() => structTemplates(config)));
  test(`remote ${id} (Compiler Explorer): a header that compiles only after the .cpp's own lines`, remote(() => needsIncluder(config, 'needs_direct.cpp', 'Wrap<long>')));
  test(`remote ${id} (Compiler Explorer): the same through another header`, remote(() => needsIncluder(config, 'needs_indirect.cpp', 'Wrap<int>')));
}
