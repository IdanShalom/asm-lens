const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cc = require('../../src/compileCommands');
const { makeProject } = require('../helpers/env');

function project() {
  return makeProject({
    'src/main.cpp': '#include "util/api.h"\n#include <vector>\nint main() { return 0; }\n',
    'src/other.cpp': '#include "local.h"\n',
    'src/local.h': '',
    'src/util/api.h': '#pragma once\n',
    'src/util/detail.h': '',
    'lib/deep/thing.cpp': '',
    'lib/deep/thing.h': '',
    'tools/x.h': '',
    'build/compile_commands.json': JSON.stringify([
      { directory: '..', file: 'src/main.cpp', arguments: ['g++', '-DA', '-c', 'src/main.cpp'] },
      { directory: '.', file: '../src/other.cpp', command: 'g++ -DB -c ../src/other.cpp' },
      { directory: '..', file: 'lib/deep/thing.cpp', command: 'clang++ -DC -c lib/deep/thing.cpp' },
      { directory: '..', file: 'src/main.cpp', arguments: ['g++', '-DDUPLICATE', '-c', 'src/main.cpp'] },
      { directory: '..', file: 'bad.cpp' },
      'not an entry'
    ])
  });
}

test('loadDatabase: entries with arguments or command; paths resolved against "directory" and the file', async () => {
  const dir = project();
  const db = await cc.loadDatabase(path.join(dir, 'build', 'compile_commands.json'));
  assert.equal(db.error, undefined);
  assert.equal(db.entries.length, 4, 'entries without a command are skipped');
  assert.equal(db.entries[0].directory, dir);
  assert.equal(db.entries[0].file, path.join(dir, 'src', 'main.cpp'));
  assert.equal(db.entries[1].directory, path.join(dir, 'build'));
  assert.equal(db.entries[1].file, path.join(dir, 'src', 'other.cpp'));
  assert.deepEqual(db.byFile.get(require('../../src/asm').normPath(path.join(dir, 'src', 'main.cpp'))).arguments, ['g++', '-DA', '-c', 'src/main.cpp'], 'the first entry of a file wins');
});

test('loadDatabase: missing and malformed files are reported, not thrown', async () => {
  const dir = makeProject({ 'broken.json': '{ nope', 'object.json': '{}' });
  assert.match((await cc.loadDatabase(path.join(dir, 'missing.json'))).error, /was not found/);
  assert.match((await cc.loadDatabase(path.join(dir, 'broken.json'))).error, /Could not read/);
  assert.match((await cc.loadDatabase(path.join(dir, 'object.json'))).error, /JSON array/);
  const merged = await cc.loadDatabases([path.join(dir, 'missing.json')]);
  assert.equal(merged.entries.length, 0);
  assert.equal(merged.errors.length, 1);
});

test('loadDatabase: reloaded when the file changes', async () => {
  const dir = project();
  const file = path.join(dir, 'build', 'compile_commands.json');
  assert.equal((await cc.loadDatabase(file)).entries.length, 4);
  fs.writeFileSync(file, JSON.stringify([{ directory: dir, file: 'src/main.cpp', command: 'g++ -c src/main.cpp' }]));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.equal((await cc.loadDatabase(file)).entries.length, 1);
});

test('entryFor: own entry, then a known includer, then a source that includes it, then the nearest folder', async () => {
  cc.reload();
  const dir = project();
  const db = await cc.loadDatabases([path.join(dir, 'build', 'compile_commands.json')]);
  const at = p => path.join(dir, ...p.split('/'));
  const pick = async (file, opts) => { const r = await cc.entryFor(db, at(file), opts); return r && [path.relative(dir, r.entry.file).replace(/\\/g, '/'), r.reason]; };
  assert.deepEqual(await pick('src/main.cpp'), ['src/main.cpp', 'its own entry']);
  assert.deepEqual(await pick('src/local.h', { includedBy: [at('lib/deep/thing.cpp')] }), ['lib/deep/thing.cpp', 'the entry of thing.cpp, which includes it']);
  assert.deepEqual(await pick('src/util/api.h'), ['src/main.cpp', 'the entry of main.cpp, which includes it']);
  assert.deepEqual(await pick('src/local.h'), ['src/other.cpp', 'the entry of other.cpp, which includes it']);
  assert.deepEqual(await pick('lib/deep/thing.h'), ['lib/deep/thing.cpp', 'the entry of thing.cpp in the same folder']);
  assert.deepEqual(await pick('src/util/detail.h'), ['src/main.cpp', 'the entry of main.cpp in the nearest folder']);
  assert.equal(await cc.entryFor({ entries: [], byFile: new Map() }, at('tools/x.h')), undefined, 'no database entries: the settings are used');
});

