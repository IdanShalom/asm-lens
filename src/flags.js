'use strict';
// Compiler command lines: assembly-syntax flags, flags a compiler rejects, and
// compile_commands.json entries. Pure functions: no dependency on the VS Code API.
const path = require('path');

const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Assembly syntax
//
// Asm Lens chooses the assembly syntax itself, because the right flag depends
// on the compiler and its target: -masm=intel is unknown to MSVC and rejected by
// compilers for ARM, RISC-V and others. Flags that set it are taken out of the
// user's flags; `syntax` says which one was asked for (Intel unless AT&T was).

const SYNTAX_FLAG_RE = /(^|\s)(?:-masm=(\S+)|-mllvm\s+-{1,2}x86-asm-syntax=(\S+))(?=\s|$)/g;

function stripSyntaxFlags(flags) {
  let syntax = 'intel';
  const rest = String(flags || '').replace(SYNTAX_FLAG_RE, (all, lead, masm, llvm) => {
    syntax = /^att$/i.test(masm || llvm || '') ? 'att' : 'intel';   // the last one wins, as for the compiler
    return lead;
  }).replace(/\s{2,}/g, ' ').trim();
  return { flags: rest, syntax };
}

function stripSyntaxArgs(args) {
  let syntax = 'intel';
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let m;
    if ((m = /^-masm=(.+)$/.exec(a))) { syntax = /^att$/i.test(m[1]) ? 'att' : 'intel'; continue; }
    if (a === '-mllvm' && /^-{1,2}x86-asm-syntax=/.test(args[i + 1] || '')) { syntax = /=att$/i.test(args[i + 1]) ? 'att' : 'intel'; i++; continue; }
    out.push(a);
  }
  return { args: out, syntax };
}

// What a local compiler is, from `<cc> --version` and `<cc> -dumpmachine` output.
function compilerKind(versionText, executable) {
  const v = String(versionText || '');
  const base = path.basename(String(executable || '')).toLowerCase();
  if (/^(?:cl|clang-cl)(?:\.exe)?$/.test(base) || /Microsoft \(R\) C\/C\+\+ Optimizing Compiler/.test(v)) return 'msvc';
  if (/clang|oneAPI|Intel\(R\) .*Compiler/i.test(v)) return 'clang';
  if (/\bgcc\b|\bg\+\+\b|Free Software Foundation|\bGCC\b/i.test(v)) return 'gcc';
  if (/clang/.test(base)) return 'clang';
  if (/(?:^|[-_])(?:gcc|g\+\+|c\+\+|cc)(?:-[\d.]+)?(?:\.exe)?$/.test(base)) return 'gcc';
  return 'unknown';
}

// The target a command line compiles for: --target/-target in `args`, else the
// compiler's default (-dumpmachine).
function targetOf(args, defaultTarget) {
  for (let i = 0; i < args.length; i++) {
    const m = /^--?target=(.+)$/.exec(args[i]);
    if (m) return m[1];
    if ((args[i] === '-target' || args[i] === '--target') && args[i + 1]) return args[i + 1];
  }
  return String(defaultTarget || '').trim();
}

function isX86(target) { return /^(?:x86_64|amd64|x64|i[3-6]86|x86)\b/i.test(String(target || '')); }

// The flags that select the syntax, for this compiler and target (none when not x86 or not wanted).
function syntaxArgs(kind, target, syntax = 'intel') {
  if (syntax !== 'intel' || !isX86(target)) return [];
  if (kind === 'clang') return ['-mllvm', '-x86-asm-syntax=intel'];
  if (kind === 'gcc') return ['-masm=intel'];
  return [];
}

// ---------------------------------------------------------------------------
// GCC/Clang flags for MSVC, and the other way round
//
// One set of flags can serve every compiler: the common options are written
// the way the active compiler expects. Unknown options are left as they are.

// Whether a compiler takes MSVC-style options: cl.exe on Compiler Explorer (vcpp_*, vc_*,
// cl19*, cl_new_*, and ccl* for C) and clang-cl.
function isMsvcStyle(id, name) {
  return /^(?:vcpp_|vc_|c?cl19|c?cl_new_|c?clang-cl)/i.test(String(id || '')) || /\bmsvc\b|clang-cl/i.test(String(name || ''));
}

