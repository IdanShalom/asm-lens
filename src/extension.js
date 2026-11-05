const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const projectConfig = require('./projectConfig');
const scan = require('./cppScan');
const languages = require('./languages');
const flagsLib = require('./flags');
const compileCommands = require('./compileCommands');
const {
  IS_WIN, normPath, makeRefResolver, makeLocalRefResolver, localAsmToRows, isMachO, prepareMachO, finishMachO,
  parseFunctions, mergeFunctionParts, buildLineIndex, normalizeName, sameName,
  matchSourceSymbol, findFunctionResult, findAllFunctionResults,
  ANSI_RE, missingIncludesFrom, preprocessorErrorFilesFrom, errorLocationsFrom, stubFilename,
  cleanAssemblyRowsForDisplay, cleanAssemblyForDisplay
} = require('./asm');
const { maskCode, blankEnclosingDeclaration, keepHeaderFunctions } = scan;

const LANGS = languages.LANGUAGE_IDS;
const VIRTUAL_ROOT = 'asm_lens';
const HEADER_RE = /\.(?:h|hh|hpp|hxx|h\+\+|inl|ipp|tcc|tpp|txx|cuh|ph)$/i;
// Template instantiations requested per file: { [file key]: [{ kind, expr, keyword }] }.
const INSTANTIATIONS_KEY = 'asmLens.instantiations';
const TEMPLATE_ARGS_KEY = 'asmLens.lastTemplateArgs';

// analysis cache, keyed by the URI of the document that was analyzed (the "root").
let lastAnalysis = new Map();
let outputPanel;
// What the assembly panel is currently showing: { analysis, result, fileKeys, groups, stale }.
let panelState;
let outputChannel;
let analysisBusy = new Set();
// Files to analyze again once their running analysis ends (edited or saved meanwhile).
const rerunAfter = new Set();
// The running analysis of each file (to cancel it when it is outdated), and the
// pending automatic re-analyses: file key -> job / timer.
const runningJobs = new Map();
const reanalysisTimers = new Map();
// Files analyzed in this session, for re-analysis on save:
// file key -> { uri, deps (file path keys it used), stamp (when) }. Kept when edits invalidate the results.
const analyzedFiles = new Map();
let codeLensEmitter;
let extContext;
let statusItem;
let lineDecoration;
let dimDecoration;
let tokenDecoration;
let paletteDecorations = [];
let syncTimer;
let panelRefreshTimer;

function config() { return vscode.workspace.getConfiguration('asmLens'); }

// Writes a setting where it is in effect: a workspace-folder or workspace
// value if one is set (a user-level change would be hidden by it), else user settings.
async function updateSetting(key, value, document) {
  const cfg = vscode.workspace.getConfiguration('asmLens', document?.uri);
  const info = cfg.inspect(key) || {};
  const target = info.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
    : info.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await cfg.update(key, value, target);
}

// The source file commands act on: the active editor's, else a visible one,
// else the last one that was active (the assembly view may have the focus).
let lastSourceDocument;
function currentSourceDocument() {
  const active = vscode.window.activeTextEditor?.document;
  if (active && LANGS.includes(active.languageId)) return active;
  const visible = (vscode.window.visibleTextEditors || []).find(e => LANGS.includes(e.document.languageId));
  if (visible) return visible.document;
  return lastSourceDocument && !lastSourceDocument.isClosed ? lastSourceDocument : undefined;
}
function fileKey(document) { return document.uri.toString(); }
function docPathKey(document) { return document.uri.scheme === 'file' ? normPath(document.uri.fsPath) : document.uri.toString(); }


// ---------------------------------------------------------------------------
// Settings: VS Code settings, overridden by the project's .asm-lens.json

const DEFAULT_BUILD_FOLDERS = ['build', 'Build', 'builds', '_build', 'out', 'bin', 'cmake-build-*', 'generated', 'gen', '.build'];

// Folders whose headers are never uploaded: unconfigured copies of standard
// libraries (e.g. 3rdparty/pin-llvm-project.git/libcxx) shadow the compiler's own headers.
const DEFAULT_EXCLUDES = ['**/libcxx/**', '**/libc++/**', '**/libcxxabi/**', '**/*llvm-project*/**', '**/sysroot/**', '**/node_modules/**'];

const SYSTEM_HEADERS = new Set(`assert.h complex.h ctype.h errno.h fenv.h float.h inttypes.h iso646.h limits.h locale.h math.h setjmp.h signal.h
stdalign.h stdarg.h stdatomic.h stdbool.h stddef.h stdint.h stdio.h stdlib.h stdnoreturn.h string.h tgmath.h threads.h time.h uchar.h wchar.h wctype.h
unistd.h fcntl.h pthread.h dlfcn.h dirent.h sched.h semaphore.h poll.h termios.h syslog.h strings.h alloca.h malloc.h elf.h link.h features.h syscall.h
endian.h byteswap.h execinfo.h ucontext.h cpuid.h immintrin.h x86intrin.h emmintrin.h xmmintrin.h pmmintrin.h smmintrin.h intrin.h
algorithm any array atomic barrier bit bitset cassert cctype cerrno cfenv cfloat charconv chrono cinttypes climits clocale cmath codecvt compare complex
concepts condition_variable coroutine csetjmp csignal cstdarg cstddef cstdint cstdio cstdlib cstring ctime cuchar cwchar cwctype deque exception execution
expected filesystem format forward_list fstream functional future initializer_list iomanip ios iosfwd iostream istream iterator latch limits list locale
map memory memory_resource mutex new numbers numeric optional ostream print queue random ranges ratio regex scoped_allocator semaphore set shared_mutex
source_location span sstream stack stacktrace stdexcept stop_token streambuf string string_view syncstream system_error thread tuple type_traits
typeindex typeinfo unordered_map unordered_set utility valarray variant vector version`.split(/\s+/));
const SYSTEM_HEADER_DIRS = /^(?:bits|sys|linux|asm|asm-generic|gnu|net|netinet|arpa|machine|mach|ext|tr1|experimental|__\w*)\//;

