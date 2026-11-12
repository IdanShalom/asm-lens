const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pc = require('../../src/projectConfig');
const { makeProject } = require('../helpers/env');

test('parseJsonc: comments, trailing commas, comment-like text inside strings', () => {
  const v = pc.parseJsonc(`{
    // line comment
    "a": "http://x//y", /* block { */ "b": [1, 2,],
    "c": "quote \\" // not a comment",
  }`);
  assert.deepEqual(v, { a: 'http://x//y', b: [1, 2], c: 'quote " // not a comment' });
  assert.throws(() => pc.parseJsonc('{ "a": }'));
});

test('parseJsonc: the template written by "Open or Create Project Config" parses and validates', () => {
  const cfg = pc.normalizeConfig(pc.parseJsonc(pc.TEMPLATE), '/proj');
  assert.deepEqual(cfg.warnings, []);
  assert.equal(cfg.mode, 'remote');
  assert.equal(cfg.compilers[0].id, 'g152');
});

test('normalizeConfig: every key the extension reads, unchanged from earlier versions', () => {
  const base = path.resolve('/proj');
  const cfg = pc.normalizeConfig({
    baseUrl: 'https://ce.example.com/',
    flags: '-O3',
    language: 'cpp',
    maxIncludeFiles: 12.7,
    compilers: ['g152', { id: ' clang1910 ', name: 'Clang', flags: '-O1', language: 'c', defines: ['-DX=1', 'Y'], extraFlags: ['-g', '-Wall'], compiler: 'clang' }],
    includePaths: ['include', { path: 'third_party', recursive: true }, path.resolve('/abs/inc')],
    buildFolders: ['build', 'cmake-build-*'],
    excludePaths: ['vendor'],
    defines: ['-DNDEBUG', 'A=2'],
    extraFlags: '-fno-exceptions',
    uploadSystemHeaders: true,
    mode: 'Local',
    compiler: 'g++-14'
  }, base);
  assert.deepEqual(cfg.warnings, []);
  assert.equal(cfg.baseUrl, 'https://ce.example.com');
  assert.equal(cfg.flags, '-O3');
  assert.equal(cfg.language, 'c++');
  assert.equal(cfg.maxIncludeFiles, 12);
  assert.deepEqual(cfg.compilers, [
    { id: 'g152', name: 'g152' },
    { id: 'clang1910', name: 'Clang', flags: '-O1', language: 'c', defines: ['X=1', 'Y'], extraFlags: '-g -Wall', compiler: 'clang' }
  ]);
  assert.deepEqual(cfg.includePaths, [
    { dir: path.join(base, 'include'), recursive: false },
    { dir: path.join(base, 'third_party'), recursive: true },
    { dir: path.resolve('/abs/inc'), recursive: false }
  ]);
  assert.deepEqual(cfg.buildFolders, ['build', 'cmake-build-*']);
  assert.deepEqual(cfg.excludePaths, ['vendor']);
  assert.deepEqual(cfg.defines, ['NDEBUG', 'A=2']);
  assert.equal(cfg.extraFlags, '-fno-exceptions');
  assert.equal(cfg.uploadSystemHeaders, true);
  assert.equal(cfg.mode, 'local');
  assert.equal(cfg.compiler, 'g++-14');
});

test('normalizeConfig: languages and per-compiler mode for other languages', () => {
  const cfg = pc.normalizeConfig({ compilers: [
    { id: 'r1990', language: 'Rust', mode: 'remote' },
    { id: 'py', language: 'py', mode: 'local', compiler: 'python3.12' },
    { id: 'go', language: 'golang' },
    { id: 'x', language: 'cobol' },
    { id: 'm', mode: 'cloud' }
  ] }, '/p');
  assert.deepEqual(cfg.compilers.map(c => [c.id, c.language, c.mode]), [['r1990', 'rust', 'remote'], ['py', 'python', 'local'], ['go', 'go', undefined], ['x', undefined, undefined], ['m', undefined, undefined]]);
  assert.equal(cfg.warnings.length, 2);
  assert.match(cfg.warnings[0], /compilers\[3\].*cobol/);
  assert.match(cfg.warnings[1], /compilers\[4\]\.mode/);
});

test('normalizeConfig: invalid values are skipped with a warning, never thrown', () => {
  const cfg = pc.normalizeConfig({ compilers: {}, includePaths: 'inc', buildFolders: 'b', defines: 'X', extraFlags: 5, language: 'rust', mode: 1, maxIncludeFiles: -3 }, '/p');
  assert.deepEqual(cfg.compilers, []);
  assert.deepEqual(cfg.includePaths, []);
  assert.equal(cfg.language, undefined);
  assert.equal(cfg.maxIncludeFiles, undefined);
  assert.equal(cfg.warnings.length, 7);
  assert.deepEqual(pc.normalizeConfig([], '/p').warnings, ['The config file must contain a JSON object.']);
  const items = pc.normalizeConfig({ compilers: [{}, { id: '' }, 7], includePaths: [{}, ''] }, '/p');
  assert.equal(items.warnings.length, 5);
});

