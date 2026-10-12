# Asm Lens

See what your code compiles to without leaving the editor. Asm Lens puts the
instruction count of every function above it, opens the function's assembly
next to your code, and links the two: hover a source line to see its
instructions, hover an instruction to see its source line.

It compiles with [Compiler Explorer](https://godbolt.org) (no setup) or with
the compiler installed on your machine (nothing leaves it). C and C++ get the
full treatment, including local headers, header-only code and templates. Rust,
Go, Python, Zig, Swift, D and Fortran are supported too.

## Features

- **Instruction counts as CodeLens** above every function: `12 instructions · GCC 15.2 · -O2`.
  Template functions show every instantiation (`3 instantiations · 4 / 6 / 9 instructions`).
- **Assembly view** next to the editor. Click a count to open it; it follows the cursor
  from function to function.
- **Two-way highlighting**, like Compiler Explorer: each source line and its instructions
  share a color. Hover a source line to highlight its instructions; hover an instruction
  to highlight its source line (and the exact token, when the compiler reports a column).
  Hover a function's signature to preview its whole assembly.
- **Headers work**: analyze a header on its own, or analyze a `.cpp` and open the headers
  it includes. Functions defined in headers get counts too, including code inlined into callers.
- **Templates on demand**: click **Instantiate…** above a template, type the template
  arguments (`int`, `float, 4`, `std::vector<int>`), and see the code for exactly that type.
- **Robust against real projects**: local headers are found and uploaded the way a
  compiler would find them; a missing header is replaced by an empty file; a function
  that does not compile is skipped and marked *Not compiled*, and the rest is analyzed.
- **Remote or local**, per project or per compiler, on Windows, Linux and macOS.
- **Fast, and visibly working**: a progress notification shows each step (finding headers,
  compiling, retrying around errors) with a **Cancel** button; the status bar and the CodeLens
  spin while it runs. Saving re-analyzes automatically, unchanged code is answered from a cache,
  and Compiler Explorer is asked for compact replies.

## Quick start

1. Install the extension and open a C, C++, Rust, Go, Python, … file.
2. Click **Analyze with Asm Lens** above any function (or run **Asm Lens: Analyze Current File**,
   or right-click in the editor).
3. Click a count to open the assembly view. Hover lines in either view.

While it compiles, a notification shows what is happening and lets you cancel. After that,
saving the file updates the counts by itself.

By default the file is compiled on godbolt.org with GCC 15.2 and `-O2 -masm=intel`.
Choose another compiler with the compiler name in the status bar (bottom right) or
**Asm Lens: Select Compiler**. To change flags, include folders and so on for a
project, run **Asm Lens: Open or Create Project Config** (see [`.asm-lens.json`](#project-configuration-asm-lensjson)).

## Remote and local mode

|                     | `"mode": "remote"` (default)                                   | `"mode": "local"`                                              |
|---------------------|----------------------------------------------------------------|----------------------------------------------------------------|
| Where it compiles   | A Compiler Explorer server: godbolt.org, or your own (`baseUrl`) | On this machine                                                |
| What leaves the machine | The file, plus the local headers it includes               | Nothing                                                        |
| Compilers           | Any Compiler Explorer compiler: GCC, Clang, MSVC, ICX, … in many versions | The compiler you name: any GCC- or Clang-compatible one for C/C++ (`g++`, `clang++`, `g++-14`, MinGW `g++.exe`, …) |
| Headers             | Found locally and uploaded with their folder layout            | Read from disk by the compiler; `includePaths` become `-I`    |
| Standard library    | The server's                                                   | Yours                                                          |
| Target              | What the server's compiler targets (mostly Linux x86-64)       | Your OS and CPU (x86-64, arm64; ELF, COFF or Mach-O)           |
| Speed               | A network round trip (about 0.5–5 s); unchanged code is answered from a cache | Usually well under a second                                    |
| Works offline       | No                                                             | Yes                                                            |
| Unsaved edits       | Used                                                           | Used                                                           |
| Missing headers, failing functions | Recovered (see below)                           | Recovered the same way                                         |

Choose the mode in `.asm-lens.json` (`"mode": "local"`), per compiler (`{ "id": "...", "mode": "local" }`),
or for every project with the `asmLens.mode` setting. The status bar shows which one is active
(`clang++ (local)` or the Compiler Explorer compiler's name).

Local mode for C/C++ runs `<compiler> -S -g -x c++ -iquote <file folder> -I<includePaths> <flags> -`
with your unsaved text on standard input, then `c++filt` to demangle names. Asm Lens never
runs your program and never builds the rest of the project.

## Headers and templates

**Analyzing a header on its own.** A header usually compiles to nothing: an `inline` or
`static inline` function that nothing calls is dropped, and a template is just a pattern.
When you analyze a header (`.h`, `.hpp`, `.hxx`, `.hh`, `.inl`, `.ipp`, `.tpp`, …), Asm Lens
marks every non-template function in it `__attribute__((used))` (only in the copy that is
compiled, keeping every line in place), so each one is emitted and gets a count:
free functions, `static inline` functions, and member functions defined inside classes.

**Templates.** Above every template function, and every member function of a class template,
there is an **Instantiate…** CodeLens. Click it and type the template arguments:

- `square<T>`: type `int` and Asm Lens compiles `square<int>`;
- `mx::Box<T>::twice()`: type `double` and Asm Lens compiles `template struct mx::Box<double>;`,
  which gives the code of every member of `Box<double>`;
- a member template of a class template asks for both argument lists.

The requests are added after the file's last line, so line numbers do not change. They
are remembered per file (shown in a CodeLens at the top of the file; click it to remove
some) and compiled every time you analyze that file. A request that does not compile
(a misspelled type, for example) is removed and the compiler's message is shown.
Template constructors cannot be instantiated this way; use them from a `.cpp` file instead.

**Analyzing a `.cpp` and then opening its headers.** Every header the `.cpp` includes shows
the result of that analysis (`· via user.cpp`): functions that were emitted show their
counts, and code that was inlined into the `.cpp`'s functions shows as
`N inlined instructions · used in M function(s)`. A header shows the newest analysis that
involved it: its own, or the last analyzed file that includes it.

## Languages

| Language       | Remote | Local compiler (default command) | Notes |
|----------------|:------:|-----------------------------------|-------|
| C, C++, Objective-C, Objective-C++ | ✓ | `g++` (any GCC/Clang-compatible compiler) | Headers uploaded, error recovery, header and template support |
| Rust           | ✓ | `rustc` | Compiled as a library with `-C link-dead-code`, so every function is kept; Asm Lens adds that flag |
| Go             | ✓ | `go` | Locally: one file that imports only the standard library |
| Python         | ✓ | `python3` (`python` on Windows) | Shows CPython **bytecode**, one function per code object |
| Zig            | ✓ | `zig` | Only `export` functions (and what they use) are compiled |
| Swift          | ✓ | `swiftc` | |
| D              | ✓ | – | Remote only (LDC) |
| Fortran        | ✓ | `gfortran` | |

For languages other than C and C++, the default remote compiler is Compiler Explorer's default for
that language. Choose another with **Select Compiler**, or list one in `.asm-lens.json` with its
`"language"`. The top-level `flags`, `defines`, `includePaths` and `compiler` are C/C++ settings and
are not used for other languages; give those compilers their own `flags` and `compiler`.

VS Code has built-in support for C, C++, Objective-C, Rust, Go, Python and Swift files. For Zig, D and
Fortran, install an extension that adds the language (for example *Zig Language*, *code-d* or
*Modern Fortran*).

## Project configuration: `.asm-lens.json`

Put a `.asm-lens.json` in the project root (**Asm Lens: Open or Create Project Config** creates one
from a template). It is found by walking up from the analyzed file, also as `.vscode/asm-lens.json`.
It accepts comments and trailing commas, editing it takes effect immediately, and problems in it are
listed in the *Asm Lens* output channel. VS Code validates it as you type.

Settings are taken in this order: the active compiler's own entry, then the top level of
`.asm-lens.json`, then the VS Code settings.

### Example: Compiler Explorer, several compilers

```jsonc
{
  "compilers": [
    { "id": "g152", "name": "GCC 15.2", "flags": "-O2 -masm=intel" },
    { "id": "clang1910", "name": "Clang 19", "flags": "-O3 -march=native" },
    { "id": "cg152", "name": "GCC 15.2 (C)", "language": "c" }
  ],
  "includePaths": ["include", "src/generated", { "path": "third_party", "recursive": true }],
  "defines": ["NDEBUG", "USE_SIMD=1"],
  "buildFolders": ["build", "out"]
}
```

### Example: local compiler

```jsonc
{
  "mode": "local",
  "compiler": "g++-14",              // or "clang++", "C:/msys64/ucrt64/bin/g++.exe", "./tools/bin/g++"
  "flags": "-O2 -std=c++20 -march=x86-64-v3",
  "includePaths": ["include"]
}
```

### Example: mixing languages and modes

```jsonc
{
  "mode": "local",
  "compilers": [
    { "id": "local-gcc", "name": "GCC", "compiler": "g++", "flags": "-O2" },
    { "id": "r1990", "name": "Rust 1.99", "language": "rust", "mode": "remote", "flags": "-C opt-level=3" },
    { "id": "py", "name": "Python 3.12", "language": "python", "compiler": "python3.12" }
  ]
}
```

### All options

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `mode` | `"remote"` \| `"local"` | `asmLens.mode` (`"remote"`) | Where to compile (see [Remote and local mode](#remote-and-local-mode)). |
| `compiler` | string | `asmLens.localCompiler`, else `g++` | Local mode, C/C++: the compiler command or path. A path starting with `./` or `../` is relative to the config file. |
| `compilers` | array | `asmLens.compilerId` | Compilers in order of preference. The first one for a language is the default; switch with the status bar. An entry is a Compiler Explorer id (`"g152"`) or an object (below). |
| `flags` | string | `asmLens.flags` (`-O2 -masm=intel`) | C/C++ flags for compilers without their own `flags`. |
| `language` | `"c"` \| `"c++"` | by file type | Force the language of C-family files (for example compile `.c` files as C++). |
| `includePaths` | array | `[]` | Folders searched for `#include`s, in priority order. A string, or `{ "path": "...", "recursive": true }` to also search every subfolder. Relative to the config file. |
| `buildFolders` | string[] | `build`, `out`, `bin`, `cmake-build-*`, `generated`, … | Folder names searched last, for generated headers. Wildcards allowed. |
| `excludePaths` | string[] | `[]` | Glob patterns of folders whose headers are never uploaded, added to the built-in list (`**/libcxx/**`, `**/*llvm-project*/**`, `**/sysroot/**`, `**/node_modules/**`, …). A bare name such as `"vendor"` means any folder with that name. |
| `defines` | string[] | `[]` | Preprocessor defines, passed as `-D<name>` (`"NDEBUG"`, `"LEVEL=2"`; a leading `-D` is accepted). |
| `extraFlags` | string \| string[] | `""` | C/C++ flags added after all others. |
| `uploadSystemHeaders` | boolean | `false` | Remote: also upload workspace copies of standard headers (`vector`, `stdio.h`, …). Normally the server's own are used. |
| `baseUrl` | string | `asmLens.baseUrl` (`https://godbolt.org`) | Compiler Explorer server, for example a self-hosted one that keeps code in-house. |
| `maxIncludeFiles` | number | `asmLens.maxIncludeFiles` (80) | Remote: most local headers uploaded per analysis. |

Each object in `compilers` may have:

| Key | Type | Meaning |
|-----|------|---------|
| `id` | string (required) | Compiler Explorer compiler id, such as `g152`, `clang1910`, `r1990`. Use **Select Compiler → Browse** to look them up (they differ per server). In local mode it is only a name. |
| `name` | string | Label for the status bar and CodeLens. |
| `flags` | string | Flags for this compiler; replaces the top-level `flags`. |
| `language` | `c`, `c++`, `rust`, `go`, `python`, `zig`, `swift`, `d`, `fortran` | Use this compiler only for that language. Without it the compiler is for C and C++. |
| `mode` | `"remote"` \| `"local"` | Overrides the top-level `mode` for this compiler. |
| `compiler` | string | Local mode: the command or path (`clang++-18`, `rustc`, `python3.12`). |
| `defines` | string[] | Extra `-D` defines for this compiler (C/C++). |
| `extraFlags` | string \| string[] | Flags added after the others. |

## VS Code settings

| Setting | Default | Meaning |
|---------|---------|---------|
| `asmLens.mode` | `remote` | Where to compile when `.asm-lens.json` does not say. |
| `asmLens.localCompiler` | `""` (= `g++`) | Local C/C++ compiler when `.asm-lens.json` does not name one. |
| `asmLens.reanalyzeOnSave` | `true` | Saving a file that was analyzed (or a header an analyzed file uses) analyzes it again, with a status-bar spinner instead of a notification. |
| `asmLens.baseUrl` | `https://godbolt.org` | Compiler Explorer server. |
| `asmLens.compilerId` | `g152` | Compiler Explorer compiler for C/C++ without a project file. **Select Compiler** sets it. |
| `asmLens.compilerName` | `GCC (selected ID)` | Its label in the CodeLens. |
| `asmLens.flags` | `-O2 -masm=intel` | C/C++ flags. |
| `asmLens.language` | `c++` | Language sent for C-family files without a project file. |
| `asmLens.includePaths` | `[]` | Extra include folders, searched after the project file's. |
| `asmLens.maxIncludeFiles` | `80` | Most local headers uploaded per analysis. |
| `asmLens.skipFailingFunctions` | `true` | Skip functions that do not compile instead of failing. |
| `asmLens.maxRecoveryAttempts` | `12` | Most compiles per analysis while recovering. |
| `asmLens.stubFailingHeaders` | `false` | Remote: replace an uploaded header that fails in the preprocessor (`#error`) by an empty file. |
| `asmLens.requestTimeoutMs` | `30000` | Timeout of one compile. |
| `asmLens.showCounts` | `true` | Show the CodeLens. |
| `asmLens.highlightOnHover` | `true` | Two-way highlighting. |
| `asmLens.colorizeLines` | `true` | Color source lines and their instructions alike. |
| `asmLens.followCursor` | `true` | The assembly view follows the function under the cursor. |

## Commands

| Command | What it does |
|---------|--------------|
| Asm Lens: Analyze Current File | Compile the file and show counts (also in the editor's context menu). |
| Asm Lens: Select Compiler | Choose a compiler from `.asm-lens.json`, or browse Compiler Explorer's list for the file's language. |
| Asm Lens: Instantiate Template at Cursor… | Same as the **Instantiate…** CodeLens. |
| Asm Lens: Remove Template Instantiations… | Remove instantiation requests of the current file. |
| Asm Lens: Open or Create Project Config (.asm-lens.json) | Open the project file, creating it from a template. |
| Asm Lens: Show Output | The log: what was compiled, uploaded, skipped and why. |

## When code does not compile

Projects rarely compile from a single file without their build system. Asm Lens recovers instead of giving up:

1. **Missing header**: retried with that header replaced by an empty file.
2. **A function that then fails** (it used something from that header): the function is blanked out
   (line numbers stay the same) and the rest is compiled again. Its CodeLens says *Not compiled*.
3. Each retry is one more compile, up to `asmLens.maxRecoveryAttempts`.

Only the copy that is compiled changes, never your files. Everything that was skipped is listed in the
*Asm Lens* output. If a header is not on any include path, the workspace is searched for it
(case-insensitively): first your normal folders, then build output folders, where generated headers
live. If that is not enough, add the folders to `includePaths`, the needed `defines`, or switch to local
mode, where your own compiler and system headers are used.

## Troubleshooting

- **"No code emitted"**: the function is not used (an unused `inline` function in a `.cpp`), was
  inlined everywhere, or is a template that was never instantiated: click **Instantiate…**, or analyze a
  file that calls it.
- **Rust shows nothing**: only `pub` functions (and what they use) are compiled into a library.
- **Zig shows nothing**: mark functions `export`.
- **Local mode: "g++ was not found"**: install a compiler or set `"compiler"` (or `asmLens.localCompiler`)
  to its full path. On Windows, MinGW-w64 (MSYS2) and LLVM both work; MSVC's `cl.exe` does not.
- **Hover highlighting does nothing**: the compiler gave no line information for that function. All
  defaults include it; flags such as `-g0` remove it.
- **A compiler id does not work**: ids differ between Compiler Explorer servers and change over time;
  use **Select Compiler → Browse**.
- See **Asm Lens: Show Output** for the exact command, flags and compiler messages.

## Privacy

In **remote** mode the analyzed file and the local headers it includes are sent to the Compiler Explorer
server in `baseUrl` (godbolt.org by default; see its [privacy policy](https://godbolt.org/#privacy)).
Use **local** mode, or a self-hosted Compiler Explorer, for code that must stay private. In local mode
nothing is sent anywhere.

## Development

```sh
npm test                 # unit tests, recorded Compiler Explorer responses, and every local compiler found
npm run test:remote      # the same against the live godbolt.org
node test/run.js --record   # refresh the recorded responses (test/fixtures/ce)
npm run package          # build asm-lens-<version>.vsix (needs network for npx)
```

There are no runtime dependencies and no build step: the extension is plain JavaScript in `src/`:

| File | Contents |
|------|----------|
| `src/extension.js` | VS Code integration: commands, CodeLens, hover, the assembly view, remote and local compiles |
| `src/cppScan.js` | C/C++ source scanning: functions, classes, templates; keeping header functions; instantiation requests |
| `src/asm.js` | Assembly parsing (ELF, COFF, Mach-O), symbol names, source mapping, compiler diagnostics |
| `src/languages.js` | Rust, Go, Python, Zig, Swift, D, Fortran |
| `src/projectConfig.js` | `.asm-lens.json` parsing and validation |

Every push builds the `.vsix` on GitHub Actions (tests on Windows, Linux and macOS first); it is attached to
the workflow run. Pushing a tag such as `v0.6.0` also creates a GitHub release with the `.vsix`.

To publish on the Visual Studio Marketplace: create a publisher at
<https://marketplace.visualstudio.com/manage>, set `"publisher"` in `package.json` to its id, then run
`npx @vscode/vsce login <publisher>` and `npx @vscode/vsce publish`. (Changing the publisher changes the
extension id, so VS Code treats it as a new extension next to the locally installed one.)

## License

[MIT](LICENSE)
