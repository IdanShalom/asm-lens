// Inside the extension host of a real VS Code; started by test/e2e/run.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CODE = /^\$\(symbol-numeric\) \d+ (?:inlined )?instructions|^\$\(symbol-numeric\) \d+ instantiations/;

exports.run = async () => {
  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const uriOf = rel => vscode.Uri.file(path.join(folder, rel));
  const titles = async rel => {
    const all = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uriOf(rel)) || [];
    return all.map(l => ({ line: l.range.start.line + 1, title: l.command?.title || '' })).filter(l => !l.title.endsWith('Instantiate…'));
  };
  // Opens the file as a user would, and waits until nothing is compiling.
  const settled = async rel => {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uriOf(rel)), { preview: false });
    for (let i = 0; i < 240; i++) {
      await sleep(250);
      const first = await titles(rel);
      if (first.length && !first.some(l => /Analyzing|Updating/.test(l.title))) {
        await sleep(500);
        const again = await titles(rel);
        if (!again.some(l => /Analyzing|Updating/.test(l.title))) return again;
      }
    }
    throw new Error(`${rel} is still being analyzed after a minute`);
  };
  const at = (lenses, line) => lenses.find(l => l.line === line)?.title || '';

  const tests = [];
  const check = async (name, fn) => {
    try { await fn(); tests.push({ name }); } catch (e) { tests.push({ name, error: e.stack || String(e) }); }
  };

  await check('the extension activates and registers its commands', async () => {
    const ext = vscode.extensions.all.find(e => /asm-lens$/i.test(e.id));
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const c of ['asmLens.analyzeFile', 'asmLens.instantiateTemplate', 'asmLens.selectCompiler']) assert.ok(commands.includes(c), c);
  });

  await check('.hxx and .h files are C++ here', async () => {
    assert.equal((await vscode.workspace.openTextDocument(uriOf('forms.hxx'))).languageId, 'cpp');
    assert.equal((await vscode.workspace.openTextDocument(uriOf('sub/types.h'))).languageId, 'cpp');
  });

  await check('after analyzing a .cpp, static inline functions in its header show code without a click', async () => {
    await vscode.commands.executeCommand('asmLens.analyzeFile', uriOf('user.cpp'));
    const lenses = await settled('forms.hxx');
    for (const line of [8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27, 28, 31, 32, 33, 36]) assert.match(at(lenses, line), CODE, `line ${line}: ${at(lenses, line)}`);
    assert.match(at(lenses, 39), /Not compiled · inside #ifdef NOT_DEFINED_HERE, which is off/);
  });

  await check('struct templates in that header show code without a click', async () => {
    const lenses = await settled('tmpl.hxx');
    for (const line of [8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 20, 23, 27, 33, 34, 35, 42, 43, 49, 50, 51, 55, 59, 65, 68]) assert.match(at(lenses, line), CODE, `line ${line}: ${at(lenses, line)}`);
    assert.match(at(lenses, 19), /^\$\(symbol-numeric\) \d+ /, 'a friend function');
    assert.ok(at(lenses, 10).includes('Box<int>'), at(lenses, 10));
    assert.ok(!lenses.some(l => /not instantiated|not used/.test(l.title)), JSON.stringify(lenses));
  });

  await check('a header that compiles only after the lines before its #include', async () => {
    await vscode.commands.executeCommand('asmLens.analyzeFile', uriOf('needs_direct.cpp'));
    const lenses = await settled('needs.hxx');
    for (const line of [3, 4, 6, 15, 16]) assert.match(at(lenses, line), CODE, `line ${line}: ${at(lenses, line)}`);
    assert.match(at(lenses, 9), /Not compiled · inside #ifdef NEVER_ON/);
    assert.ok(at(lenses, 15).includes('Wrap<long>'), at(lenses, 15));
  });

  await check('nothing is sent before the question is answered (tests answer no dialog)', async () => {
    const real = globalThis.fetch;
    const urls = [];
    globalThis.fetch = (url, init) => { urls.push(String(url)); return real(url, init); };
    try {
      // VS Code refuses dialogs during tests, naming the one it refused: that it got this far is the point.
      await assert.rejects(vscode.commands.executeCommand('asmLens.analyzeFile', uriOf('remote/r.cpp')), /Send your code to 127\.0\.0\.1:9\?/);
      await sleep(300);
      assert.deepEqual(urls.filter(u => u.includes('/compile')), []);
      assert.match(at(await titles('remote/r.cpp'), 1), /Analyze with Asm Lens/);
    } finally { globalThis.fetch = real; }
  });

  fs.writeFileSync(process.env.ASM_LENS_E2E_RESULT, JSON.stringify({ version: vscode.version, tests }));
};
