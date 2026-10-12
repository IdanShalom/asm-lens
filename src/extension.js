const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const projectConfig = require('./projectConfig');
const scan = require('./cppScan');
const languages = require('./languages');
const {
  normPath, makeRefResolver, makeLocalRefResolver, localAsmToRows, isMachO, prepareMachO, finishMachO,
  parseFunctions, buildLineIndex, normalizeName,
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
let codeLensEmitter;
let extContext;
let statusItem;
let lineDecoration;
let tokenDecoration;
let paletteDecorations = [];
let syncTimer;

function config() { return vscode.workspace.getConfiguration('asmLens'); }
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

function readConfigText(file) {
  const open = (vscode.workspace.textDocuments || []).find(d => d.uri.scheme === 'file' && normPath(d.uri.fsPath) === normPath(file));
  if (open) return Promise.resolve(open.getText());
  return fs.readFile(file, 'utf8').then(t => t, () => undefined);
}

async function loadProject(document) {
  if (!document || document.uri.scheme !== 'file') return undefined;
  const root = vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath;
  const project = await projectConfig.loadProjectConfig(path.dirname(document.uri.fsPath), root, readConfigText);
  if (project?.error) outputChannel?.appendLine(project.error);
  for (const w of project?.warnings || []) outputChannel?.appendLine(`${project.file}: ${w}`);
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
  const chosen = extContext?.workspaceState.get('asmLens.activeCompiler');
  const active = (chosen && (compilers.find(x => x.id === chosen.id) || (chosen.browsed ? { id: chosen.id, name: chosen.name || chosen.id } : undefined))) || compilers[0];
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
    localCompiler: resolveCompilerPath(active.compiler || c?.compiler || s.get('localCompiler', '') || 'g++', project)
  };
}

// Settings for Rust, Go, Python, ...: compilers from .asm-lens.json entries with
// that "language", else the language's Compiler Explorer default. Top-level
// flags, defines and include paths are C/C++ settings and are not used.
function resolveOtherSettings(lang, project, s) {
  const c = project?.config;
  const compilers = (c?.compilers || []).filter(x => x.language === lang.id);
  const chosen = extContext?.workspaceState.get(`asmLens.activeCompiler.${lang.id}`);
  const active = (chosen && (compilers.find(x => x.id === chosen.id) || (chosen.browsed ? { id: chosen.id, name: chosen.name || chosen.id } : undefined)))
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
    ceDefaults.set(baseUrl, fetch(`${baseUrl}/api/languages?fields=id,defaultCompiler`, { headers: { Accept: 'application/json' } })
      .then(r => r.ok ? r.json() : [])
      .then(list => new Map((Array.isArray(list) ? list : []).filter(l => l && l.defaultCompiler).map(l => [l.id, l.defaultCompiler])))
      .catch(() => new Map()));
  }
  const map = await ceDefaults.get(baseUrl);
  if (!map.size) ceDefaults.delete(baseUrl);
  return map.get(lang.id) || lang.compiler;
}

async function refreshStatusBar() {
  if (!statusItem) return;
  const document = vscode.window.activeTextEditor?.document;
  if (!document || !LANGS.includes(document.languageId)) return statusItem.hide();
  try {
    const r = await resolveSettings(document);
    const local = r.mode === 'local';
    statusItem.text = `$(chip) ${local ? `${path.basename(r.localCompiler || '')} (local)` : r.active.name || r.active.id}`;
    statusItem.tooltip = `Asm Lens compiler: ${local ? `${r.localCompiler} on this machine` : `${r.active.id} on ${r.baseUrl}`}\n${r.configFile ? `Config: ${r.configFile}` : 'No .asm-lens.json (using VS Code settings)'}\nClick to change`;
    statusItem.show();
  } catch (_) { statusItem.hide(); }
}

