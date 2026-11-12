// Choosing how a file is compiled: one build of compile_commands.json (a file listed for two
// builds), compilers in .asm-lens.json with their own database or entries, and the command edited
// in the assembly view. With every local C++ compiler found here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeProject, start, hasCommand, IS_WIN } = require('../helpers/env');

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
const OFF = name => new RegExp(`inside #ifdef ${name}, which is off`);
// main.cpp lines (1-based)
const L = { both: 2, onlyA: 4, onlyB: 7 };
// api.h lines (1-based)
const H = { twice: 2, apiA: 4, apiB: 7 };

const FILES = {
  'src/main.cpp': '#include "api.h"\nint both(int x) { return api_twice(x) + 1; }\n#ifdef BUILD_A\nint only_a(int x) { return x * 3 + api_a(x); }\n#endif\n#ifdef BUILD_B\nint only_b(int x) { return x * 5 + api_b(x); }\n#endif\n',
  'inc/api.h': '#pragma once\ninline int api_twice(int x) { return x * 2; }\n#ifdef BUILD_A\ninline int api_a(int x) { return x - 1; }\n#endif\n#ifdef BUILD_B\ninline int api_b(int x) { return x + 1; }\n#endif\n'
};

// main.cpp listed twice: a build with -DBUILD_A and one with -DBUILD_B, as one database lists a 32-bit and a 64-bit build.
function entry(dir, cc, define, compiler = cc) {
  return { directory: dir, file: 'src/main.cpp', arguments: [compiler, `-D${define}`, '-Iinc', '-O1', '-c', 'src/main.cpp', '-o', `build/${define}/main.o`] };
}
function project(cc, config = {}, databases = { 'build/compile_commands.json': ['BUILD_A', 'BUILD_B'] }) {
  const dir = makeProject(FILES, { mode: 'local', compileCommands: 'build/compile_commands.json', ...config });
  for (const [rel, defines] of Object.entries(databases)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(defines.map(d => (typeof d === 'string' ? entry(dir, cc, d) : d(dir))), null, 2));
  }
  return dir;
}