function isSystemHeader(name) {
  const n = String(name).replace(/\\/g, '/').replace(/^\.\//, '');
  return SYSTEM_HEADERS.has(n) || SYSTEM_HEADER_DIRS.test(n) || /^__/.test(n);
}

// Minimal glob: ** = any folders, * = any chars except '/', ? = one char.
// A bare name like "vendor" means "any folder named vendor".
function globToRegExp(glob) {
  let s = String(glob).replace(/\\/g, '/').trim();
  if (!s.includes('/') && !s.includes('*')) s = `**/${s}/**`;
  let re = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*' && s[i + 1] === '*') { i++; if (s[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

const PALETTE = [
  'rgba(255, 99, 71, 0.20)', 'rgba(60, 179, 113, 0.20)', 'rgba(65, 105, 225, 0.24)', 'rgba(255, 215, 0, 0.20)',
  'rgba(186, 85, 211, 0.20)', 'rgba(0, 206, 209, 0.20)', 'rgba(255, 140, 0, 0.20)', 'rgba(154, 205, 50, 0.20)',
  'rgba(255, 105, 180, 0.20)', 'rgba(100, 149, 237, 0.24)'
];

const loggedConfigProblems = new Set();

function readConfigText(file) {
  const open = (vscode.workspace.textDocuments || []).find(d => d.uri.scheme === 'file' && normPath(d.uri.fsPath) === normPath(file));
  if (open) return Promise.resolve(open.getText());
  return fs.readFile(file, 'utf8').then(t => t, () => undefined);
}

async function loadProject(document) {
  if (!document || document.uri.scheme !== 'file') return undefined;
  const root = vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath;
  const project = await projectConfig.loadProjectConfig(path.dirname(document.uri.fsPath), root, readConfigText);
  // Logged once each: this runs on every status-bar refresh.
  for (const line of [project?.error, ...(project?.warnings || []).map(w => `${project.file}: ${w}`)]) {
    if (line && !loggedConfigProblems.has(line)) { loggedConfigProblems.add(line); outputChannel?.appendLine(line); }
  }
  return project;
}

// A relative compiler path in .asm-lens.json ("./tools/gcc") is relative to that file.
function resolveCompilerPath(command, project) {
  return command && /^\.\.?[\\/]/.test(command) && project?.file ? path.resolve(path.dirname(project.file), command) : command;
}

// Everything an analysis needs, for one document.
async function resolveSettings(document) {
  const s = config();
  const project = await loadProject(document);
  const c = project?.config;
  const lang = languages.languageOf(document.languageId);
  if (lang && lang.family !== 'c') return resolveOtherSettings(lang, project, s);
  const docLang = document.languageId === 'c' ? 'c' : 'c++';
  // Compilers for other languages (Rust, Python, ...) never apply to C/C++ files.
  const cFamily = (c?.compilers || []).filter(x => !x.language || x.language === 'c' || x.language === 'c++');
  const all = cFamily.length
    ? cFamily
    : [{ id: s.get('compilerId', 'g152'), name: s.get('compilerName', '') || s.get('compilerId', 'g152') }];
  const matching = all.filter(x => !x.language || x.language === docLang);
  const compilers = matching.length ? matching : all;
  // A pick made with Select Compiler in a project with .asm-lens.json applies to that project only;
  // without a project file the VS Code settings decide (Select Compiler writes them).
  const stored = extContext?.workspaceState.get('asmLens.activeCompiler');
  const chosen = stored && project?.file && (!stored.configFile || normPath(stored.configFile) === normPath(project.file)) ? stored : undefined;
  // A compiler picked from Compiler Explorer's list compiles there, for the language it was picked for.
  const browsed = chosen && chosen.browsed && (!chosen.language || chosen.language === docLang)
    ? { id: chosen.id, name: chosen.name || chosen.id, mode: 'remote' } : undefined;
  const active = (chosen && !chosen.browsed && compilers.find(x => x.id === chosen.id)) || browsed || compilers[0];
  const settingsPaths = (s.get('includePaths', []) || []).filter(x => typeof x === 'string' && x.trim());
  return {
    configFile: project?.file,
    configError: project?.error,
    compilers,
    active,
    baseUrl: (c?.baseUrl || s.get('baseUrl', 'https://godbolt.org')).replace(/\/$/, ''),
    flags: active.flags ?? c?.flags ?? s.get('flags', '-O2 -masm=intel'),
    language: active.language || c?.language || (c ? docLang : s.get('language', docLang)),
    // Project folders first, in the order written, then the VS Code setting.
    includePaths: [...(c?.includePaths || []), ...settingsPaths],
    buildFolders: c?.buildFolders ?? DEFAULT_BUILD_FOLDERS,
    maxIncludeFiles: c?.maxIncludeFiles ?? s.get('maxIncludeFiles', 80),
    excludePaths: [...DEFAULT_EXCLUDES, ...(c?.excludePaths || [])],
    defines: [...(c?.defines || []), ...(active.defines || [])],
    extraFlags: [c?.extraFlags, active.extraFlags].filter(Boolean).join(' '),
    uploadSystemHeaders: c?.uploadSystemHeaders === true,
    mode: active.mode || c?.mode || s.get('mode', 'remote'),
    localCompiler: resolveCompilerPath(active.compiler || c?.compiler || s.get('localCompiler', '') || 'g++', project),
    // Local mode: compile_commands.json databases (absolute paths), and the flags added to an entry's.
    compileCommands: c?.compileCommands ?? settingsCompileCommands(document, s),
    activeExtraFlags: active.extraFlags || ''
  };
}

// asmLens.compileCommands: a path or paths, relative to the workspace folder.
function settingsCompileCommands(document, s) {
  const value = s.get('compileCommands', '');
  const list = (Array.isArray(value) ? value : [value]).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
  const base = vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath || (document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : process.cwd());
  return list.map(x => path.isAbsolute(x) ? path.resolve(x) : path.resolve(base, x));
}

// Settings for Rust, Go, Python, ...: compilers from .asm-lens.json entries with
// that "language", else the language's Compiler Explorer default. Top-level
// flags, defines and include paths are C/C++ settings and are not used.
function resolveOtherSettings(lang, project, s) {
  const c = project?.config;
  const compilers = (c?.compilers || []).filter(x => x.language === lang.id);
  const chosen = extContext?.workspaceState.get(`asmLens.activeCompiler.${lang.id}`);
  const active = (chosen && !chosen.browsed && compilers.find(x => x.id === chosen.id))
    || (chosen && chosen.browsed ? { id: chosen.id, name: chosen.name || chosen.id, mode: 'remote' } : undefined)
    || compilers[0]
    || { id: lang.compiler, name: `${lang.label} (Compiler Explorer default)`, isDefault: true };
  const mode = active.mode || c?.mode || s.get('mode', 'remote');
  return {
    lang,
    configFile: project?.file,
    configError: project?.error,
    compilers,
    active,
    baseUrl: (c?.baseUrl || s.get('baseUrl', 'https://godbolt.org')).replace(/\/$/, ''),
    flags: active.flags ?? lang.flags ?? '',
    extraFlags: active.extraFlags || '',
    defines: [],
    includePaths: [],
    language: lang.id,
    mode,
    localCompiler: resolveCompilerPath(active.compiler || lang.local, project)
  };
}

// Compiler Explorer's default compiler for a language (cached), or a known one when offline.
const ceDefaults = new Map();
async function ceDefaultCompiler(baseUrl, lang) {
  if (!ceDefaults.has(baseUrl)) {
    ceDefaults.set(baseUrl, fetch(`${baseUrl}/api/languages?fields=id,defaultCompiler`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
      .then(r => r.ok ? r.json() : [])
      .then(list => new Map((Array.isArray(list) ? list : []).filter(l => l && l.defaultCompiler).map(l => [l.id, l.defaultCompiler])))
      .catch(() => new Map()));
  }
  const map = await ceDefaults.get(baseUrl);
  if (!map.size) ceDefaults.delete(baseUrl);
  return map.get(lang.id) || lang.compiler;
}

async function refreshStatusBar() {
  if (!statusItem || analysisBusy.size) return;
  const document = currentSourceDocument();
  if (!document || !LANGS.includes(document.languageId)) return statusItem.hide();
  try {
    const r = await resolveSettings(document);
    if (analysisBusy.size) return;            // an analysis started meanwhile: keep its spinner
    const local = r.mode === 'local';
    const database = local && r.compileCommands && r.compileCommands.length;
    statusItem.text = `$(chip) ${database ? 'compile_commands (local)' : local ? `${path.basename(r.localCompiler || '')} (local)` : r.active.name || r.active.id}`;
    statusItem.tooltip = `Asm Lens compiler: ${database ? `from ${r.compileCommands.join(', ')}` : local ? `${r.localCompiler} on this machine` : `${r.active.id} on ${r.baseUrl}`}\n${r.configFile ? `Config: ${r.configFile}` : 'No .asm-lens.json (using VS Code settings)'}\nClick to change`;
    statusItem.show();
  } catch (_) { statusItem.hide(); }
}

function activate(context) {
  extContext = context;
  outputChannel = vscode.window.createOutputChannel('Asm Lens');
  context.subscriptions.push(outputChannel);

  lineDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
    isWholeLine: true,
    // A frame with a thick left edge: stands out over the line colors without fading anything else.
    borderWidth: '1px 1px 1px 3px', borderStyle: 'solid', borderColor: new vscode.ThemeColor('focusBorder'),
    overviewRulerColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center
  });
  dimDecoration = vscode.window.createTextEditorDecorationType({ opacity: '0.45' });
  context.subscriptions.push(dimDecoration);
  tokenDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchBackground'),
    border: '1px solid', borderColor: new vscode.ThemeColor('editor.findMatchBorder')
  });
  context.subscriptions.push(lineDecoration, tokenDecoration);
  paletteDecorations = PALETTE.map(color => vscode.window.createTextEditorDecorationType({ backgroundColor: color, isWholeLine: true }));
  context.subscriptions.push(...paletteDecorations);
  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => applySourceColors()));
  codeLensEmitter = new vscode.EventEmitter();
  context.subscriptions.push(codeLensEmitter);

  const selector = LANGS.map(language => ({ language }));

  const provider = {
    onDidChangeCodeLenses: codeLensEmitter.event,
    async provideCodeLenses(document) {
      if (!LANGS.includes(document.languageId)) return [];
      if (!config().get('showCounts', true)) return [];
      const tree = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
      // Read the cache after the async symbol-provider call. Analysis may finish
      // while symbols are being collected, so an earlier snapshot can be stale.
      const cached = analysisFor(document);
      const functions = sourceFunctionsOf(document, tree);
      if (analysisBusy.has(fileKey(document)) && !cached) {
        return functions.map(sym => new vscode.CodeLens(sym.range, { title: '$(sync~spin) Analyzing…', command: 'asmLens.showOutput' }));
      }
      const templates = templateTargetsOf(document, functions);
      const extra = templateLenses(document, templates);
      if (!cached) {
        return [...functions.map(sym => new vscode.CodeLens(sym.range, {
          title: '$(play) Analyze with Asm Lens',
          command: 'asmLens.analyzeFile',
          arguments: [document.uri]
        })), ...extra];
      }
      const key = docPathKey(document);
      const own = lastAnalysis.get(fileKey(document));
      const requested = instantiationsFor(document).length > 0;
      return [...functions.map(sym => {
        const template = templates.has(sym);
        const { analysis, results, inlined, skipped: wasSkipped } = codeFor(document, sym, { template });
        const result = results[0];
        const viaRoot = analysis.rootKey !== fileKey(document) ? ` · via ${path.basename(analysis.rootPath)}` : '';
        const updating = reanalysisTimers.has(analysis.rootKey) || analysisBusy.has(analysis.rootKey);
        // Edited since the last compile: its old numbers would be wrong.
        if (isStale(analysis, key, sym.range, results.length ? results : inlined ? [inlined] : [])) {
          return new vscode.CodeLens(sym.range, updating
            ? { title: '$(sync~spin) Updating…', command: 'asmLens.showOutput' }
            : { title: '$(edit) Changed since the last analysis · click to update', command: 'asmLens.analyzeFile', arguments: [vscode.Uri.file(analysis.rootPath)] });
        }
        // No code, and known only through a file that includes this one: that file not using a
        // function says nothing about the function. Compiling this file itself will show it.
        if (!result && !inlined && !wasSkipped && viaRoot) {
          if (analysisBusy.has(fileKey(document))) return new vscode.CodeLens(sym.range, { title: '$(sync~spin) Analyzing…', command: 'asmLens.showOutput' });
          if ((!own || own.compilerId !== analysis.compilerId) && (!template || requested)) {
            return new vscode.CodeLens(sym.range, {
              title: template ? '$(play) Instantiations not compiled yet · click to analyze this file' : `$(play) Not used by ${path.basename(analysis.rootPath)} · click to analyze this file`,
              command: 'asmLens.analyzeFile',
              arguments: [document.uri]
            });
          }
        }
        const title = results.length > 1
          ? `$(symbol-numeric) ${results.length} ${template || /</.test(results[0].name) ? 'instantiations' : 'versions'} · ${results.map(r => r.count).join(' / ')} instructions · ${analysis.compilerLabel}${viaRoot}`
          : result
            ? `$(symbol-numeric) ${result.count} instructions · ${analysis.compilerLabel} · ${analysis.flags}${viaRoot}`
            : inlined
              ? `$(symbol-numeric) ${inlined.count} inlined instructions · used in ${inlined.users.length} function(s)${viaRoot}`
              : wasSkipped
                ? `$(warning) Not compiled · this function has compile errors (missing include?) · ${analysis.compilerLabel}`
                : template
                  ? `$(info) No code emitted: template not instantiated · ${analysis.compilerLabel}${viaRoot}`
                  : `$(info) No code emitted (not used, or a template never instantiated) · ${analysis.compilerLabel}`;
        return new vscode.CodeLens(sym.range, {
          title,
          command: 'asmLens.showAssembly',
          arguments: [document.uri, sym.name, sym.range.start.line]
        });
      }), ...extra];
    }
  };
  context.subscriptions.push(vscode.languages.registerCodeLensProvider(selector, provider));

  context.subscriptions.push(vscode.languages.registerHoverProvider(selector, {
    provideHover(document, position) {
      const analysis = analysisAt(document, position.line);
      if (!analysis) return undefined;
      const key = docPathKey(document);
      if ((analysis.edits || []).some(e => e.key === key && e.start <= position.line && position.line <= e.end)) return undefined;
      syncAsmHighlight(analysis, key, position.line);

      // Hovering the function's own signature line previews the whole function.
      const fn = functionAtSignature(document, position, analysis, key);
      if (fn) {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${escapeMarkdown(fn.sourceName || fn.name)}** — ${fn.count} instructions\n\n`);
        md.appendCodeblock(truncateLines(cleanAssemblyForDisplay(fn) || '(no emitted instructions)', 60), 'asm');
        md.isTrusted = false;
        return new vscode.Hover(md);
      }
      // Anywhere else: show only the instructions generated by the hovered line.
      const entries = analysis.lineIndex.get(key)?.get(position.line);
      if (!entries || !entries.length) return undefined;
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**Line ${position.line + 1}** — ${entries.length} instruction${entries.length === 1 ? '' : 's'}\n\n`);
      const names = new Set(entries.map(e => e.fnName));
      const body = entries.map(e => names.size > 1 ? `${e.text}    ; ${e.fnName}` : e.text).join('\n');
      md.appendCodeblock(truncateLines(body, 40), 'asm');
      md.isTrusted = false;
      return new vscode.Hover(md);
    }
  }));

  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
    const document = event.textEditor.document;
    if (!LANGS.includes(document.languageId)) return;
    const line = event.selections[0].active.line;
    const analysis = analysisAt(document, line);
    if (!analysis) return;
    const key = docPathKey(document);
    const byUser = event.kind === vscode.TextEditorSelectionChangeKind.Mouse || event.kind === vscode.TextEditorSelectionChangeKind.Keyboard;
    clearTimeout(syncTimer);
    const fn = byUser && outputPanel && config().get('followCursor', true) ? functionForLine(analysis, key, line) : undefined;
    if (fn && (!panelState || panelState.result !== fn || panelState.stale)) {
      // Switching function: coalesce fast cursor moves, then render and highlight (messages keep their order).
      syncTimer = setTimeout(() => { showAssembly(fn, analysis); syncAsmHighlight(analysis, key, line); }, 30);
      return;
    }
    syncAsmHighlight(analysis, key, line);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('asmLens.analyzeFile', async (uri) => {
    const document = uri ? await vscode.workspace.openTextDocument(uri) : currentSourceDocument();
    if (!document) return vscode.window.showWarningMessage('Asm Lens: open a source file first.');
    await analyzeDocument(document);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('asmLens.instantiateTemplate', instantiateTemplate));
  context.subscriptions.push(vscode.commands.registerCommand('asmLens.manageInstantiations', manageInstantiations));
  context.subscriptions.push(vscode.commands.registerCommand('asmLens.showOutput', () => outputChannel.show(true)));

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'asmLens.selectCompiler';
  context.subscriptions.push(statusItem);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor && LANGS.includes(editor.document.languageId)) lastSourceDocument = editor.document;
    refreshStatusBar();
  }));
  refreshStatusBar();

  // Results of the old settings are dropped; the visible files that had results are analyzed again.
  const onConfigChanged = () => {
    const visible = new Set((vscode.window.visibleTextEditors || []).map(e => fileKey(e.document)));
    const again = [...lastAnalysis.keys()].filter(k => visible.has(k) && analyzedFiles.has(k));
    lastAnalysis.clear();
    loggedConfigProblems.clear();
    codeLensEmitter?.fire();
    refreshStatusBar();
    if (reanalyzeMode() === 'never') return;
    for (const key of again) {
      clearTimeout(reanalysisTimers.get(key));
      reanalysisTimers.set(key, setTimeout(() => {
        reanalysisTimers.delete(key);
        const entry = analyzedFiles.get(key);
        if (entry) Promise.resolve(vscode.workspace.openTextDocument(entry.uri)).then(d => analyzeDocument(d, { auto: true }), () => {});
      }, 400));
    }
  };
  if (vscode.workspace.createFileSystemWatcher) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/{.asm-lens.json,.vscode/asm-lens.json}');
    watcher.onDidChange(onConfigChanged); watcher.onDidCreate(onConfigChanged); watcher.onDidDelete(onConfigChanged);
    context.subscriptions.push(watcher);
  }
  // Settings that change what is compiled discard the results; display settings only redraw.
  const COMPILE_SETTINGS = ['baseUrl', 'compilerId', 'compilerName', 'flags', 'language', 'includePaths', 'maxIncludeFiles', 'skipFailingFunctions', 'maxRecoveryAttempts', 'stubFailingHeaders', 'mode', 'localCompiler', 'compileCommands', 'emitUnusedFunctions'];
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (!e.affectsConfiguration('asmLens')) return;
    if (COMPILE_SETTINGS.some(k => e.affectsConfiguration(`asmLens.${k}`))) return onConfigChanged();
    codeLensEmitter?.fire();
    if (panelState && outputPanel) showAssembly(panelState.result, panelState.analysis, { reveal: false });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('asmLens.selectCompiler', async () => {
    // The file the choice is for: the active editor, or the last source file
    // when the assembly view (or another panel) has the focus.
    const document = currentSourceDocument();
    if (!document) return vscode.window.showInformationMessage('Asm Lens: open a source file first; compilers are chosen per language.');
    const settings = await resolveSettings(document);
    const other = settings.lang && settings.lang.family !== 'c' ? settings.lang : undefined;
    const docLang = other ? other.id : (document.languageId === 'c' ? 'c' : 'c++');
    const BROWSE = { label: '$(search) Browse all Compiler Explorer compilers…', browse: true };
    let picked;
    if (settings.configFile && settings.compilers.length) {
      const items = settings.compilers.map((c, i) => ({
        label: c.name || c.id,
        description: `${c.id}${i === 0 ? ' · first in config' : ''}${c.id === settings.active.id ? ' · active' : ''}${(c.mode || settings.mode) === 'local' ? ' · local' : ''}`,
        detail: c.flags,
        compiler: c
      }));
      picked = await vscode.window.showQuickPick([...items, BROWSE], { placeHolder: 'Choose a compiler from .asm-lens.json' });
      if (!picked) return;
    } else picked = BROWSE;
    try {
      let chosen;
      if (picked.browse) {
        const baseUrl = settings.baseUrl || config().get('baseUrl', 'https://godbolt.org').replace(/\/$/, '');
        const response = await fetch(`${baseUrl}/api/compilers/${encodeURIComponent(settings.language)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) })
          .catch(e => { throw e.name === 'TimeoutError' ? new Error(`${hostOf(baseUrl)} did not send its compiler list within 30 s; try again in a moment.`) : e; });
        if (!response.ok) throw new Error(`Compiler list request failed: HTTP ${response.status}`);
        const compilers = await response.json();
        const selected = await vscode.window.showQuickPick(compilers.map(c => ({
          label: c.name || c.id,
          description: `${c.id}${c.semver ? ` · ${c.semver}` : ''}`,
          detail: c.id,
          compiler: c
        })), { placeHolder: 'Choose a Compiler Explorer compiler (the id can be copied into .asm-lens.json)', matchOnDescription: true });
        if (!selected) return;
        // A compiler from Compiler Explorer compiles there, even when the project is in local mode.
        chosen = { id: selected.compiler.id, name: selected.compiler.name || selected.compiler.id, browsed: true, mode: 'remote', language: docLang };
      } else {
        chosen = { id: picked.compiler.id, name: picked.compiler.name || picked.compiler.id, browsed: false };
      }
      // Before the settings change: it discards the results.
      const hadAnalysis = analysisFor(document);
      if (other) {
        await extContext.workspaceState.update(`asmLens.activeCompiler.${other.id}`, chosen);
      } else if (settings.configFile) {
        await extContext.workspaceState.update('asmLens.activeCompiler', { ...chosen, configFile: settings.configFile });
      } else {
        // No project file: the settings are the choice; an older pick must not hide them.
        await extContext.workspaceState.update('asmLens.activeCompiler', undefined);
        await updateSetting('compilerId', chosen.id, document);
        await updateSetting('compilerName', chosen.name, document);
        if (chosen.mode === 'remote' && settings.mode === 'local') await updateSetting('mode', 'remote', document);
      }
      lastAnalysis.clear();
      // Analyzed right below; no second, automatic run from the settings change.
      clearTimeout(reanalysisTimers.get(fileKey(document)));
      reanalysisTimers.delete(fileKey(document));
      codeLensEmitter?.fire();
      await refreshStatusBar();
      const now = await resolveSettings(document);
      vscode.window.showInformationMessage(`Asm Lens compiler set to ${chosen.name}${now.mode === 'local' ? ' (local)' : ' (Compiler Explorer)'}.`);
      if (hadAnalysis) await analyzeDocument(document);
    } catch (e) {
      vscode.window.showErrorMessage(`Asm Lens could not load compilers: ${e.message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('asmLens.reloadCompileCommands', async () => {
    compileCommands.reload();
    const document = currentSourceDocument();
    const resolved = document ? await resolveSettings(document) : undefined;
    if (!resolved || !resolved.compileCommands || !resolved.compileCommands.length) {
      return vscode.window.showInformationMessage('Asm Lens: no compile_commands.json is configured ("compileCommands" in .asm-lens.json, or the asmLens.compileCommands setting).');
    }
    const db = await compileCommands.loadDatabases(resolved.compileCommands);
    for (const e of db.errors) outputChannel.appendLine(`compile_commands: ${e}`);
    vscode.window.showInformationMessage(`Asm Lens: loaded ${db.entries.length} entries from ${resolved.compileCommands.map(f => path.basename(path.dirname(f)) + '/' + path.basename(f)).join(', ')}${db.errors.length ? ' (with errors; see the Asm Lens output)' : ''}.`);
    if (document && analysisFor(document) && resolved.mode === 'local') await analyzeDocument(document);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('asmLens.openConfig', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return vscode.window.showWarningMessage('Open a folder first; Asm Lens keeps .asm-lens.json in the project root.');
    const file = path.join(folder.uri.fsPath, '.asm-lens.json');
    const exists = await fs.stat(file).then(() => true, () => false);
    if (!exists) await fs.writeFile(file, projectConfig.TEMPLATE, 'utf8');
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    if (!exists) vscode.window.showInformationMessage('Created .asm-lens.json. List your compilers and include folders in order of priority.');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('asmLens.showAssembly', async (uri, functionName, line) => {
    const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!document) return;
    const cached = analysisFor(document);
    if (!cached) return analyzeDocument(document);
    const key = docPathKey(document);
    const tree = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
    const sym = sourceFunctionsOf(document, tree).find(s => s.name === functionName && (!Number.isInteger(line) || s.range.start.line === line))
      || (Number.isInteger(line) ? { name: functionName, range: new vscode.Range(line, 0, line, 0) } : { name: functionName });
    const { analysis, results, inlined } = codeFor(document, sym, { template: Boolean(sym.range) && templateTargetsOf(document, [sym]).has(sym) });
    let result = results[0];
    if (results.length > 1) {
      const pick = await vscode.window.showQuickPick(
        results.map(f => ({ label: f.name, description: `${f.count} instructions`, f })),
        { placeHolder: `${functionName}: choose an instantiation` });
      if (!pick) return;
      result = pick.f;
    }
    if (!result) result = inlined;
    if (!result) return vscode.window.showInformationMessage(`No emitted code for ${functionName}. It may be unused, fully inlined, or a template that is never instantiated.`);
    showAssembly(result, analysis);
  }));

  // Saving analyzes again the newest analysis that used the file: its own, or
  // (for a header) that of the file including it.
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
    if (reanalyzeMode() === 'never' || !LANGS.includes(document.languageId)) return;
    const target = analysisToUpdate(document);
    if (!target) return;
    clearTimeout(reanalysisTimers.get(target.rootKey));
    reanalysisTimers.delete(target.rootKey);
    return reanalyze(target, document);
  }));

  // Editing keeps the results: lines below an edit move with the text, the
  // edited functions are marked as changed, and (by default) the file is
  // analyzed again in the background once typing pauses.
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    if (event.contentChanges.length === 0) return;
    const key = docPathKey(event.document);
    let changed = false;
    for (const analysis of lastAnalysis.values()) {
      if (analysis.rootKey === fileKey(event.document) || analysis.deps.has(key)) { applyEdits(analysis, key, event.contentChanges); changed = true; }
    }
    if (panelState && panelState.analysis.deps.has(key)) {
      // The panel's line numbers moved with the edit: send them again (cheap) so hovering stays correct.
      panelState.stale = true;
      clearSourceHighlight();
      clearTimeout(panelRefreshTimer);
      panelRefreshTimer = setTimeout(() => { if (panelState && outputPanel) showAssembly(panelState.result, panelState.analysis, { reveal: false }); }, 150);
    }
    if (reanalyzeMode() === 'edit' && LANGS.includes(event.document.languageId)) {
      const target = analysisToUpdate(event.document);
      if (target) {
        // A compile of the old text is useless now; the timer starts the next one.
        runningJobs.get(target.rootKey)?.cancel('outdated');
        clearTimeout(reanalysisTimers.get(target.rootKey));
        const delay = Math.max(200, Number(config().get('reanalyzeDelayMs', 1000)) || 1000);
        reanalysisTimers.set(target.rootKey, setTimeout(() => {
          reanalysisTimers.delete(target.rootKey);
          reanalyze(target, event.document);
        }, delay));
        changed = true;
      }
    }
    if (changed) codeLensEmitter?.fire();
  }));
}