const TO_MSVC = [
  [/^-O0$|^-Og$/, ['/Od']], [/^-O1$|^-Os$|^-Oz$/, ['/O1']], [/^-O[23]?$/, ['/O2']], [/^-Ofast$/, ['/O2', '/fp:fast']],
  [/^-std=(?:c|gnu)\+\+(?:98|03|0x|11|1y|14)$/, ['/std:c++14']], [/^-std=(?:c|gnu)\+\+(?:1z|17)$/, ['/std:c++17']],
  [/^-std=(?:c|gnu)\+\+(?:2a|20)$/, ['/std:c++20']], [/^-std=(?:c|gnu)\+\+(?:2b|23|2c|26)$/, ['/std:c++latest']],
  [/^-std=(?:c|gnu)(?:89|90|99|1x|11)$/, ['/std:c11']], [/^-std=(?:c|gnu)(?:17|18)$/, ['/std:c17']], [/^-std=(?:c|gnu)(?:2x|23)$/, ['/std:clatest']],
  [/^-Wall$/, ['/W4']], [/^-Werror$/, ['/WX']], [/^-w$/, ['/w']],
  [/^-fno-exceptions$/, ['/EHs-c-']], [/^-fexceptions$/, ['/EHsc']], [/^-fno-rtti$/, ['/GR-']], [/^-frtti$/, ['/GR']],
  [/^-ffast-math$/, ['/fp:fast']], [/^-fopenmp$/, ['/openmp']],
  [/^-mavx$/, ['/arch:AVX']], [/^-mavx2$/, ['/arch:AVX2']], [/^-mavx512\w*$/, ['/arch:AVX512']], [/^-msse2$/, ['/arch:SSE2']],
  // No MSVC equivalent: left out instead of warning "D9002 ignoring unknown option".
  [/^-(?:march|mtune|mcpu)=|^-m(?:32|64|sse\d*\w*|fma|bmi2?|popcnt|arch=.*)$|^-g|^-W|^-pedantic|^-pipe$|^-f(?:no-)?(?:PIC|pic|PIE|pie|omit-frame-pointer|strict-aliasing|stack-protector\S*|lto\S*|visibility\S*|diagnostics\S*|color-diagnostics)$/, []]
];
// `/` options, and `-` ones that GCC and Clang do not have (cl.exe takes both forms).
const TO_GCC = [
  [/^[/-]Od$/, ['-O0']], [/^\/O1$/, ['-Os']], [/^\/O2$/, ['-O2']], [/^[/-]Ox$/, ['-O3']],
  [/^[/-]std:c\+\+(14|17|20)$/, m => [`-std=c++${m[1]}`]], [/^[/-]std:c\+\+latest$/, ['-std=c++2b']],
  [/^[/-]std:c(11|17)$/, m => [`-std=c${m[1]}`]], [/^[/-]std:clatest$/, ['-std=c2x']],
  [/^\/W4$|^\/Wall$/, ['-Wall']], [/^[/-]WX$/, ['-Werror']], [/^\/w$/, ['-w']],
  [/^[/-]EHs-c-$/, ['-fno-exceptions']], [/^[/-]GR-$/, ['-fno-rtti']], [/^[/-]fp:fast$/, ['-ffast-math']], [/^\/openmp$/, ['-fopenmp']],
  [/^[/-]arch:AVX$/, ['-mavx']], [/^[/-]arch:AVX2$/, ['-mavx2']], [/^[/-]arch:AVX512$/, ['-mavx512f']],
  [/^\/D([A-Za-z_]\w*(?:=.*)?)$/, m => [`-D${m[1]}`]], [/^\/U([A-Za-z_]\w*)$/, m => [`-U${m[1]}`]],
  [/^\/(?:EH\w*|GR|Z[i7I]|permissive-?|utf-8|nologo|MDd?|MTd?|W[0-3]|sdl-?|Zc:\S+|FC|diagnostics:\S+)$|^-(?:EH\w+|Z[i7I]|permissive-|utf-8|nologo|Zc:\S+|sdl-?|diagnostics:\S+)$/, []]
];

