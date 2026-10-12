const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const projectConfig = require('./projectConfig');

const LANGS = ['c', 'cpp', 'objective-c', 'objective-cpp'];
const IS_WIN = process.platform === 'win32';
const VIRTUAL_ROOT = 'asm_lens';

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
function normPath(p) { const n = path.resolve(p); return IS_WIN ? n.toLowerCase() : n; }
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

// Everything an analysis needs, for one document.
async function resolveSettings(document) {
  const s = config();
  const project = await loadProject(document);
  const c = project?.config;
  const docLang = document.languageId === 'c' ? 'c' : 'c++';
  const all = c?.compilers?.length
    ? c.compilers
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
    mode: c?.mode || 'remote',
    localCompiler: active.compiler || c?.compiler || 'g++'
  };
}

async function refreshStatusBar() {
  if (!statusItem) return;
  const document = vscode.window.activeTextEditor?.document;
  if (!document || !LANGS.includes(document.languageId)) return statusItem.hide();
  try {
    const r = await resolveSettings(document);
    statusItem.text = `$(chip) ${r.active.name || r.active.id}`;
    statusItem.tooltip = `Asm Lens compiler: ${r.active.id}\n${r.configFile ? `Config: ${r.configFile}` : 'No .asm-lens.json (using VS Code settings)'}\nClick to change`;
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
      if (!cached) {
        return functions.map(sym => new vscode.CodeLens(sym.range, {
          title: '$(play) Analyze with Asm Lens',
          command: 'asmLens.analyzeFile',
          arguments: [document.uri]
        }));
      }
      const key = docPathKey(document);
      const viaRoot = cached.rootKey !== fileKey(document) ? ` · via ${path.basename(cached.rootPath)}` : '';
      return functions.map(sym => {
        const result = findFunctionResult(sym, cached.functions, key);
        const wasSkipped = !result && (cached.skipped || []).some(k => k.key === key && sym.range.start.line >= k.startLine && sym.range.start.line <= k.endLine);
        const title = result
          ? `$(symbol-numeric) ${result.count} instructions · ${cached.compilerLabel} · ${cached.flags}${viaRoot}`
          : wasSkipped
            ? `$(warning) Not compiled · this function has compile errors (missing include?) · ${cached.compilerLabel}`
            : `$(info) Assembly unavailable · ${cached.compilerLabel}`;
        return new vscode.CodeLens(sym.range, {
          title,
          command: 'asmLens.showAssembly',
          arguments: [document.uri, sym.name]
        });
      });
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
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncAsmHighlight(analysis, docPathKey(document), line), 50);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('asmLens.analyzeFile', async (uri) => {
    const editor = vscode.window.activeTextEditor;
    const document = uri ? await vscode.workspace.openTextDocument(uri) : editor && editor.document;
    if (!document) return vscode.window.showWarningMessage('Open a C/C++ file first.');
    await analyzeDocument(document);
  }));

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
      if (settings?.configFile) {
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

  context.subscriptions.push(vscode.commands.registerCommand('asmLens.showAssembly', async (uri, functionName) => {
    const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!document) return;
    const cached = analysisFor(document);
    if (!cached) return analyzeDocument(document);
    const result = findFunctionResult({ name: functionName }, cached.functions, docPathKey(document));
    if (!result) return vscode.window.showInformationMessage(`No emitted assembly found for ${functionName}. It may have been optimized away or inlined.`);
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

function guessFunctionSymbols(document) {
  const lines = document.getText().split(/\r?\n/);
  const out = [];
  const seen = new Set();
  const ignored = new Set(['if', 'for', 'while', 'switch', 'catch', 'sizeof', 'decltype', 'return', 'new', 'delete']);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:#|\/\/|\/\*|\*|using\b|typedef\b|class\b|struct\b|enum\b)/.test(line)) continue;
    const m = line.match(/^\s*(?:(?:[\w:<>~,*&]+\s+)+)?([~A-Za-z_]\w*(?:::\w+)*(?:<[^{};]*>)?)\s*\([^;{}]*\)\s*(?:const\b\s*)?(?:noexcept\b\s*)?(?:->\s*[\w:<>*& ]+)?\s*(\{)?\s*(?:\/\/.*)?$/);
    if (!m || ignored.has(m[1])) continue;
    // Avoid ordinary declarations: require an opening brace on this line or
    // one of the next two lines (supports the common brace-on-next-line style).
    let hasBody = Boolean(m[2]);
    if (!hasBody) {
      for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
        if (/^\s*\{/.test(lines[j])) { hasBody = true; break; }
        if (/;/.test(lines[j]) || /\S/.test(lines[j]) && !/^\s*(?:const\b|noexcept\b|->)/.test(lines[j])) break;
      }
    }
    if (!hasBody || seen.has(`${m[1]}:${i}`)) continue;
    seen.add(`${m[1]}:${i}`);
    out.push({ name: m[1], kind: vscode.SymbolKind.Function, range: new vscode.Range(i, 0, i, line.length), selectionRange: new vscode.Range(i, 0, i, line.length), children: [] });
  }
  return out;
}

function isFunctionSymbol(s) {
  return [vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor, vscode.SymbolKind.Operator].includes(s.kind);
}

// The analysis that covers `document`: its own, or the newest one that uploaded
// it as an included header.
function analysisFor(document) {
  const own = lastAnalysis.get(fileKey(document));
  if (own) return own;
  if (document.uri.scheme !== 'file') return undefined;
  const key = docPathKey(document);
  let best;
  for (const analysis of lastAnalysis.values()) {
    if (analysis.deps.has(key) && (!best || analysis.timestamp > best.timestamp)) best = analysis;
  }
  return best;
}

function functionAtSignature(document, position, analysis, key) {
  if (key === analysis.rootPathKey) {
    const hit = analysis.functions.find(f => f.sourceRange && (f.sourceSelection || f.sourceRange).contains(position));
    if (hit) return hit;
  }
  const guessed = guessFunctionSymbols(document).find(s => s.range.start.line === position.line);
  return guessed ? findFunctionResult(guessed, analysis.functions, key) : undefined;
}

// ---------------------------------------------------------------------------
// Analysis

async function analyzeDocument(document) {
  const key = fileKey(document);
  if (analysisBusy.has(key)) return;
  if (!LANGS.includes(document.languageId)) {
    return vscode.window.showWarningMessage('Asm Lens currently supports C and C++ files.');
  }
  analysisBusy.add(key);
  try {
    const settings = config();
    const resolved = await resolveSettings(document);
    if (resolved.configError) vscode.window.showWarningMessage(`Asm Lens: ${resolved.configError} Using VS Code settings instead.`);
    if (resolved.mode === 'local') return await analyzeLocal(document, resolved, settings);
    const { baseUrl, language } = resolved;
    const flags = [resolved.flags, ...resolved.defines.map(d => `-D${d}`), resolved.extraFlags].filter(Boolean).join(' ');
    const compilerId = resolved.active.id;
    const timeoutMs = settings.get('requestTimeoutMs', 30000);
    const source = document.getText();
    const includeBundle = await collectLocalIncludes(document, resolved.includePaths, {
      maxFiles: resolved.maxIncludeFiles, buildFolders: resolved.buildFolders,
      excludePaths: resolved.excludePaths, uploadSystemHeaders: resolved.uploadSystemHeaders
    });
    const maxAttempts = Math.max(1, Number(settings.get('maxRecoveryAttempts', 12)));
    const recoverErrors = settings.get('skipFailingFunctions', true);
    const compiled = await compileWithRecovery({
      baseUrl, compilerId, language, timeoutMs, source, flags, includeBundle, maxAttempts, recoverErrors, rootFile: document.fileName
    });
    const { data, effectiveFlags } = compiled;
    const asmRows = Array.isArray(data.asm) ? data.asm : [];
    const asmText = asmRows.map(x => typeof x === 'string' ? x : x.text || '').join('\n');
    const rootPathKey = docPathKey(document);
    const resolveRef = makeRefResolver(rootPathKey, includeBundle.pathMap);
    const functions = parseFunctions(asmRows, resolveRef);
    const totalInstr = functions.reduce((n, f) => n + f.instructionRows.length, 0);
    const mappedInstr = functions.reduce((n, f) => n + f.instructionRows.filter(r => r.ref).length, 0);
    const metaRows = asmRows.filter(r => r && typeof r === 'object' && r.source).length;
    outputChannel.appendLine(`Source mapping: ${mappedInstr}/${totalInstr} instructions mapped to local files (${metaRows} rows carried Compiler Explorer source metadata).`);
    if (totalInstr && !mappedInstr) outputChannel.appendLine('  No instruction could be mapped: hover highlighting needs debug line info from the compiler. Sample rows: ' + JSON.stringify(asmRows.slice(0, 5)));
    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri) || [];
    const allSourceFunctions = sourceFunctionsOf(document, symbols);
    const matched = functions.map(fn => {
      const symbol = matchSourceSymbol(fn.name, allSourceFunctions, fn, rootPathKey);
      return { ...fn, sourceName: symbol?.name || fn.name, sourceRange: symbol?.range, sourceSelection: symbol?.selectionRange };
    });
    const paths = new Map([[rootPathKey, document.uri.fsPath]]);
    for (const entry of includeBundle.pathMap) paths.set(normPath(entry.real), entry.real);
    const result = {
      functions: matched,
      lineIndex: buildLineIndex(matched),
      asmText,
      asmRows,
      compilerId,
      compilerLabel: resolved.active.name || compilerId,
      flags: effectiveFlags,
      includeCount: includeBundle.files.length,
      rootKey: key,
      configFile: resolved.configFile,
      rootPath: document.uri.fsPath,
      rootPathKey,
      deps: new Set([rootPathKey, ...includeBundle.pathMap.map(e => normPath(e.real))]),
      paths,
      timestamp: Date.now(),
      skipped: compiled.skipped.map(k => {
        const entry = k.key === 'main' ? undefined : includeBundle.pathMap.find(e => e.virtual === k.key);
        return { ...k, key: k.key === 'main' ? rootPathKey : entry ? normPath(entry.real) : k.key };
      }),
      stubbed: compiled.stubbed,
      sourceVersion: document.version
    };
    lastAnalysis.set(key, result);
    codeLensEmitter?.fire();
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
    vscode.window.showInformationMessage(`Asm Lens: found ${functions.length} emitted function bodies${includeBundle.pathMap.length ? `; uploaded ${includeBundle.pathMap.length} local header(s)` : ''}${notes.length ? ` (${notes.join('; ')}; see the Asm Lens output)` : ''}.`);
  } catch (e) {
    const message = e.name === 'AbortError' ? 'Compiler Explorer request timed out.' : e.message;
    outputChannel.appendLine(`Error: ${message}`);
    vscode.window.showErrorMessage(`Asm Lens: ${message}`);
  } finally { analysisBusy.delete(key); }
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
    try { child = spawn(cmd, args, { cwd }); } catch (e) { return reject(e); }
    const out = [], err = [];
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs || 60000);
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', e => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`"${cmd}" was not found. Install it or set "compiler" in .asm-lens.json.`) : e);
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

// Maps `.file`/`.loc` paths from local compiler output to local files.
// "<stdin>" is the analyzed file (it is compiled from the editor buffer).
function makeLocalRefResolver(mainKey, cwd) {
  return function resolveRef(row) {
    const s = row && typeof row === 'object' ? row.source : undefined;
    if (!s || !Number.isInteger(s.line) || s.line <= 0) return undefined;
    const line = s.line - 1;
    const column = Number.isInteger(s.column) && s.column > 0 ? s.column - 1 : undefined;
    const file = String(s.file || '');
    if (!file || file === '<stdin>' || file === '-') return { key: mainKey, line, column };
    const abs = path.isAbsolute(file) ? file : path.resolve(cwd, file);
    if (/^\/usr\/|\/include\/c\+\+\//.test(abs.replace(/\\/g, '/'))) return undefined; // system headers
    return { key: normPath(abs), line, column };
  };
}

// Converts raw `-S -g` output into Compiler Explorer-style rows: { text, source }.
// Reads .file/.loc for line info and drops assembler directives and comments.
function localAsmToRows(asm, cwd) {
  const files = new Map();
  let cur = null;
  const rows = [];
  for (const raw of asm.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const t = line.trim();
    let m;
    if ((m = t.match(/^\.file\s+(\d+)\s+"([^"]*)"(?:\s+"([^"]*)")?/))) {
      const name = m[3] !== undefined ? (path.isAbsolute(m[3]) ? m[3] : path.join(m[2] || cwd, m[3])) : m[2];
      files.set(Number(m[1]), name);
      continue;
    }
    if ((m = t.match(/^\.loc\s+(\d+)\s+(\d+)(?:\s+(\d+))?/))) {
      const line0 = Number(m[2]);
      cur = line0 > 0 ? { file: files.get(Number(m[1])) || '<stdin>', line: line0, column: m[3] ? Number(m[3]) : undefined } : null;
      continue;
    }
    if (!t || t.startsWith('#') || t.startsWith('//')) continue;
    if (/^\.[A-Za-z_]/.test(t) && !/^\.[\w.$]+:/.test(t)) continue;   // directive, not a label
    if (/^\.L(?:tmp|func_end|fe|ASF|FB|FE|VL|ehtable|Lexception|Ldebug|Linfo|Lsection)/.test(t)) continue; // debug/EH labels
    const isLabel = /^[^\s].*:\s*(#.*)?$/.test(line);
    rows.push({ text: line, source: isLabel || !cur ? undefined : { ...cur } });
  }
  return rows;
}

async function analyzeLocal(document, resolved, settings) {
  if (document.uri.scheme !== 'file') throw new Error('Local mode needs a file that is saved on disk.');
  const key = fileKey(document);
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
  let source = document.getText();
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
    if (!progressed && recoverErrors) {
      for (const loc of errorLocationsFrom(err)) {
        if (loc.file !== '<stdin>') continue;
        const cut = blankEnclosingDeclaration(source, loc.line);
        if (!cut) continue;
        source = cut.text;
        skipped.push({ name: cut.name, file: document.fileName, key: rootPathKey, startLine: cut.startLine, endLine: cut.endLine });
        progressed = true;
      }
    }
    if (!progressed || attempt === maxAttempts) {
      outputChannel.appendLine(`Local compile command: ${compiler} ${args.join(' ')}  (cwd ${cwd})`);
      outputChannel.appendLine('--- full compiler output ---\n' + err);
      const errorsOnly = err.split('\n').filter(l => /\berror\b|fatal/i.test(l)).slice(0, 25).join('\n');
      throw new Error((errorsOnly || err).slice(0, 1800));
    }
  }

  // Demangle names (if c++filt exists) so they match source function names.
  try {
    const d = await runProcess('c++filt', [], { cwd, input: asm, timeoutMs });
    if (d.code === 0 && d.stdout) asm = d.stdout;
  } catch (_) { /* c++filt not installed: keep mangled names */ }

  const rows = localAsmToRows(asm, cwd);
  asm = rows.map(r => r.text).join('\n');
  const functions = parseFunctions(rows, makeLocalRefResolver(rootPathKey, cwd));
  const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri) || [];
  const allSourceFunctions = sourceFunctionsOf(document, symbols);
  const matched = functions.map(fn => {
    const symbol = matchSourceSymbol(fn.name, allSourceFunctions, fn, rootPathKey);
    return { ...fn, sourceName: symbol?.name || fn.name, sourceRange: symbol?.range, sourceSelection: symbol?.selectionRange };
  });
  const fileKeys = new Set([rootPathKey]);
  for (const f of functions) for (const k of f.fileKeys) fileKeys.add(k);
  const paths = new Map([[rootPathKey, document.uri.fsPath]]);
  for (const k of fileKeys) if (k !== rootPathKey) paths.set(k, k);

  lastAnalysis.set(key, {
    functions: matched,
    lineIndex: buildLineIndex(matched),
    asmText: asm,
    asmRows: rows,
    compilerId: compiler,
    compilerLabel: `${path.basename(compiler)} (local)`,
    flags,
    includeCount: 0,
    rootKey: key,
    configFile: resolved.configFile,
    rootPath: document.uri.fsPath,
    rootPathKey,
    deps: fileKeys,
    paths,
    timestamp: Date.now(),
    skipped,
    stubbed,
    sourceVersion: document.version
  });
  codeLensEmitter?.fire();
  const ms = Date.now() - started;
  outputChannel.appendLine(`Local compile of ${document.fileName} with ${compiler} ${flags} took ${ms} ms; found ${functions.length} emitted function(s).`);
  for (const n of stubbed) outputChannel.appendLine(`  missing header treated as empty: ${n}`);
  for (const k of skipped) outputChannel.appendLine(`  skipped (does not compile): ${k.name || '(declaration)'} at line ${k.startLine + 1}-${k.endLine + 1}`);
  vscode.window.showInformationMessage(`Asm Lens (local): found ${functions.length} emitted function bodies in ${ms} ms${stubbed.length || skipped.length ? ' (see the Asm Lens output)' : ''}.`);
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

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
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

// Names of includes the compiler reported as missing.
function missingIncludesFrom(errText) {
  const names = new Set();
  for (const m of errText.matchAll(/fatal error:\s*(.+?):\s*No such file or directory/g)) names.add(m[1].trim());
  return [...names];
}

// Files that broke during preprocessing (#error, malformed #if, ...).
function preprocessorErrorFilesFrom(errText) {
  const files = new Set();
  const re = /^(.+?):\d+(?::\d+)?:\s*(?:fatal )?error:\s*(?:#error|#if|#elif|missing binary operator|missing '\)'|invalid preprocessing directive|unterminated|token ".*" is not valid|operator '.*' has no)/gm;
  for (const m of errText.matchAll(re)) files.add(m[1].trim());
  return [...files];
}

// [{ file, line (0-based) }] for every `error:` diagnostic.
function errorLocationsFrom(errText) {
  const out = [];
  for (const m of errText.matchAll(/^(.+?):(\d+)(?::\d+)?:\s*(?:fatal )?error:/gm)) out.push({ file: m[1].trim(), line: Number(m[2]) - 1 });
  return out;
}

async function compileWithRecovery(opts) {
  const { includeBundle, maxAttempts, recoverErrors } = opts;
  const files = includeBundle.files.map(f => ({ ...f }));
  const stubbed = [];
  const stubNames = new Set();
  const skipped = [];
  let source = opts.source;
  let flags = [opts.flags, ...includeBundle.includeFlags].filter(Boolean).join(' ');
  let lastErr = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const data = await postCompile({ ...opts, source, files, flags });
    if (data.code === undefined || data.code === 0) {
      if (attempt > 1) outputChannel.appendLine(`Compiled after ${attempt - 1} recovery step(s).`);
      return { data, effectiveFlags: flags, skipped, stubbed };
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
    if (!recoverErrors) break;

    // 2. Errors inside functions -> blank those functions out and retry.
    for (const loc of errorLocationsFrom(lastErr)) {
      let target;
      if (/^<source>$|^<stdin>$|(^|\/)example\.\w+$/.test(loc.file.replace(/\\/g, '/'))) target = 'main';
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

// Where an empty stand-in for a missing include goes (the remote working
// directory, which `-I.` adds to the search path). Names that try to leave it are refused.
function stubFilename(name) {
  const norm = path.posix.normalize(String(name).replace(/\\/g, '/'));
  if (!norm || norm.startsWith('../') || norm === '..' || path.posix.isAbsolute(norm)) return undefined;
  return norm;
}

// Blank the function (signature and body) or statement that contains `line`,
// replacing every character but newlines with spaces so line numbers survive.
// Returns { text, name, startLine, endLine } or undefined if nothing safe to cut.
function blankEnclosingDeclaration(text, line) {
  const n = text.length;
  const masked = maskCode(text);
  const lineStarts = [0];
  for (let i = 0; i < n; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineOf = idx => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; } return lo; };
  const dirEnds = masked.directiveEnds;
  let dirPtr = 0;
  const m = masked.text;
  const stack = []; // { isFunc, declStart }
  let boundary = 0;
  let candidate;
  const inFunc = () => stack.some(s => s.isFunc);
  const consider = (start, end, name) => {
    if (candidate) return;
    // Begin at the first code character, so comments above the declaration stay.
    const offset = m.slice(start, end).search(/\S/);
    if (offset < 0) return;
    const from = start + offset;
    const first = lineOf(from), last = lineOf(end - 1);
    if (line >= first && line <= last) candidate = { start: from, end, name, startLine: first, endLine: last };
  };
  for (let i = 0; i < n; i++) {
    while (dirPtr < dirEnds.length && dirEnds[dirPtr] <= i) { if (!inFunc()) boundary = Math.max(boundary, dirEnds[dirPtr]); dirPtr++; }
    const c = m[i];
    if (c === '{') {
      if (inFunc()) { stack.push({ isFunc: false }); continue; }
      const seg = m.slice(boundary, i).replace(/^\s*(?:public|private|protected)\s*:/, '');
      const fn = classifyFunctionSegment(seg);
      stack.push({ isFunc: !!fn, declStart: boundary, name: fn?.name });
      boundary = i + 1;
    } else if (c === '}') {
      const top = stack.pop();
      if (top && top.isFunc) consider(top.declStart, i + 1, top.name);
      if (!inFunc()) boundary = i + 1;
    } else if (c === ';' && !inFunc()) {
      if (/\S/.test(m.slice(boundary, i))) consider(boundary, i + 1, undefined);
      boundary = i + 1;
    }
  }
  if (!candidate) return undefined;
  const out = text.slice(0, candidate.start) + text.slice(candidate.start, candidate.end).replace(/[^\n]/g, ' ') + text.slice(candidate.end);
  return { text: out, name: candidate.name, startLine: candidate.startLine, endLine: candidate.endLine };
}

// Looks at the text between the previous boundary and a `{` and decides whether
// it opens a function body (as opposed to a class, namespace, enum, control block...).
function classifyFunctionSegment(seg) {
  const s = seg.replace(/\btemplate\s*<[^;{}]*?>\s*/g, '').trim();
  if (!s || !s.includes('(')) return undefined;
  if (/^(?:if|for|while|switch|catch|else|do|try)\b/.test(s)) return undefined;
  if (/^(?:namespace|class|struct|union|enum|extern)\b/.test(s) && !/\)\s*(?:const|noexcept|override|final|\s)*$/.test(s)) return undefined;
  if (!/\)\s*(?:(?:const|volatile|noexcept(?:\s*\([^)]*\))?|override|final|&&?|->[^;{}]*|\s)*)$/.test(s) && !/\)\s*:/.test(s) && !/\)\s*\{?$/.test(s)) return undefined;
  const nm = s.match(/([~A-Za-z_][\w:~]*(?:\s*<[^()]*>)?|operator\s*[^\s(]+)\s*\(/);
  return { name: nm ? nm[1] : undefined };
}

// Copy of `text` with comments, string/char literals and preprocessor lines
// replaced by spaces (newlines kept), plus the offsets where directives end.
function maskCode(text) {
  const n = text.length;
  const out = text.split('');
  const directiveEnds = [];
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0, lineStart = true;
  while (i < n) {
    const c = text[i];
    if (c === '\n') { lineStart = true; i++; continue; }
    if (lineStart && /\s/.test(c)) { i++; continue; }
    if (lineStart && c === '#') {
      let j = i;
      while (j < n && !(text[j] === '\n' && text[j - 1] !== '\\')) j++;
      // comments inside the directive are blanked along with it
      blank(i, j); directiveEnds.push(j); i = j; continue;
    }
    lineStart = false;
    if (c === '/' && text[i + 1] === '/') { let j = i; while (j < n && text[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '/' && text[i + 1] === '*') { let j = text.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; blank(i, j); i = j; continue; }
    if (c === '"' || c === "'") {
      // raw string R"delim( ... )delim"
      if (c === '"' && text[i - 1] === 'R') {
        const d = text.slice(i + 1).match(/^([^()\\\s]{0,16})\(/);
        if (d) { const endTok = ')' + d[1] + '"'; let j = text.indexOf(endTok, i); j = j < 0 ? n : j + endTok.length; blank(i, j); i = j; continue; }
      }
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') { if (text[j] === '\\') j++; j++; }
      blank(i, Math.min(j + 1, n)); i = j + 1; continue;
    }
    i++;
  }
  return { text: out.join(''), directiveEnds };
}

// ---------------------------------------------------------------------------
// Assembly parsing and source mapping

// Turns Compiler Explorer's per-row `source` metadata into { key, line, column }
// where `key` identifies a real local file. Rows from files we did not upload
// (system headers) resolve to undefined instead of being mis-mapped to the
// analyzed file.
function makeRefResolver(mainKey, pathMap) {
  const entries = (pathMap || [])
    .map(e => ({ virtual: e.virtual, key: normPath(e.real) }))
    .sort((a, b) => b.virtual.length - a.virtual.length);
  return function resolveRef(row) {
    const s = row && typeof row === 'object' ? row.source : undefined;
    if (s === undefined || s === null) return undefined;
    if (Number.isInteger(s)) return s > 0 ? { key: mainKey, line: s - 1 } : undefined;
    if (typeof s !== 'object' || !Number.isInteger(s.line) || s.line <= 0) return undefined;
    const column = Number.isInteger(s.column) && s.column > 0 ? s.column - 1 : undefined;
    const line = s.line - 1;
    const file = s.file;
    if (file === null || file === undefined || file === 0 || s.mainsource === true) return { key: mainKey, line, column };
    if (typeof file !== 'string') return undefined;
    const norm = file.replace(/\\/g, '/');
    for (const e of entries) {
      if (norm === e.virtual || norm.endsWith('/' + e.virtual)) return { key: e.key, line, column };
    }
    if (/<source>|<stdin>|(^|\/)example\.[^/]+$/.test(norm)) return { key: mainKey, line, column };
    return undefined;
  };
}

// Compilers also state the mapping inside the assembly (`.file N "name"`,
// `.loc N line col`). Compiler Explorer's per-row `source` metadata is preferred;
// these directives are the fallback when a row has none.
const FILE_DIRECTIVE = /^\.file\s+(\d+)\s+"((?:[^"\\]|\\.)*)"(?:\s+"((?:[^"\\]|\\.)*)")?/;
const LOC_DIRECTIVE = /^\.loc\s+(\d+)\s+(\d+)(?:\s+(\d+))?/;

function parseFunctions(rows, resolveRef) {
  const functions = [];
  const fileTable = new Map();
  for (const row of rows) {
    const t = (typeof row === 'string' ? row : row.text || '').trim();
    const m = t.match(FILE_DIRECTIVE);
    if (m) fileTable.set(Number(m[1]), m[3] !== undefined && !/^[/<]|^[A-Za-z]:[\\/]/.test(m[3]) ? `${m[2]}/${m[3]}` : (m[3] !== undefined ? m[3] : m[2]));
  }
  let current = null;
  let loc;
  for (const row of rows) {
    const text = (typeof row === 'string' ? row : row.text || '').replace(/\r/g, '');
    const trimmed = text.trim();
    const lm = resolveRef ? trimmed.match(LOC_DIRECTIVE) : null;
    if (lm) {
      const name = fileTable.get(Number(lm[1]));
      loc = name === undefined ? undefined : resolveRef({ source: { file: name, line: Number(lm[2]), column: lm[3] && Number(lm[3]) > 0 ? Number(lm[3]) : undefined } });
    }
    const hasMeta = row && typeof row === 'object' && row.source !== undefined && row.source !== null;
    let ref = resolveRef ? resolveRef(row) : undefined;
    if (!ref && !hasMeta && loc && isInstructionLine(trimmed)) ref = loc;
    const labelMatch = trimmed.match(/^([^\s].*):(?:\s*(?:[#;].*)?)?$/);
    if (labelMatch && !trimmed.startsWith('.L') && !trimmed.startsWith('$')) {
      const label = labelMatch[1].trim();
      if (looksLikeFunctionLabel(label)) {
        if (current) functions.push(finalizeFunction(current));
        current = { name: label, rows: [{ text, ref: undefined }], lines: [text], count: 0, instructionLines: [], instructionRows: [] };
        continue;
      }
    }
    if (current) {
      current.rows.push({ text, ref });
      current.lines.push(text);
      if (isInstructionLine(trimmed)) {
        current.count++;
        current.instructionLines.push(text);
        current.instructionRows.push({ text, ref });
      }
    }
  }
  if (current) functions.push(finalizeFunction(current));
  return functions;
}
function looksLikeFunctionLabel(label) {
  if (!label || label.startsWith('.') || label.startsWith('$')) return false;
  if (/^(?:LBB|LBE|Ltmp|LCFI|Lfunc_begin|Lfunc_end|\.L)/.test(label)) return false;
  return /[A-Za-z_?@]/.test(label) && label.length < 500;
}
function isInstructionLine(line) {
  if (!line || line.startsWith('.') || line.startsWith('#') || line.startsWith(';') || line.endsWith(':')) return false;
  if (/^(?:[A-Za-z_.$?@][\w.$?@]*):/.test(line)) return false;
  const token = line.split(/\s+/)[0];
  if (!token || token.startsWith('.')) return false;
  if (/^(?:section|global|type|size|align|p2align|file|loc|cfi_\w*|intel_syntax|att_syntax|ident|weak|hidden|globl|end|proc|endp|public|extern|assume|segment|ends|equ|db|dw|dd|dq|dt|org|include|includelib|macro|endm|title|subttl|model|code|data|const|byte|word|dword|qword|zero|string|ascii|asciz|long|quad|short|value|text|bss|comm|lcomm|set|option|ALIGN|PUBLIC|EXTRN)$/i.test(token)) return false;
  return /^[A-Za-z][A-Za-z0-9_.]*$/.test(token);
}
function finalizeFunction(fn) {
  const fileKeys = new Set();
  for (const r of fn.instructionRows) if (r.ref) fileKeys.add(r.ref.key);
  return { ...fn, fileKeys, assembly: fn.lines.join('\n') };
}
function cleanInstruction(text) { return text.trim().replace(/\s+#.*$/, '').trim(); }

// key -> line -> [{ fnName, text }]: every emitted instruction by source line.
function buildLineIndex(functions) {
  const index = new Map();
  for (const fn of functions) {
    for (const r of fn.instructionRows) {
      if (!r.ref) continue;
      let lines = index.get(r.ref.key);
      if (!lines) index.set(r.ref.key, lines = new Map());
      let list = lines.get(r.ref.line);
      if (!list) lines.set(r.ref.line, list = []);
      list.push({ fnName: fn.sourceName || fn.name, text: cleanInstruction(r.text) });
    }
  }
  return index;
}

function normalizeName(name) {
  return String(name || '').replace(/^.*::/, '').replace(/\s+/g, '').replace(/[&*]/g, '').replace(/\(.*$/, '').replace(/\[clone.*\]$/, '');
}
// Picks the source function for an emitted assembly function.
// 1) By location: the source function whose range contains most of the function's mapped lines
//    (this tells overloads apart). 2) Fallback: by name, as before.
function matchSourceSymbol(asmName, symbols, fn, docKey) {
  if (fn && docKey) {
    const lines = fn.instructionRows.filter(r => r.ref && r.ref.key === docKey).map(r => r.ref.line);
    if (lines.length) {
      let best, bestHits = 0;
      for (const s of symbols) {
        if (!s.range) continue;
        const hits = lines.filter(l => l >= s.range.start.line && l <= s.range.end.line).length;
        // Prefer more hits; on a tie prefer the smaller (inner) range.
        if (hits > bestHits || (hits && hits === bestHits && best &&
            (s.range.end.line - s.range.start.line) < (best.range.end.line - best.range.start.line))) {
          best = s; bestHits = hits;
        }
      }
      if (best) return best;
    }
  }
  const norm = normalizeName(asmName);
  return symbols.find(s => normalizeName(s.name) === norm)
    || symbols.find(s => asmName.includes(s.name) || s.name.includes(asmName))
    || symbols.find(s => normalizeName(s.name).split('(')[0] === norm.split('(')[0]);
}
// `docKey`, when given, rejects functions whose instructions all come from other
// files, so a same-named function elsewhere is not shown on this document.
function findFunctionResult(symbol, functions, docKey) {
  if (!symbol) return undefined;
  const usable = f => !docKey || !f.fileKeys || f.fileKeys.size === 0 || f.fileKeys.has(docKey);
  const exact = functions.find(f => usable(f) && (f.sourceName === symbol.name || f.name === symbol.name));
  if (exact) return exact;
  const normalized = normalizeName(symbol.name);
  return functions.find(f => usable(f) && (normalizeName(f.sourceName) === normalized || normalizeName(f.name) === normalized))
    || functions.find(f => usable(f) && (normalizeName(f.sourceName).startsWith(normalized) || normalizeName(f.name).startsWith(normalized)));
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

function cleanAssemblyRowsForDisplay(result) {
  const rows = result.rows || String(result.assembly || '').split(/\r?\n/).map(text => ({ text }));
  const referencedLocalLabels = new Set();
  for (const row of rows) {
    const text = (typeof row === 'string' ? row : row.text || '').trim();
    if (!isInstructionLine(text)) continue;
    const withoutComment = text.replace(/\s+#.*$/, '');
    const refs = withoutComment.matchAll(/(?:^|[\s,])((?:\.L|\$L)[\w.$]*)\b/g);
    for (const match of refs) referencedLocalLabels.add(match[1]);
  }
  const cleaned = [];
  for (const row of rows) {
    const rawText = typeof row === 'string' ? row : row.text || '';
    const text = rawText.trim();
    if (!text) continue;
    if (isInstructionLine(text)) {
      cleaned.push({ text: cleanInstruction(text), ref: typeof row === 'object' ? row.ref : undefined });
      continue;
    }
    const label = text.match(/^((?:\.L|\$L)[\w.$]*):$/);
    if (label && referencedLocalLabels.has(label[1])) cleaned.push({ text, ref: undefined });
  }
  return cleaned;
}
function cleanAssemblyForDisplay(result) {
  return cleanAssemblyRowsForDisplay(result).map(row => row.text).join('\n');
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
    resolveSettings, showAssembly, handleWebviewMessage, syncAsmHighlight, _state: () => ({ panelState }),
    blankEnclosingDeclaration, missingIncludesFrom, preprocessorErrorFilesFrom, errorLocationsFrom, compileWithRecovery,
    collectLocalIncludes, parseFunctions, makeRefResolver, isInstructionLine, cleanAssemblyRowsForDisplay, buildLineIndex,
    maskCode, classifyFunctionSegment, guessFunctionSymbols, isSystemHeader, globToRegExp
  }
};
