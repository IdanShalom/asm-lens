// Runs the extension (under the mock VS Code) against one compiler of every
// compiler family on Compiler Explorer, and reports whether each function of a
// small program gets its own instruction count.
//   node test/tools/survey-ce.js [c++|c] [--all] [--json out.json] [--only <id substring>]
// Network: one or two requests per compiler. Not part of `npm test`.
const fs = require('fs');
const { makeProject, start } = require('../helpers/env');

const args = process.argv.slice(2);
const lang = args.find(a => a === 'c' || a === 'c++') || 'c++';
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined;
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const baseUrl = 'https://godbolt.org';

const FILES = {
  'c++': {
    'main.cpp': '#include "util.h"\nint square(int x) { return x * x; }\nint use(int a) { return twice(a) + square(a); }\n',
    'util.h': '#pragma once\nstatic inline int twice(int v) { return v + v; }\n'
  },
  c: {
    'main.c': '#include "util.h"\nint square(int x) { return x * x; }\nint use(int a) { return twice(a) + square(a); }\n',
    'util.h': '#ifndef UTIL_H\n#define UTIL_H\nstatic int twice(int v) { return v + v; }\n#endif\n'
  }
};

// Newest-looking compiler of each (compilerType, instructionSet) family.
function representatives(list) {
  const groups = new Map();
  for (const c of list) {
    const key = `${c.compilerType || 'default'} | ${c.instructionSet || '?'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const score = c => (String(c.semver || '').match(/\d+/g) || []).map(Number).reduce((s, n) => s * 1000 + n, 0) + (/trunk|nightly|latest/i.test(`${c.id} ${c.name}`) ? -1e15 : 0);
  return [...groups.entries()].map(([key, cs]) => ({ key, compiler: cs.sort((a, b) => score(b) - score(a))[0] }));
}

(async () => {
  const list = await (await fetch(`${baseUrl}/api/compilers/${encodeURIComponent(lang)}?fields=id,name,compilerType,instructionSet,semver`, { headers: { Accept: 'application/json' } })).json();
  let picks = args.includes('--all') ? list.map(c => ({ key: c.id, compiler: c })) : representatives(list);
  if (only) picks = picks.filter(p => p.compiler.id.includes(only) || p.key.includes(only));
  const results = [];
  for (const { key, compiler } of picks) {
    const main = lang === 'c' ? 'main.c' : 'main.cpp';
    const dir = makeProject(FILES[lang], { compilers: [{ id: compiler.id, name: compiler.name, flags: '-O2', language: lang === 'c' ? 'c' : undefined }] });
    const x = start(dir);
    if (lang === 'c') x.vscode._openDocument(x.at(main), 'c');
    const t0 = Date.now();
    const msg = await x.analyze(main);
    const lens2 = await x.lensAt(main, 2) || '';
    const lens3 = await x.lensAt(main, 3) || '';
    const analysis = x.analysis(main);
    const ok = / \d+ instructions/.test(lens2) && / \d+ instructions/.test(lens3);
    const header = await x.lensAt('util.h', lang === 'c' ? 3 : 2) || '';
    const r = {
      key, id: compiler.id, name: compiler.name, ok, ms: Date.now() - t0,
      square: lens2.split(' · ')[0], use: lens3.split(' · ')[0], header: header.split(' · ')[0],
      functions: analysis ? analysis.functions.map(f => f.name).slice(0, 8) : [],
      error: (msg.error[0] || msg.warning[0] || '').slice(0, 300),
      stderr: x.state.outputLines.filter(l => /warning|error/i.test(l)).slice(0, 3).join(' | ').slice(0, 300)
    };
    results.push(r);
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${key.padEnd(28)} ${compiler.id.padEnd(30)} ${String(r.ms).padStart(6)}ms  square: ${r.square} | use: ${r.use} | header: ${r.header}${ok ? '' : `\n       functions: ${JSON.stringify(r.functions)}\n       ${r.error}`}`);
  }
  console.log(`\n${results.filter(r => r.ok).length}/${results.length} OK`);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
