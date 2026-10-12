// Shared test helpers: temporary projects, the extension under a mock VS Code,
// and detection of compilers installed on this machine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadExtension } = require('./vscode-mock');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const IS_WIN = process.platform === 'win32';

const commandCache = new Map();
// Whether `cmd` runs here (`cmd --version` or the given probe succeeds).
function hasCommand(cmd, probe = ['--version']) {
  const key = `${cmd} ${probe.join(' ')}`;
  if (!commandCache.has(key)) {
    let ok = false;
    try {
      const r = spawnSync(cmd, probe, { encoding: 'utf8', timeout: 60000, windowsHide: true });
      ok = !r.error && (r.status === 0 || /version/i.test(`${r.stdout}${r.stderr}`));
    } catch (_) { ok = false; }
    commandCache.set(key, ok);
  }
  return commandCache.get(key);
}

// First command of `candidates` that is installed, or undefined.
function firstCommand(candidates, probe) { return candidates.find(c => hasCommand(c, probe)); }

// A fresh temporary folder holding `files` ({ relativePath: text }) and,
// with `config`, a .asm-lens.json.
function makeProject(files = {}, config) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'asm-lens-test-')));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  if (config) fs.writeFileSync(path.join(dir, '.asm-lens.json'), typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  return dir;
}

function fixture(...parts) { return fs.readFileSync(path.join(FIXTURES, ...parts), 'utf8'); }

// The extension activated in a mock VS Code whose workspace is `dir`.
function start(dir, options = {}) {
  const ctx = loadExtension({ workspaceFolders: [dir], ...options });
  const at = rel => path.join(dir, rel);
  return {
    ...ctx,
    dir,
    at,
    open: rel => ctx.vscode._openDocument(at(rel)),
    async analyze(rel) {
      ctx.vscode._showDocument(at(rel));
      const before = snapshot(ctx.state);
      await ctx.state.commands.get('asmLens.analyzeFile')(ctx.vscode.Uri.file(at(rel)));
      return delta(ctx.state, before);
    },
    async instantiate(rel, line1, ...answers) {
      ctx.state.inputBoxAnswers.push(...answers);
      const before = snapshot(ctx.state);
      await ctx.state.commands.get('asmLens.instantiateTemplate')(ctx.vscode.Uri.file(at(rel)), line1 - 1);
      return delta(ctx.state, before);
    },
    // [{ line (1-based), title, command }]
    async lenses(rel) {
      const doc = ctx.vscode._openDocument(at(rel));
      const list = await ctx.state.codeLensProviders[0].provider.provideCodeLenses(doc);
      return list.map(l => ({ line: l.range.start.line + 1, title: l.command.title, command: l.command.command, args: l.command.arguments }));
    },
    // Title of the main (count) lens on 1-based `line`.
    async lensAt(rel, line) {
      const all = await this.lenses(rel);
      return all.find(l => l.line === line && l.command !== 'asmLens.instantiateTemplate')?.title;
    },
    analysis(rel) { return ctx.ext._internals.analysisFor(ctx.vscode._openDocument(at(rel))); }
  };
}

function snapshot(state) { return { info: state.messages.info.length, warning: state.messages.warning.length, error: state.messages.error.length }; }
function delta(state, before) {
  return { info: state.messages.info.slice(before.info), warning: state.messages.warning.slice(before.warning), error: state.messages.error.slice(before.error) };
}

module.exports = { FIXTURES, IS_WIN, hasCommand, firstCommand, makeProject, fixture, start };