test('includes: relative includes, includes through include paths, other files with the same name', () => {
  const from = path.resolve('/p/src/main.cpp');
  assert.equal(cc.includes('#include "util/api.h"\n', from, path.resolve('/p/src/util/api.h')), true);
  assert.equal(cc.includes('#include <proj/api.h>\n', from, path.resolve('/p/include/proj/api.h')), true);
  assert.equal(cc.includes('  #  include "../inc/x.hpp"\n', from, path.resolve('/p/inc/x.hpp')), true);
  assert.equal(cc.includes('#include "api.h"\n', from, path.resolve('/p/other/myapi.h')), false);
  assert.equal(cc.includes('// #include "api.h"\nint x;\n', from, path.resolve('/p/src/zzz.h')), false);
  assert.equal(cc.folderDistance('/a/b', '/a/b'), 0);
  assert.equal(cc.folderDistance('/a/b', '/a/c/d'), 3);
});

test('includersOf: through other headers, with the entry\'s include folders; all that include it', async () => {
  cc.reload();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-lens-cc-'));
  const write = (rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  const target = write('inc/deep/target.hxx', 'static inline int t() { return 1; }\n');
  write('inc/mid.h', '#include <deep/target.hxx>\n');
  write('inc/other.h', 'int nothing;\n');
  write('src/a.cpp', '#include "mid.h"\n');
  write('src/b.cpp', '#include "../inc/deep/target.hxx"\n');
  write('src/c.cpp', '#include "other.h"\n');
  const command = (file, extra = '') => ({ directory: dir, file, command: `g++ -Iinc ${extra} -c ${file}` });
  write('compile_commands.json', JSON.stringify([command('src/c.cpp'), command('src/a.cpp', '-DA'), command('src/b.cpp', '-DB')]));
  const db = await cc.loadDatabases([path.join(dir, 'compile_commands.json')]);
  const found = await cc.includersOf(db, target);
  assert.deepEqual(found.map(e => path.basename(e.file)).sort(), ['a.cpp', 'b.cpp']);
  const match = await cc.entryFor(db, target);
  assert.match(match.reason, /the entry of [ab]\.cpp, which includes it/);
});

test('entriesOf and includersOf: a file listed for two builds, one of each build before a second one of any', async () => {
  cc.reload();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-lens-cc-'));
  const write = (rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  const target = write('h.hxx', 'int x;\n');
  for (let i = 0; i < 6; i++) write(`s${i}.cpp`, '#include "h.hxx"\n');
  const entry = (file, flag) => ({ directory: dir, file, command: `g++ ${flag} -c ${file}` });
  write('a.json', JSON.stringify([0, 1, 2, 3, 4, 5].map(i => entry(`s${i}.cpp`, '-m32'))));
  write('b.json', JSON.stringify([0, 1, 2, 3, 4, 5].map(i => entry(`s${i}.cpp`, '-m64'))));
  const db = await cc.loadDatabases([path.join(dir, 'a.json'), path.join(dir, 'b.json')]);
  assert.equal(db.byFile.get(require('../../src/asm').normPath(path.join(dir, 's0.cpp'))).command.includes('-m32'), true, 'the first database wins for one entry');
  assert.deepEqual(cc.entriesOf(db, path.join(dir, 's0.cpp')).map(e => /-m\d+/.exec(e.command)[0]), ['-m32', '-m64']);
  const found = await cc.includersOf(db, target);
  assert.deepEqual(found.slice(0, 2).map(e => /-m\d+/.exec(e.command)[0]).sort(), ['-m32', '-m64'], 'both builds, though the first one has many files');
  assert.equal(found.length, 4, 'two of each build are enough');
});

test('buildsAmong: what tells each build of a file apart; inBuild and filterDatabase keep only one', async () => {
  cc.reload();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-lens-cc-'));
  const write = (rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  const main = write('main.cpp', '');
  write('other.cpp', '');
  // A 32-bit build, and a 64-bit one written without -m64; both define what every build has.
  write('cc.json', JSON.stringify([
    { directory: dir, file: 'main.cpp', command: 'g++ -m32 -DCOMMON -DWIDE=0 -c main.cpp' },
    { directory: dir, file: 'main.cpp', command: 'g++ -DCOMMON -DWIDE=0 -c main.cpp' },
    { directory: dir, file: 'other.cpp', command: 'g++ -m32 -DCOMMON -DOTHER -c other.cpp' },
    { directory: dir, file: 'other.cpp', command: 'g++ -DCOMMON -DOTHER -c other.cpp' }
  ]));
  const db = await cc.loadDatabases([path.join(dir, 'cc.json')]);
  const builds = cc.buildsAmong(cc.entriesOf(db, main));
  assert.deepEqual(builds.map(b => b.label), ['-m32', 'without -m32']);
  assert.deepEqual(builds.map(b => b.build), [{ with: ['-m32'], without: [] }, { with: [], without: ['-m32'] }]);
  // The same build in another file, whose own defines differ.
  const [b32, b64] = builds.map(b => cc.filterDatabase(db, b.build));
  assert.deepEqual(b32.entries.map(e => path.basename(e.file)), ['main.cpp', 'other.cpp']);
  assert.ok(b32.entries.every(e => e.command.includes('-m32')));
  assert.ok(b64.entries.every(e => !e.command.includes('-m32')) && b64.entries.length === 2);
  assert.ok(b64.byFile.get(require('../../src/asm').normPath(main)).command.startsWith('g++ -DCOMMON'), 'the file\'s entry in that build');
  assert.equal(cc.filterDatabase(db, undefined), db, 'no build: the database as it is');
  assert.equal(cc.filterDatabase(await cc.loadDatabases([path.join(dir, 'cc.json')]), builds[0].build), b32, 'the same view while the database does not change');
  assert.notEqual(b32.stamp, db.stamp, 'its own cache key for includers');
  // One build, or none: nothing to choose.
  assert.deepEqual(cc.buildsAmong(cc.entriesOf(db, main).slice(0, 1)), []);
  assert.deepEqual(cc.buildsAmong([]), []);
  // Builds that differ by database (two build folders with the same flags) or compiler.
  write('b32/compile_commands.json', JSON.stringify([{ directory: dir, file: 'main.cpp', command: 'g++ -DX -c main.cpp' }]));
  write('b64/compile_commands.json', JSON.stringify([{ directory: dir, file: 'main.cpp', command: 'clang++ -DX -c main.cpp' }]));
  const two = await cc.loadDatabases([path.join(dir, 'b32', 'compile_commands.json'), path.join(dir, 'b64', 'compile_commands.json')]);
  const split = cc.buildsAmong(cc.entriesOf(two, main));
  assert.deepEqual(split.map(b => b.label), ['b32/compile_commands.json g++', 'b64/compile_commands.json clang++']);
  assert.ok(cc.inBuild(cc.entriesOf(two, main)[1], split[1].build) && !cc.inBuild(cc.entriesOf(two, main)[0], split[1].build));
  // -D written apart counts like -DNAME.
  assert.ok(cc.inBuild({ directory: dir, file: 'main.cpp', arguments: ['g++', '-D', 'FAST', '-c', 'main.cpp'] }, { with: ['-DFAST'], without: [] }));
});

test('entryFor says what kind of entry it found: own, includer or nearest', async () => {
  cc.reload();
  const dir = project();
  const db = await cc.loadDatabases([path.join(dir, 'build', 'compile_commands.json')]);
  assert.equal((await cc.entryFor(db, path.join(dir, 'src', 'main.cpp'))).kind, 'own');
  assert.equal((await cc.entryFor(db, path.join(dir, 'src', 'util', 'api.h'))).kind, 'includer');
  assert.equal((await cc.entryFor(db, path.join(dir, 'tools', 'x.h'))).kind, 'nearest');
});
