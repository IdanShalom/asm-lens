// Checks the C/C++ scanner on large real-world headers: scan time, and that
// the text with __attribute__((used)) marks still compiles whenever the
// original does. Downloads the headers (network) into a temporary folder and
// needs clang on PATH. Not part of `npm test`.
//   node test/tools/stress-headers.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const scan = require('../../src/cppScan');

const HEADERS = [
  ['https://raw.githubusercontent.com/nlohmann/json/v3.11.3/single_include/nlohmann/json.hpp', 'c++', ''],
  ['https://raw.githubusercontent.com/doctest/doctest/v2.4.11/doctest/doctest.h', 'c++', '#define DOCTEST_CONFIG_IMPLEMENT\n'],
  ['https://raw.githubusercontent.com/fmtlib/fmt/10.2.1/include/fmt/core.h', 'c++', ''],
  ['https://raw.githubusercontent.com/nothings/stb/master/stb_image.h', 'c', '#define STB_IMAGE_IMPLEMENTATION\n']
];

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asm-lens-stress-'));
  let failed = 0;
  for (const [url, lang, prefix] of HEADERS) {
    const file = path.join(dir, path.basename(url));
    const res = await fetch(url);
    if (!res.ok) { console.log(`${url}: HTTP ${res.status}`); failed++; continue; }
    fs.writeFileSync(file, await res.text());
    const text = fs.readFileSync(file, 'utf8');
    let t0 = Date.now();
    const fns = scan.scanDefinitions(text).filter(d => d.kind === 'function');
    const scanMs = Date.now() - t0;
    t0 = Date.now();
    const kept = scan.keepHeaderFunctions(text);
    const keepMs = Date.now() - t0;
    const compile = t => spawnSync('clang', ['-fsyntax-only', '-w', `-std=${lang === 'c' ? 'c11' : 'c++17'}`, '-x', lang, '-'], { input: prefix + t, encoding: 'utf8', maxBuffer: 64 << 20 });
    const original = compile(text);
    const marked = compile(kept);
    const ok = kept.split('\n').length === text.split('\n').length && (original.status !== 0 || marked.status === 0) && scanMs < 2000;
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${path.basename(file).padEnd(12)} ${String(text.split('\n').length).padStart(6)} lines, ${fns.length} functions, scan ${scanMs} ms, marks ${keepMs} ms, original ${original.status === 0 ? 'compiles' : 'does not compile'}, marked ${marked.status === 0 ? 'compiles' : 'does not compile'}`);
    if (original.status === 0 && marked.status !== 0) console.log(marked.stderr.split('\n').filter(l => /error:/.test(l)).slice(0, 5).join('\n'));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