function reanalyzeMode() {
  const mode = config().get('reanalyzeOn', 'edit');
  return mode === 'save' || mode === 'never' ? mode : 'edit';
}

// The analyzed file whose results `document` shows (itself, or the newest file
// that includes it), or undefined.
function analysisToUpdate(document) {
  const key = docPathKey(document);
  let newest;
  for (const [rootKey, entry] of analyzedFiles) {
    if ((rootKey === fileKey(document) || entry.deps.has(key)) && (!newest || entry.stamp > newest.stamp)) newest = { ...entry, rootKey };
  }
  return newest;
}

function reanalyze(target, document) {
  if (target.uri.toString() === document.uri.toString()) return analyzeDocument(document, { auto: true });
  return Promise.resolve(vscode.workspace.openTextDocument(target.uri)).then(d => analyzeDocument(d, { auto: true }), () => {});
}

// Moves the results of `analysis` along with edits of file `key`: instruction
// lines and function ranges below an edit shift by the lines added or removed;
// the edited lines are remembered (analysis.edits) so the functions there are
// shown as changed until the next compile.
function applyEdits(analysis, key, changes) {
  const refs = new Set();
  for (const f of analysis.functions) {
    for (const r of f.rows || []) if (r.ref && r.ref.key === key) refs.add(r.ref);
    for (const r of f.instructionRows) if (r.ref && r.ref.key === key) refs.add(r.ref);
  }
  analysis.edits = analysis.edits || [];
  const ordered = [...changes].filter(c => c.range).sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character);
  for (const change of ordered) {
    const s = change.range.start.line, e = change.range.end.line;
    const added = (change.text.match(/\n/g) || []).length;
    const delta = added - (e - s);
    // Line e is untouched when the change ends at its start (whole lines replaced, or text inserted before it).
    const untouchedEnd = change.range.end.character === 0 && (s < e || change.range.start.character === 0);
    const moveLine = l => (l > e || (l === e && untouchedEnd)) ? l + delta : l < s ? l : Math.min(l, s + added);
    for (const ref of refs) ref.line = moveLine(ref.line);
    const moveRange = r => r && new vscode.Range(moveLine(r.start.line), r.start.character, Math.max(moveLine(r.start.line), moveLine(r.end.line)), r.end.character);
    if (key === analysis.rootPathKey) {
      for (const f of analysis.functions) { f.sourceRange = moveRange(f.sourceRange); f.sourceSelection = moveRange(f.sourceSelection); }
    }
    for (const k of analysis.skipped || []) {
      if (k.key === key) { k.startLine = moveLine(k.startLine); k.endLine = Math.max(k.startLine, moveLine(k.endLine)); }
    }
    // The lines that now hold edited text (none when whole lines were only deleted).
    // Text inserted at the start of a line without a line break does change that line.
    const lastLineEdited = !untouchedEnd || (change.text !== '' && !change.text.endsWith('\n'));
    let span = { key, start: s, end: lastLineEdited ? s + added : s + added - 1 };
    const kept = [];
    for (const x of analysis.edits) {
      if (x.key !== key) { kept.push(x); continue; }
      const moved = { key, start: moveLine(x.start), end: moveLine(x.end) };
      if (span.end < span.start || moved.end < span.start - 1 || moved.start > span.end + 1) kept.push(moved);
      else span = { key, start: Math.min(span.start, moved.start), end: Math.max(span.end, moved.end) };
    }
    analysis.edits = span.end < span.start ? kept : [...kept, span];
  }
  analysis.lineIndex = buildLineIndex(analysis.functions);
}

// Whether lines `range` of file `key`, or the instructions of `results`, were
// edited after the analysis was made.
function isStale(analysis, key, range, results) {
  const edits = analysis.edits || [];
  if (!edits.length) return false;
  const touched = (k, a, b) => edits.some(x => x.key === k && x.start <= b && a <= x.end);
  if (range && touched(key, range.start.line, range.end.line)) return true;
  return results.some(f => (f.instructionRows || []).some(r => r.ref && touched(r.ref.key, r.ref.line, r.ref.line)));
}

// ---------------------------------------------------------------------------
// Source function discovery

function flattenSymbols(symbols) {
  const out = [];
  for (const s of symbols) { out.push(s); if (s.children?.length) out.push(...flattenSymbols(s.children)); }
  return out;
}

// Merge language-server symbols with a source scan. Some C/C++ providers return
// prototypes but omit definitions (e.g. `main`), or return nothing while indexing.
// Declarations (prototypes) are left out: they have no code. A function found
// by the scan is added unless a language-server symbol covers it.
function sourceFunctionsOf(document, tree) {
  const symbolFunctions = flattenSymbols(tree || []).filter(isFunctionSymbol).filter(s => !isPrototype(document, s));
  const functions = [...symbolFunctions];
  for (const guessed of guessFunctionSymbols(document)) {
    const covered = symbolFunctions.some(s => s.range && s.range.start.line <= guessed.selectionRange.start.line && guessed.selectionRange.start.line <= s.range.end.line);
    if (!covered) functions.push(guessed);
  }
  return functions;
}

function isPrototype(document, symbol) {
  if (!symbol.range || typeof document.getText !== 'function') return false;
  let text;
  try { text = document.getText(symbol.range); } catch (_) { return false; }
  return typeof text === 'string' && !text.includes('{') && /\)[^()]*;\s*$/.test(text);
}

// Line of the `}` that closes the body opened at or after `startLine` (masked text, so
// braces in comments/strings/#directives are ignored). Falls back to `startLine`.
function findBodyEndLine(maskedLines, startLine) {
  let depth = 0, opened = false;
  for (let i = startLine; i < maskedLines.length && i < startLine + 5000; i++) {
    for (const c of maskedLines[i]) {
      if (c === '{') { depth++; opened = true; }
      else if (c === '}' && opened && --depth === 0) return i;
    }
  }
  return startLine;
}

// Function definitions found in the source text: the C/C++ scanner (one-line
// bodies, multi-line signatures, in-class methods, templates) plus the line
// patterns below; for other languages their own finder. Cached per version,
// since hover and CodeLens ask often.
const guessCache = new WeakMap();
function guessFunctionSymbols(document) {
  const hit = guessCache.get(document);
  if (hit && hit.version === document.version) return hit.symbols;
  const symbols = scanFunctionSymbols(document);
  guessCache.set(document, { version: document.version, symbols });
  return symbols;
}

function scanFunctionSymbols(document) {
  const text = document.getText();
  const lines = text.split(/\r?\n/);
  const toSymbol = g => ({
    name: g.name, kind: vscode.SymbolKind.Function,
    range: new vscode.Range(g.startLine, 0, g.endLine, (lines[g.endLine] || '').length),
    selectionRange: new vscode.Range(g.nameLine, 0, g.nameLine, (lines[g.nameLine] || '').length),
    children: []
  });
  const lang = languages.languageOf(document.languageId);
  if (lang && lang.family !== 'c') return languages.guessFunctions(lang.key, text).map(toSymbol);
  const found = scan.guessCFunctions(text).map(toSymbol);
  for (const g of guessFunctionSymbolsByLine(document)) {
    const line = g.range.start.line;
    if (!found.some(s => s.range.start.line <= line && line <= s.selectionRange.start.line)) found.push(g);
  }
  return found;
}

function guessFunctionSymbolsByLine(document) {
  const text = document.getText();
  const lines = text.split(/\r?\n/);
  const maskedLines = maskCode(text).text.split(/\r?\n/);
  const out = [];
  const seen = new Set();
  const ignored = new Set(['if', 'for', 'while', 'switch', 'catch', 'sizeof', 'decltype', 'return', 'new', 'delete']);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:#|\/\/|\/\*|\*|using\b|typedef\b|class\b|struct\b|enum\b)/.test(line)) continue;
    const m = line.match(/^\s*(?:(?:[\w:<>~,*&]+\s+)+)?([~A-Za-z_]\w*(?:::\w+)*(?:<[^{};]*>)?)\s*\([^;{}]*\)\s*(?:const\b\s*)?(?:noexcept\b\s*)?(?:->\s*[\w:<>*& ]+)?\s*(\{)?\s*(?:\/\/.*)?$/);
    if (!m || ignored.has(m[1])) continue;
    let hasBody = Boolean(m[2]);
    if (!hasBody) {
      for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
        if (/^\s*\{/.test(lines[j])) { hasBody = true; break; }
        if (/;/.test(lines[j]) || /\S/.test(lines[j]) && !/^\s*(?:const\b|noexcept\b|->)/.test(lines[j])) break;
      }
    }
    if (!hasBody || seen.has(`${m[1]}:${i}`)) continue;
    seen.add(`${m[1]}:${i}`);
    const end = findBodyEndLine(maskedLines, i);
    out.push({
      name: m[1], kind: vscode.SymbolKind.Function,
      range: new vscode.Range(i, 0, end, (lines[end] || '').length),
      selectionRange: new vscode.Range(i, 0, i, line.length),
      children: []
    });
  }
  return out;
}

function isFunctionSymbol(s) {
  return [vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor, vscode.SymbolKind.Operator].includes(s.kind);
}

// Which emitted function holds the instructions for `line` of file `key`.
function functionForLine(analysis, key, line) {
  const users = [...new Set((analysis.lineIndex.get(key)?.get(line) || []).map(e => e.fn).filter(Boolean))];
  if (users.length) {
    // The function the line belongs to (by name before lambdas and inlined library code), else the smallest user.
    const inside = key === analysis.rootPathKey ? users.filter(f => f.sourceRange && f.sourceRange.start.line <= line && line <= f.sourceRange.end.line) : [];
    const own = inside.find(f => sameName(normalizeName(f.name), normalizeName(f.sourceName))) || inside[0];
    return own || users.slice().sort((a, b) => a.count - b.count)[0];
  }
  if (key === analysis.rootPathKey) {
    return analysis.functions.find(f => f.sourceRange && f.sourceRange.start.line <= line && line <= f.sourceRange.end.line);
  }
  return undefined;
}

// A function's instructions as inlined into the functions that use it.
function inlinedResultFor(sym, analysis, key) {
  if (!sym || !sym.range) return undefined;
  const s = sym.range.start.line, e = sym.range.end.line;
  const rows = [];
  const users = new Set();
  for (const f of analysis.functions) {
    const mine = f.instructionRows.filter(r => r.ref && r.ref.key === key && r.ref.line >= s && r.ref.line <= e);
    if (!mine.length) continue;
    users.add(f.sourceName || f.name);
    rows.push(...mine);
  }
  if (!rows.length) return undefined;
  return { name: sym.name, sourceName: `${sym.name} (inlined)`, rows, instructionRows: rows, count: rows.length, users: [...users], fileKeys: new Set([key]) };
}

// The analyses that cover `document`, newest first: its own analysis (if it
// found code) and the analyses of files that include it.
function analysesFor(document) {
  const own = lastAnalysis.get(fileKey(document));
  if (document.uri.scheme !== 'file') return own ? [own] : [];
  const key = docPathKey(document);
  const list = [...lastAnalysis.values()]
    .filter(a => (a === own ? a.functions.length > 0 : a.deps.has(key)))
    .sort((a, b) => b.timestamp - a.timestamp);
  return list.length || !own ? list : [own];
}

function analysisFor(document) {
  return analysesFor(document)[0];
}

// What is known about the function `sym` of `document`. The newest analysis
// decides, and older ones made with the same compiler fill its gaps: a header
// analyzed on its own emits functions that a .cpp analyzed later does not use.
// Requested template instantiations are compiled only in the file's own
// analysis, so it comes first for a template that has them.
function codeFor(document, sym, { template = false } = {}) {
  const key = docPathKey(document);
  const all = analysesFor(document);
  const own = lastAnalysis.get(fileKey(document));
  const same = all.filter(a => a.compilerId === all[0].compilerId);
  const ordered = template && same.includes(own) && instantiationsFor(document).length ? [own, ...same.filter(a => a !== own)] : same;
  // A function that does not compile now is not shown with the code it used to have.
  const first = ordered[0];
  const line = sym.range?.start.line;
  const skipped = line !== undefined && (first.skipped || []).some(k => k.key === key && line >= k.startLine && line <= k.endLine);
  for (const analysis of skipped ? [] : ordered) {
    const results = findAllFunctionResults(sym, analysis.functions, key, analysis.rootPathKey);
    const inlined = results.length ? undefined : inlinedResultFor(sym, analysis, key);
    if (results.length || inlined) return { analysis, results, inlined, skipped: false };
  }
  return { analysis: first, results: [], inlined: undefined, skipped };
}

// The analysis to use for line `line` of `document`: the first of them that has code for it.
function analysisAt(document, line) {
  const all = analysesFor(document);
  if (!all.length) return undefined;
  const key = docPathKey(document);
  const hasLine = a => a.lineIndex.get(key)?.get(line)?.length > 0
    || (key === a.rootPathKey && a.functions.some(f => f.sourceRange && f.sourceRange.start.line <= line && line <= f.sourceRange.end.line));
  return all.filter(a => a.compilerId === all[0].compilerId).find(hasLine) || all[0];
}

function functionAtSignature(document, position, analysis, key) {
  if (key === analysis.rootPathKey) {
    const hits = analysis.functions.filter(f => f.sourceRange && (f.sourceSelection || f.sourceRange).contains(position));
    const hit = hits.find(f => sameName(normalizeName(f.name), normalizeName(f.sourceName))) || hits[0];
    if (hit) return hit;
  }
  const guessed = guessFunctionSymbols(document).find(s => s.range.start.line <= position.line && position.line <= s.selectionRange.start.line);
  return guessed ? findFunctionResult(guessed, analysis.functions, key, analysis.rootPathKey) : undefined;
}

// ---------------------------------------------------------------------------
// Template instantiation (C++)

function describeInstantiation(it) {
  return it.kind === 'class' ? `template ${it.keyword || 'class'} ${it.expr}` : it.expr;
}

function instantiationsFor(document) {
  const all = extContext?.workspaceState.get(INSTANTIATIONS_KEY, {}) || {};
  return Array.isArray(all[docPathKey(document)]) ? all[docPathKey(document)] : [];
}

async function setInstantiations(document, list) {
  const all = { ...(extContext.workspaceState.get(INSTANTIATIONS_KEY, {}) || {}) };
  if (list.length) all[docPathKey(document)] = list; else delete all[docPathKey(document)];
  await extContext.workspaceState.update(INSTANTIATIONS_KEY, all);
}

// Source symbol -> template target, for the C++ functions of `document` that are templates.
const templateCache = new WeakMap();
function templateTargetsOf(document, functions) {
  const out = new Map();
  if (!/cpp/.test(document.languageId)) return out;
  let cached = templateCache.get(document);
  if (!cached || cached.version !== document.version) {
    const text = document.getText();
    const defs = scan.scanDefinitions(text);
    cached = { version: document.version, text, defs, templated: defs.filter(d => d.kind === 'function' && d.templated) };
    templateCache.set(document, cached);
  }
  if (!cached.templated.length) return out;
  for (const sym of functions) {
    const line = (sym.selectionRange || sym.range).start.line;
    if (!cached.templated.some(d => d.startLine <= line && line <= d.endLine)) continue;
    const target = scan.templateTargetAt(cached.text, line, cached.defs);
    if (target && !target.unsupported) out.set(sym, target);
  }
  return out;
}

