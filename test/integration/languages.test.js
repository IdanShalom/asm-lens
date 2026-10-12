// Rust, Go, Python, Zig, Swift, D and Fortran: each fixture analyzed with the
// local compiler (when installed here) and on Compiler Explorer (recorded
// responses; live with `node test/run.js --remote`).
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeProject, start, fixture, firstCommand, IS_WIN } = require('../helpers/env');
const { installFetch } = require('../helpers/ce-replay');

// file -> { local compiler candidates, 1-based lines of functions that must get a count }
const CASES = {
  'geom.py': { local: IS_WIN ? ['python', 'py'] : ['python3', 'python'], lines: [1, 6, 13] },
  'geom.go': { local: ['go'], probe: ['version'], lines: [5, 9, 11] },
  'geom.rs': { local: ['rustc'], lines: [1, 5, 12] },
  'geom.zig': { local: ['zig'], probe: ['version'], lines: [1, 5] },
  'geom.swift': { local: ['swiftc'], lines: [1, 7] },
  'geom.d': { lines: [1, 5] },
  'geom.f90': { local: ['gfortran'], lines: [1, 6] }
};

const COUNT = /^\$\(symbol-numeric\) \d+ instructions · /;

async function analyzeFixture(file, config) {
  const dir = makeProject({ [file]: fixture('languages', file) }, config);
  const x = start(dir);
  const msg = await x.analyze(file);
  assert.deepEqual(msg.error, [], `${file}: ${msg.error[0]}`);
  for (const line of CASES[file].lines) assert.match(await x.lensAt(file, line) || '(no lens)', COUNT, `${file} line ${line}\n${x.describe(file)}`);
  return x;
}

for (const [file, c] of Object.entries(CASES)) {
  const cmd = c.local && firstCommand(c.local, c.probe);
  test(`local ${file}${cmd ? ` (${cmd})` : ''}`, { skip: !cmd && `${(c.local || ['no local compiler']).join('/')} not installed` }, async () => {
    const lang = file.split('.').pop();
    const language = { py: 'python', go: 'go', rs: 'rust', zig: 'zig', swift: 'swift', f90: 'fortran' }[lang];
    const x = await analyzeFixture(file, { mode: 'local', compilers: [{ id: `local-${language}`, language, compiler: cmd }] });
    // Hovering a line that produced instructions shows them.
    const lines = x.analysis(file).lineIndex.get(x.analysis(file).rootPathKey);
    const line = [...lines.keys()][0];
    const hover = x.state.hoverProviders[0].provider.provideHover(x.open(file), new x.vscode.Position(line, 0));
    assert.ok(hover, `${file}: hover on line ${line + 1}`);
    assert.match(hover.contents.value, /instruction/);
  });
  test(`remote ${file} (Compiler Explorer)`, async () => {
    const ce = installFetch();
    try { await analyzeFixture(file); } finally { ce.restore(); }
  });
}

test('local Python: unsaved edits are compiled; syntax errors are reported', { skip: !firstCommand(CASES['geom.py'].local) && 'python not installed' }, async () => {
  const dir = makeProject({ 'a.py': 'def f(x):\n    return x\n' }, { mode: 'local', compilers: [{ id: 'py', language: 'python', compiler: firstCommand(CASES['geom.py'].local) }] });
  const x = start(dir);
  const doc = x.open('a.py');
  doc.setText('def f(x):\n    return x\n\ndef g(y):\n    return y * 2\n');
  doc.isDirty = true;
  await x.analyze('a.py');
  assert.match(await x.lensAt('a.py', 4), COUNT);
  doc.setText('def broken(:\n');
  const msg = await x.analyze('a.py');
  assert.match(msg.error[0], /SyntaxError|invalid syntax/);
});
