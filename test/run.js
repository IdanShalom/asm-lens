// Runs every *.test.js under test/ with Node's built-in test runner.
//   node test/run.js            unit tests, replayed Compiler Explorer responses, local compilers found on PATH
//   node test/run.js --remote   also live Compiler Explorer requests (network)
//   node test/run.js --record   refresh the recorded Compiler Explorer responses (network)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const env = { ...process.env };
if (args.includes('--remote')) env.ASM_LENS_REMOTE = '1';
if (args.includes('--record')) env.ASM_LENS_RECORD = '1';
const filters = args.filter(a => !a.startsWith('--'));

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name !== 'fixtures') walk(p);
    else if (e.name.endsWith('.test.js') && (!filters.length || filters.some(f => p.includes(f)))) files.push(p);
  }
})(__dirname);

const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files.sort()], { stdio: 'inherit', env });
process.exit(r.status === null ? 1 : r.status);