function templateLenses(document, templates) {
  const out = [];
  const lines = new Set();
  for (const [sym, target] of templates) {
    if (lines.has(sym.range.start.line)) continue;
    lines.add(sym.range.start.line);
    out.push(new vscode.CodeLens(sym.range, {
      title: '$(symbol-type-parameter) Instantiate…',
      tooltip: `Choose template arguments for ${target.label} and see the code for them`,
      command: 'asmLens.instantiateTemplate',
      arguments: [document.uri, (sym.selectionRange || sym.range).start.line]
    }));
  }
  const list = instantiationsFor(document);
  if (list.length) {
    out.push(new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
      title: `$(symbol-type-parameter) Instantiated: ${list.map(describeInstantiation).join(', ')} · edit`,
      tooltip: 'Template instantiations compiled with this file. Click to remove some.',
      command: 'asmLens.manageInstantiations',
      arguments: [document.uri]
    }));
  }
  return out;
}

function bracketsBalanced(s) {
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{', '>': '<' };
  for (const c of s) {
    if ('([{<'.includes(c)) stack.push(c);
    else if (pairs[c]) { if (stack.pop() !== pairs[c]) return false; }
  }
  return !stack.length;
}

// Asks for template arguments for the template at `line` and compiles the file
// with that instantiation added (after its last line, so line numbers stay).
async function instantiateTemplate(uri, line) {
  const document = uri ? await vscode.workspace.openTextDocument(uri) : currentSourceDocument();
  if (!document) return;
  const editor = (vscode.window.visibleTextEditors || []).find(e => e.document === document);
  if (!/cpp/.test(document.languageId)) return vscode.window.showInformationMessage('Asm Lens: templates can be instantiated in C++ files only.');
  const at = Number.isInteger(line) ? line : editor?.selection?.active?.line ?? 0;
  const target = scan.templateTargetAt(document.getText(), at);
  if (!target) return vscode.window.showInformationMessage('Asm Lens: put the cursor in a template function, or in a member function of a class template, first.');
  if (target.unsupported) return vscode.window.showWarningMessage(`Asm Lens: ${target.unsupported}`);
  const remembered = extContext.workspaceState.get(TEMPLATE_ARGS_KEY, {}) || {};
  const args = [];
  for (const p of target.prompts) {
    const value = await vscode.window.showInputBox({
      title: `Asm Lens: instantiate ${target.label}`,
      prompt: `Template arguments for ${p.name}<${p.params}>`,
      value: remembered[p.name] ?? p.suggestion,
      placeHolder: 'for example: int    or    int, double    or    std::vector<int>',
      ignoreFocusOut: true,
      validateInput: v => bracketsBalanced(v) ? undefined : 'The brackets do not match.'
    });
    if (value === undefined) return;
    args.push(value.trim());
    remembered[p.name] = value.trim();
  }
  await extContext.workspaceState.update(TEMPLATE_ARGS_KEY, remembered);
  const request = target.make(args);
  const list = instantiationsFor(document);
  if (!list.some(x => x.kind === request.kind && x.expr === request.expr)) await setInstantiations(document, [...list, request]);
  outputChannel.appendLine(`Instantiating ${describeInstantiation(request)} in ${document.fileName}`);
  await analyzeDocument(document);
}

async function manageInstantiations(uri) {
  const document = uri ? await vscode.workspace.openTextDocument(uri) : currentSourceDocument();
  if (!document) return;
  const list = instantiationsFor(document);
  if (!list.length) return vscode.window.showInformationMessage('Asm Lens: no template instantiations for this file. Click "Instantiate…" above a template to add one.');
  const picks = await vscode.window.showQuickPick(list.map(it => ({ label: describeInstantiation(it), it })), { canPickMany: true, placeHolder: 'Select the instantiations to remove' });
  if (!picks || !picks.length) return;
  await setInstantiations(document, list.filter(it => !picks.some(p => p.it === it)));
  if (lastAnalysis.has(fileKey(document))) await analyzeDocument(document);
  else codeLensEmitter?.fire();
}

// Removes instantiation requests that did not compile and tells the user why.
async function dropFailedInstantiations(document, failed) {
  if (!failed.length) return;
  const list = instantiationsFor(document);
  const bad = new Set(failed.map(f => f.index));
  await setInstantiations(document, list.filter((_, i) => !bad.has(i)));
  for (const f of failed) {
    const it = list[f.index];
    if (!it) continue;
    outputChannel.appendLine(`  instantiation failed and was removed: ${describeInstantiation(it)}: ${f.message || 'compile error'}`);
    vscode.window.showWarningMessage(`Asm Lens: could not instantiate ${describeInstantiation(it)}${f.message ? `: ${f.message}` : ''}. It was removed; see the Asm Lens output for details.`);
  }
}

// Main-file lines (0-based) at or after `firstLine` that an error points at,
// directly or through its "required from here" / "requested here" notes.
// Warnings are ignored.
function instantiationLinesIn(errText, firstLine, isMainFile) {
  if (firstLine < 0) return [];
  const lines = new Set();
  const add = (file, line) => { if (isMainFile(file.trim()) && Number(line) - 1 >= firstLine) lines.add(Number(line) - 1); };
  for (const m of errText.matchAll(/^(.+?):(\d+)(?::\d+)?:\s*(?:(?:fatal )?error\b|.*\brequired from here\b|note:.*\brequested here\b)/gm)) add(m[1], m[2]);
  for (const m of errText.matchAll(/^(.+?)\((\d+)(?:,\d+)?\)\s*:\s*(?:(?:fatal )?error\b|note:\s*see reference to)/gm)) add(m[1], m[2]);
  return [...lines];
}

function blankLine(text, line) {
  const lines = text.split('\n');
  if (line >= 0 && line < lines.length) lines[line] = lines[line].replace(/[^\r]/g, ' ');
  return lines.join('\n');
}

function firstErrorMessage(errText) {
  return errorLocationsFrom(errText)[0]?.message || (errText.split('\n').find(l => /error/i.test(l)) || '').trim().slice(0, 300);
}

// ---------------------------------------------------------------------------
// Progress and cancellation
//
// Each analysis runs as a "job" (progress reporter + cancellation) kept in
// async-local storage, so the compile helpers below find it without passing it
// through every call.

const jobContext = new AsyncLocalStorage();

class Cancelled extends Error { constructor() { super('Cancelled.'); this.name = 'Cancelled'; } }

function report(message) {
  const job = jobContext.getStore();
  if (job) job.report(message);
}
function throwIfCancelled() {
  if (jobContext.getStore()?.cancelled) throw new Cancelled();
}

// Runs `task` with a progress UI: a notification with a progress bar and a
// Cancel button when the user asked for the analysis, a status-bar spinner for
// automatic ones (on save). The status-bar item and the CodeLens spin meanwhile.
function withJob(document, auto, task) {
  const name = path.basename(document.fileName);
  const key = fileKey(document);
  return vscode.window.withProgress({
    location: auto ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
    title: auto ? `Asm Lens: ${name}` : `Asm Lens: analyzing ${name}`,
    cancellable: !auto
  }, (progress, token) => {
    const job = {
      cancelled: false,
      aborts: new Set(),
      children: new Set(),
      report(message) {
        progress.report({ message });
        setBusyStatus(message);
      }
    };
    // reason: 'user' (Cancel button), 'outdated' (the text changed; a timer
    // analyzes again) or 'rerun' (analyze again as soon as this one stops).
    job.cancel = reason => {
      if (job.cancelled) return;
      job.cancelled = true;
      job.cancelReason = reason;
      if (reason === 'rerun') rerunAfter.add(key);
      for (const c of job.aborts) c.abort();
      for (const child of [...job.children]) child.kill();
    };
    token?.onCancellationRequested?.(() => job.cancel('user'));
    runningJobs.set(key, job);
    return jobContext.run(job, task).finally(() => { if (runningJobs.get(key) === job) runningJobs.delete(key); });
  });
}

function setBusyStatus(message) {
  if (!statusItem) return;
  statusItem.text = `$(sync~spin) Asm Lens${message ? `: ${message}` : ''}`;
  statusItem.tooltip = 'Asm Lens is compiling. Click to change the compiler.';
  statusItem.show();
}

// ---------------------------------------------------------------------------
// Analysis

async function analyzeDocument(document, { auto = false } = {}) {
  const key = fileKey(document);
  if (auto && Date.now() < rateLimitedUntil) return;
  if (analysisBusy.has(key)) {
    if (auto) runningJobs.get(key)?.cancel('rerun');
    return;
  }
  if (!LANGS.includes(document.languageId)) {
    return vscode.window.showWarningMessage(`Asm Lens supports C, C++, Objective-C, Rust, Go, Python, Zig, Swift, D and Fortran files (this file is "${document.languageId}").`);
  }
  analysisBusy.add(key);
  if (!analyzedFiles.has(key)) analyzedFiles.set(key, { uri: document.uri, deps: new Set([docPathKey(document)]), stamp: 0 });
  codeLensEmitter?.fire();
  try {
    await withJob(document, auto, () => runAnalysis(document));
  } finally {
    analysisBusy.delete(key);
    codeLensEmitter?.fire();
    await refreshStatusBar();
    if (rerunAfter.delete(key)) analyzeDocument(document, { auto: true });
  }
}

async function runAnalysis(document) {
  // Ask the language server for the file's functions now, in parallel with the
  // compile (it can be slow while it indexes); the answer is used at the end.
  const job = jobContext.getStore();
  if (job) {
    job.startVersion = document.version;
    job.symbols = Promise.resolve(vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri)).then(s => s || [], () => []);
    job.symbolsVersion = document.version;
  }
  try {
    report('reading settings…');
    const settings = config();
    const resolved = await resolveSettings(document);
    if (resolved.configError) vscode.window.showWarningMessage(`Asm Lens: ${resolved.configError} Using VS Code settings instead.`);
    if (resolved.lang && resolved.lang.family !== 'c') return await analyzeOtherLanguage(document, resolved, settings);
    if (resolved.mode === 'local') return await analyzeLocal(document, resolved, settings);
    const { baseUrl, language } = resolved;
    // The syntax flag is Compiler Explorer's job (filters.intel), per compiler: -masm=intel would break MSVC and non-x86 compilers.
    const stripped = flagsLib.stripSyntaxFlags([resolved.flags, ...resolved.defines.map(d => `-D${d}`), resolved.extraFlags].filter(Boolean).join(' '));
    const compilerId = resolved.active.id;
    const timeoutMs = settings.get('requestTimeoutMs', 60000);
    // The same flags serve every compiler: -O2 -std=c++20 becomes /O2 /std:c++20 for MSVC (and the other way round).
    const msvcStyle = flagsLib.isMsvcStyle(compilerId, resolved.active.name);
    const adapted = flagsLib.adaptFlags(stripped.flags, msvcStyle, { cxx: language !== 'c' });
    if (adapted.changes.length) outputChannel.appendLine(`Flags for ${compilerId}: ${adapted.changes.join(', ')}`);
    const { flags } = adapted, { syntax } = stripped;
    // MSVC does not know __attribute__((used)): functions are kept by taking their address (clang-cl knows it).
    const marksKey = `${document.uri.toString()}\n${compilerId}\n${flags}`;
    const marks = marksRejected.has(marksKey) ? 'none' : msvcStyle && !/clang/i.test(`${compilerId} ${resolved.active.name || ''}`) ? 'address' : 'attribute';
    const prepared = prepareCSource(document, { marks });
    report('finding local headers…');
    const includeBundle = await collectLocalIncludes(document, resolved.includePaths, {
      maxFiles: resolved.maxIncludeFiles, buildFolders: resolved.buildFolders,
      excludePaths: resolved.excludePaths, uploadSystemHeaders: resolved.uploadSystemHeaders
    });
    const maxAttempts = Math.max(1, Number(settings.get('maxRecoveryAttempts', 12)));
    const recoverErrors = settings.get('skipFailingFunctions', true);
    const opts = {
      baseUrl, compilerId, language, timeoutMs, flags, syntax, includeBundle, maxAttempts, recoverErrors, rootFile: document.fileName,
      instFirstLine: prepared.firstLine, instCount: prepared.instCount, original: prepared.plain
    };
    let compiled, keptFailed = false;
    if (prepared.kept !== undefined) {
      try { compiled = await compileWithRecovery({ ...opts, source: prepared.kept, kept: true }); }
      catch (e) {
        // Cancelled, timed out or rate-limited: compiling the plain text would not help.
        if (e.name === 'AbortError' || e.name === 'TimeoutError' || e.name === 'Cancelled' || Date.now() < rateLimitedUntil) throw e;
        keptFailed = true;
        outputChannel.appendLine(`  compiling it again without ${marks === 'address' ? 'the lines that keep its functions' : '__attribute__((used))'}`);
      }
    }
    if (!compiled) {
      compiled = await compileWithRecovery({ ...opts, source: prepared.plain });
      // The text as written compiled at once, so the marks were the problem: not tried again for this file and compiler.
      if (keptFailed && !compiled.skipped.length && !compiled.stubbed.length && !compiled.removedFlags.length) {
        if (marksRejected.size > 200) marksRejected.clear();
        marksRejected.add(marksKey);
      }
    }
    const { data, effectiveFlags } = compiled;
    const asmRows = Array.isArray(data.asm) ? data.asm : [];
    const rootPathKey = docPathKey(document);
    const paths = new Map([[rootPathKey, document.uri.fsPath]]);
    for (const entry of includeBundle.pathMap) paths.set(normPath(entry.real), entry.real);
    const result = await recordAnalysis(document, {
      rows: asmRows,
      resolveRef: makeRefResolver(rootPathKey, includeBundle.pathMap),
      compilerId,
      compilerLabel: resolved.active.name || compilerId,
      flags: effectiveFlags,
      includeCount: includeBundle.files.length,
      configFile: resolved.configFile,
      deps: new Set([rootPathKey, ...includeBundle.pathMap.map(e => normPath(e.real))]),
      paths,
      skipped: compiled.skipped.map(k => {
        const entry = k.key === 'main' ? undefined : includeBundle.pathMap.find(e => e.virtual === k.key);
        return { ...k, key: k.key === 'main' ? rootPathKey : entry ? normPath(entry.real) : k.key };
      }),
      stubbed: compiled.stubbed
    });
    const functions = result.functions;
    const totalInstr = functions.reduce((n, f) => n + f.instructionRows.length, 0);
    const mappedInstr = functions.reduce((n, f) => n + f.instructionRows.filter(r => r.ref).length, 0);
    const metaRows = asmRows.filter(r => r && typeof r === 'object' && r.source).length;
    outputChannel.appendLine(`Source mapping: ${mappedInstr}/${totalInstr} instructions mapped to local files (${metaRows} rows carried Compiler Explorer source metadata).`);
    if (totalInstr && !mappedInstr) outputChannel.appendLine('  No instruction could be mapped: hover highlighting needs debug line info from the compiler. Sample rows: ' + JSON.stringify(asmRows.slice(0, 5)));
    const notes = [];
    if (includeBundle.unresolved.length) notes.push(`${includeBundle.unresolved.length} quoted include(s) not found`);
    if (compiled.stubbed.length) notes.push(`${compiled.stubbed.length} header(s) replaced by empty files`);
    if (compiled.skipped.length) notes.push(`${compiled.skipped.length} function/declaration(s) skipped because they do not compile`);
    if (compiled.removedFlags.length) notes.push(`flags the compiler does not accept were left out: ${compiled.removedFlags.join(' ')}`);
    if (includeBundle.truncated) notes.push(`include upload limited to ${includeBundle.files.length} files`);
    outputChannel.appendLine(`Compiled ${document.fileName} with ${compilerId} ${effectiveFlags}; sent ${includeBundle.pathMap.length} local header file(s); found ${functions.length} emitted function(s).${notes.length ? ' ' + notes.join('; ') + '.' : ''}`);
    for (const d of includeBundle.autoDirs) outputChannel.appendLine(`  auto-detected include directory: ${d}`);
    for (const e of includeBundle.pathMap) outputChannel.appendLine(`  uploaded ${e.virtual}  <-  ${e.real}`);
    if (includeBundle.skippedSystem?.length) outputChannel.appendLine(`  system headers left to the compiler: ${includeBundle.skippedSystem.join(', ')}`);
    for (const n of compiled.stubbed) outputChannel.appendLine(`  header treated as empty: ${n}`);
    for (const k of compiled.skipped) outputChannel.appendLine(`  skipped (does not compile): ${k.name || '(declaration)'} at ${path.basename(k.file)}:${k.startLine + 1}-${k.endLine + 1}`);
    for (const u of includeBundle.unresolved) outputChannel.appendLine(`  not found: #include "${u.name}" (from ${u.from})`);
    if (includeBundle.truncated) outputChannel.appendLine('  include discovery stopped at the asmLens.maxIncludeFiles limit.');
    await dropFailedInstantiations(document, compiled.failedInstantiations);
    if (!functions.length && prepared.isHeader) return reportHeaderWithoutCode(document);
    vscode.window.showInformationMessage(`Asm Lens: found ${functions.length} emitted function bodies${includeBundle.pathMap.length ? `; uploaded ${includeBundle.pathMap.length} local header(s)` : ''}${notes.length ? ` (${notes.join('; ')}; see the Asm Lens output)` : ''}.`);
  } catch (e) {
    if (e.name === 'Cancelled' || jobContext.getStore()?.cancelled) {
      const reason = jobContext.getStore()?.cancelReason;
      outputChannel.appendLine(reason === 'user' || !reason ? `Cancelled: ${document.fileName}` : `Outdated (the file changed while compiling): ${document.fileName}`);
      return;
    }
    const message = e.name === 'AbortError' ? 'Compiler Explorer request timed out.' : e.message;
    outputChannel.appendLine(`Error: ${message}`);
    vscode.window.showErrorMessage(`Asm Lens: ${message}`);
  }
}

