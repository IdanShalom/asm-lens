// Local mode with compile_commands.json, and syntax flags chosen per compiler,
// with every local C++ compiler found here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeProject, start, hasCommand, IS_WIN } = require('../helpers/env');
const { isX86 } = require('../../src/flags');

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

const COUNT = /^\$\(symbol-numeric\) \d+ instructions · /;

function databaseProject(cc, { value = 'VALUE=7' } = {}) {
  const dir = makeProject({
    'src/main.cpp': '#include "api.h"\nint compute(int x) {\n  int unused = 0;\n  return api_scale(x) + VALUE + EXTRA;\n}\n',
    'inc/api.h': '#pragma once\n#ifndef VALUE\n#error "VALUE must be defined (it comes from compile_commands.json)"\n#endif\ninline int api_scale(int x) { return x * VALUE; }\n',
    'lib/other/lonely.h': '#pragma once\n#ifndef VALUE\n#error "VALUE must be defined"\n#endif\ninline int lonely(int x) { return x + VALUE; }\n'
  }, {
    mode: 'local',
    compiler: 'definitely-not-a-compiler',          // proves the entry's compiler is used
    compileCommands: 'build/compile_commands.json',
    compilers: [{ id: 'local', extraFlags: '-DEXTRA=3' }]
  });
  writeDatabase(dir, cc, value);
  return dir;
}

function writeDatabase(dir, cc, value) {
  fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
  const db = path.join(dir, 'build', 'compile_commands.json');
  const args = [cc, ...(value ? [`-D${value}`] : []), '-Iinc', '-Wall', '-Werror', '-MD', '-MF', 'build/main.d', '-c', 'src/main.cpp', '-o', 'build/main.o'];
  fs.writeFileSync(db, JSON.stringify([{ directory: dir, file: 'src/main.cpp', arguments: args }], null, 2));
  const later = new Date(Date.now() + Math.floor(Math.random() * 100000) + 5000);
  fs.utimesSync(db, later, later);
}

