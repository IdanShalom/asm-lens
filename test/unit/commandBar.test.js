// The command above the assembly: edited flags on Compiler Explorer (a fake one), and the
// assembly view's own script, run against a small stand-in for the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { makeProject, start } = require('../helpers/env');

function fakeCompilerExplorer() {
  const real = global.fetch;
  const requests = [];
  global.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url: String(url), body });
    const asm = [{ text: 'f():' }, { text: '        mov eax, 1', source: { file: null, line: 1 } }, { text: '        ret', source: { file: null, line: 1 } }];
    const json = { code: 0, asm, stdout: [], stderr: [] };
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
  };
  return { requests, restore: () => { global.fetch = real; } };
}

test('Compiler Explorer: the flags above the assembly can be edited, and reset', async () => {
  const ce = fakeCompilerExplorer();
  try {
    const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\n' }, { compilers: [{ id: 'g152', name: 'GCC 15.2', flags: '-O2 -masm=intel' }], defines: ['FROM_CONFIG'] });
    const x = start(dir, { settings: { 'asmLens.reanalyzeOn': 'never' } });
    assert.deepEqual((await x.analyze('a.cpp')).error, []);
    const lens = (await x.lenses('a.cpp')).find(l => l.command === 'asmLens.showAssembly');
    await x.state.commands.get('asmLens.showAssembly')(...lens.args);
    const shown = x.state.lastRender().command;
    assert.deepEqual({ ...shown, added: undefined }, { kind: 'flags', label: 'GCC 15.2', where: 'godbolt.org', text: '-O2 -DFROM_CONFIG', added: undefined, cwd: '', edited: false });
    assert.match(shown.added, /^Intel syntax and the 0 local header\(s\) found are added by Asm Lens$/);
    assert.equal(x.state.lastRender().meta, 'GCC 15.2');

    await x.ext._internals.handleWebviewMessage({ type: 'compileWith', text: '-O3   -DEDITED -Werror' });
    assert.equal(ce.requests.at(-1).body.options.userArguments, '-O3 -DEDITED', 'the edited flags replace the settings\' (a warning never stops the analysis)');
    assert.equal(x.state.lastRender().command.edited, true);
    assert.equal(x.state.lastRender().command.text, '-O3 -DEDITED');
    assert.match(x.state.statusItem.text, /GCC 15\.2 · edited$/);
    // AT&T syntax written in the flags stays in them.
    await x.ext._internals.handleWebviewMessage({ type: 'compileWith', text: '-O1 -masm=att' });
    assert.equal(ce.requests.at(-1).body.options.filters.intel, false);
    assert.equal(x.state.lastRender().command.text, '-O1 -masm=att');
    // Empty flags are flags too.
    await x.ext._internals.handleWebviewMessage({ type: 'compileWith', text: '   ' });
    assert.equal(ce.requests.at(-1).body.options.userArguments, '');
    // Reset (the same request as the first one is answered from the cache).
    await x.ext._internals.handleWebviewMessage({ type: 'resetCommand' });
    assert.equal(x.state.lastRender().command.text, '-O2 -DFROM_CONFIG');
    assert.equal(x.analysis('a.cpp').flags, '-O2 -DFROM_CONFIG');
    assert.equal(x.state.lastRender().command.edited, false);
  } finally { ce.restore(); }
});

test('the command bar is not offered for a panel without an analysis, and nothing runs from a stale message', async () => {
  const dir = makeProject({ 'a.cpp': 'int f() { return 1; }\n' });
  const x = start(dir);
  await x.ext._internals.handleWebviewMessage({ type: 'compileWith', text: 'rm -rf /' });
  assert.deepEqual(x.state.workspaceState.get('asmLens.editedCommands'), undefined);
});

// ---------------------------------------------------------------------------
// The assembly view's script, with just enough of a page for it.

class Element {
  constructor(id, tag = 'div') { this.id = id; this.tagName = tag; this.hidden = false; this.textContent = ''; this.value = ''; this.disabled = false; this.className = ''; this.style = {}; this.dataset = {}; this.attributes = {}; this.children = []; this.listeners = {}; this.scrollHeight = 20; }
  get classList() { const el = this; const set = () => new Set(el.className.split(/\s+/).filter(Boolean)); return { add(c) { const s = set(); s.add(c); el.className = [...s].join(' '); }, remove(c) { const s = set(); s.delete(c); el.className = [...s].join(' '); }, toggle(c, on) { if (on) this.add(c); else this.remove(c); }, contains: c => set().has(c) }; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, event = {}) { const e = { preventDefault() { this.defaultPrevented = true; }, target: this, ...event }; for (const fn of this.listeners[type] || []) fn(e); return e; }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...c) { this.children = c.flatMap(x => (x.children && x.tagName === '#fragment' ? x.children : [x])); }
}