function reportHeaderWithoutCode(document) {
  const templates = /cpp/.test(document.languageId) && scan.scanDefinitions(document.getText()).some(d => d.kind === 'function' && d.templated);
  vscode.window.showInformationMessage(templates
    ? 'Asm Lens: this header emitted no code: its functions are templates. Click "Instantiate…" above a template to choose its types, or analyze a .cpp file that uses the header.'
    : 'Asm Lens: this header emitted no code (it only has declarations). Analyze a .cpp file that uses it, then come back to this file.');
}

// The text to compile for a C/C++ file. Functions a compiler leaves out when
// nothing calls them are kept: in a header compiled on its own all of them,
// elsewhere the in-class, inline, static and constexpr ones (with
// asmLens.emitUnusedFunctions). `marks` says how: 'attribute' marks them
// __attribute__((used)), 'address' (MSVC) appends lines that take their
// address, 'none' keeps nothing. `kept` is that text (undefined when nothing
// is kept) and `plain` the fallback. Requested template instantiations, then
// those lines, come after the file's last line, from `firstLine` on (-1: none).
function prepareCSource(document, { marks = 'attribute' } = {}) {
  const original = document.getText();
  const isHeader = HEADER_RE.test(document.fileName);
  const insts = /cpp/.test(document.languageId) ? instantiationsFor(document) : [];
  const withInsts = text => scan.appendInstantiations(text, insts).text;
  const plain = withInsts(original);
  const keep = marks !== 'none' && (isHeader || config().get('emitUnusedFunctions', true));
  let kept;
  if (keep && marks === 'attribute') {
    const marked = keepHeaderFunctions(original, { all: isHeader });
    if (marked !== original) kept = withInsts(marked);
  } else if (keep) {
    const lines = scan.keepByAddress(original, { c: document.languageId === 'c', all: isHeader });
    if (lines.length) kept = `${plain.endsWith('\n') ? plain : `${plain}\n`}${lines.join('\n')}\n`;
  }
  const base = original.endsWith('\n') ? original : `${original}\n`;
  const appended = insts.length || (kept !== undefined && marks === 'address');
  return { isHeader, firstLine: appended ? (base.match(/\n/g) || []).length : -1, instCount: insts.length, kept, plain };
}

// "file \n compiler \n flags" for which the kept text failed and the plain text compiled.
const marksRejected = new Set();

// Undoes __attribute__((used)) on the main-file lines the compiler complains about.
function revertKeptLines(source, original, lines) {
  if (!original) return undefined;
  const a = source.split('\n'), b = original.split('\n');
  let changed = false;
  for (const l of lines) {
    if (a[l] !== undefined && b[l] !== undefined && a[l] !== b[l] && a[l].includes('__attribute__((used))')) { a[l] = b[l]; changed = true; }
  }
  return changed ? a.join('\n') : undefined;
}

let lastStamp = 0;

// Parses rows (Compiler Explorer style), matches functions with the document's
// symbols, stores the analysis and refreshes CodeLens.
async function recordAnalysis(document, o) {
  throwIfCancelled();
  const running = jobContext.getStore();
  if (running && running.startVersion !== undefined && running.startVersion !== document.version) {
    // The text changed while compiling: these results belong to the old text.
    running.cancel(reanalysisTimers.has(fileKey(document)) ? 'outdated' : 'rerun');
    throw new Cancelled();
  }
  report('matching functions with the source…');
  const rootPathKey = docPathKey(document);
  const functions = mergeFunctionParts(parseFunctions(o.rows, o.resolveRef));
  const job = jobContext.getStore();
  const symbols = (job?.symbols && job.symbolsVersion === document.version
    ? await job.symbols
    : await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri)) || [];
  const allSourceFunctions = sourceFunctionsOf(document, symbols);
  const matched = functions.map(fn => {
    const symbol = matchSourceSymbol(fn.name, allSourceFunctions, fn, rootPathKey, { requireName: o.requireName });
    return { ...fn, sourceName: symbol?.name || fn.name, sourceRange: symbol?.range, sourceSelection: symbol?.selectionRange };
  });
  let deps = o.deps;
  if (!deps) { deps = new Set([rootPathKey]); for (const f of functions) for (const k of f.fileKeys) deps.add(k); }
  let paths = o.paths;
  if (!paths) { paths = new Map([[rootPathKey, document.uri.fsPath]]); for (const k of deps) if (k !== rootPathKey) paths.set(k, o.resolveRef?.pathOf?.get(k) || k); }
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  const result = {
    functions: matched,
    lineIndex: buildLineIndex(matched),
    asmText: o.asmText ?? o.rows.map(r => typeof r === 'string' ? r : r.text || '').join('\n'),
    asmRows: o.rows,
    compilerId: o.compilerId,
    compilerLabel: o.compilerLabel,
    flags: o.flags,
    includeCount: o.includeCount || 0,
    rootKey: fileKey(document),
    configFile: o.configFile,
    rootPath: document.uri.fsPath,
    rootPathKey,
    deps,
    paths,
    timestamp: lastStamp,
    skipped: o.skipped || [],
    stubbed: o.stubbed || [],
    sourceVersion: document.version
  };
  lastAnalysis.set(fileKey(document), result);
  analyzedFiles.set(fileKey(document), { uri: document.uri, deps, stamp: lastStamp });
  codeLensEmitter?.fire();
  refreshPanel(result);
  return result;
}

// ---------------------------------------------------------------------------
// Local mode: compile only the current file with a local compiler (no upload,
// no project build). Headers are read straight from disk by the compiler.

function splitArgs(s) {
  return (String(s || '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).map(a => a.replace(/^(["'])(.*)\1$/, '$2'));
}

function runProcess(cmd, args, { cwd, input, timeoutMs }) {
  const job = jobContext.getStore();
  if (job?.cancelled) return Promise.reject(new Cancelled());
  return new Promise((resolve, reject) => {
    let child;
    // Its own process group (POSIX), so cancelling also stops what the compiler started (cc1plus, as, ...).
    try { child = spawn(cmd, args, { cwd, windowsHide: true, detached: !IS_WIN }); } catch (e) { return reject(e); }
    const out = [], err = [];
    let done = false;
    const finish = fn => { if (done) return; done = true; clearTimeout(timer); job?.children.delete(entry); fn(); };
    const entry = { kill: () => { killTree(child); finish(() => reject(new Cancelled())); } };
    job?.children.add(entry);
    const timer = setTimeout(() => { killTree(child); finish(() => reject(new Error(`${cmd} timed out.`))); }, timeoutMs || 60000);
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', e => finish(() => {
      if (e.code !== 'ENOENT') return reject(e);
      const missing = new Error(`"${cmd}" was not found. Install it or set "compiler" in .asm-lens.json.`);
      missing.code = 'ENOENT';
      reject(missing);
    }));
    child.on('close', code => finish(() => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })));
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}

// Stops a process and everything it started.
function killTree(child) {
  if (!child.pid) return;
  try {
    if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill());
    else process.kill(-child.pid, 'SIGKILL');
  } catch (_) {
    try { child.kill('SIGKILL'); } catch (__) { /* already gone */ }
  }
}

// [[folder with symlinks resolved, folder as the editor names it], ...]
function realDirsFor(dirs) {
  return Promise.all([...new Set(dirs)].map(async d => [await fs.realpath(d).catch(() => d), d]));
}

// Demangles symbol names with the first demangler that is installed.
async function demangle(text, demanglers, cwd, timeoutMs) {
  for (const [cmd, args] of demanglers) {
    try {
      const d = await runProcess(cmd, args, { cwd, input: text, timeoutMs });
      if (d.code === 0 && d.stdout) return d.stdout;
    } catch (_) { /* not installed: try the next one */ }
  }
  return text;
}

