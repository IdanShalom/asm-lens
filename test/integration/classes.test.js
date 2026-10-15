// Functions defined inside classes (and static/inline ones) get their own
// results in a .cpp file, and main is one result even when lambdas and library
// templates share its lines. With every local C++ compiler found here, and
// GCC, Clang and MSVC on Compiler Explorer (recorded responses).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeProject, start, fixture, hasCommand, IS_WIN } = require('../helpers/env');
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

// One result: "N instructions", never "N instantiations" or "N versions".
const ONE = /^\$\(symbol-numeric\) \d+ instructions · /;
// counter.cpp: in-class add/get/unused_twice/helper, out-of-line outOfLine, Point::dot, main.
const COUNTER = { add: 6, get: 7, unused_twice: 8, helper: 9, outOfLine: 15, dot: 17, main: 19 };
// shapes.cpp: Sq's constructor and area() on line 7, main on line 11.
const SHAPES = { ctorAndArea: 7, main: 11 };

async function scenario(config) {
  const dir = makeProject({ 'counter.cpp': fixture('classes', 'counter.cpp'), 'shapes.cpp': fixture('classes', 'shapes.cpp') }, config);
  const x = start(dir);
  assert.deepEqual((await x.analyze('counter.cpp')).error, [], x.state.outputLines.join('\n'));
  for (const [name, line] of Object.entries(COUNTER)) assert.match(await x.lensAt('counter.cpp', line) || '', ONE, `${name}\n${x.describe('counter.cpp')}`);
  assert.deepEqual((await x.analyze('shapes.cpp')).error, [], x.state.outputLines.join('\n'));
  const line7 = (await x.lenses('shapes.cpp')).filter(l => l.line === SHAPES.ctorAndArea && l.command === 'asmLens.showAssembly');
  assert.equal(line7.length, 2, 'the constructor and area()');
  for (const l of line7) assert.match(l.title, ONE, `${l.title}\n${x.describe('shapes.cpp')}`);
  assert.match(await x.lensAt('shapes.cpp', SHAPES.main), ONE, x.describe('shapes.cpp'));
  return x;
}

for (const cc of localCompilers()) {
  test(`local ${cc}: in-class methods have results; main is one result`, async () => {
    await scenario({ mode: 'local', compiler: cc });
  });
}

for (const id of ['g152', 'clang2010', 'vcpp_v19_latest_x64']) {
  test(`remote ${id} (Compiler Explorer): in-class methods have results; main is one result`, async () => {
    const ce = installFetch();
    try {
      const x = await scenario({ compilers: [{ id, name: id }] });
      if (/^vcpp/.test(id)) assert.ok(ce.requests.every(r => !r.body || !/-O2|__attribute__/.test(`${r.body.options.userArguments} ${r.body.source}`)), 'MSVC gets /O2 and no __attribute__');
    } finally { ce.restore(); }
  });
}

// A compiler whose default is C++98 (Apple clang 14): -std=gnu++17 is added when the code needs it.
test('local: a compiler that defaults to C++98 gets -std=gnu++17 when C++11 code fails', { skip: IS_WIN && 'needs a shell script as the compiler' }, async () => {
  const dir = makeProject({ 'a.cpp': 'int f() { auto l = [] { return 1; }; return l(); }\n' }, { mode: 'local' });
  const cc = path.join(dir, 'old-c++');
  fs.writeFileSync(cc, [
    '#!/bin/sh',
    'case "$*" in *--version*) echo "old-c++ 1.0"; exit 0;; esac',
    'cat > /dev/null',
    'case "$*" in *-std=gnu++17*) printf "f():\\n\\t.loc 1 1 0\\n\\tmov eax, 1\\n\\tret\\n"; exit 0;; esac',
    'echo "<stdin>:1:11: warning: \'auto\' type specifier is a C++11 extension [-Wc++11-extensions]" >&2',
    'echo "<stdin>:1:20: error: expected expression" >&2',
    'exit 1'
  ].join('\n') + '\n', { mode: 0o755 });
  const x = start(dir, { settings: { 'asmLens.localCompiler': cc } });
  fs.writeFileSync(path.join(dir, '.asm-lens.json'), JSON.stringify({ mode: 'local', compiler: cc }));
  assert.deepEqual((await x.analyze('a.cpp')).error, [], x.state.outputLines.join('\n'));
  assert.ok(x.state.outputLines.some(l => /defaults to an older C\+\+ standard: added -std=gnu\+\+17/.test(l)), x.state.outputLines.join('\n'));
  assert.match(await x.lensAt('a.cpp', 1), /-std=gnu\+\+17$/);
});
