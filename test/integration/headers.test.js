// The header scenario that used to fail: a .hxx with templates, static inline,
// inline and in-class functions, analyzed on its own, with template
// instantiations, and after analyzing a .cpp that includes it.
// Runs with every local C++ compiler found here, and on Compiler Explorer
// (recorded responses; live with `node test/run.js --remote`).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { normPath } = require('../../src/asm');
const { makeProject, start, fixture, hasCommand, IS_WIN } = require('../helpers/env');
const { installFetch } = require('../helpers/ce-replay');

// Local C++ compilers, without duplicates (on macOS g++ is Apple Clang).
function localCompilers() {
  const seen = new Set();
  const out = [];
  for (const cc of IS_WIN ? ['g++', 'clang++'] : ['g++', 'clang++', 'g++-14', 'g++-13', 'clang++-18']) {
    if (!hasCommand(cc)) continue;
    const id = spawnSync(cc, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout.split('\n')[0];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(cc);
  }
  return out;
}

const COUNT = /^\$\(symbol-numeric\) \d+ instructions · /;
const NOT_INSTANTIATED = /^\$\(info\) No code emitted: template not instantiated/;

// Header lines (1-based) of mathx.hxx
const L = { square: 4, clamp: 7, addInts: 14, mulInts: 16, cube: 21, push: 25, get: 26, twice: 32 };

async function headerScenario(t, config) {
  const dir = makeProject({ 'mathx.hxx': fixture('headers', 'mathx.hxx'), 'user.cpp': fixture('headers', 'user.cpp') }, config);
  const x = start(dir);

  // 1. The header on its own: non-template functions are emitted, templates wait for instantiation.
  const alone = await x.analyze('mathx.hxx');
  assert.deepEqual(alone.error, []);
  assert.match(alone.info[0], /found 4 emitted function bodies/);
  for (const line of [L.addInts, L.mulInts, L.push, L.get]) assert.match(await x.lensAt('mathx.hxx', line), COUNT, `line ${line}`);
  for (const line of [L.square, L.clamp, L.cube, L.twice]) assert.match(await x.lensAt('mathx.hxx', line), NOT_INSTANTIATED, `line ${line}`);
  const instantiateLenses = (await x.lenses('mathx.hxx')).filter(l => l.command === 'asmLens.instantiateTemplate').map(l => l.line);
  assert.deepEqual(instantiateLenses, [L.square, L.clamp, L.cube, L.twice]);

  // 2. Live instantiation with chosen types; a type that does not exist is dropped with the compiler's message.
  assert.deepEqual((await x.instantiate('mathx.hxx', L.square + 1, 'int')).warning, []);
  assert.deepEqual((await x.instantiate('mathx.hxx', L.twice, 'double')).warning, []);
  const bad = await x.instantiate('mathx.hxx', L.cube, 'NoSuchType');
  assert.match(bad.warning[0], /could not instantiate mx::cube<NoSuchType>: .*NoSuchType/);
  assert.match(await x.lensAt('mathx.hxx', L.square), COUNT);
  assert.match(await x.lensAt('mathx.hxx', L.twice), COUNT);
  assert.match(await x.lensAt('mathx.hxx', L.cube), NOT_INSTANTIATED);
  assert.deepEqual(x.ext._internals.instantiationsFor(x.open('mathx.hxx')).map(i => i.expr), ['square<int>', 'mx::Box<double>']);

  // 3. The .cpp that uses the header.
  const cpp = await x.analyze('user.cpp');
  assert.deepEqual(cpp.error, []);
  for (const line of [3, 5, 7, 9, 11]) assert.match(await x.lensAt('user.cpp', line), COUNT, `user.cpp line ${line}`);

  // 4. Back in the header: it shows what user.cpp used (inlined at -O2). Which
  // header lines inlined code is attributed to is the compiler's choice (GCC on
  // arm64 macOS attributes square()'s single instruction to the caller), so
  // each template must show code exactly when some instruction maps into it.
  const analysis = x.analysis('mathx.hxx');
  assert.equal(path.basename(analysis.rootPath), 'user.cpp');
  const headerKey = normPath(x.at('mathx.hxx'));
  let withCode = 0;
  for (const [line, last] of [[L.square, L.square + 1], [L.clamp, L.clamp + 5], [L.cube, L.cube], [L.twice, L.twice]]) {
    const mapped = analysis.functions.some(f => f.instructionRows.some(r => r.ref && r.ref.key === headerKey && r.ref.line >= line - 1 && r.ref.line <= last - 1));
    const lens = await x.lensAt('mathx.hxx', line);
    if (mapped) withCode++;
    assert.match(lens, mapped ? /^\$\(symbol-numeric\) \d+ (inlined )?instructions.* · via user\.cpp$/ : /No code emitted.* · via user\.cpp$/, `line ${line}\n${x.describe('mathx.hxx')}`);
  }
  assert.ok(withCode >= 2, `inlined template code should show in the header\n${x.describe('mathx.hxx')}`);
  for (const line of [L.addInts, L.mulInts, L.push, L.get]) assert.match(await x.lensAt('mathx.hxx', line), /No code emitted/, `line ${line}`);
  // The panel opens on a header template's code.
  const lens = (await x.lenses('mathx.hxx')).find(l => l.line === L.clamp && l.command === 'asmLens.showAssembly');
  await x.state.commands.get('asmLens.showAssembly')(...lens.args);
  assert.match(x.state.webviewHtml, /clamp_to/);
  return x;
}

// At -O0 nothing is inlined: square<int> and square<double> are separate
// functions whose demangled names start with the return type.
async function unoptimizedScenario(t, config) {
  const dir = makeProject({ 'mathx.hxx': fixture('headers', 'mathx.hxx'), 'user.cpp': fixture('headers', 'user.cpp') }, config);
  const x = start(dir);
  assert.deepEqual((await x.analyze('user.cpp')).error, []);
  assert.match(await x.lensAt('mathx.hxx', L.square), /^\$\(symbol-numeric\) 2 instantiations · \d+ \/ \d+ instructions · .* via user\.cpp$/, x.describe('mathx.hxx'));
  for (const line of [L.clamp, L.cube, L.twice]) assert.match(await x.lensAt('mathx.hxx', line), /^\$\(symbol-numeric\) \d+ instructions · .* via user\.cpp$/, `line ${line}`);
  const names = x.analysis('mathx.hxx').functions.map(f => f.name).join('\n');
  if (/\?\?\$square@H@/.test(names)) {
    // Clang for Windows (MSVC names): readable only when llvm-undname is installed.
    assert.ok(!hasCommand('llvm-undname', ['--version']), `llvm-undname is installed but the names were not demangled:\n${names}`);
  } else {
    assert.match(names, /square<int>/);
    assert.match(names, /square<double>/);
    assert.match(names, /cube_int/);
  }
  // The .cpp's own function is not mistaken for the header's cube().
  const cubeLens = await x.lensAt('mathx.hxx', L.cube);
  const cube = x.analysis('mathx.hxx').functions.find(f => /cube<int>|\?\?\$cube@H@/.test(f.name));
  assert.ok(cube && cubeLens.includes(` ${cube.count} instructions`));
}

for (const cc of localCompilers()) {
  test(`local ${cc}: header alone, live instantiation, then the .cpp that uses it`, async t => {
    await headerScenario(t, { mode: 'local', compiler: cc, compilers: [{ id: 'local', flags: '-O2' }] });
  });
  test(`local ${cc}: at -O0 template instantiations in the header are matched by name and location`, async t => {
    await unoptimizedScenario(t, { mode: 'local', compiler: cc, compilers: [{ id: 'local', flags: '-O0' }] });
  });
  test(`local ${cc}: C header with static inline functions; missing headers and failing functions`, async () => {
    const dir = makeProject({
      'util.h': '#ifndef UTIL_H\n#define UTIL_H\nstatic inline int clampi(int v) { return v < 0 ? 0 : v; }\nstatic int twice(int v) { return 2 * v; }\n#endif\n',
      'main.c': '#include "util.h"\n#include "gen/missing.h"\nint ok(int v) { return clampi(v); }\nint bad(void) { return GEN_VALUE; }\n'
    }, { mode: 'local', compiler: cc.replace(/\+\+/, cc.startsWith('clang') ? '' : 'cc').replace(/g\+\+/, 'gcc'), compilers: [{ id: 'local', flags: '-O1' }] });
    const x = start(dir);
    x.vscode._openDocument(x.at('util.h'), 'c');
    x.vscode._openDocument(x.at('main.c'), 'c');
    assert.match((await x.analyze('util.h')).info[0], /found 2 emitted function bodies/);
    assert.match(await x.lensAt('util.h', 3), COUNT);
    assert.match(await x.lensAt('util.h', 4), COUNT);
    const msg = await x.analyze('main.c');
    assert.match(msg.info[0], /found \d+ emitted function bodies .*see the Asm Lens output/);
    assert.match(await x.lensAt('main.c', 3), COUNT);
    assert.match(await x.lensAt('main.c', 4), /Not compiled/);
  });
}

for (const id of ['g152', 'clang1910']) {
  test(`remote ${id} (Compiler Explorer): header alone, live instantiation, then the .cpp that uses it`, async t => {
    const ce = installFetch();
    try { await headerScenario(t, { compilers: [{ id, flags: '-O2 -masm=intel' }] }); } finally { ce.restore(); }
  });
  test(`remote ${id} (Compiler Explorer): at -O0 template instantiations in the header are matched`, async t => {
    const ce = installFetch();
    try { await unoptimizedScenario(t, { compilers: [{ id, flags: '-O0' }] }); } finally { ce.restore(); }
  });
}