// Clang for Windows (MSVC target) writes MSVC-mangled names, which c++filt does
// not read; llvm-undname (installed with LLVM) does. Names stay as they are
// when it is missing.
async function demangleMsvc(asm, cwd, timeoutMs) {
  const names = [...new Set((asm.match(/"\?[^"\s]+"/g) || []).map(s => s.slice(1, -1)))];
  if (!names.length) return asm;
  const input = `${names.join('\n')}\n`;
  let out;
  for (const args of [['--no-calling-convention', '--no-access-specifier', '--no-member-type'], []]) {
    try {
      const r = await runProcess('llvm-undname', args, { cwd, input, timeoutMs });
      if (r.code === 0 && r.stdout) { out = r.stdout; break; }
    } catch (e) {
      if (e.name === 'Cancelled') throw e;
      return asm;
    }
  }
  if (!out) return asm;
  // Output: each mangled name on a line, its demangled form on the next.
  const lines = out.split(/\r?\n/).map(l => l.trim());
  const wanted = new Set(names);
  const map = new Map();
  for (let i = 0; i + 1 < lines.length; i++) {
    if (wanted.has(lines[i]) && lines[i + 1] && !/^error\b/i.test(lines[i + 1]) && !wanted.has(lines[i + 1])) map.set(lines[i], lines[i + 1]);
  }
  return map.size ? asm.replace(/"(\?[^"\s]+)"/g, (all, name) => map.get(name) || all) : asm;
}

function errorsOnly(err) {
  const lines = err.split('\n').filter(l => /\berror\b|fatal/i.test(l)).slice(0, 25).join('\n');
  return (lines || err).slice(0, 1800);
}

// How to compile a C/C++ file locally: compiler, folder to run it in, flags
// (without syntax flags) and where they came from. The entry of
// compile_commands.json when one fits (the file's own, that of a file including
// it, or one in the nearest folder), else the settings.
async function localCompilePlan(document, resolved, baseDir) {
  const fileDir = path.dirname(document.uri.fsPath);
  if (resolved.compileCommands && resolved.compileCommands.length) {
    const db = await compileCommands.loadDatabases(resolved.compileCommands);
    for (const e of db.errors) outputChannel.appendLine(`compile_commands: ${e}`);
    const match = await compileCommands.entryFor(db, document.uri.fsPath, { includedBy: includersOf(document) });
    if (match) {
      const { args, syntax } = flagsLib.stripSyntaxArgs([...flagsLib.compileFlagsOf(match.entry), ...splitArgs(resolved.activeExtraFlags)]);
      return {
        compiler: flagsLib.entryCompiler(match.entry),
        cwd: match.entry.directory,
        args, syntax, fromDatabase: true,
        display: 'compile_commands.json',
        description: `compile_commands.json: ${match.reason} (${match.entry.file}, from ${match.entry.database})`
      };
    }
    outputChannel.appendLine(`compile_commands: no entry for ${document.fileName}; using the settings.`);
  }
  const incDirs = (resolved.includePaths || []).map(p => p && typeof p === 'object' ? p.dir : (path.isAbsolute(p) ? p : path.resolve(baseDir, p)));
  // Flags written for MSVC (/O2 /std:c++20) are given in the GCC/Clang form.
  const adapted = flagsLib.adaptFlags([resolved.flags, ...resolved.defines.map(d => `-D${d}`), resolved.extraFlags].filter(Boolean).join(' '), false);
  if (adapted.changes.length) outputChannel.appendLine(`Flags for ${path.basename(resolved.localCompiler || '')}: ${adapted.changes.join(', ')}`);
  const { flags } = adapted;
  const { args, syntax } = flagsLib.stripSyntaxArgs([...splitArgs(flags), ...incDirs.map(d => `-I${d}`)]);
  return {
    compiler: resolved.localCompiler, cwd: fileDir, args, syntax, fromDatabase: false,
    display: flagsLib.stripSyntaxFlags(flags).flags,
    description: resolved.configFile ? `settings from ${resolved.configFile}` : 'VS Code settings'
  };
}

// Analyzed files that include `document` (newest first): their compile_commands entries fit a header.
function includersOf(document) {
  const key = docPathKey(document);
  return [...analyzedFiles.entries()]
    .filter(([rootKey, e]) => rootKey !== fileKey(document) && e.deps.has(key) && e.uri.scheme === 'file')
    .sort((a, b) => b[1].stamp - a[1].stamp)
    .map(([, e]) => e.uri.fsPath);
}

// What a local compiler is (gcc, clang, msvc or unknown) and what it targets. Cached per command.
const compilerInfoCache = new Map();
async function compilerInfo(command, cwd, timeoutMs) {
  const key = `${command}\n${/[\\/]/.test(command) ? '' : cwd}`;
  if (!compilerInfoCache.has(key)) {
    const run = args => runProcess(command, args, { cwd, timeoutMs }).then(r => `${r.stdout}\n${r.stderr}`, e => { if (e.code === 'ENOENT' || e.name === 'Cancelled') throw e; return ''; });
    const version = await run(['--version']);
    const kind = flagsLib.compilerKind(version, command);
    const target = kind === 'gcc' || kind === 'clang' ? (await run(['-dumpmachine'])).trim().split(/\r?\n/)[0] : '';
    compilerInfoCache.set(key, { kind, target, version: version.trim().split(/\r?\n/)[0] });
  }
  return compilerInfoCache.get(key);
}

function quoteArg(a) { return /[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a; }

async function analyzeLocal(document, resolved, settings) {
  if (document.uri.scheme !== 'file') throw new Error('Local mode needs a file that is saved on disk.');
  const rootPathKey = docPathKey(document);
  const fileDir = path.dirname(document.uri.fsPath);
  const baseDir = vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath || fileDir;
  const timeoutMs = settings.get('requestTimeoutMs', 60000);
  const maxAttempts = Math.max(1, Number(settings.get('maxRecoveryAttempts', 12)));
  const recoverErrors = settings.get('skipFailingFunctions', true);
  const lang = resolved.language === 'c' ? 'c' : 'c++';
  const plan = await localCompilePlan(document, resolved, baseDir);
  const { compiler, cwd } = plan;
  const info = await compilerInfo(compiler, cwd, timeoutMs);
  if (info.kind === 'msvc') {
    throw new Error(`${path.basename(compiler)} is an MSVC-style compiler, which local mode does not support (it needs a GCC- or Clang-compatible one). Use remote mode with an MSVC compiler from Compiler Explorer, or a MinGW/Clang build.`);
  }
  // Intel syntax for x86 targets, in the form this compiler understands; nothing for other targets.
  let ownFlags = [...flagsLib.syntaxArgs(info.kind, flagsLib.targetOf(plan.args, info.target), plan.syntax), '-fdiagnostics-color=never'];
  let baseArgs = plan.args;
  const removedFlags = [];
  let addedStd = '';

  // Empty stand-ins for headers that are not found anywhere.
  const stubDir = path.join(os.tmpdir(), 'asm-lens-stubs-' + crypto.createHash('md5').update(document.uri.fsPath).digest('hex').slice(0, 10));
  await fs.rm(stubDir, { recursive: true, force: true });
  const stubbed = [];
  const skipped = [];
  const prepared = prepareCSource(document);
  let source = prepared.kept ?? prepared.plain;
  let keptHeader = prepared.kept !== undefined;
  const failedInstantiations = [];
  const failedLines = new Set();
  const isMain = f => /(?:^|[\\/])<stdin>$/.test(f);
  let asm;
  const started = Date.now();

  let args;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // The editor text goes in through stdin, so quoted includes are looked up next to the file with -iquote.
    args = [
      ...baseArgs, ...ownFlags, '-iquote', fileDir,
      ...(stubbed.length ? [`-I${stubDir}`] : []),
      '-S', '-g', '-o', '-', ...(plan.fromDatabase ? ['-w'] : []), '-x', lang, '-'
    ];
    report(attempt === 1 ? `compiling with ${path.basename(compiler)}…` : `compiling again (${attempt}/${maxAttempts}), working around errors…`);
    const r = await runProcess(compiler, args, { cwd, input: source, timeoutMs });
    if (r.code === 0) { asm = r.stdout; break; }
    const err = r.stderr.replace(ANSI_RE, '');
    let progressed = false;
    // A compiler whose default is C++98 (Apple clang 14, GCC 5) and no -std given -> C++17, the default of current ones.
    if (lang === 'c++' && !addedStd && !baseArgs.some(a => /^-std=/.test(a)) && flagsLib.needsNewerStd(err)) {
      addedStd = '-std=gnu++17';
      ownFlags = [...ownFlags, addedStd];
      outputChannel.appendLine(`  ${path.basename(compiler)} defaults to an older C++ standard: added ${addedStd} (put a -std flag in the flags to choose another)`);
      continue;
    }
    // A flag the compiler does not accept -> leave it out.
    const rejected = flagsLib.rejectedFlagsFrom(err);
    if (rejected.length) {
      const a = flagsLib.removeArgs(baseArgs, rejected), b = flagsLib.removeArgs(ownFlags, rejected);
      if (a.removed.length || b.removed.length) {
        baseArgs = a.args; ownFlags = b.args;
        removedFlags.push(...a.removed, ...b.removed);
        outputChannel.appendLine(`  left out flags the compiler does not accept: ${[...a.removed, ...b.removed].join(' ')}`);
        continue;
      }
    }
    for (const name of missingIncludesFrom(err)) {
      const stub = stubFilename(name);
      if (!stub || stubbed.includes(name)) continue;
      const target = path.join(stubDir, stub);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, '\n');
      stubbed.push(name);
      progressed = true;
    }
    // A requested template instantiation that does not compile is dropped.
    if (!progressed) {
      const message = firstErrorMessage(err);
      for (const l of instantiationLinesIn(err, prepared.firstLine, isMain)) {
        if (failedLines.has(l)) continue;
        failedLines.add(l);
        source = blankLine(source, l);
        if (l - prepared.firstLine < prepared.instCount) failedInstantiations.push({ index: l - prepared.firstLine, message });
        progressed = true;
      }
    }
    if (!progressed && keptHeader) {
      const reverted = revertKeptLines(source, prepared.plain, errorLocationsFrom(err).filter(loc => isMain(loc.file)).map(loc => loc.line));
      if (reverted !== undefined) { source = reverted; progressed = true; }
    }
    // Other errors while the header's functions are kept: compile the text as written first,
    // so that what Asm Lens added never makes a function count as "Not compiled".
    if (!progressed && keptHeader) {
      keptHeader = false;
      source = prepared.plain;
      for (const l of failedLines) source = blankLine(source, l);
      outputChannel.appendLine('  compiling it as written (without the added marks)');
      continue;
    }
    if (!progressed && recoverErrors) {
      for (const loc of errorLocationsFrom(err)) {
        if (!isMain(loc.file)) continue;
        const cut = blankEnclosingDeclaration(source, loc.line);
        if (!cut) continue;
        source = cut.text;
        skipped.push({ name: cut.name, file: document.fileName, key: rootPathKey, startLine: cut.startLine, endLine: cut.endLine });
        progressed = true;
      }
    }
    if (!progressed && keptHeader) {
      keptHeader = false;
      source = prepared.plain;
      for (const l of failedLines) source = blankLine(source, l);
      skipped.length = 0;
      outputChannel.appendLine('  retrying without __attribute__((used))');
      continue;
    }
    if (!progressed || attempt === maxAttempts) {
      outputChannel.appendLine(`Local compile command (in ${cwd}): ${[compiler, ...args].map(quoteArg).join(' ')}`);
      outputChannel.appendLine(`  flags from: ${plan.description}`);
      outputChannel.appendLine('--- full compiler output ---\n' + err);
      throw new Error(errorsOnly(err));
    }
  }

  // Demangle names (if c++filt exists) so they match source function names.
  report('reading the assembly…');
  const macho = isMachO(asm);
  if (macho) asm = prepareMachO(asm);
  asm = await demangle(asm, [['c++filt', []], ['llvm-cxxfilt', []]], cwd, timeoutMs);
  if (macho) asm = finishMachO(asm);
  asm = await demangleMsvc(asm, cwd, timeoutMs);

  const rows = localAsmToRows(asm, cwd);
  const result = await recordAnalysis(document, {
    rows,
    resolveRef: makeLocalRefResolver(rootPathKey, cwd, [], await realDirsFor([cwd, fileDir, baseDir])),
    compilerId: compiler,
    compilerLabel: `${path.basename(compiler)} (local)`,
    flags: [plan.display, addedStd].filter(Boolean).join(' '),
    configFile: resolved.configFile,
    skipped: skipped.filter(k => prepared.firstLine < 0 || k.startLine < prepared.firstLine),
    stubbed
  });
  const ms = Date.now() - started;
  outputChannel.appendLine(`Local compile of ${document.fileName} took ${ms} ms; found ${result.functions.length} emitted function(s).`);
  outputChannel.appendLine(`  flags from: ${plan.description}`);
  outputChannel.appendLine(`  command (in ${cwd}): ${[compiler, ...args].map(quoteArg).join(' ')}`);
  if (removedFlags.length) outputChannel.appendLine(`  left out (the compiler does not accept them): ${removedFlags.join(' ')}`);
  for (const n of stubbed) outputChannel.appendLine(`  missing header treated as empty: ${n}`);
  for (const k of skipped) outputChannel.appendLine(`  skipped (does not compile): ${k.name || '(declaration)'} at line ${k.startLine + 1}-${k.endLine + 1}`);
  await dropFailedInstantiations(document, failedInstantiations);
  if (!result.functions.length && prepared.isHeader) return reportHeaderWithoutCode(document);
  vscode.window.showInformationMessage(`Asm Lens (local): found ${result.functions.length} emitted function bodies in ${ms} ms${stubbed.length || skipped.length ? ' (see the Asm Lens output)' : ''}.`);
}

// ---------------------------------------------------------------------------
// Rust, Go, Python, Zig, Swift, D, Fortran: one file, compiled as is.

const EMPTY_HINTS = {
  rust: 'Rust compiles only `pub` functions (and what they use) into a library: make the functions you want to see `pub`, or add `#[no_mangle]`.',
  zig: 'Zig compiles only exported functions and what they use: mark them `export`.',
  swift: 'Swift may drop unused private functions: make them `public`.',
  d: 'Templates are compiled only when used.'
};

async function analyzeOtherLanguage(document, resolved, settings) {
  const { lang } = resolved;
  const timeoutMs = settings.get('requestTimeoutMs', 60000);
  const rootPathKey = docPathKey(document);
  const required = lang.requiredFlags && !String(resolved.flags).includes(lang.requiredFlags) ? lang.requiredFlags : '';
  let flags = [resolved.flags, resolved.extraFlags, required].filter(Boolean).join(' ');
  const started = Date.now();
  let rows, resolveRef, compilerId, compilerLabel;
  if (resolved.mode === 'local') {
    if (!lang.local) throw new Error(`Local mode is not available for ${lang.label}. Add a ${lang.label} compiler with "mode": "remote" to .asm-lens.json to use Compiler Explorer for it.`);
    report(`compiling with ${path.basename(resolved.localCompiler || '')}…`);
    ({ rows, resolveRef } = await compileOtherLocally(document, resolved, splitArgs(flags), timeoutMs));
    compilerId = resolved.localCompiler;
    compilerLabel = `${path.basename(compilerId)} (local)`;
  } else {
    compilerId = resolved.active.isDefault ? await ceDefaultCompiler(resolved.baseUrl, lang) : resolved.active.id;
    compilerLabel = resolved.active.isDefault ? `${lang.label} ${compilerId}` : resolved.active.name || compilerId;
    report(`compiling with ${compilerId} on ${hostOf(resolved.baseUrl)}…`);
    let { flags: sent, syntax } = flagsLib.stripSyntaxFlags(flags);
    let data;
    for (let attempt = 1; ; attempt++) {
      data = await postCompile({ baseUrl: resolved.baseUrl, compilerId, language: lang.id, timeoutMs, source: document.getText(), files: [], flags: sent, syntax });
      if (data.code === undefined || data.code === 0) break;
      const err = stderrText(data) || `Compiler exited with code ${data.code}`;
      const rejected = flagsLib.removeFlags(sent, flagsLib.rejectedFlagsFrom(err));
      if (rejected.removed.length && attempt < 4) {
        sent = rejected.flags;
        outputChannel.appendLine(`  left out flags the compiler does not accept: ${rejected.removed.join(' ')}`);
        continue;
      }
      outputChannel.appendLine(`--- ${compilerId} output ---\n${err}`);
      throw new Error(err.slice(0, 1800));
    }
    flags = sent;
    rows = languages.remoteRows(lang.key, Array.isArray(data.asm) ? data.asm : []);
    resolveRef = makeRefResolver(rootPathKey, []);
  }
  const result = await recordAnalysis(document, { rows, resolveRef, compilerId, compilerLabel, flags, configFile: resolved.configFile, requireName: lang.requireName });
  const mine = result.functions.filter(f => f.sourceRange).length;
  outputChannel.appendLine(`Compiled ${document.fileName} (${lang.label}) with ${compilerId} ${flags} in ${Date.now() - started} ms; found ${result.functions.length} emitted function(s), ${mine} matched to this file.`);
  const hint = !mine && EMPTY_HINTS[lang.key] ? ` ${EMPTY_HINTS[lang.key]}` : '';
  vscode.window.showInformationMessage(`Asm Lens: found ${result.functions.length} emitted function bodies (${lang.label}).${hint}`);
}

// Runs the language's local compiler on the file (or on a temporary copy when the
// editor has unsaved changes, or the compiler needs one) and returns rows.
async function compileOtherLocally(document, resolved, flags, timeoutMs) {
  const { lang } = resolved;
  const text = document.getText();
  const real = document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'asm-lens-'));
  try {
    const out = path.join(tmp, 'out.s');
    let file = real || path.join(tmp, `example${path.extname(document.fileName) || ''}`);
    let spec = languages.localCommand(lang.key, { file, out, flags, text });
    const copy = spec.copy || !real || (document.isDirty && spec.input === undefined) ? path.join(tmp, path.basename(file)) : undefined;
    if (copy) {
      await fs.writeFile(copy, spec.uniqueSuffix ? `${text}\n// asm-lens ${Date.now()}-${crypto.randomBytes(4).toString('hex')}\n` : text);
      file = copy;
      spec = languages.localCommand(lang.key, { file, out, flags, text });
      if (document.isDirty) outputChannel.appendLine(`  compiling a temporary copy with your unsaved changes: ${copy}`);
    }
    const cwd = spec.cwdTemp || copy ? tmp : path.dirname(file);
    const candidates = [resolved.localCompiler];
    if (lang.key === 'python' && resolved.localCompiler === lang.local) candidates.push('python3', 'python', 'py');
    let r;
    for (const cmd of [...new Set(candidates)]) {
      try { r = await runProcess(cmd, spec.args, { cwd, input: spec.input, timeoutMs }); resolved.localCompiler = cmd; break; }
      catch (e) { if (e.code !== 'ENOENT' || cmd === candidates[candidates.length - 1]) throw e; }
    }
    if (r.code !== 0) {
      outputChannel.appendLine(`Local compile command: ${resolved.localCompiler} ${spec.args.join(' ')}  (cwd ${cwd})`);
      outputChannel.appendLine('--- full compiler output ---\n' + (r.stderr || r.stdout));
      throw new Error(errorsOnly((r.stderr || r.stdout).replace(ANSI_RE, '')));
    }
    let output = spec.output === 'file' ? await fs.readFile(out, 'utf8') : spec.output === 'stderr' ? r.stderr : r.stdout;
    let rows;
    if (spec.format === 'python') rows = JSON.parse(output);
    else if (spec.format === 'go') rows = languages.goLocalRows(output, languages.goPackageName(text));
    else {
      const macho = isMachO(output);
      if (macho) output = prepareMachO(output);
      output = await demangle(output, spec.demanglers || [], cwd, timeoutMs);
      if (macho) output = finishMachO(output);
      rows = localAsmToRows(output, cwd);
    }
    const aliases = copy ? [copy, await fs.realpath(copy).catch(() => copy)] : [];
    const dirs = [cwd, real && path.dirname(real), real && vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath].filter(Boolean);
    return { rows, resolveRef: makeLocalRefResolver(docPathKey(document), cwd, aliases, await realDirsFor(dirs)) };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Compile with recovery
//
// A function that does not use a missing header should still be analyzable.
// When the compiler stops because of a missing include, we retry with that
// include replaced by an empty file. Uploaded headers that fail in the
// preprocessor (#error, malformed #if) are emptied the same way. When the
// remaining errors are inside specific functions, those functions are blanked
// out -- keeping every line number intact -- and we retry.

// Directives (debug info, section switches) and comment-only lines are left out
// on the server: the per-row source metadata still maps every instruction to its
// line, and the reply is 5 to 15 times smaller.
const CE_FILTERS = { binary: false, binaryObject: false, commentOnly: true, demangle: true, directives: true, execute: false, intel: true, labels: true, libraryCode: false, trim: false };

function hostOf(url) { try { return new URL(url).host; } catch (_) { return url; } }

// Replies for identical requests (same code, headers, compiler and flags), so
// analyzing unchanged code again is instant. Kept in memory for the session.
const replyCache = new Map();
// After HTTP 429 (too many requests), automatic re-analyses wait until this time.
let rateLimitedUntil = 0;
const REPLY_CACHE_SIZE = 40;

// How long a compile request waits before the progress shows the seconds.
const WAIT_SHOWN_AFTER_MS = 3000;

async function postCompile({ baseUrl, compilerId, language, timeoutMs, source, files, flags, syntax = 'intel' }) {
  const url = `${baseUrl}/api/compiler/${encodeURIComponent(compilerId)}/compile`;
  const filters = { ...CE_FILTERS, intel: syntax !== 'att' };
  const body = JSON.stringify({ source, lang: language, ...(files.length ? { files } : {}), options: { userArguments: flags, filters } });
  const cacheKey = crypto.createHash('sha1').update(`${url}\n${body}`).digest('hex');
  if (replyCache.has(cacheKey)) {
    const cached = replyCache.get(cacheKey);
    replyCache.delete(cacheKey);
    replyCache.set(cacheKey, cached);
    return JSON.parse(cached);
  }
  // A server that does not answer in time (busy, or starting the compiler) is asked once more.
  // Meanwhile the progress shows how long it has been waiting.
  const job = jobContext.getStore();
  let response, text;
  for (let attempt = 1; ; attempt++) {
    throwIfCancelled();
    const controller = new AbortController();
    job?.aborts.add(controller);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const started = Date.now();
    const waiting = `${attempt > 1 ? 'asking again: ' : ''}compiling with ${compilerId} on ${hostOf(baseUrl)}`;
    const ticker = setInterval(() => {
      const ms = Date.now() - started;
      if (ms >= WAIT_SHOWN_AFTER_MS) report(`${waiting}… ${Math.round(ms / 1000)} s`);
    }, 1000);
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        signal: controller.signal
      });
      text = await response.text();
      break;
    } catch (e) {
      if (job?.cancelled) throw new Cancelled();
      if (!timedOut) throw e;
      if (attempt >= 2) {
        const err = new Error(`${hostOf(baseUrl)} did not answer within ${Math.round(timeoutMs / 1000)} s, twice. Compiler Explorer is sometimes slow when it is busy: analyze again in a moment, or raise asmLens.requestTimeoutMs.`);
        err.name = 'TimeoutError';
        throw err;
      }
      outputChannel.appendLine(`  ${hostOf(baseUrl)} did not answer within ${Math.round(timeoutMs / 1000)} s; asking again.`);
    } finally { clearTimeout(timeout); clearInterval(ticker); job?.aborts.delete(controller); }
  }
  if (response.status === 429) {
    rateLimitedUntil = Date.now() + 30000;
    throw new Error(`${hostOf(baseUrl)} is limiting how often it compiles (HTTP 429). Automatic re-analysis pauses for 30 seconds; analyze again in a moment.`);
  }
  if (!response.ok) {
    throw new Error(`Compiler Explorer returned HTTP ${response.status} for compiler "${compilerId}"${response.status === 404 ? ' (unknown compiler id? Use Select Compiler → Browse)' : ''}: ${String(text || '').trim().slice(0, 200)}`);
  }
  let data;
  try { data = JSON.parse(text); } catch (_) {
    throw new Error(`Compiler Explorer sent a reply that is not JSON: ${String(text || '').trim().slice(0, 200)}`);
  }
  replyCache.set(cacheKey, text);
  if (replyCache.size > REPLY_CACHE_SIZE) replyCache.delete(replyCache.keys().next().value);
  return data;
}