test('configBaseDir: .vscode/asm-lens.json resolves paths from the project root', () => {
  assert.equal(pc.configBaseDir(path.join('/p', '.asm-lens.json')), path.join('/p'));
  assert.equal(pc.configBaseDir(path.join('/p', '.vscode', 'asm-lens.json')), path.join('/p'));
});

test('loadProjectConfig: walks up from the file, stops at the workspace, prefers unsaved text', async () => {
  const dir = makeProject({
    '.asm-lens.json': '{ "flags": "-O1" }',
    'a/b/c.cpp': '',
    'other/.vscode/asm-lens.json': '{ "flags": "-O3", "includePaths": ["inc"] }',
    'other/x.cpp': '',
    'bad/.asm-lens.json': '{ broken',
    'bad/y.cpp': ''
  });
  const found = await pc.loadProjectConfig(path.join(dir, 'a', 'b'), dir);
  assert.equal(found.file, path.join(dir, '.asm-lens.json'));
  assert.equal(found.config.flags, '-O1');
  const vs = await pc.loadProjectConfig(path.join(dir, 'other'), dir);
  assert.equal(vs.file, path.join(dir, 'other', '.vscode', 'asm-lens.json'));
  assert.deepEqual(vs.config.includePaths, [{ dir: path.join(dir, 'other', 'inc'), recursive: false }]);
  const bad = await pc.loadProjectConfig(path.join(dir, 'bad'), dir);
  assert.equal(bad.config, undefined);
  assert.match(bad.error, /Could not parse/);
  const unsaved = await pc.loadProjectConfig(path.join(dir, 'a'), dir, async f => f === path.join(dir, '.asm-lens.json') ? '{ "flags": "-Os" }' : undefined);
  assert.equal(unsaved.config.flags, '-Os');
  assert.equal(await pc.loadProjectConfig(path.join(dir, 'a'), path.join(dir, 'a'), async () => undefined), undefined);
});

test('the JSON schema lists every top-level key normalizeConfig accepts', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schemas', 'asm-lens.schema.json'), 'utf8'));
  const keys = ['mode', 'compiler', 'compilers', 'flags', 'language', 'includePaths', 'buildFolders', 'excludePaths', 'defines', 'extraFlags', 'uploadSystemHeaders', 'baseUrl', 'maxIncludeFiles'];
  for (const k of keys) assert.ok(schema.properties[k], k);
  const item = schema.properties.compilers.items.oneOf[1].properties;
  for (const k of ['id', 'name', 'flags', 'language', 'mode', 'compiler', 'defines', 'extraFlags']) assert.ok(item[k], `compilers[].${k}`);
});

test('normalizeConfig: a compiler can have its own compile_commands.json, none, and a choice of its entries', () => {
  const base = path.resolve('/proj');
  const cfg = pc.normalizeConfig({
    compileCommands: 'build/compile_commands.json',
    compilers: [
      { id: 'x86', compileCommands: 'build32/compile_commands.json', entriesWith: '-m32 -DFAST' },
      { id: 'x64', compileCommands: ['a.json', path.resolve('/abs/b.json')], entriesWithout: ['-m32'] },
      { id: 'plain', compileCommands: false, compiler: 'clang++' },
      { id: 'bad', compileCommands: 3, entriesWith: 7, entriesWithout: [1] }
    ]
  }, base);
  assert.deepEqual(cfg.compileCommands, [path.join(base, 'build', 'compile_commands.json')]);
  const [x86, x64, plain, bad] = cfg.compilers;
  assert.deepEqual(x86.compileCommands, [path.join(base, 'build32', 'compile_commands.json')]);
  assert.deepEqual(x86.entriesWith, ['-m32', '-DFAST']);
  assert.deepEqual(x64.compileCommands, [path.join(base, 'a.json'), path.resolve('/abs/b.json')]);
  assert.deepEqual(x64.entriesWithout, ['-m32']);
  assert.deepEqual(plain.compileCommands, [], 'false: no database for this compiler');
  assert.equal(plain.compiler, 'clang++');
  for (const k of ['compileCommands', 'entriesWith', 'entriesWithout']) assert.equal(bad[k], undefined, k);
  assert.equal(cfg.warnings.length, 3, cfg.warnings.join('\n'));
  assert.match(cfg.warnings[0], /compilers\[3\]\.compileCommands" must be a path or an array of paths .*, or false/);
  // The top level still takes no false: it has nothing to turn off.
  const top = pc.normalizeConfig({ compileCommands: false }, base);
  assert.equal(top.compileCommands, undefined);
  assert.match(top.warnings[0], /"compileCommands" must be a path or an array of paths to compile_commands\.json files\.$/);
});

test('the JSON schema lists the keys a compiler can have for compile_commands.json', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schemas', 'asm-lens.schema.json'), 'utf8'));
  const item = schema.properties.compilers.items.oneOf[1].properties;
  for (const k of ['compileCommands', 'entriesWith', 'entriesWithout']) assert.ok(item[k], `compilers[].${k}`);
});