function page(html) {
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const elements = new Map(ids.map(id => [id, new Element(id)]));
  for (const el of elements.values()) if (/hidden/.test(html.match(new RegExp(`<[^>]*id="${el.id}"[^>]*>`))[0])) el.hidden = true;
  elements.get('cmdRun').disabled = true;
  const posted = [];
  const windowListeners = {};
  const sandbox = {
    // Copied out of the page's context, so that deepEqual compares plain objects.
    acquireVsCodeApi: () => ({ postMessage: m => posted.push(JSON.parse(JSON.stringify(m))) }),
    document: {
      getElementById: id => elements.get(id) || null,
      createDocumentFragment: () => new Element('', '#fragment'),
      createElement: tag => new Element('', tag),
      createTextNode: t => ({ textContent: t })
    },
    window: { addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); } },
    innerHeight: 800
  };
  const script = html.slice(html.indexOf('<script'), html.indexOf('</script>')).replace(/^<script[^>]*>/, '');
  vm.runInNewContext(script, sandbox);
  return { $: id => elements.get(id), posted, send: m => { for (const fn of windowListeners.message || []) fn({ data: m }); } };
}

test('the assembly view: the command can be edited, compiled with Enter, put back with Escape, and reset', async () => {
  const x = start(makeProject({ 'a.cpp': '' }));
  const command = { kind: 'command', label: '', where: '', text: 'g++ -O2 -Iinc', added: '-masm=intel -S -g -o - -x c++ -', cwd: '/proj/build', edited: false };
  x.ext._internals.showAssembly({ name: 'f', count: 1, instructionRows: [], rows: [] }, { compilerLabel: 'g++ (local)', compilerId: 'g++', flags: '-O2', functions: [], command });
  const p = page(x.state.webviewHtml);
  assert.deepEqual(p.posted, [{ type: 'ready' }]);
  p.posted.length = 0;
  const render = c => p.send({ ...x.state.lastRender(), command: c });

  render(command);
  assert.equal(p.$('cmdbox').hidden, false);
  assert.equal(p.$('cmd').value, 'g++ -O2 -Iinc');
  assert.equal(p.$('cmd').attributes['aria-label'], 'Compiler command');
  assert.equal(p.$('cmdLabel').textContent, '', 'the compiler is part of the command');
  assert.equal(p.$('cmdAdded').textContent, 'Asm Lens adds: -masm=intel -S -g -o - -x c++ - · Runs in /proj/build');
  assert.equal(p.$('cmdRun').disabled, true, 'nothing to compile before an edit');
  assert.equal(p.$('cmdReset').hidden, true);

  // Typing enables Compile; Shift+Enter is a new line, Enter compiles.
  p.$('cmd').value = 'g++ -O3 -Iinc';
  p.$('cmd').fire('input');
  assert.equal(p.$('cmdRun').disabled, false);
  assert.equal(p.$('cmd').fire('keydown', { key: 'Enter', shiftKey: true }).defaultPrevented, undefined);
  assert.deepEqual(p.posted, []);
  assert.equal(p.$('cmd').fire('keydown', { key: 'Enter' }).defaultPrevented, true);
  assert.deepEqual(p.posted, [{ type: 'compileWith', text: 'g++ -O3 -Iinc' }]);
  assert.equal(p.$('cmdNote').textContent, 'Compiling…');
  p.$('cmd').fire('keydown', { key: 'Enter' });
  assert.equal(p.posted.length, 1, 'once while it compiles');

  // The new code arrives, with the command it was compiled with.
  render({ ...command, text: 'g++ -O3 -Iinc', edited: true });
  assert.equal(p.$('cmd').value, 'g++ -O3 -Iinc');
  assert.equal(p.$('cmdReset').hidden, false);
  assert.match(p.$('cmdNote').textContent, /^Edited here/);

  // Typing that was not sent survives a render from elsewhere (a save); Escape puts the command back.
  p.$('cmd').value = 'g++ -O1';
  p.$('cmd').fire('input');
  render({ ...command, text: 'g++ -O3 -Iinc', edited: true });
  assert.equal(p.$('cmd').value, 'g++ -O1');
  p.$('cmd').fire('keydown', { key: 'Escape' });
  assert.equal(p.$('cmd').value, 'g++ -O3 -Iinc');
  assert.equal(p.$('cmdRun').disabled, true);
  // The same command with other spacing is no edit.
  p.$('cmd').value = '  g++   -O3\n-Iinc ';
  p.$('cmd').fire('input');
  assert.equal(p.$('cmdRun').disabled, true);

  // Reset, and a compile that fails says so.
  p.$('cmdReset').fire('click');
  assert.deepEqual(p.posted.at(-1), { type: 'resetCommand' });
  p.send({ type: 'commandDone', failed: true });
  assert.match(p.$('cmdNote').textContent, /^That did not compile: the compiler's message is in the Asm Lens output\.$/);
  assert.equal(p.$('cmdReset').disabled, false);

  // Compiler Explorer: the compiler is fixed, the flags are edited.
  render({ kind: 'flags', label: 'GCC 15.2', where: 'godbolt.org', text: '-O2', added: 'Intel syntax and the 2 local header(s) found are added by Asm Lens', cwd: '', edited: false });
  assert.equal(p.$('cmdLabel').textContent, 'GCC 15.2 on godbolt.org');
  assert.equal(p.$('cmd').attributes['aria-label'], 'Compiler flags');
  assert.equal(p.$('cmdAdded').textContent, 'Intel syntax and the 2 local header(s) found are added by Asm Lens');
  // An analysis without a command (none is known): no bar.
  render(undefined);
  assert.equal(p.$('cmdbox').hidden, true);
});