function lastCommand(x) {
  return x.state.outputLines.filter(l => /^\s+command \(in /.test(l)).at(-1) || '';
}

for (const cc of localCompilers()) {
  const target = spawnSync(cc, ['-dumpmachine'], { encoding: 'utf8', windowsHide: true }).stdout.trim();

  test(`compile_commands.json with ${cc}: the file's own entry (compiler, flags, folder), filtered`, async () => {
    const dir = databaseProject(cc);
    const x = start(dir);
    const msg = await x.analyze('src/main.cpp');
    assert.deepEqual(msg.error, [], x.state.outputLines.join('\n'));
    assert.match(await x.lensAt('src/main.cpp', 2), COUNT);
    assert.ok(x.state.outputLines.some(l => /flags from: compile_commands\.json: its own entry/.test(l)));
    const command = lastCommand(x);
    for (const want of ['-DVALUE=7', '-Iinc', '-DEXTRA=3', '-S', '-g', '-o -', '-w', '-x c++ -']) assert.ok(command.includes(want), `${want} in ${command}`);
    for (const unwanted of ['-Werror', ' -c ', 'build/main.o', '-MF', '-MD', 'src/main.cpp']) assert.ok(!command.includes(unwanted), `${unwanted} not in ${command}`);
    assert.ok(command.includes(`(in ${dir})`), 'runs in the entry\'s directory');
    assert.equal(fs.existsSync(path.join(dir, 'build', 'main.o')), false);
    assert.equal(fs.existsSync(path.join(dir, 'build', 'main.d')), false);
    // Intel syntax on x86 in the form this compiler takes; nothing for other targets.
    if (isX86(target)) {
      assert.ok(/-masm=intel|-mllvm -x86-asm-syntax=intel/.test(command), command);
      const text = x.analysis('src/main.cpp').functions.flatMap(f => f.instructionRows.map(r => r.text)).join('\n');
      assert.ok(!/%[re]?[a-z]{2}\b/.test(text), `Intel syntax expected:\n${text}`);
    } else {
      assert.ok(!/-masm|x86-asm-syntax/.test(command), command);
    }
  });

  test(`compile_commands.json with ${cc}: headers use the entry of a file that includes them, or the nearest one`, async () => {
    const dir = databaseProject(cc);
    const x = start(dir);
    assert.deepEqual((await x.analyze('inc/api.h')).error, [], x.state.outputLines.join('\n'));
    assert.ok(x.state.outputLines.some(l => /entry of main\.cpp, which includes it/.test(l)));
    assert.match(await x.lensAt('inc/api.h', 5), COUNT);
    assert.deepEqual((await x.analyze('lib/other/lonely.h')).error, [], x.state.outputLines.join('\n'));
    assert.ok(x.state.outputLines.some(l => /entry of main\.cpp in the nearest folder/.test(l)));
  });

  test(`compile_commands.json with ${cc}: a changed database is read again; Reload Compile Commands`, async () => {
    const dir = databaseProject(cc);
    const x = start(dir);
    assert.deepEqual((await x.analyze('src/main.cpp')).error, []);
    writeDatabase(dir, cc, '');
    assert.match((await x.analyze('src/main.cpp')).error[0] || '', /VALUE must be defined/);
    writeDatabase(dir, cc, 'VALUE=9');
    x.vscode._showDocument(x.at('src/main.cpp'));
    await x.state.commands.get('asmLens.reloadCompileCommands')();
    assert.ok(x.state.messages.info.some(m => /loaded 1 entries from build\/compile_commands\.json/.test(m)), x.state.messages.info.join('\n'));
    assert.ok(lastCommand(x).includes('-DVALUE=9'), lastCommand(x));
  });

  test(`local ${cc}: the default flags (-O2 -masm=intel) work on any target; -masm is chosen per compiler`, async () => {
    const dir = makeProject({ 'a.cpp': 'int f(int x) { return x * 3; }\n' }, { mode: 'local', compiler: cc });
    const x = start(dir);
    const msg = await x.analyze('a.cpp');
    assert.deepEqual(msg.error, [], x.state.outputLines.join('\n'));
    assert.match(await x.lensAt('a.cpp', 1), /^\$\(symbol-numeric\) \d+ instructions · \S+ \(local\) · -O2$/);
    const command = lastCommand(x);
    assert.equal(/-masm=intel|x86-asm-syntax=intel/.test(command), isX86(target), command);
  });
}

test('compile_commands.json: entries for a compiler that is not installed are reported clearly', async () => {
  const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\n' }, { mode: 'local', compileCommands: 'cc.json' });
  fs.writeFileSync(path.join(dir, 'cc.json'), JSON.stringify([{ directory: dir, file: 'a.cpp', command: 'no-such-compiler-xyz -c a.cpp' }]));
  const x = start(dir);
  assert.match((await x.analyze('a.cpp')).error[0], /"no-such-compiler-xyz" was not found/);
});

test('compile_commands.json: an MSVC entry gets a clear message (local mode needs GCC or Clang)', async () => {
  const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\n' }, { mode: 'local', compileCommands: ['missing.json', 'cc.json'] });
  fs.writeFileSync(path.join(dir, 'cc.json'), JSON.stringify([{ directory: dir, file: 'a.cpp', command: `"${process.execPath}" /c a.cpp`, }]));
  // Pretend node is cl.exe: the kind comes from the name, so use a copy named cl.
  const cl = path.join(dir, IS_WIN ? 'cl.exe' : 'cl');
  fs.copyFileSync(process.execPath, cl);
  fs.writeFileSync(path.join(dir, 'cc.json'), JSON.stringify([{ directory: dir, file: 'a.cpp', arguments: [cl, '/c', 'a.cpp'] }]));
  const x = start(dir);
  assert.match((await x.analyze('a.cpp')).error[0], /MSVC-style compiler, which local mode does not support/);
  assert.ok(x.state.outputLines.some(l => /missing\.json was not found/.test(l)), 'a missing database is logged');
});
