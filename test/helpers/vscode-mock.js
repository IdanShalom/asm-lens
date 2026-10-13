// A small stand-in for the `vscode` module, enough to load the extension in
// plain Node and drive its commands, CodeLens and hover providers from tests.
const fs = require('fs');
const path = require('path');
const Module = require('module');

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  isBefore(o) { return this.line < o.line || (this.line === o.line && this.character < o.character); }
  isAfter(o) { return o.isBefore(this); }
}
class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) { this.start = a; this.end = b; }
    else { this.start = new Position(a, b); this.end = new Position(c, d); }
  }
  contains(p) {
    if (p instanceof Range) return this.contains(p.start) && this.contains(p.end);
    return !p.isBefore(this.start) && !p.isAfter(this.end);
  }
}
class Selection extends Range {
  constructor(a, b, c, d) { super(a, b, c, d); this.active = this.end; this.anchor = this.start; }
}
class Uri {
  constructor(scheme, fsPath) { this.scheme = scheme; this.fsPath = fsPath; this.path = fsPath; }
  static file(p) { return new Uri('file', path.resolve(p)); }
  static parse(s) { return s.startsWith('file://') ? Uri.file(decodeURIComponent(s.slice(7))) : new Uri(s.split(':')[0], s); }
  toString() { return this.scheme === 'file' ? `file://${this.fsPath}` : this.path; }
  with() { return this; }
}
class EventEmitter {
  constructor() { this.listeners = []; this.event = (fn) => { this.listeners.push(fn); return { dispose() {} }; }; }
  fire(e) { for (const l of this.listeners) l(e); }
  dispose() {}
}
class CodeLens { constructor(range, command) { this.range = range; this.command = command; } }
class MarkdownString {
  constructor(v = '') { this.value = v; }
  appendMarkdown(s) { this.value += s; return this; }
  appendCodeblock(s, lang) { this.value += `\n\`\`\`${lang || ''}\n${s}\n\`\`\`\n`; return this; }
  appendText(s) { this.value += s; return this; }
}
class Hover { constructor(contents, range) { this.contents = contents; this.range = range; } }
class ThemeColor { constructor(id) { this.id = id; } }
class CancellationTokenSource { constructor() { this.token = { isCancellationRequested: false, onCancellationRequested() { return { dispose() {} }; } }; } cancel() { this.token.isCancellationRequested = true; } dispose() {} }

const SymbolKind = { File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15, Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21, Struct: 22, Event: 23, Operator: 24, TypeParameter: 25 };

const LANGUAGE_BY_EXT = {
  '.c': 'c', '.h': 'cpp', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp', '.hh': 'cpp', '.inl': 'cpp', '.ipp': 'cpp', '.tpp': 'cpp',
  '.rs': 'rust', '.go': 'go', '.py': 'python', '.zig': 'zig', '.swift': 'swift', '.d': 'd', '.f90': 'fortran', '.cu': 'cuda-cpp', '.m': 'objective-c', '.mm': 'objective-cpp'
};

class TextDocument {
  constructor(fsPath, text, languageId) {
    this.uri = Uri.file(fsPath);
    this.fileName = this.uri.fsPath;
    this.languageId = languageId || LANGUAGE_BY_EXT[path.extname(fsPath).toLowerCase()] || 'plaintext';
    this.version = 1;
    this.isDirty = false;
    this._text = text;
  }
  getText(range) {
    if (!range) return this._text;
    const lines = this._text.split('\n');
    if (range.start.line === range.end.line) return lines[range.start.line].slice(range.start.character, range.end.character);
    return [lines[range.start.line].slice(range.start.character), ...lines.slice(range.start.line + 1, range.end.line), lines[range.end.line].slice(0, range.end.character)].join('\n');
  }
  get lineCount() { return this._text.split('\n').length; }
  lineAt(n) {
    const line = typeof n === 'number' ? n : n.line;
    const text = this._text.split('\n')[line].replace(/\r$/, '');
    return { lineNumber: line, text, range: new Range(line, 0, line, text.length), isEmptyOrWhitespace: !text.trim() };
  }
  getWordRangeAtPosition(pos) {
    const text = this.lineAt(pos.line).text;
    const re = /[A-Za-z_]\w*/g;
    let m;
    while ((m = re.exec(text))) if (m.index <= pos.character && pos.character <= m.index + m[0].length) return new Range(pos.line, m.index, pos.line, m.index + m[0].length);
    return undefined;
  }
  setText(text) { this._text = text; this.version++; }
}

