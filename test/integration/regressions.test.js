// What already worked must keep working. Every function that has had code in the samples is
// listed in fixtures/regression-baseline.json: none may lose it, with any compiler, when a file is
// analyzed or its templates are instantiated. And what the plain forms alone would have lost: private
// members, members defined in another file, virtual functions.
// To add to the baseline, when more functions have code: node test/tools/update-baseline.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeProject, start, FIXTURES, hasCommand, IS_WIN } = require('../helpers/env');
const { installFetch } = require('../helpers/ce-replay');
const { readSamples, codeInSamples } = require('../helpers/samples');

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

const CODE = /^\$\(symbol-numeric\) \d+ (?:inlined )?instructions|^\$\(symbol-numeric\) \d+ (?:instantiations|versions)/;
const file = (...p) => fs.readFileSync(path.join(FIXTURES, ...p), 'utf8');
const NEVER = { settings: { 'asmLens.reanalyzeOn': 'never' } };

const baseline = JSON.parse(file('regression-baseline.json'));
// What a compiler itself decides, or cannot read, listed with the reason. Everything else counts.
const notFor = {
  // Clang for Windows has MSVC's standard library, which needs more than these samples include.
};

for (const cc of localCompilers()) {
  test(`local ${cc}: no function in the samples loses its code`, { timeout: 600000 }, async () => {
    const now = await codeInSamples(readSamples(), { compiler: cc, makeProject, start });
    const lost = [];
    for (const [key, lines] of Object.entries(baseline)) {
      for (const line of lines) if (!(now[key] || []).includes(line) && !(notFor[cc] || []).includes(`${key} ${line}`)) lost.push(`${key}  line ${line}`);
    }
    assert.deepEqual(lost, [], `functions that lost their code with ${cc}`);
  });

  test(`local ${cc}: private members of a class template keep their code`, () => privateMembers({ mode: 'local', compiler: cc, flags: '-O2 -std=c++17' }, { reachesPrivate: true }));
  test(`local ${cc}: members defined in another file, and virtual functions, keep their code`, () => otherFile({ mode: 'local', compiler: cc, flags: '-O2 -std=c++17' }));
  test(`local ${cc}: instantiations saved by older versions still compile`, () => savedRequests({ mode: 'local', compiler: cc, flags: '-O2 -std=c++17' }));
}

for (const id of ['g152', 'clang2010', 'vcpp_v19_latest_x64']) {
  const config = { flags: '-O2 -std=c++17', compilers: [{ id, name: id }] };
  const remote = fn => async () => { const ce = installFetch(); try { await fn(); } finally { ce.restore(); } };
  const msvc = /^vcpp/.test(id);
  test(`remote ${id} (Compiler Explorer): private members of a class template keep their code`, remote(() => privateMembers(config, { reachesPrivate: !msvc })));
  test(`remote ${id} (Compiler Explorer): members defined in another file, and virtual functions, keep their code`, remote(() => otherFile(config)));
  test(`remote ${id} (Compiler Explorer): instantiations saved by older versions still compile`, remote(() => savedRequests(config)));
}

async function privateMembers(config, { reachesPrivate }) {
  const x = start(makeProject({ 'p.hxx': file('templates', 'private_member.hxx') }, config), { settings: { 'asmLens.reanalyzeOn': 'never', 'asmLens.autoInstantiateTemplates': false } });
  // The class compiles as a whole: private members come with it, as they always did.
  assert.deepEqual((await x.instantiate('p.hxx', 2, 'int')).warning, [], x.state.outputLines.slice(-8).join('\n'));
  assert.match(await x.lensAt('p.hxx', 2) || '', CODE);
  assert.match(await x.lensAt('p.hxx', 5) || '', CODE, `the private member\n${x.state.outputLines.slice(-8).join('\n')}`);
  // It does not: the other members still have code, a private one too where the compiler allows it.
  assert.deepEqual((await x.instantiate('p.hxx', 8, 'S')).warning, [], x.state.outputLines.slice(-8).join('\n'));
  assert.match(await x.lensAt('p.hxx', 8) || '', CODE, await x.lensAt('p.hxx', 8));
  assert.match(await x.lensAt('p.hxx', 9) || '', /PrivBroken<S>::broken does not compile/);
  if (reachesPrivate) assert.match(await x.lensAt('p.hxx', 12) || '', CODE, `${await x.lensAt('p.hxx', 12)}\n${x.state.outputLines.slice(-8).join('\n')}`);
}

async function otherFile(config) {
  const x = start(makeProject({ 'box_tpp.h': file('templates', 'box_tpp.h'), 'box.tpp': file('templates', 'box.tpp') }, config), { settings: { 'asmLens.reanalyzeOn': 'never', 'asmLens.autoInstantiateTemplates': false } });
  x.vscode._openDocument(x.at('box.tpp'), 'cpp');
  assert.deepEqual((await x.instantiate('box_tpp.h', 3, 'int')).warning, [], x.state.outputLines.slice(-8).join('\n'));
  assert.match(await x.lensAt('box_tpp.h', 3) || '', CODE);
  assert.match(await x.lensAt('box_tpp.h', 5) || '', CODE, 'a virtual function');
  assert.match(await x.lensAt('box_tpp.h', 6) || '', CODE, 'a virtual destructor');
  const names = x.analysis('box_tpp.h').functions.map(f => f.name).join('\n');
  assert.match(names, /in_tpp|\?in_tpp@/, `the member defined in box.tpp\n${names}`);
}

async function savedRequests(config) {
  const text = 'template <class T> struct Whole { T get() const { return T{}; } };\ntemplate <class T> struct Part { T get() const { return T{}; } };\ntemplate <class T> T plain(T x) { return x + x; }\ntemplate <class T> T over(T x) { return x; }\ntemplate <class T> T over(T x, T y) { return y; }\n';
  const x = start(makeProject({ 's.hxx': text }, config), { ...NEVER, settings: { ...NEVER.settings, 'asmLens.autoInstantiateTemplates': false } });
  x.state.workspaceState.set('asmLens.instantiations', { [require('../../src/asm').normPath(x.at('s.hxx'))]: [
    { kind: 'class', expr: 'Whole<int>', keyword: 'struct', member: 'Whole<int>::get' },
    { kind: 'address', expr: 'Part<int>::get' },
    { kind: 'address', expr: 'plain<int>' },
    { kind: 'address', expr: 'over<int>', cast: 'int (*)(int x, int y)' }
  ] });
  assert.deepEqual((await x.analyze('s.hxx')).warning, [], x.state.outputLines.slice(-8).join('\n'));
  const lenses = (await x.lenses('s.hxx')).filter(l => !/Instantiate…$|Instantiated:/.test(l.title));
  for (const line of [1, 2, 3, 5]) assert.match(lenses.find(l => l.line === line)?.title || '', CODE, `line ${line}\n${x.state.outputLines.slice(-8).join('\n')}`);
  assert.equal(x.ext._internals.instantiationsFor(x.open('s.hxx')).length, 4, 'all still saved');
}