// The compiler's diagnostics. MSVC on Compiler Explorer writes them to stdout, the others to stderr.
function stderrText(data) {
  const lines = [...(data.stderr || []), ...(data.stdout || [])].map(x => (x && x.text) || '').filter(l => l.trim() && !/^\s*(?:example|<source>)\.\w+\s*$/.test(l));
  return lines.join('\n').replace(ANSI_RE, '');
}

const isRemoteMain = f => /^<source>$|^<stdin>$|(^|\/)example\.\w+$/.test(f.replace(/\\/g, '/'));

async function compileWithRecovery(opts) {
  const { includeBundle, maxAttempts, recoverErrors } = opts;
  const files = includeBundle.files.map(f => ({ ...f }));
  const stubbed = [];
  const stubNames = new Set();
  const skipped = [];
  const failedInstantiations = [];
  const failedLines = new Set();
  const removedFlags = [];
  let source = opts.source;
  let flags = [opts.flags, ...includeBundle.includeFlags].filter(Boolean).join(' ');
  let lastErr = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    report(attempt === 1 ? `compiling with ${opts.compilerId} on ${hostOf(opts.baseUrl)}…` : `compiling again (${attempt}/${maxAttempts}), working around errors…`);
    const data = await postCompile({ ...opts, source, files, flags });
    if (data.code === undefined || data.code === 0) {
      if (attempt > 1) outputChannel.appendLine(`Compiled after ${attempt - 1} recovery step(s).`);
      return { data, effectiveFlags: flags, skipped, stubbed, failedInstantiations, removedFlags };
    }
    lastErr = stderrText(data) || `Compiler exited with code ${data.code}`;

    // 0. A flag the compiler does not accept (-O2 for cc65, ...) -> leave it out.
    const rejected = flagsLib.removeFlags(flags, flagsLib.rejectedFlagsFrom(lastErr));
    if (rejected.removed.length) {
      flags = rejected.flags;
      removedFlags.push(...rejected.removed);
      outputChannel.appendLine(`  left out flags the compiler does not accept: ${rejected.removed.join(' ')}`);
      continue;
    }

    // 1. Missing include -> empty stand-in so preprocessing can continue.
    let progressed = false;
    for (const name of missingIncludesFrom(lastErr)) {
      const stub = stubFilename(name);
      if (!stub || files.some(f => f.filename === stub)) continue;
      files.push({ filename: stub, contents: '\n' });
      stubNames.add(stub);
      stubbed.push(name);
      progressed = true;
    }
    // 1b. Optionally: an uploaded header that fails in the preprocessor -> empty stand-in.
    // Off by default: a #error usually means a missing define, and emptying the header hides that.
    for (const bad of (config().get('stubFailingHeaders', false) ? preprocessorErrorFilesFrom(lastErr) : [])) {
      const norm = bad.replace(/\\/g, '/');
      const f = files.find(x => !stubNames.has(x.filename) && !x.filename.endsWith('.asm_lens_keep') && (norm === x.filename || norm.endsWith('/' + x.filename)));
      if (!f) continue;
      f.contents = '\n';
      stubNames.add(f.filename);
      stubbed.push(`${f.filename} (preprocessor error; add the needed "defines" to .asm-lens.json?)`);
      progressed = true;
    }
    if (progressed) {
      if (!/(^|\s)-I\.(\s|$)/.test(flags)) flags += ' -I.';
      continue;
    }

    // 2. A requested template instantiation that does not compile -> drop it.
    const message = firstErrorMessage(lastErr);
    for (const l of instantiationLinesIn(lastErr, opts.instFirstLine ?? -1, isRemoteMain)) {
      if (failedLines.has(l)) continue;
      failedLines.add(l);
      source = blankLine(source, l);
      if (l - opts.instFirstLine < (opts.instCount ?? Infinity)) failedInstantiations.push({ index: l - opts.instFirstLine, message });
      progressed = true;
    }
    if (progressed) continue;

    // 3. __attribute__((used)) added to a header line that the compiler rejects -> remove it there.
    const reverted = revertKeptLines(source, opts.original, errorLocationsFrom(lastErr).filter(loc => isRemoteMain(loc.file)).map(loc => loc.line));
    if (reverted !== undefined && reverted !== source) { source = reverted; continue; }
    // Other errors while the header's functions are kept: the caller compiles the text as written
    // instead, so that what Asm Lens added never makes a function count as "Not compiled".
    if (opts.kept) throw new Error(lastErr.slice(0, 1800));

    if (!recoverErrors) break;

    // 4. Errors inside functions -> blank those functions out and retry.
    for (const loc of errorLocationsFrom(lastErr)) {
      let target;
      if (isRemoteMain(loc.file)) target = 'main';
      else {
        const norm = loc.file.replace(/\\/g, '/');
        const f = files.find(x => !x.filename.endsWith('.asm_lens_keep') && (norm === x.filename || norm.endsWith('/' + x.filename)) && !stubNames.has(x.filename));
        if (f) target = f;
      }
      if (!target) continue;
      const before = target === 'main' ? source : target.contents;
      const cut = blankEnclosingDeclaration(before, loc.line);
      if (!cut) continue;
      if (target === 'main') source = cut.text; else target.contents = cut.text;
      skipped.push({ name: cut.name, file: target === 'main' ? opts.rootFile || 'source' : target.filename, key: target === 'main' ? 'main' : target.filename, startLine: cut.startLine, endLine: cut.endLine });
      progressed = true;
    }
    if (!progressed) break;
  }
  const hint = includeBundle.unresolved.length
    ? `\n\nAsm Lens could not find these headers locally: ${[...new Set(includeBundle.unresolved.map(u => u.name))].join(', ')}. Add their directory to the asmLens.includePaths setting.`
    : '';
  outputChannel.appendLine(`Uploaded: ${includeBundle.pathMap.map(e => e.virtual).join(', ') || '(no headers)'}; flags: ${flags}`);
  throw new Error(lastErr.slice(0, 1800) + hint);
}



// ---------------------------------------------------------------------------
// Assembly panel and highlighting

// The assembly view: a webview built once; each function is sent to it as a
// message and rendered in one DOM update (no page reload when switching).
let panelReady = false;
let panelQueue = [];
let lastRender;

function postToPanel(message) {
  if (!outputPanel) return;
  if (panelReady) outputPanel.webview.postMessage(message);
  else panelQueue.push(message);
}