// Creates a fresh mock. `state` is inspected by tests.
function createVscode(options = {}) {
  const state = {
    settings: { ...(options.settings || {}) },
    workspaceSettings: { ...(options.workspaceSettings || {}) },
    settingUpdates: [],
    documents: new Map(),           // fsPath -> TextDocument
    workspaceFolders: (options.workspaceFolders || []).map((p, index) => ({ uri: Uri.file(p), name: path.basename(p), index })),
    messages: { info: [], warning: [], error: [] },
    commands: new Map(),
    codeLensProviders: [],
    hoverProviders: [],
    symbols: new Map(),             // fsPath -> DocumentSymbol[] (default: none, like a busy language server)
    quickPickAnswers: [],           // queued answers for showQuickPick: function(items) or index
    inputBoxAnswers: [],            // queued answers for showInputBox
    webviewHtml: undefined,
    webviewMessages: [],
    outputLines: [],
    activeEditor: undefined,
    selectionListeners: [],
    workspaceState: new Map(),
    globalState: new Map(),
    shownDocuments: [],
    progress: [],
    activeEditorListeners: []
  };

  // Like VS Code: a setting that is not set returns the default declared in package.json.
  const declared = require(path.resolve(__dirname, '..', '..', 'package.json')).contributes.configuration.properties;
  // User settings (state.settings) and workspace settings (state.workspaceSettings); the workspace wins.
  function getConfiguration(section) {
    return {
      get(key, def) {
        const k = `${section}.${key}`;
        if (state.workspaceSettings[k] !== undefined) return state.workspaceSettings[k];
        if (state.settings[k] !== undefined) return state.settings[k];
        const d = declared[k];
        return d && d.default !== undefined ? d.default : def;
      },
      has(key) { return this.get(key) !== undefined; },
      inspect(key) {
        const k = `${section}.${key}`;
        return { key: k, defaultValue: declared[k]?.default, globalValue: state.settings[k], workspaceValue: state.workspaceSettings[k], workspaceFolderValue: undefined };
      },
      async update(key, value, target) {
        const k = `${section}.${key}`;
        if (target === 2 || target === 3) state.workspaceSettings[k] = value; else state.settings[k] = value;
        state.settingUpdates.push({ key: k, value, target });
      }
    };
  }

  function openDocumentSync(p, languageId) {
    const abs = path.resolve(p);
    let doc = state.documents.get(abs);
    if (!doc) { doc = new TextDocument(abs, fs.readFileSync(abs, 'utf8'), languageId); state.documents.set(abs, doc); }
    return doc;
  }

  const makeEditor = (doc) => ({
    document: doc,
    selection: new Selection(0, 0, 0, 0),
    decorations: new Map(),
    setDecorations(type, ranges) { this.decorations.set(type, ranges); },
    revealRange() {}
  });

  const vscode = {
    Position, Range, Selection, Uri, EventEmitter, CodeLens, MarkdownString, Hover, ThemeColor, SymbolKind, CancellationTokenSource,
    ViewColumn: { One: 1, Two: 2, Beside: -2, Active: -1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    workspace: {
      get workspaceFolders() { return state.workspaceFolders.length ? state.workspaceFolders : undefined; },
      get textDocuments() { return [...state.documents.values()]; },
      getConfiguration,
      getWorkspaceFolder(uri) {
        return state.workspaceFolders.filter(f => uri.fsPath === f.uri.fsPath || uri.fsPath.startsWith(f.uri.fsPath + path.sep))
          .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
      },
      async openTextDocument(arg) { return openDocumentSync(arg instanceof Uri ? arg.fsPath : arg); },
      async findFiles(include, exclude, max) { return findFiles(state, include, exclude, max); },
      createFileSystemWatcher() { return { onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }; },
      onDidChangeConfiguration() { return { dispose() {} }; },
      onDidChangeTextDocument(fn) { state.changeListener = fn; return { dispose() {} }; },
      onDidSaveTextDocument(fn) { state.saveListener = fn; return { dispose() {} }; },
      onDidCloseTextDocument() { return { dispose() {} }; }
    },
    window: {
      get activeTextEditor() { return state.activeEditor; },
      get visibleTextEditors() { return state.activeEditor ? [state.activeEditor] : []; },
      createOutputChannel() { return { appendLine(l) { state.outputLines.push(l); }, append(l) { state.outputLines.push(l); }, show() {}, clear() {}, dispose() {} }; },
      createTextEditorDecorationType(o) { return { options: o, dispose() {} }; },
      createStatusBarItem() { return { show() {}, hide() {}, dispose() {}, text: '', tooltip: '' }; },
      createWebviewPanel() {
        const panel = {
          visible: true, title: '',
          webview: {
            // Like a real webview, the page reports 'ready' once loaded.
            set html(h) { state.webviewHtml = h; if (state.webviewHandler) state.webviewHandler({ type: 'ready' }); }, get html() { return state.webviewHtml; },
            postMessage(m) { state.webviewMessages.push(m); return Promise.resolve(true); },
            onDidReceiveMessage(fn) { state.webviewHandler = fn; return { dispose() {} }; },
            asWebviewUri: (u) => u, cspSource: 'mock'
          },
          onDidDispose(fn) { state.panelDispose = fn; return { dispose() {} }; },
          onDidChangeViewState() { return { dispose() {} }; },
          reveal() {}, dispose() { state.panelDispose?.(); }
        };
        state.panel = panel;
        return panel;
      },
      showInformationMessage(m) { state.messages.info.push(m); return Promise.resolve(undefined); },
      showWarningMessage(m) { state.messages.warning.push(m); return Promise.resolve(undefined); },
      showErrorMessage(m) { state.messages.error.push(m); return Promise.resolve(undefined); },
      async showQuickPick(items, opts) {
        const list = await items;
        const a = state.quickPickAnswers.shift();
        if (a === undefined) return undefined;
        return typeof a === 'function' ? a(list, opts) : list[a];
      },
      async showInputBox(opts) {
        const a = state.inputBoxAnswers.shift();
        return typeof a === 'function' ? a(opts) : a;
      },
      async showTextDocument(arg) {
        const doc = arg instanceof TextDocument ? arg : openDocumentSync(arg.fsPath);
        state.activeEditor = makeEditor(doc);
        for (const fn of state.activeEditorListeners) fn(state.activeEditor);
        state.shownDocuments.push(doc.fileName);
        return state.activeEditor;
      },
      // Records progress; tests cancel the running one with state.cancelProgress().
      async withProgress(opts, task) {
        const listeners = [];
        const token = { isCancellationRequested: false, onCancellationRequested(fn) { listeners.push(fn); return { dispose() {} }; } };
        const entry = { opts, messages: [], cancel() { token.isCancellationRequested = true; listeners.forEach(fn => fn()); } };
        state.progress.push(entry);
        state.cancelProgress = () => entry.cancel();
        return task({ report(p) { if (p && p.message) entry.messages.push(p.message); } }, token);
      },
      onDidChangeVisibleTextEditors() { return { dispose() {} }; },
      onDidChangeActiveTextEditor(fn) { state.activeEditorListeners.push(fn); return { dispose() {} }; },
      onDidChangeTextEditorSelection(fn) { state.selectionListeners.push(fn); return { dispose() {} }; }
    },
    languages: {
      registerCodeLensProvider(selector, provider) { state.codeLensProviders.push({ selector, provider }); return { dispose() {} }; },
      registerHoverProvider(selector, provider) { state.hoverProviders.push({ selector, provider }); return { dispose() {} }; }
    },
    commands: {
      registerCommand(id, fn) { state.commands.set(id, fn); return { dispose() {} }; },
      async executeCommand(id, ...args) {
        if (id === 'vscode.executeDocumentSymbolProvider') return state.symbols.get(args[0].fsPath) || [];
        const fn = state.commands.get(id);
        return fn ? fn(...args) : undefined;
      }
    },
    env: { openExternal: async () => true, clipboard: { writeText: async () => {} } }
  };

  // Test helpers (not part of the real API).
  vscode._state = state;
  // The last function the assembly view was asked to show.
  state.lastRender = () => state.webviewMessages.filter(m => m.type === 'render').at(-1);
  vscode._openDocument = openDocumentSync;
  vscode._showDocument = (p) => {
    const d = openDocumentSync(p);
    state.activeEditor = makeEditor(d);
    for (const fn of state.activeEditorListeners) fn(state.activeEditor);
    return d;
  };
  // Focus moves to a panel (the assembly view): no active text editor.
  vscode._focusPanel = () => { state.activeEditor = undefined; for (const fn of state.activeEditorListeners) fn(undefined); };
  vscode._context = () => ({
    subscriptions: [],
    extensionPath: path.resolve(__dirname, '..', '..'),
    extensionUri: Uri.file(path.resolve(__dirname, '..', '..')),
    workspaceState: { get: (k, d) => state.workspaceState.has(k) ? state.workspaceState.get(k) : d, update: async (k, v) => { state.workspaceState.set(k, v); }, keys: () => [...state.workspaceState.keys()] },
    globalState: { get: (k, d) => state.globalState.has(k) ? state.globalState.get(k) : d, update: async (k, v) => { state.globalState.set(k, v); }, keys: () => [...state.globalState.keys()], setKeysForSync() {} }
  });
  return vscode;
}

// Tiny glob for findFiles: supports **, *, ? and {a,b}.
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
function findFiles(state, include, exclude, max) {
  const out = [];
  const inc = globRe(include);
  const excl = exclude ? String(exclude).split(/,(?![^{]*})/).map(globRe) : [];
  for (const folder of state.workspaceFolders) {
    const root = folder.uri.fsPath;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        const rel = path.relative(root, full).replace(/\\/g, '/');
        if (e.isDirectory()) walk(full);
        else if (inc.test(rel) && !excl.some(r => r.test(rel))) out.push(Uri.file(full));
        if (out.length >= (max || 1e9)) return;
      }
    };
    walk(root);
  }
  return out;
}

// Loads a fresh copy of the extension wired to a fresh mock.
function loadExtension(options = {}) {
  const vscode = createVscode(options);
  const root = path.resolve(__dirname, '..', '..');
  const origResolve = Module._resolveFilename;
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return origLoad.call(this, request, parent, isMain);
  };
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(root, 'src'))) delete require.cache[k];
  let ext;
  try { ext = require(path.join(root, options.main || 'src/extension.js')); }
  finally { Module._load = origLoad; Module._resolveFilename = origResolve; }
  const context = vscode._context();
  ext.activate(context);
  return { ext, vscode, state: vscode._state, context };
}

module.exports = { createVscode, loadExtension, Position, Range, Uri, SymbolKind, TextDocument };