function activate(context) {
  extContext = context;
  outputChannel = vscode.window.createOutputChannel('Asm Lens');
  context.subscriptions.push(outputChannel);

  lineDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    isWholeLine: true,
    overviewRulerColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center
  });
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
      const viaRoot = cached.rootKey !== fileKey(document) ? ` · via ${path.basename(cached.rootPath)}` : '';
      return [...functions.map(sym => {
        const results = findAllFunctionResults(sym, cached.functions, key, cached.rootPathKey);
        const result = results[0];
        const inlined = !result ? inlinedResultFor(sym, cached, key) : undefined;
        const wasSkipped = !result && !inlined && (cached.skipped || []).some(k => k.key === key && sym.range.start.line >= k.startLine && sym.range.start.line <= k.endLine);
        const title = results.length > 1
          ? `$(symbol-numeric) ${results.length} instantiations · ${results.map(r => r.count).join(' / ')} instructions · ${cached.compilerLabel}${viaRoot}`
          : result
            ? `$(symbol-numeric) ${result.count} instructions · ${cached.compilerLabel} · ${cached.flags}${viaRoot}`
            : inlined
              ? `$(symbol-numeric) ${inlined.count} inlined instructions · used in ${inlined.users.length} function(s)${viaRoot}`
              : wasSkipped
                ? `$(warning) Not compiled · this function has compile errors (missing include?) · ${cached.compilerLabel}`
                : templates.has(sym)
                  ? `$(info) No code emitted: template not instantiated · ${cached.compilerLabel}${viaRoot}`
                  : `$(info) No code emitted (not used, or a template never instantiated) · ${cached.compilerLabel}`;
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
      const analysis = analysisFor(document);
      if (!analysis) return undefined;
      const key = docPathKey(document);
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
    const analysis = analysisFor(document);
    if (!analysis) return;
    const line = event.selections[0].active.line;
    const key = docPathKey(document);
    const byUser = event.kind === vscode.TextEditorSelectionChangeKind.Mouse || event.kind === vscode.TextEditorSelectionChangeKind.Keyboard;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      if (byUser && config().get('followCursor', true)) {
        const fn = functionForLine(analysis, key, line);
        if (fn && (!panelState || panelState.result !== fn || panelState.stale)) {
          showAssembly(fn, analysis);
          setTimeout(() => syncAsmHighlight(analysis, key, line), 200);
          return;
        }
      }
      syncAsmHighlight(analysis, key, line);
    }, 50);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('asmLens.analyzeFile', async (uri) => {
    const editor = vscode.window.activeTextEditor;
    const document = uri ? await vscode.workspace.openTextDocument(uri) : editor && editor.document;
    if (!document) return vscode.window.showWarningMessage('Open a C/C++ file first.');
    await analyzeDocument(document);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('asmLens.instantiateTemplate', instantiateTemplate));
  context.subscriptions.push(vscode.commands.registerCommand('asmLens.manageInstantiations', manageInstantiations));
  context.subscriptions.push(vscode.commands.registerCommand('asmLens.showOutput', () => outputChannel.show(true)));

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'asmLens.selectCompiler';
  context.subscriptions.push(statusItem);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => refreshStatusBar()));
  refreshStatusBar();

  const onConfigChanged = () => { lastAnalysis.clear(); codeLensEmitter?.fire(); refreshStatusBar(); };
  if (vscode.workspace.createFileSystemWatcher) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/{.asm-lens.json,.vscode/asm-lens.json}');
    watcher.onDidChange(onConfigChanged); watcher.onDidCreate(onConfigChanged); watcher.onDidDelete(onConfigChanged);
    context.subscriptions.push(watcher);
  }
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('asmLens')) onConfigChanged(); }));

  context.subscriptions.push(vscode.commands.registerCommand('asmLens.selectCompiler', async () => {
    const editor = vscode.window.activeTextEditor;
    const document = editor && LANGS.includes(editor.document.languageId) ? editor.document : undefined;
    const settings = document ? await resolveSettings(document) : undefined;
    const BROWSE = { label: '$(search) Browse all Compiler Explorer compilers…', browse: true };
    let picked;
    if (settings?.configFile && settings.compilers.length) {
      const items = settings.compilers.map((c, i) => ({
        label: c.name || c.id,
        description: `${c.id}${i === 0 ? ' · first in config' : ''}${c.id === settings.active.id ? ' · active' : ''}`,
        detail: c.flags,
        compiler: c
      }));
      picked = await vscode.window.showQuickPick([...items, BROWSE], { placeHolder: 'Choose a compiler from .asm-lens.json' });
      if (!picked) return;
    } else picked = BROWSE;
    try {
      let chosen = picked.compiler;
      let browsed = false;
      if (picked.browse) {
        const baseUrl = settings?.baseUrl || config().get('baseUrl', 'https://godbolt.org').replace(/\/$/, '');
        const lang = settings?.language || config().get('language', 'c++');
        const response = await fetch(`${baseUrl}/api/compilers/${encodeURIComponent(lang)}`, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Compiler list request failed: HTTP ${response.status}`);
        const compilers = await response.json();
        const selected = await vscode.window.showQuickPick(compilers.map(c => ({
          label: c.name || c.id,
          description: `${c.id}${c.semver ? ` · ${c.semver}` : ''}`,
          detail: c.id,
          compiler: c
        })), { placeHolder: 'Choose a Compiler Explorer compiler (the id can be copied into .asm-lens.json)', matchOnDescription: true });
        if (!selected) return;
        chosen = { id: selected.compiler.id, name: selected.compiler.name || selected.compiler.id };
        browsed = true;
      }
      const other = settings?.lang && settings.lang.family !== 'c' ? settings.lang : undefined;
      if (other) {
        await extContext.workspaceState.update(`asmLens.activeCompiler.${other.id}`, { id: chosen.id, name: chosen.name, browsed });
      } else if (settings?.configFile) {
        await extContext.workspaceState.update('asmLens.activeCompiler', { id: chosen.id, name: chosen.name, browsed });
      } else {
        await config().update('compilerId', chosen.id, vscode.ConfigurationTarget.Global);
        await config().update('compilerName', chosen.name || chosen.id, vscode.ConfigurationTarget.Global);
      }
      const hadAnalysis = document && analysisFor(document);
      lastAnalysis.clear();
      codeLensEmitter?.fire();
      await refreshStatusBar();
      vscode.window.showInformationMessage(`Asm Lens compiler set to ${chosen.name || chosen.id}.`);
      if (hadAnalysis) await analyzeDocument(document);
    } catch (e) {
      vscode.window.showErrorMessage(`Asm Lens could not load compilers: ${e.message}`);
    }
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
    const results = findAllFunctionResults(sym, cached.functions, key, cached.rootPathKey);
    let result = results[0];
    if (results.length > 1) {
      const pick = await vscode.window.showQuickPick(
        results.map(f => ({ label: f.name, description: `${f.count} instructions`, f })),
        { placeHolder: `${functionName}: choose an instantiation` });
      if (!pick) return;
      result = pick.f;
    }
    if (!result) result = inlinedResultFor(sym, cached, key);
    if (!result) return vscode.window.showInformationMessage(`No emitted code for ${functionName}. It may be unused, fully inlined, or a template that is never instantiated.`);
    showAssembly(result, cached);
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    if (event.contentChanges.length === 0) return;
    // Invalidate every analysis that used this document, either as the analyzed
    // file or as an uploaded header.
    const key = docPathKey(event.document);
    let changed = false;
    for (const [k, analysis] of lastAnalysis) {
      if (k === fileKey(event.document) || analysis.deps.has(key)) { lastAnalysis.delete(k); changed = true; }
    }
    if (panelState && panelState.analysis.deps.has(key)) { panelState.stale = true; clearSourceColors(); clearSourceHighlight(); }
    if (changed) codeLensEmitter?.fire();
  }));
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
function sourceFunctionsOf(document, tree) {
  const symbolFunctions = flattenSymbols(tree || []).filter(isFunctionSymbol);
  const functions = [...symbolFunctions];
  const knownNames = new Set(symbolFunctions.map(s => normalizeName(s.name)));
  for (const guessed of guessFunctionSymbols(document)) {
    if (!knownNames.has(normalizeName(guessed.name))) functions.push(guessed);
  }
  return functions;
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
  if (hit && hit.version === document.version && hit.text === document.getText()) return hit.symbols;
  const symbols = scanFunctionSymbols(document);
  guessCache.set(document, { version: document.version, text: document.getText(), symbols });
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
  const users = analysis.functions.filter(f => f.instructionRows.some(r => r.ref && r.ref.key === key && r.ref.line === line));
  if (users.length) {
    const own = key === analysis.rootPathKey
      ? users.find(f => f.sourceRange && f.sourceRange.start.line <= line && line <= f.sourceRange.end.line)
      : undefined;
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

// The analysis that covers `document`: the newest of its own analysis (if it
// found code) and the analyses of files that include it. A header analyzed on
// its own and later used by an analyzed .cpp shows the .cpp's results, until
// it is analyzed (or a template in it instantiated) again.
function analysisFor(document) {
  const own = lastAnalysis.get(fileKey(document));
  if (document.uri.scheme !== 'file') return own;
  const key = docPathKey(document);
  let best = own && own.functions.length ? own : undefined;
  for (const analysis of lastAnalysis.values()) {
    if (analysis !== own && analysis.deps.has(key) && (!best || analysis.timestamp > best.timestamp)) best = analysis;
  }
  return best || own;
}

function functionAtSignature(document, position, analysis, key) {
  if (key === analysis.rootPathKey) {
    const hit = analysis.functions.find(f => f.sourceRange && (f.sourceSelection || f.sourceRange).contains(position));
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
  const editor = vscode.window.activeTextEditor;
  const document = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
  if (!document) return;
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
  const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
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
// Analysis

async function analyzeDocument(document) {
  const key = fileKey(document);
  if (analysisBusy.has(key)) return;
  if (!LANGS.includes(document.languageId)) {
    return vscode.window.showWarningMessage(`Asm Lens supports C, C++, Objective-C, Rust, Go, Python, Zig, Swift, D and Fortran files (this file is "${document.languageId}").`);
  }
  analysisBusy.add(key);
  try {
    const settings = config();
    const resolved = await resolveSettings(document);
    if (resolved.configError) vscode.window.showWarningMessage(`Asm Lens: ${resolved.configError} Using VS Code settings instead.`);
    if (resolved.lang && resolved.lang.family !== 'c') return await analyzeOtherLanguage(document, resolved, settings);
    if (resolved.mode === 'local') return await analyzeLocal(document, resolved, settings);
    const { baseUrl, language } = resolved;
    const flags = [resolved.flags, ...resolved.defines.map(d => `-D${d}`), resolved.extraFlags].filter(Boolean).join(' ');
    const compilerId = resolved.active.id;
    const timeoutMs = settings.get('requestTimeoutMs', 30000);
    // MSVC does not know __attribute__((used)), so headers are compiled as they are.
    const msvc = /^vcpp|msvc/i.test(`${compilerId} ${resolved.active.name || ''}`);
    const prepared = prepareCSource(document, { keep: !msvc });
    const includeBundle = await collectLocalIncludes(document, resolved.includePaths, {
      maxFiles: resolved.maxIncludeFiles, buildFolders: resolved.buildFolders,
      excludePaths: resolved.excludePaths, uploadSystemHeaders: resolved.uploadSystemHeaders
    });
    const maxAttempts = Math.max(1, Number(settings.get('maxRecoveryAttempts', 12)));
    const recoverErrors = settings.get('skipFailingFunctions', true);
    const opts = {
      baseUrl, compilerId, language, timeoutMs, flags, includeBundle, maxAttempts, recoverErrors, rootFile: document.fileName,
      instFirstLine: prepared.firstLine, original: prepared.plain
    };
    let compiled;
    if (prepared.kept !== undefined) {
      try { compiled = await compileWithRecovery({ ...opts, source: prepared.kept }); }
      catch (e) {
        if (e.name === 'AbortError') throw e;
        outputChannel.appendLine('  header: retrying without __attribute__((used))');
      }
    }
    if (!compiled) compiled = await compileWithRecovery({ ...opts, source: prepared.plain });
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
    const message = e.name === 'AbortError' ? 'Compiler Explorer request timed out.' : e.message;
    outputChannel.appendLine(`Error: ${message}`);
    vscode.window.showErrorMessage(`Asm Lens: ${message}`);
  } finally { analysisBusy.delete(key); }
}

function reportHeaderWithoutCode(document) {
  const templates = /cpp/.test(document.languageId) && scan.scanDefinitions(document.getText()).some(d => d.kind === 'function' && d.templated);
  vscode.window.showInformationMessage(templates
    ? 'Asm Lens: this header emitted no code: its functions are templates. Click "Instantiate…" above a template to choose its types, or analyze a .cpp file that uses the header.'
    : 'Asm Lens: this header emitted no code (it only has declarations). Analyze a .cpp file that uses it, then come back to this file.');
}

// The text to compile for a C/C++ file. A header compiled on its own gets its
// functions marked __attribute__((used)) (`kept`, with `plain` as the fallback);
// requested template instantiations are appended after the last line.
function prepareCSource(document, { keep = true } = {}) {
  const original = document.getText();
  const isHeader = HEADER_RE.test(document.fileName);
  const insts = /cpp/.test(document.languageId) ? instantiationsFor(document) : [];
  const withInsts = text => scan.appendInstantiations(text, insts).text;
  return {
    isHeader,
    firstLine: scan.appendInstantiations(original, insts).firstLine,
    kept: isHeader && keep ? withInsts(keepHeaderFunctions(original)) : undefined,
    plain: withInsts(original)
  };
}

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
  const rootPathKey = docPathKey(document);
  const functions = parseFunctions(o.rows, o.resolveRef);
  const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri) || [];
  const allSourceFunctions = sourceFunctionsOf(document, symbols);
  const matched = functions.map(fn => {
    const symbol = matchSourceSymbol(fn.name, allSourceFunctions, fn, rootPathKey, { requireName: o.requireName });
    return { ...fn, sourceName: symbol?.name || fn.name, sourceRange: symbol?.range, sourceSelection: symbol?.selectionRange };
  });
  let deps = o.deps;
  if (!deps) { deps = new Set([rootPathKey]); for (const f of functions) for (const k of f.fileKeys) deps.add(k); }
  let paths = o.paths;
  if (!paths) { paths = new Map([[rootPathKey, document.uri.fsPath]]); for (const k of deps) if (k !== rootPathKey) paths.set(k, k); }
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
  codeLensEmitter?.fire();
  return result;
}

// ---------------------------------------------------------------------------
// Local mode: compile only the current file with a local compiler (no upload,
// no project build). Headers are read straight from disk by the compiler.

function splitArgs(s) {
  return (String(s || '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).map(a => a.replace(/^(["'])(.*)\1$/, '$2'));
}

function runProcess(cmd, args, { cwd, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { cwd, windowsHide: true }); } catch (e) { return reject(e); }
    const out = [], err = [];
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs || 60000);
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', e => {
      clearTimeout(timer);
      if (e.code !== 'ENOENT') return reject(e);
      const missing = new Error(`"${cmd}" was not found. Install it or set "compiler" in .asm-lens.json.`);
      missing.code = 'ENOENT';
      reject(missing);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`${cmd} timed out.`));
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
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

function errorsOnly(err) {
  const lines = err.split('\n').filter(l => /\berror\b|fatal/i.test(l)).slice(0, 25).join('\n');
  return (lines || err).slice(0, 1800);
}

async function analyzeLocal(document, resolved, settings) {
  if (document.uri.scheme !== 'file') throw new Error('Local mode needs a file that is saved on disk.');
  const rootPathKey = docPathKey(document);
  const cwd = path.dirname(document.uri.fsPath);
  const baseDir = vscode.workspace.getWorkspaceFolder?.(document.uri)?.uri.fsPath || cwd;
  const compiler = resolved.localCompiler;
  const timeoutMs = settings.get('requestTimeoutMs', 30000);
  const maxAttempts = Math.max(1, Number(settings.get('maxRecoveryAttempts', 12)));
  const recoverErrors = settings.get('skipFailingFunctions', true);
  const incDirs = (resolved.includePaths || []).map(p => p && typeof p === 'object' ? p.dir : (path.isAbsolute(p) ? p : path.resolve(baseDir, p)));
  const flags = [resolved.flags, ...resolved.defines.map(d => `-D${d}`), resolved.extraFlags].filter(Boolean).join(' ');
  const lang = resolved.language === 'c' ? 'c' : 'c++';

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

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const args = [
      ...splitArgs(flags), ...incDirs.map(d => `-I${d}`), '-iquote', cwd,
      ...(stubbed.length ? [`-I${stubDir}`] : []),
      '-S', '-g', '-fdiagnostics-color=never', '-x', lang, '-o', '-', '-'
    ];
    const r = await runProcess(compiler, args, { cwd, input: source, timeoutMs });
    if (r.code === 0) { asm = r.stdout; break; }
    const err = r.stderr.replace(ANSI_RE, '');
    let progressed = false;
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
        failedInstantiations.push({ index: l - prepared.firstLine, message });
        progressed = true;
      }
    }
    if (!progressed && keptHeader) {
      const reverted = revertKeptLines(source, prepared.plain, errorLocationsFrom(err).filter(loc => isMain(loc.file)).map(loc => loc.line));
      if (reverted !== undefined) { source = reverted; progressed = true; }
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
      outputChannel.appendLine('  header: retrying without __attribute__((used))');
      continue;
    }
    if (!progressed || attempt === maxAttempts) {
      outputChannel.appendLine(`Local compile command: ${compiler} ${args.join(' ')}  (cwd ${cwd})`);
      outputChannel.appendLine('--- full compiler output ---\n' + err);
      throw new Error(errorsOnly(err));
    }
  }

  // Demangle names (if c++filt exists) so they match source function names.
  const macho = isMachO(asm);
  if (macho) asm = prepareMachO(asm);
  asm = await demangle(asm, [['c++filt', []], ['llvm-cxxfilt', []]], cwd, timeoutMs);
  if (macho) asm = finishMachO(asm);

  const rows = localAsmToRows(asm, cwd);
  const result = await recordAnalysis(document, {
    rows,
    resolveRef: makeLocalRefResolver(rootPathKey, cwd, [], await realDirsFor([cwd, baseDir])),
    compilerId: compiler,
    compilerLabel: `${path.basename(compiler)} (local)`,
    flags,
    configFile: resolved.configFile,
    skipped: skipped.filter(k => prepared.firstLine < 0 || k.startLine < prepared.firstLine),
    stubbed
  });
  const ms = Date.now() - started;
  outputChannel.appendLine(`Local compile of ${document.fileName} with ${compiler} ${flags} took ${ms} ms; found ${result.functions.length} emitted function(s).`);
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
  const timeoutMs = settings.get('requestTimeoutMs', 30000);
  const rootPathKey = docPathKey(document);
  const required = lang.requiredFlags && !String(resolved.flags).includes(lang.requiredFlags) ? lang.requiredFlags : '';
  const flags = [resolved.flags, resolved.extraFlags, required].filter(Boolean).join(' ');
  const started = Date.now();
  let rows, resolveRef, compilerId, compilerLabel;
  if (resolved.mode === 'local') {
    if (!lang.local) throw new Error(`Local mode is not available for ${lang.label}. Add a ${lang.label} compiler with "mode": "remote" to .asm-lens.json to use Compiler Explorer for it.`);
    ({ rows, resolveRef } = await compileOtherLocally(document, resolved, splitArgs(flags), timeoutMs));
    compilerId = resolved.localCompiler;
    compilerLabel = `${path.basename(compilerId)} (local)`;
  } else {
    compilerId = resolved.active.isDefault ? await ceDefaultCompiler(resolved.baseUrl, lang) : resolved.active.id;
    compilerLabel = resolved.active.isDefault ? `${lang.label} ${compilerId}` : resolved.active.name || compilerId;
    const data = await postCompile({ baseUrl: resolved.baseUrl, compilerId, language: lang.id, timeoutMs, source: document.getText(), files: [], flags });
    if (data.code !== undefined && data.code !== 0) {
      const err = stderrText(data) || `Compiler exited with code ${data.code}`;
      outputChannel.appendLine(`--- ${compilerId} output ---\n${err}`);
      throw new Error(err.slice(0, 1800));
    }
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

const CE_FILTERS = { binary: false, binaryObject: false, commentOnly: false, demangle: true, directives: false, execute: false, intel: true, labels: true, libraryCode: false, trim: false };

async function postCompile({ baseUrl, compilerId, language, timeoutMs, source, files, flags }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${baseUrl}/api/compiler/${encodeURIComponent(compilerId)}/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ source, lang: language, ...(files.length ? { files } : {}), options: { userArguments: flags, filters: CE_FILTERS } }),
      signal: controller.signal
    });
  } finally { clearTimeout(timeout); }
  if (!response.ok) throw new Error(`Compiler Explorer returned HTTP ${response.status}. Check the compiler ID and network connection.`);
  return response.json();
}

function stderrText(data) {
  return (data.stderr || []).map(x => x.text || '').join('\n').replace(ANSI_RE, '');
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
  let source = opts.source;
  let flags = [opts.flags, ...includeBundle.includeFlags].filter(Boolean).join(' ');
  let lastErr = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const data = await postCompile({ ...opts, source, files, flags });
    if (data.code === undefined || data.code === 0) {
      if (attempt > 1) outputChannel.appendLine(`Compiled after ${attempt - 1} recovery step(s).`);
      return { data, effectiveFlags: flags, skipped, stubbed, failedInstantiations };
    }
    lastErr = stderrText(data) || `Compiler exited with code ${data.code}`;

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
      failedInstantiations.push({ index: l - opts.instFirstLine, message });
      progressed = true;
    }
    if (progressed) continue;

    // 3. __attribute__((used)) added to a header line that the compiler rejects -> remove it there.
    const reverted = revertKeptLines(source, opts.original, errorLocationsFrom(lastErr).filter(loc => isRemoteMain(loc.file)).map(loc => loc.line));
    if (reverted !== undefined && reverted !== source) { source = reverted; continue; }

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

function showAssembly(result, analysis) {
  if (!outputPanel) {
    outputPanel = vscode.window.createWebviewPanel('asmLensAssembly', 'Asm Lens Assembly', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
    outputPanel.onDidDispose(() => {
      clearSourceHighlight();
      clearSourceColors();
      outputPanel = undefined;
      panelState = undefined;
    });
    outputPanel.onDidChangeViewState(e => { if (e.webviewPanel.visible) applySourceColors(); else { clearSourceColors(); clearSourceHighlight(); } });
    outputPanel.webview.onDidReceiveMessage(handleWebviewMessage);
  }
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
  panelState = { analysis, result, fileKeys, groups, stale: false };
  const colorize = config().get('colorizeLines', true);
  outputPanel.title = `Assembly: ${result.sourceName || result.name}`;
  const rowsHtml = displayRows.map(row => {
    let cls = 'asm-line';
    let attrs = '';
    if (row.ref) {
      attrs = ` data-f="${fileKeys.indexOf(row.ref.key)}" data-l="${row.ref.line}"`;
      if (row.ref.column !== undefined) attrs += ` data-c="${row.ref.column}"`;
      if (colorize) cls += ` c${colorOf.get(`${row.ref.key}\n${row.ref.line}`)}`;
    }
    return `<span class="${cls}"${attrs}>${escapeHtml(row.text)}</span>`;
  }).join('\n');
  const title = escapeHtml(`${result.sourceName || result.name} — ${result.count} instructions`);
  const meta = escapeHtml(`${analysis.compilerLabel} · ${analysis.compilerId} · ${analysis.flags}`);
  const nonce = crypto.randomBytes(16).toString('base64');
  const paletteCss = PALETTE.map((c, i) => `.c${i}{background:${c}}`).join('\n');
  const noMap = displayRows.some(r => r.ref) ? '' : '<p class="meta">No source mapping is available for this function, so hover highlighting is disabled.</p>';
  outputPanel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:16px}
.asm{font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size);white-space:pre;overflow:auto;background:var(--vscode-editor-background);padding:12px;border:1px solid var(--vscode-panel-border)}
.asm-line{display:block;min-height:1em}
.asm-line[data-l]{cursor:pointer}
${paletteCss}
.asm-line.hl{background:var(--vscode-editor-findMatchHighlightBackground);outline:1px solid var(--vscode-editor-findMatchBorder, var(--vscode-focusBorder))}
.asm-line.hl-self{background:var(--vscode-editor-findMatchBackground)}
.meta{color:var(--vscode-descriptionForeground);margin-bottom:14px}
</style></head><body><h2>${title}</h2><div class="meta">${meta}</div>${noMap}<div class="asm">${rowsHtml}</div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
const groups=new Map();
const mapped=[...document.querySelectorAll('.asm-line[data-l]')];
const gk=el=>el.dataset.f+':'+el.dataset.l;
for(const el of mapped){const k=gk(el);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(el);}
let current='';let leaveTimer;
function clearMarks(){current='';document.querySelectorAll('.hl,.hl-self').forEach(e=>e.classList.remove('hl','hl-self'));}
function mark(k,self,scroll){clearMarks();current=k;const els=groups.get(k)||[];els.forEach(e=>e.classList.add('hl'));if(self)self.classList.add('hl-self');if(scroll&&els.length)els[0].scrollIntoView({block:'nearest'});}
const payload=(type,el)=>({type,file:Number(el.dataset.f),line:Number(el.dataset.l),column:el.dataset.c===undefined?undefined:Number(el.dataset.c)});
for(const el of mapped){
  el.addEventListener('mouseenter',()=>{clearTimeout(leaveTimer);const k=gk(el);const same=k===current;mark(k,el,false);if(!same)vscode.postMessage(payload('highlight',el));});
  el.addEventListener('click',()=>vscode.postMessage(payload('open',el)));
}
const box=document.querySelector('.asm');
if(box)box.addEventListener('mouseleave',()=>{leaveTimer=setTimeout(()=>{clearMarks();vscode.postMessage({type:'clearHighlight'});},150);});
window.addEventListener('message',e=>{const m=e.data||{};if(m.type==='highlightAsm'){const k=m.file+':'+m.line;if(k!==current)mark(k,null,true);}else if(m.type==='clearAsm')clearMarks();});
</script></body></html>`;
  outputPanel.reveal(vscode.ViewColumn.Beside, true);
  applySourceColors();
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
  if (!message || !panelState) return;
  if (message.type === 'clearHighlight') return clearSourceHighlight();
  if (message.type !== 'highlight' && message.type !== 'open') return;
  const key = panelState.fileKeys[message.file];
  if (!key || !Number.isInteger(message.line) || message.line < 0) return;
  const column = Number.isInteger(message.column) ? message.column : undefined;
  if (message.type === 'highlight') {
    if (config().get('highlightOnHover', true)) highlightSource(key, message.line, column);
    return;
  }
  const real = panelState.analysis.paths.get(key);
  if (!real) return;
  const pos = new vscode.Position(message.line, column || 0);
  vscode.window.showTextDocument(vscode.Uri.file(real), { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.One, preserveFocus: false })
    .then(() => { applySourceColors(); highlightSource(key, message.line, column); }, () => { /* file may have been deleted */ });
}

function visibleEditorsFor(key) {
  return vscode.window.visibleTextEditors.filter(e => e.document.uri.scheme === 'file' && normPath(e.document.uri.fsPath) === key);
}

// Highlight the whole source line plus, when Compiler Explorer reports a column,
// the token at that column.
function highlightSource(key, line, column) {
  clearSourceHighlight();
  for (const editor of visibleEditorsFor(key)) {
    const document = editor.document;
    if (line >= document.lineCount) continue;
    const range = document.lineAt(line).range;
    editor.setDecorations(lineDecoration, [{ range }]);
    if (column !== undefined && column < range.end.character) {
      const token = document.getWordRangeAtPosition(new vscode.Position(line, column));
      if (token) editor.setDecorations(tokenDecoration, [{ range: token }]);
    }
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}
function clearSourceHighlight() {
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(lineDecoration, []);
    editor.setDecorations(tokenDecoration, []);
  }
}

// Source -> assembly: highlight the panel's instructions for the hovered or
// selected source line (only when the panel shows this analysis).
function syncAsmHighlight(analysis, key, line) {
  if (!outputPanel || !panelState || panelState.stale || panelState.analysis.rootKey !== analysis.rootKey) return;
  if (!config().get('highlightOnHover', true)) return;
  const file = panelState.fileKeys.indexOf(key);
  const hasRows = file >= 0 && panelState.result.instructionRows.some(r => r.ref && r.ref.key === key && r.ref.line === line);
  outputPanel.webview.postMessage(hasRows ? { type: 'highlightAsm', file, line } : { type: 'clearAsm' });
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

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function deactivate() { if (outputPanel) outputPanel.dispose(); }
module.exports = {
  activate, deactivate,
  // exported for tests
  _internals: {
    resolveSettings, showAssembly, handleWebviewMessage, syncAsmHighlight, _state: () => ({ panelState, lastAnalysis }),
    compileWithRecovery, collectLocalIncludes, guessFunctionSymbols, sourceFunctionsOf, analysisFor, analyzeDocument,
    instantiationsFor, prepareCSource, isSystemHeader, globToRegExp, splitArgs
  }
};