function ensurePanel() {
  if (outputPanel) return;
  panelReady = false;
  panelQueue = [];
  outputPanel = vscode.window.createWebviewPanel('asmLensAssembly', 'Asm Lens Assembly', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
  outputPanel.onDidDispose(() => {
    clearSourceHighlight();
    clearSourceColors();
    outputPanel = undefined;
    panelState = undefined;
    lastRender = undefined;
  });
  outputPanel.onDidChangeViewState(e => { if (e.webviewPanel.visible) applySourceColors(); else { clearSourceColors(); clearSourceHighlight(); } });
  outputPanel.webview.onDidReceiveMessage(handleWebviewMessage);
  outputPanel.webview.html = panelHtml();
}

function showAssembly(result, analysis, { reveal = true } = {}) {
  const created = !outputPanel;
  ensurePanel();
  const displayRows = cleanAssemblyRowsForDisplay(result);
  const fileKeys = [];
  const colorOf = new Map();
  const groups = [];
  for (const row of displayRows) {
    if (!row.ref) continue;
    if (!fileKeys.includes(row.ref.key)) fileKeys.push(row.ref.key);
    const g = `${row.ref.key}\n${row.ref.line}`;
    if (!colorOf.has(g)) {
      colorOf.set(g, colorOf.size % PALETTE.length);
      groups.push({ key: row.ref.key, line: row.ref.line, color: colorOf.get(g) });
    }
  }
  // "fileIndex:line" of every mapped row, to answer "does this line have instructions here?" at once.
  const mappedLines = new Set(groups.map(g => `${fileKeys.indexOf(g.key)}:${g.line}`));
  panelState = { analysis, result, fileKeys, groups, mappedLines, stale: false };
  outputPanel.title = `Assembly: ${result.sourceName || result.name}`;
  lastRender = {
    type: 'render',
    title: `${result.sourceName || result.name} — ${result.count} instructions`,
    meta: `${analysis.compilerLabel} · ${analysis.compilerId} · ${analysis.flags}`,
    noMap: !displayRows.some(r => r.ref),
    colorize: config().get('colorizeLines', true),
    dim: config().get('dimOtherLines', false),
    rows: displayRows.map(row => row.ref
      ? { t: row.text, f: fileKeys.indexOf(row.ref.key), l: row.ref.line, c: row.ref.column, k: colorOf.get(`${row.ref.key}\n${row.ref.line}`) }
      : { t: row.text })
  };
  postToPanel(lastRender);
  // In the column the user put it in; a new panel opens beside the editor.
  if (reveal && !created && !outputPanel.visible) outputPanel.reveal(undefined, true);
  applySourceColors();
}

function panelHtml() {
  const nonce = crypto.randomBytes(16).toString('base64');
  const paletteCss = PALETTE.map((c, i) => `.c${i}{background:${c}}`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:16px}
.asm{font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);white-space:pre;background:var(--vscode-editor-background);padding:12px;border:1px solid var(--vscode-panel-border)}
.asm-line{display:block;min-height:1em;transition:opacity 80ms}
.asm-line[data-l]{cursor:pointer}
${paletteCss}
.asm.dim.focus .asm-line:not(.hl){opacity:.38}
.asm-line.hl{background:var(--vscode-editor-wordHighlightStrongBackground,var(--vscode-editor-findMatchHighlightBackground));box-shadow:inset 3px 0 0 var(--vscode-focusBorder)}
.asm-line.hl-self{background:var(--vscode-editor-findMatchBackground);outline:1px solid var(--vscode-focusBorder)}
.meta{color:var(--vscode-descriptionForeground);margin-bottom:14px}
</style></head><body><h2 id="title"></h2><div class="meta" id="meta"></div><p class="meta" id="nomap" hidden>No source mapping is available for this function, so hover highlighting is disabled.</p><div class="asm" id="asm"></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
const box=document.getElementById('asm');
let groups=new Map(),current='',self=null,leaveTimer;
const keyOf=el=>el.dataset.f+':'+el.dataset.l;
function clearMarks(){if(current)for(const e of groups.get(current)||[])e.classList.remove('hl');if(self)self.classList.remove('hl-self');current='';self=null;box.classList.remove('focus');}
function mark(k,el,scroll){
  if(k!==current){clearMarks();current=k;for(const e of groups.get(k)||[])e.classList.add('hl');box.classList.add('focus');}
  if(self!==el){if(self)self.classList.remove('hl-self');self=el;if(el)el.classList.add('hl-self');}
  if(scroll){const els=groups.get(k)||[];if(els.length){const a=els[0].getBoundingClientRect(),b=els[els.length-1].getBoundingClientRect();if(a.top<0||b.bottom>innerHeight)els[0].scrollIntoView({block:b.bottom-a.top<innerHeight?'center':'start'});}}
}
function render(m){
  clearMarks();groups=new Map();
  box.classList.toggle('dim',!!m.dim);
  document.getElementById('title').textContent=m.title;
  document.getElementById('meta').textContent=m.meta;
  document.getElementById('nomap').hidden=!m.noMap;
  const frag=document.createDocumentFragment();
  for(const r of m.rows){
    const el=document.createElement('span');
    el.className='asm-line'+(m.colorize&&r.k!==undefined?' c'+r.k:'');
    el.textContent=r.t;
    if(r.f!==undefined){el.dataset.f=r.f;el.dataset.l=r.l;if(r.c!==undefined&&r.c!==null)el.dataset.c=r.c;const k=r.f+':'+r.l;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(el);}
    frag.appendChild(el);frag.appendChild(document.createTextNode('\\n'));
  }
  box.replaceChildren(frag);
}
const payload=(type,el)=>({type,file:Number(el.dataset.f),line:Number(el.dataset.l),column:el.dataset.c===undefined?undefined:Number(el.dataset.c)});
box.addEventListener('mouseover',e=>{const el=e.target.closest&&e.target.closest('.asm-line[data-l]');if(!el)return;clearTimeout(leaveTimer);const k=keyOf(el);const same=k===current;mark(k,el,false);if(!same)vscode.postMessage(payload('highlight',el));});
box.addEventListener('click',e=>{const el=e.target.closest&&e.target.closest('.asm-line[data-l]');if(el)vscode.postMessage(payload('open',el));});
box.addEventListener('mouseleave',()=>{leaveTimer=setTimeout(()=>{clearMarks();vscode.postMessage({type:'clearHighlight'});},120);});
window.addEventListener('message',e=>{const m=e.data||{};if(m.type==='render')render(m);else if(m.type==='highlightAsm'){const k=m.file+':'+m.line;if(k!==current||self)mark(k,null,true);}else if(m.type==='clearAsm')clearMarks();});
vscode.postMessage({type:'ready'});
</script></body></html>`;
}

// After an analysis, the open assembly view shows the new code of the same function.
function refreshPanel(analysis) {
  if (!outputPanel || !outputPanel.visible || !panelState || panelState.analysis.rootKey !== analysis.rootKey) return;
  const old = panelState.result;
  const next = analysis.functions.find(f => f.name === old.name)
    || (old.sourceName && analysis.functions.find(f => f.sourceName === old.sourceName && !/\(inlined\)$/.test(old.sourceName)));
  if (next) showAssembly(next, analysis, { reveal: false });
}

// Persistent CE-style coloring: each source line gets the same color as its instructions.
function applySourceColors() {
  clearSourceColors();
  if (!outputPanel || !outputPanel.visible || !panelState || panelState.stale || !config().get('colorizeLines', true)) return;
  const byKey = new Map();
  for (const g of panelState.groups) {
    if (!byKey.has(g.key)) byKey.set(g.key, PALETTE.map(() => []));
    byKey.get(g.key)[g.color].push(g.line);
  }
  for (const [key, perColor] of byKey) {
    for (const editor of visibleEditorsFor(key)) {
      const count = editor.document.lineCount;
      perColor.forEach((lines, i) => editor.setDecorations(paletteDecorations[i], lines.filter(l => l < count).map(l => editor.document.lineAt(l).range)));
    }
  }
}
function clearSourceColors() {
  for (const editor of vscode.window.visibleTextEditors) for (const d of paletteDecorations) editor.setDecorations(d, []);
}

function handleWebviewMessage(message) {
  if (message && message.type === 'ready') {
    panelReady = true;
    // A reloaded webview (moved to another window, ...) gets the current function again.
    const queued = panelQueue.length ? panelQueue : lastRender ? [lastRender] : [];
    panelQueue = [];
    for (const m of queued) outputPanel?.webview.postMessage(m);
    return;
  }
  if (!message || !panelState) return;
  if (message.type === 'clearHighlight') return clearSourceHighlight();
  if (message.type !== 'highlight' && message.type !== 'open') return;
  const key = panelState.fileKeys[message.file];
  if (!key || !Number.isInteger(message.line) || message.line < 0) return;
  const column = Number.isInteger(message.column) ? message.column : undefined;
  if (message.type === 'highlight') {
    // Rows of a panel that does not match the edited text yet would point at wrong lines.
    if (config().get('highlightOnHover', true) && !panelState.stale) highlightSource(key, message.line, column);
    return;
  }
  // The open document's own URI (exact casing on Windows), else the path the compiler named.
  const open = (vscode.workspace.textDocuments || []).find(d => d.uri.scheme === 'file' && normPath(d.uri.fsPath) === key);
  const real = panelState.analysis.paths.get(key);
  if (!open && !real) return;
  const pos = new vscode.Position(message.line, column || 0);
  const shown = visibleEditorsFor(key)[0] || (lastSourceDocument && vscode.window.visibleTextEditors.find(e => e.document === lastSourceDocument));
  vscode.window.showTextDocument(open ? open.uri : vscode.Uri.file(real), { selection: new vscode.Range(pos, pos), viewColumn: shown?.viewColumn ?? vscode.ViewColumn.One, preserveFocus: false })
    .then(() => { applySourceColors(); highlightSource(key, message.line, column); }, () => { /* file may have been deleted */ });
}

function visibleEditorsFor(key) {
  return vscode.window.visibleTextEditors.filter(e => e.document.uri.scheme === 'file' && normPath(e.document.uri.fsPath) === key);
}

// Highlights the source line of a hovered instruction (and the token at its
// column, when the compiler reports one). With asmLens.dimOtherLines the other
// lines of the function fade too.
function highlightSource(key, line, column) {
  clearSourceHighlight();
  const span = panelState && config().get('dimOtherLines', false) ? sourceSpanOf(panelState.result, panelState.analysis, key) : undefined;
  for (const editor of visibleEditorsFor(key)) {
    const document = editor.document;
    if (line >= document.lineCount) continue;
    const range = document.lineAt(line).range;
    editor.setDecorations(lineDecoration, [{ range }]);
    if (column !== undefined && column < range.end.character) {
      const token = document.getWordRangeAtPosition(new vscode.Position(line, column));
      if (token) editor.setDecorations(tokenDecoration, [{ range: token }]);
    }
    if (span) {
      const last = Math.min(span.end, document.lineCount - 1);
      const dim = [];
      if (span.start < line) dim.push(new vscode.Range(span.start, 0, line - 1, document.lineAt(line - 1).range.end.character));
      if (line < last) dim.push(new vscode.Range(line + 1, 0, last, document.lineAt(last).range.end.character));
      editor.setDecorations(dimDecoration, dim);
    }
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

// First and last line of file `key` that the function shown comes from.
function sourceSpanOf(result, analysis, key) {
  let start = Infinity, end = -1;
  if (key === analysis.rootPathKey && result.sourceRange) { start = result.sourceRange.start.line; end = result.sourceRange.end.line; }
  for (const r of result.instructionRows || []) {
    if (r.ref && r.ref.key === key) { start = Math.min(start, r.ref.line); end = Math.max(end, r.ref.line); }
  }
  return end >= start ? { start, end } : undefined;
}

function clearSourceHighlight() {
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(lineDecoration, []);
    editor.setDecorations(tokenDecoration, []);
    if (dimDecoration) editor.setDecorations(dimDecoration, []);
  }
}

// Source -> assembly: highlight the panel's instructions for the hovered or
// selected source line (only when the panel shows this analysis).
function syncAsmHighlight(analysis, key, line) {
  if (!outputPanel || !panelState || panelState.stale || panelState.analysis.rootKey !== analysis.rootKey) return;
  if (!config().get('highlightOnHover', true)) return;
  const file = panelState.fileKeys.indexOf(key);
  const hasRows = file >= 0 && panelState.mappedLines.has(`${file}:${line}`);
  postToPanel(hasRows ? { type: 'highlightAsm', file, line } : { type: 'clearAsm' });
}

function truncateLines(text, max) {
  const lines = text.split('\n');
  return lines.length <= max ? text : lines.slice(0, max).join('\n') + `\n; … ${lines.length - max} more`;
}
function escapeMarkdown(s) { return String(s || '').replace(/[\\`*_{}\[\]()#+.!|>~-]/g, '\\$&'); }

// ---------------------------------------------------------------------------
// Local include discovery

// Every local file is uploaded at a virtual path that mirrors its real layout,
// relative to the closest common ancestor of all involved files
// (asm_lens/include/x.h). Keeping the real layout keeps all relative includes
// (`"../include/x.h"`, `"sub/y.h"`) valid without rewriting the source.
function commonAncestor(paths) {
  const split = paths.map(p => path.resolve(p).split(/[\\/]+/));
  let common = split[0];
  for (const parts of split.slice(1)) {
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  return common.join(path.sep) || path.sep;
}
function toVirtualPath(realPath, rootDir) {
  const abs = path.resolve(realPath);
  let rel = rootDir ? path.relative(rootDir, abs) : abs.replace(/^([A-Za-z]):/, '$1');
  // A different Windows drive has no relative path; fall back to the full path.
  if (rootDir && path.isAbsolute(rel)) rel = abs.replace(/^([A-Za-z]):/, '$1');
  const parts = rel.split(/[\\/]+/).filter(Boolean).map(p => p.replace(/[^A-Za-z0-9._+-]/g, '_'));
  return [VIRTUAL_ROOT, ...parts].join('/');
}

function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
}

async function collectLocalIncludes(document, configuredIncludePaths, limits = {}) {
  const empty = { files: [], includeFlags: [], pathMap: [], unresolved: [], unresolvedAll: [], autoDirs: [], truncated: false, skippedSystem: [] };
  if (document.uri.scheme !== 'file') return empty;
  const mainPath = path.resolve(document.uri.fsPath);
  const mainDir = path.dirname(mainPath);
  const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
  const ownFolder = vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath;
  const baseDir = ownFolder || folders[0] || mainDir;
  const configured = (Array.isArray(configuredIncludePaths) ? configuredIncludePaths : []).map(p => {
    if (p && typeof p === 'object') return { dir: path.resolve(p.dir), recursive: !!p.recursive };
    const t = String(p).trim();
    return t ? { dir: path.isAbsolute(t) ? path.resolve(t) : path.resolve(baseDir, t), recursive: false } : undefined;
  }).filter(Boolean);
  // Search order: the analyzed file's directory (the remote compiler's own cwd
  // does not match it), then the configured folders in the order given, then
  // the workspace folders. A "recursive" folder is also searched in all its subfolders.
  const searchEntries = [];
  const addEntry = (dir, recursive) => {
    const existing = searchEntries.find(e => e.dir === dir);
    if (existing) existing.recursive = existing.recursive || recursive; else searchEntries.push({ dir, recursive });
  };
  addEntry(mainDir, false);
  configured.forEach(c => addEntry(c.dir, c.recursive));
  folders.forEach(f => addEntry(path.resolve(f), false));
  const includeDirs = searchEntries.map(e => e.dir);
  const maxFiles = Math.max(1, Number(limits.maxFiles) || 80);
  const maxFileBytes = 1024 * 1024;
  const maxDepth = 32;
  const excludeRes = (limits.excludePaths || DEFAULT_EXCLUDES).map(globToRegExp);
  const relOf = p => { const r = path.relative(baseDir, p).replace(/\\/g, '/'); return r.startsWith('..') ? path.resolve(p).replace(/\\/g, '/') : r; };
  const isExcluded = p => excludeRes.some(re => re.test(relOf(p)));
  const skippedSystem = new Set();

  // Prefer the editor's (possibly unsaved) text over what is on disk.
  const openDocs = new Map();
  for (const d of vscode.workspace.textDocuments || []) {
    if (d.uri.scheme === 'file') openDocs.set(normPath(d.uri.fsPath), d);
  }
  async function readText(p) {
    const open = openDocs.get(normPath(p));
    if (open) { const t = open.getText(); return t.length <= maxFileBytes ? t : undefined; }
    try {
      const stat = await fs.stat(p);
      if (!stat.isFile() || stat.size > maxFileBytes) return undefined;
      return await fs.readFile(p, 'utf8');
    } catch (_) { return undefined; }
  }

  // Fallback for headers not on any configured include path: look through the
  // workspace (like a build's own -I flags would), match the include spelling
  // case-insensitively, and remember the directory as an include root.
  const autoDirs = [];
  const unresolvedAll = [];
  const HEADER_GLOB = '{h,H,hh,hpp,hxx,h++,inc,inl,tcc,ipp,cuh,hip}';
  const buildList = Array.isArray(limits.buildFolders) && limits.buildFolders.length ? limits.buildFolders : DEFAULT_BUILD_FOLDERS;
  const BUILD_DIRS = buildList.length > 1 ? `{${buildList.join(',')}}` : buildList[0];
  const HEADER_EXT = /\.(?:h|hh|hpp|hxx|h\+\+|inc|inl|tcc|ipp|cuh|hip)$/i;
  const recursiveCache = new Map();
  async function recursiveIndex(dir) {
    if (recursiveCache.has(dir)) return recursiveCache.get(dir);
    const out = [];
    const walk = async (d, depth) => {
      if (depth > 12 || out.length >= 20000) return;
      let items;
      try { items = await fs.readdir(d, { withFileTypes: true }); } catch (_) { return; }
      for (const it of items) {
        if (it.isDirectory()) { const sub = path.join(d, it.name); if (it.name !== 'node_modules' && it.name !== '.git' && !isExcluded(sub + '/x')) await walk(sub, depth + 1); }
        else if (HEADER_EXT.test(it.name)) out.push(path.join(d, it.name));
      }
    };
    await walk(dir, 0);
    recursiveCache.set(dir, out);
    return out;
  }
  let headerIndex, buildIndex;
  async function listHeaders(include, exclude) {
    try {
      const uris = await vscode.workspace.findFiles(include, exclude, 20000);
      return uris.filter(u => u.scheme === 'file').map(u => u.fsPath);
    } catch (_) { return []; }
  }
  async function matchIn(index, name) {
    const tail = ('/' + name.replace(/\\/g, '/')).replace(/\/\.\//g, '/').toLowerCase();
    for (const f of index) {
      const norm = f.replace(/\\/g, '/');
      if (isExcluded(f)) continue;
      if (!norm.toLowerCase().endsWith(tail)) continue;
      const root = path.resolve(f.slice(0, f.length - name.length - 1));
      const text = await readText(f);
      if (text === undefined) continue;
      // Spell the uploaded path exactly as the #include does: the remote compiler is case-sensitive.
      return { real: f, virtualReal: path.resolve(root, name), root, text };
    }
    return undefined;
  }
  async function searchWorkspace(name) {
    if (!vscode.workspace.findFiles) return undefined;
    // Normal source folders first, then build output folders (generated headers).
    if (!headerIndex) headerIndex = await listHeaders(`**/*.${HEADER_GLOB}`, `**/{node_modules,.git}/**,**/${BUILD_DIRS}/**`);
    const hit = await matchIn(headerIndex, name);
    if (hit) return hit;
    if (!buildIndex) buildIndex = await listHeaders(`**/${BUILD_DIRS}/**/*.${HEADER_GLOB}`, '**/{node_modules,.git}/**');
    return matchIn(buildIndex, name);
  }

  async function direct(dir, name) {
    const candidate = path.resolve(dir, name);
    const content = await readText(candidate);
    return content === undefined ? undefined : { real: candidate, text: content };
  }
  function addAuto(hit) {
    if (hit && !includeDirs.includes(hit.root)) { includeDirs.push(hit.root); autoDirs.push(hit.root); }
    return hit;
  }
  // Mirrors a compiler's lookup: includer's directory (quoted only), then each
  // search folder in priority order, then folders found automatically.
  async function locate(name, quoted, includerDir) {
    if (quoted) { const h = await direct(includerDir, name); if (h) return h; }
    // Standard/system headers come from the compiler, never from workspace copies.
    if (!limits.uploadSystemHeaders && isSystemHeader(name)) return { system: true };
    for (const e of searchEntries) {
      const h = await direct(e.dir, name);
      if (h) return h;
      if (e.recursive) { const m = await matchIn(await recursiveIndex(e.dir), name); if (m) return addAuto(m); }
    }
    for (const d of autoDirs) { const h = await direct(d, name); if (h) return h; }
    return addAuto(await searchWorkspace(name));
  }

  const found = new Map(); // normalized real path -> { real, virtual, text }
  const unresolved = [];
  let truncated = false;
  const visited = new Set([normPath(mainPath)]);

  async function visit(realPath, text, depth) {
    if (depth > maxDepth) return;
    const re = /^[ \t]*#[ \t]*(?:include|import|include_next)[ \t]*(["<])([^">\n]+)[">]/gm;
    for (const match of stripBlockComments(text).matchAll(re)) {
      const quoted = match[1] === '"';
      const name = match[2].trim();
      if (!name || path.isAbsolute(name)) continue;
      const hit = await locate(name, quoted, path.dirname(realPath));
      if (hit && hit.system) { skippedSystem.add(name); continue; }
      if (!hit) {
        unresolvedAll.push(name);
        if (quoted) unresolved.push({ name, from: path.relative(baseDir, realPath) || realPath });
        continue;
      }
      if (isExcluded(hit.real)) { skippedSystem.add(name); continue; }
      const nk = normPath(hit.real);
      if (visited.has(nk)) continue;
      if (found.size >= maxFiles) { truncated = true; return; }
      visited.add(nk);
      found.set(nk, { real: hit.real, virtualReal: hit.virtualReal, text: hit.text });
      await visit(hit.real, hit.text, depth + 1);
      if (truncated) return;
    }
  }

  await visit(mainPath, document.getText(), 0);
  if (found.size === 0) return { ...empty, unresolved, unresolvedAll, skippedSystem: [...skippedSystem] };

  const rootDir = commonAncestor([mainDir, ...includeDirs, ...[...found.values()].map(f => path.dirname(f.real))]);
  const entries = [...found.values()].map(f => ({ real: f.real, virtual: toVirtualPath(f.virtualReal || f.real, rootDir), text: f.text }));
  const files = entries.map(f => ({ filename: f.virtual, contents: f.text }));
  // The compiler resolves quoted includes of the main source relative to its own
  // working directory, so expose the main file's virtual directory via -I. That
  // directory must exist for "../x.h" to resolve, so ensure it does.
  const mainVirtualDir = toVirtualPath(mainDir, rootDir);
  if (!files.some(f => f.filename.startsWith(mainVirtualDir + '/'))) {
    files.push({ filename: `${mainVirtualDir}/.asm_lens_keep`, contents: '\n' });
  }
    // An auto-detected folder that holds files named like system headers (e.g. pbits/errno.h)
  // would hide the compiler's own headers, so it is not added as -I.
  const shadowsSystem = d => entries.some(e => path.dirname(path.resolve(e.real)) === d && isSystemHeader(path.basename(e.real)));
  const includeFlags = includeDirs
    .filter(d => !(autoDirs.includes(d) && shadowsSystem(d)))
    .map(d => `-I${toVirtualPath(d, rootDir)}`);
  const pathMap = entries.map(f => ({ real: f.real, virtual: f.virtual }));
  return { files, includeFlags, pathMap, unresolved, unresolvedAll, autoDirs, truncated, skippedSystem: [...skippedSystem] };
}

function deactivate() { if (outputPanel) outputPanel.dispose(); }
module.exports = {
  activate, deactivate,
  // exported for tests
  _internals: {
    resolveSettings, showAssembly, handleWebviewMessage, syncAsmHighlight, _state: () => ({ panelState, lastAnalysis }),
    compileWithRecovery, collectLocalIncludes, guessFunctionSymbols, sourceFunctionsOf, analysisFor, analyzeDocument,
    instantiationsFor, prepareCSource, isSystemHeader, globToRegExp, splitArgs, functionForLine, analysesFor, analysisAt
  }
};