const lastCommand = x => x.state.outputLines.filter(l => /^\s+command \(in /.test(l)).at(-1) || '';
const label = (items, text) => items.find(i => i.label === text) || assert.fail(`no item "${text}" in ${items.map(i => i.label).join(' | ')}`);
async function selectCompiler(x, rel, pick) {
  x.vscode._showDocument(x.at(rel));
  let offered;
  x.state.quickPickAnswers.push(items => { offered = items; return pick ? label(items, pick) : undefined; });
  await x.state.commands.get('asmLens.selectCompiler')();
  return offered;
}

for (const cc of localCompilers()) {
  test(`local ${cc}: a file listed for two builds; Select Compiler chooses one, for its headers too`, async () => {
    const x = start(project(cc), { settings: { 'asmLens.reanalyzeOn': 'never' } });
    // Every build, as before: the second fills in what the first has off.
    assert.deepEqual((await x.analyze('src/main.cpp')).error, [], x.state.outputLines.join('\n'));
    for (const line of [L.both, L.onlyA, L.onlyB]) assert.match(await x.lensAt('src/main.cpp', line) || '', COUNT, `line ${line}\n${x.describe('src/main.cpp')}`);

    const offered = await selectCompiler(x, 'src/main.cpp', '-DBUILD_B');
    assert.deepEqual(offered.filter(i => i.buildChoice).map(i => `${i.label} | ${i.description}`), ['$(layers) All builds | active', '-DBUILD_A | 1 entry here', '-DBUILD_B | 1 entry here']);
    assert.ok(x.state.messages.info.some(m => m === 'Asm Lens compiles with the build -DBUILD_B of compile_commands.json.'), x.state.messages.info.join('\n'));
    assert.match(x.state.statusItem.text, /compile_commands -DBUILD_B \(local\)$/);
    assert.match(await x.lensAt('src/main.cpp', L.onlyB) || '', COUNT, x.describe('src/main.cpp'));
    assert.match(await x.lensAt('src/main.cpp', L.onlyA) || '', OFF('BUILD_A'));
    assert.ok(lastCommand(x).includes('-DBUILD_B') && !lastCommand(x).includes('-DBUILD_A'), lastCommand(x));
    assert.ok(x.state.outputLines.some(l => /flags from: compile_commands\.json: its own entry .*, build -DBUILD_B$/.test(l)));

    // The header is compiled the way main.cpp is in that build, and offers the builds of main.cpp.
    assert.deepEqual((await x.analyze('inc/api.h')).error, [], x.state.outputLines.join('\n'));
    assert.match(await x.lensAt('inc/api.h', H.apiB) || '', COUNT, x.describe('inc/api.h'));
    assert.match(await x.lensAt('inc/api.h', H.apiA) || '', OFF('BUILD_A'));
    const forHeader = await selectCompiler(x, 'inc/api.h', '$(layers) All builds');
    assert.deepEqual(forHeader.filter(i => i.buildChoice).map(i => i.label), ['$(layers) All builds', '-DBUILD_A', '-DBUILD_B']);
    assert.match(forHeader.find(i => i.label === '-DBUILD_B').description, /active/);
    // Back to every build.
    assert.match(x.state.statusItem.text, /\$\(chip\) compile_commands \(local\)$/);
    assert.match(await x.lensAt('inc/api.h', H.apiA) || '', COUNT, x.describe('inc/api.h'));
    assert.match(await x.lensAt('inc/api.h', H.apiB) || '', COUNT, x.describe('inc/api.h'));
  });

  test(`local ${cc}: compilers in .asm-lens.json with their own entries, database, or none`, async () => {
    const dir = project(cc, {
      includePaths: ['inc'],
      compilers: [
        { id: 'all', name: 'Every build' },
        { id: 'b', name: 'Build B', entriesWith: '-DBUILD_B' },
        { id: 'not-a', name: 'Not A', entriesWithout: ['-DBUILD_A'] },
        { id: 'only-a-db', name: 'A database', compileCommands: 'build-a/compile_commands.json' },
        { id: 'none', name: 'No database', compileCommands: false, compiler: cc, flags: '-O1 -DBUILD_A' }
      ]
    }, { 'build/compile_commands.json': ['BUILD_A', 'BUILD_B'], 'build-a/compile_commands.json': ['BUILD_A'] });
    const x = start(dir, { settings: { 'asmLens.reanalyzeOn': 'never' } });
    const expect = async (on, off) => {
      assert.match(await x.lensAt('src/main.cpp', on) || '', COUNT, `${on}\n${x.describe('src/main.cpp')}`);
      if (off) assert.match(await x.lensAt('src/main.cpp', off) || '', /inside #ifdef BUILD_[AB], which is off/, x.describe('src/main.cpp'));
    };
    assert.deepEqual((await x.analyze('src/main.cpp')).error, []);
    await expect(L.onlyA); await expect(L.onlyB);
    await selectCompiler(x, 'src/main.cpp', 'Build B');
    await expect(L.onlyB, L.onlyA);
    assert.match(x.state.statusItem.text, /compile_commands -DBUILD_B \(local\)$/);
    await selectCompiler(x, 'src/main.cpp', 'Not A');
    await expect(L.onlyB, L.onlyA);
    await selectCompiler(x, 'src/main.cpp', 'A database');
    await expect(L.onlyA, L.onlyB);
    assert.ok(x.state.outputLines.some(l => /from .*build-a[\\/]compile_commands\.json\)$/.test(l)), 'the compiler\'s own database');
    await selectCompiler(x, 'src/main.cpp', 'No database');
    await expect(L.onlyA, L.onlyB);
    assert.ok(x.state.outputLines.some(l => /flags from: settings from .*\.asm-lens\.json$/.test(l)), 'its own compiler and flags');
    assert.match(x.state.statusItem.text, /\(local\)$/);
    assert.ok(!/compile_commands/.test(x.state.statusItem.text), x.state.statusItem.text);
  });

  test(`local ${cc}: a compiler named in "compilers" runs instead of the database entry's, with the entry's flags`, async () => {
    const dir = project(cc, { compilers: [{ id: 'mine', compiler: cc }] }, { 'build/compile_commands.json': [d => entry(d, cc, 'BUILD_A', 'no-such-compiler-xyz')] });
    const x = start(dir, { settings: { 'asmLens.reanalyzeOn': 'never' } });
    assert.deepEqual((await x.analyze('src/main.cpp')).error, [], x.state.outputLines.join('\n'));
    assert.match(await x.lensAt('src/main.cpp', L.onlyA) || '', COUNT);
    assert.ok(lastCommand(x).includes('-DBUILD_A') && !lastCommand(x).includes('no-such-compiler-xyz'), lastCommand(x));
    assert.match(x.state.statusItem.text, new RegExp(`\\$\\(chip\\) ${path.basename(cc).replace(/\+/g, '\\+')} compile_commands \\(local\\)$`));
  });

  test(`local ${cc}: the command above the assembly can be edited, is kept per file and compiler, and reset`, async () => {
    const dir = project(cc, { compilers: [{ id: 'main', name: 'Main' }, { id: 'second', name: 'Second' }] });
    const x = start(dir, { settings: { 'asmLens.reanalyzeOn': 'never' } });
    const send = message => x.ext._internals.handleWebviewMessage(message);
    assert.deepEqual((await x.analyze('src/main.cpp')).error, []);
    const show = async line => {
      const lens = (await x.lenses('src/main.cpp')).find(l => l.line === line && l.command === 'asmLens.showAssembly');
      await x.state.commands.get('asmLens.showAssembly')(...lens.args);
      return x.state.lastRender();
    };
    // The command of the entry, and what Asm Lens adds to get assembly.
    let shown = await show(L.both);
    assert.equal(shown.command.kind, 'command');
    assert.ok(shown.command.text.startsWith(cc) || shown.command.text.includes(path.basename(cc)), shown.command.text);
    for (const want of ['-DBUILD_A', '-Iinc', '-O1']) assert.ok(shown.command.text.includes(want), `${want} in ${shown.command.text}`);
    for (const unwanted of [' -c', 'main.o', 'src/main.cpp', '-S']) assert.ok(!shown.command.text.includes(unwanted), `${unwanted} not in ${shown.command.text}`);
    for (const want of ['-S', '-g', '-o -', '-x c++ -']) assert.ok(shown.command.added.includes(want), `${want} in ${shown.command.added}`);
    assert.equal(shown.command.cwd, dir);
    assert.equal(shown.command.edited, false);

    // Edited: a command copied from the build, with what only a build needs.
    await send({ type: 'compileWith', text: `${cc} -DBUILD_B -Iinc  -O1 -DEDITED=1\n-c src/main.cpp -o build/x.o -Werror -MD -MF build/x.d` });
    assert.ok(x.state.outputLines.some(l => /left out of the edited command: .*-c.*-o.*-Werror/.test(l)), x.state.outputLines.slice(-20).join('\n'));
    const command = lastCommand(x);
    for (const want of ['-DBUILD_B', '-DEDITED=1']) assert.ok(command.includes(want), `${want} in ${command}`);
    for (const unwanted of ['-DBUILD_A', 'src/main.cpp', 'build/x.o', '-Werror', '-MF']) assert.ok(!command.includes(unwanted), `${unwanted} not in ${command}`);
    assert.ok(!fs.existsSync(path.join(dir, 'build', 'x.o')) && !fs.existsSync(path.join(dir, 'build', 'x.d')));
    shown = x.state.lastRender();
    assert.equal(shown.command.edited, true);
    assert.ok(shown.command.text.includes('-DEDITED=1'), shown.command.text);
    assert.match(await x.lensAt('src/main.cpp', L.onlyB) || '', /^\$\(symbol-numeric\) \d+ instructions · .* · edited command$/);
    assert.match(await x.lensAt('src/main.cpp', L.onlyA) || '', OFF('BUILD_A'), 'only the edited command: no other build fills in');
    assert.match(x.state.statusItem.text, / · edited$/);
    // Kept: a later analysis uses it too.
    await x.analyze('src/main.cpp');
    assert.ok(lastCommand(x).includes('-DEDITED=1'), lastCommand(x));

    // A command that does not run: the old result stays, and the view is told.
    const before = x.analysis('src/main.cpp');
    x.state.webviewMessages.length = 0;
    await send({ type: 'compileWith', text: 'no-such-compiler-xyz -DBUILD_A' });
    assert.equal(x.analysis('src/main.cpp'), before);
    assert.deepEqual(x.state.webviewMessages.filter(m => m.type === 'commandDone'), [{ type: 'commandDone', failed: true }]);
    assert.ok(x.state.messages.error.some(m => /no-such-compiler-xyz/.test(m)), x.state.messages.error.join('\n'));
    await send({ type: 'compileWith', text: `${cc} -DBUILD_B -Iinc -O1 -DEDITED=2` });
    assert.ok(lastCommand(x).includes('-DEDITED=2'), lastCommand(x));

    // Another compiler: the edit was for the first one.
    await selectCompiler(x, 'src/main.cpp', 'Second');
    assert.ok(!lastCommand(x).includes('-DEDITED'), lastCommand(x));
    assert.match(await x.lensAt('src/main.cpp', L.onlyA) || '', COUNT);
    await selectCompiler(x, 'src/main.cpp', 'Main');
    assert.ok(lastCommand(x).includes('-DEDITED=2'), lastCommand(x));

    // Reset: the settings again, every build.
    await show(L.onlyB);
    await send({ type: 'resetCommand' });
    assert.deepEqual(x.state.workspaceState.get('asmLens.editedCommands'), {});
    assert.equal(x.state.lastRender().command.edited, false);
    assert.ok(!lastCommand(x).includes('-DEDITED'), lastCommand(x));
    for (const line of [L.onlyA, L.onlyB]) assert.match(await x.lensAt('src/main.cpp', line) || '', COUNT, x.describe('src/main.cpp'));
    assert.ok(!/edited/.test(x.state.statusItem.text), x.state.statusItem.text);
  });

  test(`local ${cc}: without compile_commands.json the command of the settings is edited the same way`, async () => {
    const dir = makeProject({ 'a.cpp': '#ifdef FAST\nint fast(int x) { return x * 2; }\n#endif\nint plain(int x) { return x + 1; }\n' }, { mode: 'local', compiler: cc, flags: '-O1' });
    const x = start(dir, { settings: { 'asmLens.reanalyzeOn': 'never' } });
    assert.deepEqual((await x.analyze('a.cpp')).error, []);
    const lens = (await x.lenses('a.cpp')).find(l => l.line === 4 && l.command === 'asmLens.showAssembly');
    await x.state.commands.get('asmLens.showAssembly')(...lens.args);
    assert.equal(x.state.lastRender().command.text, `${cc} -O1`);
    assert.equal(x.state.lastRender().command.cwd, dir);
    // Flags only: the compiler stays.
    await x.ext._internals.handleWebviewMessage({ type: 'compileWith', text: '-O2 -DFAST' });
    assert.match(await x.lensAt('a.cpp', 2) || '', COUNT, x.describe('a.cpp'));
    assert.equal(x.state.lastRender().command.text, `${cc} -O2 -DFAST`);
  });
}
