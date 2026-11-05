// Writes test/fixtures/regression-baseline.json: the lines of the samples that show code with the compiler
// given (default clang++). Run it only after checking that nothing was lost: the test compares against this file.
const fs = require('fs');
const path = require('path');
const { makeProject, start } = require('../helpers/env');
const { readSamples, codeInSamples } = require('../helpers/samples');

(async () => {
  const now = await codeInSamples(readSamples(), { compiler: process.argv[2] || 'clang++', makeProject, start });
  fs.writeFileSync(path.join(__dirname, '..', 'fixtures', 'regression-baseline.json'), `${JSON.stringify(now, null, 1)}\n`);
  console.log(`${Object.values(now).reduce((n, l) => n + l.length, 0)} lines with code in ${Object.keys(now).length} runs`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
