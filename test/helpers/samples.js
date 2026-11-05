// The sample sources, and which functions show code in them: for the regression baseline.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIRS = [['headers', 'test/fixtures/headers'], ['classes', 'test/fixtures/classes'], ['auto', 'test/fixtures/auto'], ['db', 'test/fixtures/db'], ['builds', 'test/fixtures/builds'], ['demo', 'demo']];

function readSamples() {
  const all = {};
  for (const [name, dir] of DIRS) {
    (function walk(d, rel) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, `${rel}/${e.name}`);
        else if (/\.(?:cpp|hxx|h|hpp)$/.test(e.name)) all[`${rel}/${e.name}`] = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
      }
    })(path.join(ROOT, dir), name);
  }
  return all;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// { "file [analyze]": [lines with code], "file [instantiate]": [...] }: each file analyzed by itself, then
// with every template instantiated with its suggested types.
async function codeInSamples(samples, { compiler, makeProject, start, flags = '-O2 -std=c++20' }) {
  const result = {};
  for (const file of Object.keys(samples).sort()) {
    const sub = file.split('/')[0];
    const files = {};
    for (const [k, v] of Object.entries(samples)) if (k.startsWith(`${sub}/`)) files[k.slice(sub.length + 1)] = v;
    const name = file.slice(sub.length + 1);
    const config = { mode: 'local', compiler, flags, includePaths: ['include', 'sub', '.'] };
    for (const mode of ['analyze', 'instantiate']) {
      const x = start(makeProject(files, config), { settings: { 'asmLens.reanalyzeOn': 'never' } });
      await x.analyze(name);
      if (mode === 'instantiate') {
        const lines = (await x.lenses(name)).filter(l => /Instantiate…$/.test(l.title)).map(l => l.args[1]);
        for (const line of [...new Set(lines)]) {
          for (let i = 0; i < 4; i++) x.state.inputBoxAnswers.push(o => o.value || 'int');
          await x.state.commands.get('asmLens.instantiateTemplate')(x.vscode.Uri.file(x.at(name)), line);
          x.state.inputBoxAnswers.length = 0;
        }
        await sleep(50);
      }
      const withCode = (await x.lenses(name)).filter(l => /^\$\(symbol-numeric\)/.test(l.title)).map(l => l.line);
      result[`${file} [${mode}]`] = [...new Set(withCode)].sort((a, b) => a - b);
    }
  }
  return result;
}

module.exports = { readSamples, codeInSamples };