// `flags` (a string) written for a compiler that takes MSVC-style options
// (`msvc`) or GCC/Clang ones; `cxx`: C++ (MSVC gets /EHsc unless an /EH option
// is given). Returns { flags, changes: ["-O2 -> /O2", ...] }; flags that need
// no change are returned as they were written.
function adaptFlags(flags, msvc, { cxx = true } = {}) {
  const table = msvc ? TO_MSVC : TO_GCC;
  const out = [];
  const changes = [];
  for (const tok of splitCommand(flags || '', false)) {
    const rule = table.find(([re]) => re.test(tok));
    if (!rule) { out.push(tok); continue; }
    const repl = typeof rule[1] === 'function' ? rule[1](rule[0].exec(tok)) : rule[1];
    out.push(...repl);
    changes.push(`${tok} -> ${repl.length ? repl.join(' ') : '(left out)'}`);
  }
  // Visual Studio compiles C++ with /EHsc; without it MSVC warns wherever exceptions are used (iostream).
  if (msvc && cxx && !out.some(f => /^[/-]EH/.test(f))) { out.push('/EHsc'); changes.push('added /EHsc (as Visual Studio does)'); }
  if (!changes.length) return { flags: flags || '', changes };
  return { flags: out.map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' '), changes };
}

// Whether errors come from C++11 (or later) code compiled as C++98, the default of
// older compilers (Apple clang 14, GCC 5).
function needsNewerStd(stderr) {
  return /is a C\+\+(?:11|14|17|1[yz]) extension|only available with [-'‘]*std=(?:c|gnu)\+\+(?:11|0x)|-std=(?:c|gnu)\+\+11 or -std=(?:c|gnu)\+\+11|C\+\+11 or later|requires (?:compiler and library support for the )?ISO C\+\+ 2011/.test(String(stderr || ''));
}

// ---------------------------------------------------------------------------
// Flags a compiler rejects

const REJECTED_FLAG_RES = [
  /unrecognized command[- ]line option\s+['‘"`]?(-[^'’"`\s]+)/g,            // GCC
  /unrecognized argument in option\s+['‘"`]?(-[^'’"`\s]+)/g,                // GCC
  /unknown argument:?\s+['‘"`]?(-[^'’"`\s,]+)/g,                            // Clang
  /unsupported option\s+['‘"`]?(-[^'’"`\s]+?)['’"`]?\s+for target/g,        // Clang: '-masm=' for target 'aarch64'
  /(?:^|\s)[Uu]nknown (?:command[- ]line )?(?:option|argument):?\s+['‘"`]?(-[^'’"`\s]+)/gm, // cc65 and others
  /bad option\s+['‘"`]?(-[^'’"`\s]+)/g,                                     // Norcroft
  /invalid option -- ['‘"`]?([A-Za-z0-9])/g,                                // getopt
  /Found argument\s+['‘"`]?(-[^'’"`\s]+)['’"`]? which wasn't expected/g,     // clap
  /ignoring unknown option\s+['‘"`]?(-[^'’"`\s]+)/g,                         // MSVC D9002
  /invalid compiler option\s+(-[^\s(]+)/gi                                  // TI
];

// Options the compiler said it does not accept.
function rejectedFlagsFrom(errText) {
  const out = new Set();
  for (const re of REJECTED_FLAG_RES) {
    for (const m of String(errText || '').matchAll(re)) {
      const opt = m[1].length === 1 ? `-${m[1]}` : m[1].replace(/['’"`.,:;]+$/, '');
      if (opt.length > 1) out.add(opt);
    }
  }
  return [...out];
}

// Whether `arg` is (a form of) the rejected option `opt`: "-O2" for "-O", "-masm=intel" for "-masm=".
function matchesOption(arg, opt) {
  if (arg === opt) return true;
  if (opt.endsWith('=') && arg.startsWith(opt)) return true;
  if (/^-[A-Za-z]$/.test(opt) && arg.startsWith(opt) && arg.length > 2) return true;
  return false;
}

// `flags` (a string) without the rejected options; `removed` lists what was taken out.
function removeFlags(flags, options) {
  const removed = [];
  const kept = String(flags || '').split(/(\s+)/).filter(tok => {
    if (!tok.trim()) return true;
    if (options.some(opt => matchesOption(tok, opt))) { removed.push(tok); return false; }
    return true;
  }).join('').replace(/\s{2,}/g, ' ').trim();
  return { flags: kept, removed };
}

function removeArgs(args, options) {
  const removed = [];
  const kept = args.filter(a => { if (options.some(opt => matchesOption(a, opt))) { removed.push(a); return false; } return true; });
  return { args: kept, removed };
}

// ---------------------------------------------------------------------------
// compile_commands.json

// Splits a command line the way the platform's shell would: POSIX quoting
// (quotes, backslash escapes) or Windows (CommandLineToArgvW rules).
function splitCommand(command, windows = IS_WIN) {
  const s = String(command || '');
  const args = [];
  let cur = '', inArg = false;
  if (windows) {
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') {
        let n = 0;
        while (s[i] === '\\') { n++; i++; }
        if (s[i] === '"') { cur += '\\'.repeat(Math.floor(n / 2)); if (n % 2) cur += '"'; else { quoted = !quoted; } inArg = true; }
        else { cur += '\\'.repeat(n); i--; inArg = true; }
        continue;
      }
      if (c === '"') { if (quoted && s[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted; inArg = true; continue; }
      if (!quoted && /\s/.test(c)) { if (inArg) { args.push(cur); cur = ''; inArg = false; } continue; }
      cur += c; inArg = true;
    }
  } else {
    let quote = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote === "'") { if (c === "'") quote = ''; else cur += c; continue; }
      if (quote === '"') {
        if (c === '"') quote = '';
        else if (c === '\\' && /["\\$`\n]/.test(s[i + 1] || '')) cur += s[++i];
        else cur += c;
        continue;
      }
      if (c === "'" || c === '"') { quote = c; inArg = true; continue; }
      if (c === '\\') { if (i + 1 < s.length) cur += s[++i]; inArg = true; continue; }
      if (/\s/.test(c)) { if (inArg) { args.push(cur); cur = ''; inArg = false; } continue; }
      cur += c; inArg = true;
    }
  }
  if (inArg) args.push(cur);
  return args;
}

const LAUNCHERS = /^(?:ccache|sccache|distcc|icecc|buildcache|cachecc1|ccache\.exe|sccache\.exe)$/i;

// An entry's argv: `arguments`, or `command` split. Compiler launchers are skipped.
function entryArgs(entry, windows = IS_WIN) {
  let args = Array.isArray(entry.arguments) ? entry.arguments.map(String) : splitCommand(entry.command, windows);
  while (args.length > 1 && LAUNCHERS.test(path.basename(args[0]))) args = args.slice(1);
  return args;
}

// The flags of an entry that still make sense when compiling the editor text to
// assembly: without the compiler, the source file, -c, -o x, dependency-file
// options (-M*), -Werror*, -x <lang>, -S/-E and the like.
function compileFlagsOf(entry, windows = IS_WIN) {
  const args = entryArgs(entry, windows).slice(1);
  const dir = entry.directory || '';
  const source = entry.file ? path.resolve(dir, entry.file) : undefined;
  const same = a => source && !a.startsWith('-') && path.resolve(dir, a) === source;
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '-S' || a === '-E' || a === '-M' || a === '-MM' || a === '-MD' || a === '-MMD' || a === '-MP' || a === '--') continue;
    if (a === '-o' || a === '-MF' || a === '-MT' || a === '-MQ' || a === '-x' || a === '-MJ') { i++; continue; }
    if (/^-o.+/.test(a) || /^-M[FTQJ].+/.test(a) || /^-x.+/.test(a) || /^-Werror/.test(a)) continue;
    if (/^-fdiagnostics-color/.test(a)) continue;
    if (same(a)) continue;
    out.push(a);
  }
  return out;
}

// The compiler of an entry, resolved against its directory when it is a relative path.
function entryCompiler(entry, windows = IS_WIN) {
  const c = entryArgs(entry, windows)[0] || '';
  return /[\\/]/.test(c) && !path.isAbsolute(c) ? path.resolve(entry.directory || '', c) : c;
}

module.exports = {
  stripSyntaxFlags, stripSyntaxArgs, compilerKind, targetOf, isX86, syntaxArgs, isMsvcStyle, adaptFlags, needsNewerStd,
  rejectedFlagsFrom, matchesOption, removeFlags, removeArgs,
  splitCommand, entryArgs, compileFlagsOf, entryCompiler
};
